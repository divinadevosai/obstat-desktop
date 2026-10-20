// Installed apps: where they live, their install/start scripts, and the worker
// processes running them. The registry is ~/obstat/apps.json.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const { logoSvg } = require("./logo")
const { fork, execFile } = require("node:child_process")
const { commandsOf } = require("./script")
const { withPath } = require("./env")

const WORKER = path.join(__dirname, "worker.js")
const INSPECT = path.join(__dirname, "inspect.js")
const SCRIPTS = ["install.js", "start.js", "update.js", "reset.js"]
// a launcher file the window may name: a plain .js file at the top of the app folder
const SCRIPT_NAME = /^[\w-][\w.-]{0,60}\.js$/
const checkName = (script) => { if (!SCRIPT_NAME.test(String(script))) throw new Error("That isn't one of this app's scripts."); return script }
// folders an app's packages usually go in; Reset deletes these and keeps everything else
const PACKAGE_DIRS = ["env", "venv", ".venv", "node_modules", "app/env", "app/venv", "app/.venv", "app/node_modules"]
const label = (file) => { const t = file.replace(/\.js$/, "").replace(/[_-]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1) }

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

function hasNvidia() {
  return new Promise((resolve) => execFile("nvidia-smi", ["-L"], { timeout: 5000, windowsHide: true }, (err, out) => resolve(!err && /GPU/.test(out))))
}

