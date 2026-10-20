// Runs one Pinokio script for one app, in its own process, and reports back over IPC:
//   {type:"log", text} {type:"local", key, value} {type:"ready", url?} {type:"open", url}
//   {type:"done"} {type:"error", message}
// The parent sends {type:"stop"} to end it; every shell it started is killed with it.
const fs = require("node:fs")
const path = require("node:path")
const { spawn, execFile } = require("node:child_process")
const { loadScript, render, toRegExp, skipped, SUPPORTED } = require("./script")
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
          if (p.kill) killTree(child)
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
        if (job.daemon) { log(`\n(The app stopped, exit code ${code}.)\n`); send({ type: "exited", code }) ; stopAll(0) }
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

async function runScript(file, job, ctx, depth = 0) {
  const script = loadScript(file)
  if (depth === 0) job.daemon = script.daemon
  let input = ctx.input || {}
  for (const raw of script.run) {
    const step = raw || {}
    const c = { ...ctx, input, local: job.local }
    if ("when" in step && skipped(render(step.when, c))) continue
    if (!SUPPORTED.has(step.method)) throw new Error(`This app uses "${step.method}", which Obstat can't run yet.`)
    const params = render(step.params || {}, c)
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
      case "web.open": send({ type: "open", url: params.uri || params.url }); break
      case "fs.link": log("(Skipped a drive link step; Obstat keeps each app's files in its own folder.)\n"); break
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
