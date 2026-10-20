// Runs one Pinokio script for one app, in its own process, and reports back over IPC:
//   {type:"log", text} {type:"local", key, value} {type:"ready", url?} {type:"open", url}
//   {type:"done"} {type:"error", message}
// The parent sends {type:"stop"} to end it; every shell it started is killed with it.
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const { spawn, execFile } = require("node:child_process")
const { loadScript, render, toRegExp, skipped, hfCommand, within, stepKey, obstatEnv, OPEN_MARK, HF_SETUP, SUPPORTED, CHECKED } = require("./script")
const { withPath, inside } = require("./env")

// set so Electron runs this file as plain Node; apps shouldn't inherit it
delete process.env.ELECTRON_RUN_AS_NODE

const send = (msg) => process.send && process.send(msg)
const log = (text) => send({ type: "log", text })
const children = new Set()

const OPEN_LINE = new RegExp(`${OPEN_MARK.replace(/[[\]]/g, "\\$&")} (https?:\\/\\/\\S+)`, "g")
const isLocalPage = (url) => { try { const u = new URL(url); return /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/.test(u.hostname) } catch { return false } }

// Colours and cursor moves in an app's output. Vite colours its address even when
// piped on Windows ("http://localhost:\x1b[1m5173\x1b[22m/"), which no pattern matches.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const plain = (text) => text.replace(ANSI, "")