// `area` is the folder (and registry name) the apps live in: "apps" for real
// installs, "sandboxes" for test runs. `jobEnv(id)` adds env vars to every step.
function create(home, runtimes, { emit = () => {}, execPath = process.execPath, workerEnv = {}, area = "apps", jobEnv = () => ({}) } = {}) {
  const registryFile = path.join(home.root, `${area}.json`)
  const running = new Map() // id -> { child, script, url }
  let gpu = null

  const read = () => { try { return JSON.parse(fs.readFileSync(registryFile, "utf8")) } catch { return {} } }
  const write = (reg) => fs.writeFileSync(registryFile, JSON.stringify(reg, null, 2))
  const folderName = (id) => id.replace(/[^a-z0-9._-]+/gi, "-")
  // ids are owner/name; anything else (like "." or "..") could point at Obstat's own folders
  const appDir = (id) => {
    if (typeof id !== "string" || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(id) || id.split("/").some((p) => /^\.+$/.test(p))) throw new Error("That isn't an app.")
    return path.join(home.dir(area), folderName(id))
  }

  // Asks lib/inspect.js, in a separate process without keys or the chat token,
  // to read scripts, so a repo's code never runs inside Obstat itself.
  function inspect(msg) {
    return new Promise((resolve, reject) => {
      const env = { ...workerEnv, PATH: process.env.PATH || "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
      const child = fork(INSPECT, [], { execPath, env, stdio: ["ignore", "ignore", "ignore", "ipc"] })
      const timer = setTimeout(() => { child.kill(); reject(new Error("Reading the app's scripts took too long.")) }, 15000)
      child.once("message", (r) => { clearTimeout(timer); r && !r.error ? resolve(r.data) : reject(new Error(r?.error || "Couldn't read the app's scripts.")) })
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Couldn't read the app's scripts.")) })
      child.send(msg)
    })
  }

  async function context() {
    if (gpu === null) gpu = (await hasNvidia()) ? "nvidia" : "none"
    return { platform: process.platform, arch: os.arch(), gpu, gpus: gpu === "nvidia" ? ["nvidia"] : [], args: {}, input: {}, port: await freePort(), env: {} }
  }

  function list() {
    const reg = read()
    return Object.values(reg).map((a) => ({
      ...a,
      installed: a.installed && fs.existsSync(appDir(a.id)),
      running: running.has(a.id) ? { script: running.get(a.id).script, url: running.get(a.id).url } : null,
      scripts: SCRIPTS.filter((s) => fs.existsSync(path.join(appDir(a.id), s))),
    }))
  }
  const get = (id) => list().find((a) => a.id === id) || null

  const git = (args, cwd, onLog) => new Promise((resolve, reject) => {
    onLog(`> git ${args.join(" ")}\n`)
    const env = { ...withPath(process.env, runtimes.paths()), GIT_TERMINAL_PROMPT: "0" }
    execFile(runtimes.git(), args, { cwd, env, windowsHide: true, maxBuffer: 1 << 24 }, (err, out, errOut) => {
      if (out) onLog(out)
      if (errOut) onLog(errOut)
      err ? reject(new Error(`git ${args[0]} failed.`)) : resolve()
    })
  })

  const headOf = (cwd) => new Promise((resolve) => execFile(runtimes.git(), ["rev-parse", "HEAD"], { cwd, windowsHide: true }, (err, out) => resolve(err ? null : out.trim())))

  // Clones the repo (at the reviewed commit when there is one) and adds Obstat's
  // generated scripts when it has none of its own.
  async function fetchApp(entry, onLog) {
    await runtimes.ensureAll((name, got, total) => emit({ type: "progress", id: entry.id, name, got, total }))
    const dir = appDir(entry.id)
    // made on this PC (Create an app, Copy app): nothing to download
    if (read()[entry.id]?.local) return dir
    if (!fs.existsSync(path.join(dir, ".git"))) {
      await fsp.rm(dir, { recursive: true, force: true })
      await git(["clone", entry.url, dir], home.dir(area), onLog)
    }
    if (entry.sha) await git(["-c", "advice.detachedHead=false", "checkout", entry.sha], dir, onLog)
    for (const [name, text] of Object.entries(entry.scripts || {})) {
      if (!SCRIPT_NAME.test(name) || typeof text !== "string") continue
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) fs.writeFileSync(file, text)
    }
    const commit = await headOf(dir)
    const reg = read()
    reg[entry.id] = { ...(reg[entry.id] || {}), id: entry.id, commit, owner: entry.owner, name: entry.name, url: entry.url, description: entry.description || "", sha: entry.sha || null, reviewed: !!entry.reviewed, icon: typeof entry.icon === "string" ? entry.icon : reg[entry.id]?.icon || null, fetchedAt: new Date().toISOString(), installed: reg[entry.id]?.installed || false }
    write(reg)
    return dir
  }

  // What a script would run, without running anything.
  async function preview(id, script) {
    checkName(script)
    const file = path.join(appDir(id), script)
    if (!fs.existsSync(file)) throw new Error(`This app has no ${script}.`)
    const steps = await inspect({ op: "plan", file, ctx: await context() })
    return { steps, commands: commandsOf(steps), unsupported: flatten(steps).filter((s) => s.unsupported || s.missing).map((s) => s.method || s.uri) }
  }
  const flatten = (steps) => steps.flatMap((s) => [s, ...(s.steps ? flatten(s.steps) : [])])

  function logFile(id, script) {
    const dir = path.join(home.dir("logs"), area, folderName(id))
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, script.replace(/\.js$/, ".txt"))
  }

  async function run(id, script) {
    checkName(script)
    if (running.has(id)) throw new Error("This app is already busy. Stop it first.")
    const dir = appDir(id)
    if (!fs.existsSync(path.join(dir, script))) throw new Error(`This app has no ${script}.`)
    const out = fs.createWriteStream(logFile(id, script), { flags: "w" })
    const ctx = await context()
    const extra = jobEnv(id)
    const env = { PORT: String(ctx.port), PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", UV_PYTHON: runtimes.python(), ...extra }
    const child = fork(WORKER, [], { execPath, env: { ...process.env, ...workerEnv, ...extra }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const entry = { child, script, url: null }
    running.set(id, entry)
    emit({ type: "state", id })
    return new Promise((resolve) => {
      const finish = (result) => {
        if (running.get(id) === entry) running.delete(id)
        out.end()
        emit({ type: "state", id })
        resolve(result)
      }
      child.on("message", (m) => {
        if (m.type === "log") { out.write(m.text); emit({ type: "log", id, text: m.text }) }
        else if (m.type === "local" && m.key === "url") { entry.url = m.value; emit({ type: "state", id }) }
        else if (m.type === "open") emit({ type: "open", id, url: m.url })
        else if (m.type === "ready") { entry.url = m.url || entry.url; emit({ type: "state", id }); resolve({ ok: true, running: true }) }
        else if (m.type === "done") {
          if (script === "install.js") { const reg = read(); if (reg[id]) { reg[id].installed = true; reg[id].installedAt = new Date().toISOString(); write(reg) } }
          if (script === "reset.js") { const reg = read(); if (reg[id]) { reg[id].installed = false; write(reg) } }
          finish({ ok: true })
        } else if (m.type === "error") { out.write(`\nStopped: ${m.message}\n`); emit({ type: "log", id, text: `\nStopped: ${m.message}\n` }); finish({ ok: false, error: m.message }) }
      })
      child.on("exit", () => finish({ ok: true }))
      child.send({ type: "run", job: { appDir: dir, script, env, paths: runtimes.paths(), python: runtimes.python(), ctx } })
    })
  }

  function stop(id) {
    const r = running.get(id)
    if (!r) return false
    try { r.child.send({ type: "stop" }) } catch {}
    setTimeout(() => { try { r.child.kill() } catch {} }, 3000)
    return true
  }

  async function remove(id) {
    stop(id)
    await new Promise((r) => setTimeout(r, running.has(id) ? 1500 : 0))
    await fsp.rm(appDir(id), { recursive: true, force: true, maxRetries: 3 })
    const reg = read()
    delete reg[id]
    write(reg)
    emit({ type: "state", id })
  }

  function setAutostart(id, on) {
    const reg = read()
    if (!reg[id]) throw new Error("That app isn't installed.")
    reg[id].autostart = !!on
    write(reg)
    return reg[id].autostart
  }

  const stopAll = () => { for (const id of running.keys()) stop(id) }
  const need = (id) => { if (!read()[id]) throw new Error("That app isn't installed."); return appDir(id) }
  const idle = (id) => { if (running.has(id)) throw new Error("Stop the app first.") }

  // The launcher files at the top of the app folder.
  function launchers(id) {
    const dir = need(id)
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && SCRIPT_NAME.test(e.name)).map((e) => e.name).sort().slice(0, 60)
  }

  // Ways to run the app, like Start or Run webcam: start.js first, then any other
  // launcher that isn't install/update/reset or a helper they call. An app can
  // name them itself in obstat.json: { "run": [{ "label": "Run webcam", "script": "webcam.js" }] }.
  async function runOptions(id) {
    const dir = need(id)
    const files = launchers(id)
    try {
      const custom = JSON.parse(fs.readFileSync(path.join(dir, "obstat.json"), "utf8")).run
      const ok = (Array.isArray(custom) ? custom : []).filter((r) => r && typeof r.label === "string" && files.includes(r.script)).slice(0, 12)
      if (ok.length) return ok.map((r) => ({ script: r.script, label: r.label.slice(0, 40) }))
    } catch {}
    const read = await inspect({ op: "scripts", files: files.map((f) => path.join(dir, f)) })
    const helpers = new Set()
    files.forEach((f, i) => { if (["install.js", "update.js", "reset.js"].includes(f) && read[i].ok) for (const u of read[i].starts) helpers.add(path.basename(u)) })
    const out = []
    for (const [i, f] of files.entries()) {
      if (SCRIPTS.includes(f) && f !== "start.js") continue
      if (f.startsWith("pinokio") || helpers.has(f)) continue
      if (!read[i].ok) continue
      out.push({ script: f, label: f === "start.js" ? "Start" : f === "obstat-ui.js" ? "Open with Obstat UI" : label(f) })
    }
    return out.sort((a, b) => (b.script === "start.js") - (a.script === "start.js")).slice(0, 12)
  }

  // Update: the newest reviewed commit for a reviewed app, otherwise the newest
  // code on GitHub. Obstat does the git part itself, so an app's own update.js
  // can't move it past its review.
  async function update(entry, onLog) {
    idle(entry.id)
    const dir = need(entry.id)
    if (read()[entry.id].local) throw new Error("This app was made on this PC, so there's nothing to download.")
    if (!fs.existsSync(path.join(dir, ".git"))) throw new Error("This app's folder has no git history, so it can't update. Reinstall it instead.")
    const from = await headOf(dir)
    await runtimes.ensureAll(() => {})
    await git(["fetch", entry.url, entry.sha ? entry.sha : "HEAD"], dir, onLog)
    await git(["-c", "advice.detachedHead=false", "checkout", "--detach", entry.sha || "FETCH_HEAD"], dir, onLog)
    const to = await headOf(dir)
    const reg = read()
    reg[entry.id] = { ...reg[entry.id], commit: to, sha: entry.sha || null, reviewed: !!entry.reviewed, updatedAt: new Date().toISOString() }
    write(reg)
    return { from, to, changed: from !== to }
  }

  // Reset without a reset.js: delete the app's packages, keep its own files,
  // and mark it as needing an install again.
  async function reset(id) {
    idle(id)
    const dir = need(id)
    const gone = []
    for (const d of PACKAGE_DIRS) {
      const p = path.join(dir, d)
      if (fs.existsSync(p)) { await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 }); gone.push(d) }
    }
    const reg = read()
    reg[id].installed = false
    write(reg)
    emit({ type: "state", id })
    return { removed: gone }
  }

  // A second copy of an installed app, with its own folder and settings.
  async function copy(id) {
    idle(id)
    need(id)
    const reg = read()
    const src = reg[id]
    let n = 2, name
    do name = `${src.name}-${n++}`; while (reg[`${src.owner}/${name}`.toLowerCase()] && n < 100)
    const to = `${src.owner}/${name}`.toLowerCase()
    await fsp.cp(appDir(id), appDir(to), { recursive: true, errorOnExist: true })
    reg[to] = { ...src, id: to, name, local: true, copiedFrom: id, autostart: false, createdAt: new Date().toISOString() }
    write(reg)
    return reg[to]
  }

  // A new app made on this PC: an empty folder holding what the person asked
  // for, for an AI agent to build.
  function createLocal({ name, task, files = {} }) {
    name = String(name || "").trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) throw new Error("Use 2 to 41 lowercase letters, numbers or dashes for the name.")
    const id = `me/${name}`
    const reg = read()
    if (reg[id] || fs.existsSync(appDir(id))) throw new Error("You already have an app with that name.")
    fs.mkdirSync(appDir(id), { recursive: true })
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(appDir(id), path.basename(f)), text)
    // its own logo from day one; the agent can replace icon.svg with a better one
    if (!files["icon.svg"] && !files["icon.png"]) fs.writeFileSync(path.join(appDir(id), "icon.svg"), logoSvg(name))
    const first = String(task || "").split(/\r?\n/).find((l) => l.trim()) || ""
    reg[id] = { id, owner: "me", name, url: null, description: first.slice(0, 200), sha: null, reviewed: false, local: true, installed: false, createdAt: new Date().toISOString() }
    write(reg)
    return reg[id]
  }

  function readScript(id, script) {
    checkName(script)
    const file = path.join(need(id), script)
    if (!fs.existsSync(file)) throw new Error(`This app has no ${script}.`)
    return fs.readFileSync(file, "utf8")
  }
  function writeScript(id, script, text) {
    checkName(script)
    idle(id)
    text = String(text ?? "")
    if (text.length > 200000) throw new Error("That file is too big.")
    fs.writeFileSync(path.join(need(id), script), text)
    const reg = read()
    reg[id].edited = true
    write(reg)
  }

  return { list, get, fetchApp, preview, run, stop, remove, stopAll, setAutostart, appDir, launchers, runOptions, update, reset, copy, createLocal, readScript, writeScript }
}

module.exports = { create }
