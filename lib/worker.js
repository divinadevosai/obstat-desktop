// Runs one Pinokio script for one app, in its own process, and reports back over IPC:
//   {type:"log", text} {type:"local", key, value} {type:"ready", url?} {type:"open", url}
//   {type:"done"} {type:"error", message}
// The parent sends {type:"stop"} to end it; every shell it started is killed with it.
const fs = require("node:fs")
const path = require("node:path")
const { spawn, execFile } = require("node:child_process")
const { loadScript, render, toRegExp, skipped, hfCommand, within, SUPPORTED } = require("./script")
const { withPath, inside } = require("./env")

// set so Electron runs this file as plain Node; apps shouldn't inherit it
delete process.env.ELECTRON_RUN_AS_NODE

const send = (msg) => process.send && process.send(msg)
const log = (text) => send({ type: "log", text })
const children = new Set()

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
  else try { process.kill(-child.pid, "SIGTERM") } catch {}
}

function stopAll(code = 0) {
  for (const c of children) killTree(c)
  setTimeout(() => process.exit(code), 500)
}

// Runs a shell step. Resolves when the shell exits, or as soon as an `on` pattern
// with done:true matches (the shell keeps running, as a daemon's server should).
function shellRun(params, job) {
  return new Promise((resolve, reject) => {
    const cwd = path.resolve(job.appDir, params.path || ".")
    if (!inside(cwd, job.appDir)) return reject(new Error(`A step tried to run outside the app folder (${params.path}).`))
    fs.mkdirSync(cwd, { recursive: true })
    const lines = [].concat(params.message || []).filter((x) => x !== undefined && x !== null && x !== "").map(String)
    const front = [...job.paths]
    let pre = []
    if (params.venv) {
      const venv = path.resolve(cwd, params.venv)
      const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin")
      if (!fs.existsSync(bin)) pre.push(`"${job.python}" -m venv "${venv}"`)
      front.unshift(bin)
      params = { ...params, env: { ...(params.env || {}), VIRTUAL_ENV: venv } }
    }
    const env = withPath({ ...process.env, ...job.env, ...(params.env || {}) }, front)
    // UV_PYTHON points uv at Obstat's base Python; inside a venv, uv must use the venv
    if (params.venv) delete env.UV_PYTHON
    if (params.conda) log("(Obstat ignores conda settings and uses its own Python.)\n")
    const all = [...pre, ...lines]
    if (!all.length) return resolve(null)
    log(all.map((l) => `> ${l}`).join("\n") + "\n")
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${all.join(" && ")}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn("/bin/bash", ["-c", ["set -e", ...all].join("\n")], { cwd, env, detached: true })
    children.add(child)
    const patterns = (params.on || []).map((o) => ({ ...o, re: toRegExp(o.event) })).filter((o) => o.re)
    let settled = false, buffer = ""
    const onData = (d) => {
      const text = d.toString()
      log(text)
      buffer = (buffer + text).slice(-8192)
      for (const p of patterns) {
        const m = buffer.match(p.re)
        if (m && !settled) {
          if (p.kill) { child.stopping = true; killTree(child) }
          if (p.done || p.kill) { settled = true; resolve({ event: Array.from(m) }) }
        }
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("error", (err) => { if (!settled) { settled = true; reject(err) } })
    child.on("exit", (code) => {
      children.delete(child)
      if (settled) {
        // a pattern with kill: true ended it on purpose (and a jump may start it again)
        if (job.daemon && !child.stopping) { log(`\n(The app stopped, exit code ${code}.)\n`); send({ type: "exited", code }) ; stopAll(0) }
        return
      }
      settled = true
      code === 0 ? resolve(null) : reject(new Error(`A command failed (exit code ${code}).`))
    })
  })
}

async function download(params, job) {
  const url = String(params.uri || params.url || "")
  if (!/^https:\/\//.test(url)) throw new Error(`Only https downloads are allowed (${url}).`)
  const dir = path.resolve(job.appDir, params.dir || params.path || ".")
  if (!inside(dir, job.appDir)) throw new Error("A download tried to save outside the app folder.")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, path.basename(new URL(url).pathname) || "download")
  log(`> download ${url}\n`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

// fs.copy: both ends must be inside the app folder, even after following symlinks.
// Paths are relative to the script's folder, as in Pinokio.
function copy(params, job, base) {
  const src = path.resolve(base, String(params.src || ""))
  const dest = path.resolve(base, String(params.dest || ""))
  const from = within(src, job.appDir)
  if (!params.src || !from) throw new Error(`A copy step named a file outside the app folder, or one that isn't there (${params.src}).`)
  // the destination may not exist yet: check the nearest folder that does
  let probe = dest
  while (!fs.existsSync(probe) && inside(path.dirname(probe), job.appDir) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  if (!params.dest || !inside(dest, job.appDir) || dest === job.appDir || !within(probe, job.appDir)) throw new Error(`A copy step tried to write outside the app folder (${params.dest}).`)
  log(`> copy ${params.src} -> ${params.dest}\n`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(from, dest, { recursive: true, force: true, verbatimSymlinks: true })
}

// hf.download: Hugging Face's `hf download`, from the app's own venv when it has
// one with the hf tool, otherwise from a small venv just for this (.hf-env).
// Downloads only ever come from huggingface.co.
async function hfDownload(params, job) {
  const { command, localDir } = hfCommand(params)
  const cwd = path.resolve(job.appDir, params.path || ".")
  if (!inside(cwd, job.appDir)) throw new Error(`A download tried to run outside the app folder (${params.path}).`)
  if (localDir !== null && !inside(path.resolve(cwd, localDir), job.appDir)) throw new Error("A download tried to save outside the app folder.")
  const bin = process.platform === "win32" ? "Scripts" : "bin"
  const has = (venv, tool) => fs.existsSync(path.join(venv, bin, process.platform === "win32" ? `${tool}.exe` : tool))
  const venvs = [params.venv && path.resolve(cwd, String(params.venv)), ...["env", "venv", ".venv"].flatMap((d) => [path.join(cwd, d), path.join(job.appDir, d)])]
    .filter((v) => v && inside(v, job.appDir))
  const found = venvs.find((v) => has(v, "hf") || has(v, "huggingface-cli"))
  const env = { HF_ENDPOINT: "https://huggingface.co" }
  if (found) {
    const line = has(found, "hf") ? command : command.replace(/^hf download/, "huggingface-cli download")
    return shellRun({ path: params.path || ".", venv: path.relative(cwd, found) || ".", env, message: [line] }, job)
  }
  const own = path.join(job.appDir, ".hf-env")
  return shellRun({ path: params.path || ".", venv: path.relative(cwd, own), env, message: ['python -m pip install --quiet "huggingface_hub>=0.34"', command] }, job)
}

async function runScript(file, job, ctx, depth = 0) {
  const script = loadScript(file, { root: job.appDir, ctx })
  if (depth === 0) job.daemon = script.daemon
  let input = ctx.input || {}
  let i = 0, jumps = 0
  while (i < script.run.length) {
    const step = script.run[i++] || {}
    const c = { ...ctx, input, local: job.local, cwd: path.dirname(file), self: script.self }
    if ("when" in step && skipped(render(step.when, c, job.appDir))) continue
    if (!SUPPORTED.has(step.method)) throw new Error(`This app uses "${step.method}", which Obstat can't run yet.`)
    const params = render(step.params || {}, c, job.appDir)
    switch (step.method) {
      case "shell.run": input = (await shellRun(params, job)) || {}; break
      case "script.start": {
        const child = path.resolve(path.dirname(file), String(params.uri || ""))
        if (!inside(child, job.appDir) || !fs.existsSync(child)) throw new Error(`Couldn't find ${params.uri}.`)
        if (depth > 4) throw new Error("Scripts start each other too deeply.")
        await runScript(child, job, { ...ctx, args: params.params || {} }, depth + 1)
        break
      }
      case "local.set":
        for (const [k, v] of Object.entries(params)) { job.local[k] = v; send({ type: "local", key: k, value: v }) }
        break
      case "fs.download": await download(params, job); break
      case "fs.copy": copy(params, job, path.dirname(file)); break
      case "hf.download": await hfDownload(params, job); break
      case "web.open": send({ type: "open", url: params.uri || params.url }); break
      case "fs.link": log("(Skipped a drive link step; Obstat keeps each app's files in its own folder.)\n"); break
      case "proxy.start": case "proxy.stop": log("(Skipped Pinokio's sharing step; Obstat keeps apps on this PC.)\n"); break
      case "jump": {
        // go to the step with this id (or index); its params become the next step's input
        const to = params.id !== undefined ? script.run.findIndex((s) => s && s.id === params.id) : Number(params.index)
        if (!Number.isInteger(to) || to < 0 || to >= script.run.length) throw new Error("A jump step points at a step that isn't there.")
        if (++jumps > 100) throw new Error("This script jumped back more than 100 times, so Obstat stopped it.")
        input = params.params || {}
        i = to
        continue
      }
      default: if (params.title || params.description || params.html) log(`${params.title || ""} ${params.description || params.html || ""}\n`)
    }
    // Pinokio's "next: null" ends the script here (torch.js picks one GPU step this way)
    if (step.next === null) break
  }
}

process.on("message", async (msg) => {
  if (msg.type === "stop") return stopAll(0)
  if (msg.type !== "run") return
  const job = { ...msg.job, local: {} }
  try {
    await runScript(path.join(job.appDir, job.script), job, job.ctx)
    if (job.daemon && children.size) send({ type: "ready", url: job.local.url || null })
    else { send({ type: "done" }); process.exit(0) }
  } catch (err) {
    send({ type: "error", message: err.message })
    stopAll(1)
  }
})
process.on("disconnect", () => stopAll(0))