// A web address a pattern found, tidied: without the full stop or bracket after it
// in a sentence ("running at http://127.0.0.1:7860."). null when it isn't one an
// app's page could be at: placeholders like LLaMA-Factory's "http://ip:port", and
// addresses on other computers, which Obstat wouldn't open anyway.
function pageUrl(m) {
  const at = /^https?:\/\//i.test(m[0]) ? 0 : m.findIndex((g, i) => i > 0 && typeof g === "string" && /^https?:\/\//i.test(g))
  if (at < 0) return undefined // not a web address: the pattern matches some other line
  const url = m[at].replace(/[.,;:!?)\]}'"`>]+$/, "")
  try { new URL(url) } catch { return null }
  return isLocalPage(url) ? url : null
}
const tidy = (m) => Array.from(m, (g) => (typeof g === "string" && /^https?:\/\//i.test(g) ? g.replace(/[.,;:!?)\]}'"`>]+$/, "") : g))

// Whether something answers at the address yet.
const listening = (url) => new Promise((resolve) => {
  const u = new URL(url)
  const host = u.hostname === "0.0.0.0" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, "")
  const s = net.connect({ host, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), autoSelectFamily: true })
  const end = (ok) => { s.destroy(); resolve(ok) }
  s.setTimeout(1000, () => end(false))
  s.once("connect", () => end(true))
  s.once("error", () => end(false))
})
// The app's address once its server answers there. Apps often print an address before
// the real one (LLaMA-Factory: "e.g., http://127.0.0.1:7860", whatever port it gets),
// so the newest address that answers wins. One that never answers is taken after a
// while anyway, so the window can say the app didn't answer.
const WAIT_LISTEN_MS = 10 * 60_000
async function firstListening(found, alive) {
  const until = Date.now() + WAIT_LISTEN_MS
  while (alive() && Date.now() < until) {
    for (const c of [...found].reverse()) if (await listening(c.url)) return c
    await new Promise((r) => setTimeout(r, 500))
  }
  return alive() ? found[found.length - 1] : null
}

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
// A pattern that finds the app's web address counts once the app answers there.
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
    // Obstat's own settings (shown with every plan; see obstatEnv) under the step's own
    const env = withPath({ ...process.env, ...job.env, ...obstatEnv(), ...(params.env || {}) }, front)
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
    // Obstat keeps the shell's id, so it can still end it if this worker is killed first
    if (child.pid) send({ type: "pid", pid: child.pid })
    const patterns = (params.on || []).map((o) => ({ ...o, re: toRegExp(o.event), found: [], waiting: false })).filter((o) => o.re)
    let settled = false, buffer = ""
    const settle = (p, m) => {
      if (settled) return
      if (p.kill) { child.stopping = true; killTree(child) }
      settled = true
      resolve({ event: m })
    }
    const onData = (d) => {
      const text = d.toString()
      log(text)
      buffer = (buffer + text).slice(-8192)
      const clean = plain(buffer)
      for (const u of plain(text).matchAll(OPEN_LINE)) if (isLocalPage(u[1])) send({ type: "open", url: u[1] })
      for (const p of patterns) {
        if (settled || !(p.done || p.kill)) continue
        const all = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g")
        for (const m of clean.matchAll(all)) {
          const url = pageUrl(m)
          if (url === null) continue
          // a line that isn't an address: done as soon as it shows, as in Pinokio
          if (url === undefined || p.kill) { settle(p, url ? tidy(m) : Array.from(m)); break }
          if (!p.found.some((f) => f.url === url) && p.found.length < 20) p.found.push({ url, m: tidy(m) })
        }
        if (!settled && p.found.length && !p.waiting) {
          p.waiting = true
          firstListening(p.found, () => !settled && child.exitCode === null).then((c) => { if (c) settle(p, c.m) })
        }
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("error", (err) => { if (!settled) { settled = true; reject(err) } })
    child.on("exit", (code) => {
      children.delete(child)
      send({ type: "pid-done", pid: child.pid })
      if (settled) {
        // a pattern with kill: true ended it on purpose (and a jump may start it again)
        if (job.daemon && !child.stopping) { log(`\n(The app stopped, exit code ${code}.)\n`); send({ type: "exited", code }) ; stopAll(0) }
        return
      }
      settled = true
      if (code === 0) return resolve(null)
      const err = new Error(`A command failed (exit code ${code}).`)
      // npm 7+ refuses some older packages' peer dependencies, which npm 6 (and Pinokio's apps' authors) accepted
      err.peerConflict = /\bERESOLVE\b/.test(buffer) && all.some((l) => /\bnpm(\.cmd)?\s+(install|i|ci)\b/.test(l)) && !/legacy-peer-deps/.test(all.join(" ") + JSON.stringify(params.env || {}))
      reject(err)
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

// hf.download: Hugging Face's `hf download`, always from Obstat's own small venv
// in its cache folder, never a tool the app's code put in its env. Downloads only ever
// come from huggingface.co.
async function hfDownload(params, job) {
  const { command, localDir } = hfCommand(params)
  const cwd = path.resolve(job.appDir, params.path || ".")
  if (!inside(cwd, job.appDir)) throw new Error(`A download tried to run outside the app folder (${params.path}).`)
  if (localDir !== null && !inside(path.resolve(cwd, localDir), job.appDir)) throw new Error("A download tried to save outside the app folder.")
  const env = { HF_ENDPOINT: "https://huggingface.co" }
  const own = job.hfEnv ? path.resolve(job.hfEnv) : path.join(job.appDir, ".hf-env")
  return shellRun({ path: params.path || ".", venv: own, env, message: [HF_SETUP, command] }, job)
}

// A script people approved runs from its plan: the scripts as the plan read them,
// and only steps whose filled-in params match what the plan showed.
function approvedScript(file, job) {
  const scripts = job.approved.scripts || {}
  if (!Object.hasOwn(scripts, file)) throw new Error(`This app tried to start ${path.basename(file)}, which wasn't in the steps you approved, so Obstat stopped it.`)
  return scripts[file]
}
function checkApproved(file, i, step, params, job) {
  const seen = job.approved.params || {}
  const key = stepKey(file, i)
  if (Object.hasOwn(seen, key) && seen[key].includes(JSON.stringify(params))) return
  throw new Error(`A ${step.method} step in ${path.basename(file)} changed from the steps you approved, so Obstat stopped before running it. Look at the steps again and approve them if they're fine.`)
}

async function runScript(file, job, ctx, depth = 0) {
  file = path.resolve(file)
  const script = job.approved ? approvedScript(file, job) : loadScript(file, { root: job.appDir, ctx })
  const memo = job.approved ? { exists: job.approved.exists || {} } : null
  if (depth === 0) job.daemon = script.daemon
  let input = ctx.input || {}
  let i = 0, jumps = 0
  while (i < script.run.length) {
    const at = i
    const step = script.run[i++] || {}
    const c = { ...ctx, input, local: job.local, cwd: path.dirname(file), self: script.self }
    if ("when" in step && skipped(render(step.when, c, job.appDir, memo))) continue
    if (!SUPPORTED.has(step.method)) throw new Error(`This app uses "${step.method}", which Obstat can't run yet.`)
    const params = render(step.params || {}, c, job.appDir, memo)
    if (job.approved && CHECKED.has(step.method)) checkApproved(file, at, step, params, job)
    switch (step.method) {
      case "shell.run":
        try { input = (await shellRun(params, job)) || {} } catch (err) {
          if (!err.peerConflict) throw err
          log("\nnpm couldn't settle this app's package versions. Trying again the way older npm did (--legacy-peer-deps), as npm suggests.\n")
          input = (await shellRun({ ...params, env: { ...(params.env || {}), npm_config_legacy_peer_deps: "true" } }, job)) || {}
        }
        break
      case "script.start": {
        const child = path.resolve(path.dirname(file), String(params.uri || ""))
        if (!inside(child, job.appDir) || !fs.existsSync(child)) throw new Error(`Couldn't find ${params.uri}.`)
        if (depth >= 4) throw new Error("Scripts start each other too deeply.")
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
