// Installed apps: where they live, their install/start scripts, and the worker
// processes running them. The registry is ~/obstat/apps.json.
const fs = require("node:fs")
const crypto = require("node:crypto")
const fsp = require("node:fs/promises")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const { logoSvg } = require("./logo")
const pinsLib = require("./pins")
const { fork, spawn, execFile, execFileSync } = require("node:child_process")
const { commandsOf, obstatEnv } = require("./script")
const { needsCompiler } = require("./cpptools")
const { withPath } = require("./env")
const { sandboxEnv } = require("./confine")

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

// The NVIDIA card's name from `nvidia-smi -L` ("GPU 0: NVIDIA GeForce RTX 5090 (UUID: …)"),
// or null when there's no NVIDIA GPU. Launchers check the name to pick the
// torch build RTX 50-series cards need.
function gpuModel(out) {
  if (!/GPU/.test(String(out || ""))) return null
  const m = String(out).match(/^GPU \d+:\s*([^(\r\n]+?)\s*(\(|$)/m)
  return m ? m[1].slice(0, 100) : "NVIDIA GPU"
}
const nvidiaModel = () => new Promise((resolve) => execFile("nvidia-smi", ["-L"], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : gpuModel(out))))

// Whether an app calls ffmpeg (directly, or through Gradio's waveform video,
// pydub or moviepy), from a quick look through its text files. Folders with
// installed packages are skipped, so this reads the app's own code.
const FFMPEG = /\bff(mpeg|probe)\b|make_waveform|\bpydub\b|\bmoviepy\b/i
const TEXT = /\.(py|js|mjs|json|txt|toml|cfg|ya?ml|sh|bat|ps1|md)$/i
const SKIP = new Set([".git", "node_modules", "env", "venv", ".venv", ".hf-env", "__pycache__", "models", "outputs", "cache"])
function needsFfmpeg(dir, limit = { files: 3000 }) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (limit.files-- <= 0) return false
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name) && needsFfmpeg(p, limit)) return true }
    else if (e.isFile() && TEXT.test(e.name)) {
      try { if (fs.statSync(p).size < 512 * 1024 && FFMPEG.test(fs.readFileSync(p, "utf8"))) return true } catch {}
    }
  }
  return false
}

// Old Pinokio apps keep their steps in install.json/start.json. Obstat runs them
// through a one-line install.js/start.js that loads the JSON.
function wrapJsonScripts(dir) {
  for (const name of SCRIPTS) {
    const json = name.replace(/\.js$/, ".json")
    if (!fs.existsSync(path.join(dir, name)) && fs.existsSync(path.join(dir, json))) fs.writeFileSync(path.join(dir, name), `module.exports = require("./${json}")\n`)
  }
}

// Linux and Mac clone with the PC's own git. When it isn't there, say how to get it
// instead of "git clone failed". A Mac without Apple's Command Line Tools has a git
// that only prints an xcrun error (and opens Apple's installer).
function gitMissing(err, errOut, platform = process.platform) {
  if (platform === "darwin" && (err?.code === "ENOENT" || /xcrun: error|invalid active developer path/i.test(String(errOut || "")))) {
    return "Obstat needs git, which comes with Apple's free Command Line Tools. If a window offered to install them, click Install; if not, run xcode-select --install in Terminal. Then try again."
  }
  if (platform !== "win32" && err?.code === "ENOENT") return "Obstat needs git. Install it with your system's package manager (on Ubuntu or Debian: sudo apt install git), then try again."
  return null
}

// `area` is the folder (and registry name) the apps live in: "apps" for real
// installs, "sandboxes" for test runs. `jobEnv(id)` adds env vars to every step.
// Ends a shell Obstat started and everything under it, by process id. Used when
// the worker that started it is gone (Obstat updated or was closed in a hurry),
// so the app's server doesn't stay behind holding its port. Only shells count:
// an id that now belongs to some other program is left alone.
function killShell(pid, platform = process.platform, run = execFile) {
  pid = Number(pid)
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    if (platform === "win32") {
      run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => {
        if (err || !/^"cmd\.exe","\d+"/i.test(String(out).trim())) return resolve(false)
        run("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (e) => resolve(!e))
      })
    } else {
      const end = (comm) => {
        if (path.basename(String(comm).trim()) !== "bash") return resolve(false)
        try { process.kill(-pid, "SIGTERM"); resolve(true) } catch { resolve(false) }
      }
      // Linux names a process in /proc; a Mac has no /proc, so ask ps
      if (platform === "linux") {
        try { end(fs.readFileSync(`/proc/${pid}/comm`, "utf8")) } catch { resolve(false) }
      } else {
        run("ps", ["-o", "comm=", "-p", String(pid)], {}, (err, out) => (err ? resolve(false) : end(out)))
      }
    }
  })
}

// Every process below `root`, deepest first, from the OS's own record of which
// process started which (a test can't change who its parent is). For Apple's sandbox,
// where a test's worker isn't allowed to signal the shells it started: Obstat, outside
// it, ends them instead. Taken while the worker still runs, before they lose their parent.
function descendants(root, run = execFileSync) {
  let out
  try { out = run("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 }) } catch { return [] }
  const kids = new Map()
  for (const line of String(out).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid > 0 && ppid > 0) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid) }
  }
  const found = []
  const walk = (p) => { for (const c of kids.get(p) || []) if (!found.includes(c) && found.length < 5000) { found.push(c); walk(c) } }
  walk(root)
  return found.reverse()
}
const signalAll = (pids, sig) => { for (const p of pids) try { process.kill(p, sig) } catch {} }

// Everything an app's shells started on Windows that is still running, from one list
// of the PC's processes: taskkill /T misses a grandchild whose parent is already gone
// (npm run dev starts vite through a second shell, and vite kept Plazai's port).
// Only processes started after the app did count, so a reused id is never touched.
const PROCESS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }"
function leftovers(roots, since, run = execFile) {
  roots = [].concat(roots).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (!roots.length) return Promise.resolve([])
  return new Promise((resolve) => {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_LIST], { windowsHide: true, maxBuffer: 1 << 24 }, (err, out) => {
      if (err) return resolve([])
      const kids = new Map()
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^(\d+) (\d+) (\S+)$/.exec(line.trim())
        if (!m || Date.parse(m[3]) < since) continue
        const [pid, parent] = [Number(m[1]), Number(m[2])]
        if (pid !== parent) kids.set(parent, [...(kids.get(parent) || []), pid])
      }
      const found = new Set(), todo = [...roots]
      while (todo.length && found.size < 500) for (const k of kids.get(todo.pop()) || []) if (!found.has(k) && !roots.includes(k)) { found.add(k); todo.push(k) }
      resolve([...found])
    })
  })
}
async function endLeftovers(roots, since, run = execFile) {
  const pids = await leftovers(roots, since, run)
  if (!pids.length) return 0
  await new Promise((resolve) => run("taskkill", ["/F", ...pids.flatMap((p) => ["/PID", String(p)])], { windowsHide: true }, () => resolve()))
  return pids.length
}

// What is listening on a port, if it runs from inside the app's own folder: a copy of
// the app an older Obstat left running (one that didn't record its shells). Anything
// else on the port is left alone.
const portOwnerScript = (port) => `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess); if ($p) { '{0}\t{1}\t{2}' -f $p.ProcessId, $p.ExecutablePath, $p.CommandLine } }`
function portOwners(port, dir, run = execFile) {
  port = Number(port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve([])
  const inside = String(dir).toLowerCase().replace(/\//g, "\\").replace(/[\\/]+$/, "") + "\\"
  return new Promise((resolve) => {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", portOwnerScript(port)], { windowsHide: true }, (err, out) => {
      if (err) return resolve([])
      const found = new Set()
      for (const line of String(out).split(/\r?\n/)) {
        const [pid, exe = "", cmd = ""] = line.trim().split("\t")
        if (!/^\d+$/.test(pid || "") || Number(pid) < 5) continue
        const where = `${exe}\n${cmd}`.toLowerCase().replace(/\//g, "\\")
        if (where.includes(inside)) found.add(Number(pid))
      }
      resolve([...found])
    })
  })
}
async function endPortOwners(port, dir, run = execFile) {
  const pids = await portOwners(port, dir, run)
  if (!pids.length) return 0
  await new Promise((resolve) => run("taskkill", ["/F", "/T", ...pids.flatMap((p) => ["/PID", String(p)])], { windowsHide: true }, () => resolve()))
  return pids.length
}

// `wrap(id, file, args)` (sandbox tests on Mac and Linux) returns how to start a process
// inside the sandbox, with `pidsInside` when the sandbox numbers its own processes, so
// their ids mean nothing out here. `hfEnv(id)` is where Obstat's hf tool lives for an app.
// A test with a network of its own (Linux) adds `jobExtra(id)` to its job, and
// `mapUrl(id, url)` turns an address on its own localhost into one here.
function create(home, runtimes, { emit = () => {}, execPath = process.execPath, workerEnv = {}, area = "apps", jobEnv = () => ({}), wrap = null, pidsInside = () => false, hfEnv = () => path.join(home.dir("cache"), "hf-env"), jobExtra = () => ({}), mapUrl = async (_id, url) => url, endTree = () => false, onRun = () => {} } = {}) {
  const registryFile = path.join(home.root, `${area}.json`)
  const running = new Map() // id -> { child, script, url }
  let gpu = null, gpuModel = null

  // Shells still running, by app, kept on disk so Obstat can end them on its next start.
  const pidsFile = path.join(home.root, `${area}-running.json`)
  const readPids = () => { try { return JSON.parse(fs.readFileSync(pidsFile, "utf8")) } catch { return {} } }
  const savePids = (id, pids) => {
    const all = readPids()
    if (pids.length) all[id] = pids; else delete all[id]
    try { fs.writeFileSync(pidsFile, JSON.stringify(all)) } catch {}
  }
  // Ends whatever a previous Obstat left running (its worker was killed before it could).
  async function cleanup(platform = process.platform, run = execFile) {
    const all = readPids()
    let ended = 0
    for (const pids of Object.values(all)) for (const pid of [].concat(pids)) if (await killShell(pid, platform, run)) ended++
    try { fs.rmSync(pidsFile, { force: true }) } catch {}
    return ended
  }
  const read = () => { try { return JSON.parse(fs.readFileSync(registryFile, "utf8")) } catch { return {} } }
  const write = (reg) => fs.writeFileSync(registryFile, JSON.stringify(reg, null, 2))
  const folderName = (id) => id.replace(/[^a-z0-9._-]+/gi, "-")
  // ids are owner/name; anything else (like "." or "..") could point at Obstat's own folders
  const appDir = (id) => {
    if (typeof id !== "string" || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(id) || id.split("/").some((p) => /^\.+$/.test(p))) throw new Error("That isn't an app.")
    return path.join(home.dir(area), folderName(id))
  }

  // A worker or script reader, as its own Node process (Electron runs as Node), inside
  // the sandbox when there is one. Either way it talks to Obstat over IPC.
  // `port`: the app's own port, which on a Mac is the only one on this computer a test may reach
  function start(id, file, env, port) {
    const w = wrap && wrap(id, execPath, [file], port ? { PORT: String(port) } : {})
    // a sandboxed worker's errors go to the test's log: the sandbox may be what stopped it
    // and it starts in /, since Obstat's own current folder may be hidden from it
    const opts = { env, stdio: ["ignore", "ignore", w ? "pipe" : "ignore", "ipc"], ...(w ? { cwd: "/" } : {}) }
    return w ? spawn(w.file, w.args, opts) : fork(file, [], { ...opts, execPath })
  }

  // Asks lib/inspect.js, in a separate process without keys or the chat token,
  // to read scripts, so a repo's code never runs inside Obstat itself.
  function inspect(msg) {
    return new Promise((resolve, reject) => {
      const env = { ...workerEnv, PATH: process.env.PATH || "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
      const child = start(null, INSPECT, env)
      const timer = setTimeout(() => { child.kill(); reject(new Error("Reading the app's scripts took too long.")) }, 15000)
      child.once("message", (r) => { clearTimeout(timer); r && !r.error ? resolve(r.data) : reject(new Error(r?.error || "Couldn't read the app's scripts.")) })
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Couldn't read the app's scripts.")) })
      child.send(msg)
    })
  }

  async function context() {
    // Apple Silicon Macs have Apple's GPU (Metal); Pinokio scripts check for "apple"
    if (gpu === null && process.platform === "darwin") { gpu = os.arch() === "arm64" ? "apple" : "none"; gpuModel = null }
    if (gpu === null) { gpuModel = await nvidiaModel(); gpu = gpuModel ? "nvidia" : "none" }
    return { platform: process.platform, arch: os.arch(), gpu, gpu_model: gpuModel, gpus: gpu === "none" ? [] : [gpu], args: {}, input: {}, port: await freePort(), env: {} }
  }

  function list() {
    const reg = read()
    return Object.values(reg).map((a) => ({
      ...a,
      installed: a.installed && fs.existsSync(appDir(a.id)),
      running: running.has(a.id) ? { script: running.get(a.id).script, url: running.get(a.id).url, since: running.get(a.id).startedAt } : null,
      scripts: SCRIPTS.filter((s) => fs.existsSync(path.join(appDir(a.id), s))),
    }))
  }
  const get = (id) => list().find((a) => a.id === id) || null

  // what Obstat's own git needs to run (Mac and Linux); stand-in runtimes in tests have none
  const gitEnv = () => (typeof runtimes.gitEnv === "function" ? runtimes.gitEnv() : {})
  const git = (args, cwd, onLog) => new Promise((resolve, reject) => {
    onLog(`> git ${args.join(" ")}\n`)
    const env = { ...withPath(process.env, runtimes.paths()), ...gitEnv(), GIT_TERMINAL_PROMPT: "0" }
    execFile(runtimes.git(), args, { cwd, env, windowsHide: true, maxBuffer: 1 << 24 }, (err, out, errOut) => {
      if (out) onLog(out)
      if (errOut) onLog(errOut)
      err ? reject(new Error(gitMissing(err, errOut) || `git ${args[0]} failed.`)) : resolve()
    })
  })

  const headOf = (cwd) => new Promise((resolve) => execFile(runtimes.git(), ["rev-parse", "HEAD"], { cwd, env: { ...process.env, ...gitEnv() }, windowsHide: true }, (err, out) => resolve(err ? null : out.trim())))

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
    wrapJsonScripts(dir)
    const commit = await headOf(dir)
    const reg = read()
    reg[entry.id] = { ...(reg[entry.id] || {}), id: entry.id, commit, owner: entry.owner, name: entry.name, url: entry.url, description: entry.description || "", sha: entry.sha || null, reviewed: !!entry.reviewed, pins: entry.reviewed ? pinsLib.clean(entry.clones) : null, icon: typeof entry.icon === "string" ? entry.icon : reg[entry.id]?.icon || null, fetchedAt: new Date().toISOString(), installed: reg[entry.id]?.installed || false }
    write(reg)
    return dir
  }

  // What a script would run, without running anything. Running it with the
  // returned token runs exactly these steps (see approve() in script.js).
  const approvals = new Map() // token -> { id, script, ctx, approved, at }
  async function preview(id, script) {
    checkName(script)
    const file = path.join(appDir(id), script)
    if (!fs.existsSync(file)) throw new Error(`This app has no ${script}.`)
    const ctx = await context()
    const { steps, approved } = await inspect({ op: "plan", file, ctx })
    for (const [t, a] of approvals) if (a.id === id || Date.now() - a.at > 3600000) approvals.delete(t)
    const token = crypto.randomBytes(16).toString("hex")
    approvals.set(token, { id, script, ctx, approved, hash: planHash(approved, ctx), at: Date.now() })
    // what Obstat itself sets for every command (see obstatEnv), shown with the steps
    const env = Object.entries(obstatEnv(ctx.platform)).map(([k, v]) => `${k}=${v}`)
    return { steps, token, commands: commandsOf(steps), env, unsupported: flatten(steps).filter((s) => s.unsupported || s.missing).map((s) => s.method || s.uri) }
  }
  // Every step's full params as the plan filled them in (commands, env, patterns),
  // so the same steps hash the same from run to run though each run gets a new port.
  const planHash = (approved, ctx) => crypto.createHash("sha256").update(JSON.stringify(approved.params).replace(new RegExp(`(?<!\\d)${Number(ctx.port)}(?!\\d)`, "g"), "{port}")).digest("hex")
  const flatten = (steps) => steps.flatMap((s) => [s, ...(s.steps ? flatten(s.steps) : [])])

  function logFile(id, script) {
    const dir = path.join(home.dir("logs"), area, folderName(id))
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, script.replace(/\.js$/, ".txt"))
  }

  async function run(id, script, token = null, retried = false) {
    checkName(script)
    if (running.has(id)) throw new Error("This app is already busy. Stop it first.")
    let approval = token ? approvals.get(String(token)) : null
    if (token && (!approval || approval.id !== id || approval.script !== script)) throw new Error("These steps are out of date. Look at them again before running them.")
    if (approval) approvals.delete(String(token))
    // Nobody reviewed this app's code, so its steps show before they first run
    // and again whenever they change. Steps seen before run as they were planned.
    const app = read()[id]
    // (The sandbox test runs on its own say-so: people agreed to try the app there.)
    // (Apps made on this PC are the person's own; a copy of an unreviewed app isn't.)
    if (!approval && area === "apps" && app && !app.reviewed && (!app.local || app.copiedFrom)) {
      const p = await preview(id, script)
      const fresh = approvals.get(p.token)
      if (app.seen?.[script] !== fresh.hash) return { ok: false, needsApproval: true, preview: p, error: "This app's steps are new or have changed since you last looked. Look at them on the app's page first." }
      approvals.delete(p.token)
      approval = fresh
    }
    if (approval && app) { const reg = read(); reg[id] = { ...reg[id], seen: { ...(reg[id].seen || {}), [script]: approval.hash } }; write(reg) }
    const dir = appDir(id)
    if (!fs.existsSync(path.join(dir, script))) throw new Error(`This app has no ${script}.`)
    // Busy from here on, so Stop works (and a second click can't start it twice) even
    // while Obstat is still getting things ready before the first step.
    const entry = { child: null, script, url: null, tail: "", stopped: false, pids: [], shells: [], startedAt: Date.now() }
    running.set(id, entry)
    emit({ type: "state", id })
    const release = () => { if (running.get(id) === entry) running.delete(id); emit({ type: "state", id }) }
    try {
      // apps that call ffmpeg get Obstat's own copy first (install clones most apps' code, so this looks again each run until it's found)
      if (typeof runtimes.ensure === "function" && area === "apps") {
        const reg = read()
        if (reg[id] && !reg[id].ffmpeg && needsFfmpeg(dir)) { reg[id].ffmpeg = true; write(reg) }
        if (reg[id]?.ffmpeg) await runtimes.ensure("ffmpeg", (name, got, total) => emit({ type: "progress", id, name, got, total }))
      }
    } catch (err) { release(); throw err }
    if (entry.stopped) { release(); return { ok: false, error: "Stopped." } }
    const out = fs.createWriteStream(logFile(id, script), { flags: "w" })
    const ctx = approval ? approval.ctx : await context()
    const extra = jobEnv(id)
    // the bundled git's settings, so app scripts that run git (on Mac and Linux) can use it
    const env = { PORT: String(ctx.port), PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", UV_PYTHON: runtimes.python(), ...gitEnv(), ...extra }
    // inside a sandbox, only a short list of Obstat's own settings (see lib/confine.js)
    const walled = !!(wrap && wrap(id, execPath, [WORKER], {}))
    const base = walled ? sandboxEnv(process.env) : process.env
    // Gradio checks its own server once started: in a sandbox that has to be on the
    // app's own port, not Gradio's usual 7860
    if (walled) env.GRADIO_SERVER_PORT = env.PORT
    const child = start(id, WORKER, { ...base, ...workerEnv, ...extra }, ctx.port)
    entry.child = child
    child.stderr?.on("data", (d) => { const text = `(sandbox) ${String(d).slice(0, 4000)}`; out.write(text); emit({ type: "log", id, text }) })
    // Big downloads (PyTorch is 3 GB) print nothing for minutes, so say it's still going.
    let quietSince = Date.now()
    const started = Date.now()
    const still = setInterval(() => {
      if (Date.now() - quietSince < 60000) return
      quietSince = Date.now()
      const text = `Still working (${Math.round((Date.now() - started) / 60000)} min). Big downloads can take a few minutes with nothing to show.\n`
      out.write(text); emit({ type: "log", id, text })
    }, 15000)
    return new Promise((resolve) => {
      const finish = (result) => {
        clearInterval(still)
        // the worker ends its shells itself; this catches any it couldn't
        if (entry.pids.length) { for (const pid of entry.pids) killShell(pid); savePids(id, []) }
        if (process.platform === "win32" && entry.shells.length) endLeftovers(entry.shells, entry.startedAt - 2000).then((n) => { if (n) home.log?.(`${id}: ended ${n} leftover process${n > 1 ? "es" : ""}`) }).catch(() => {})
        if (running.get(id) === entry) running.delete(id)
        out.end()
        emit({ type: "state", id })
        if (result !== undefined) {
          // for Insights (lib/usage.js): one line per finished run, kept on this computer
          try { onRun({ id, script, area, at: entry.startedAt, end: Date.now(), ok: !!result.ok && !entry.stopped }) } catch {}
          resolve(result)
        }
      }
      // one message at a time, in order: an address may first need mapping (mapUrl)
      let queue = Promise.resolve()
      const inOrder = (fn) => { queue = queue.then(fn).catch((err) => home.log?.(`${id}: ${err.message}`)) }
      const local = async (url) => (url && /^https?:\/\//i.test(String(url)) ? mapUrl(id, String(url)) : url)
      // a shell the worker asks Obstat to end (see killTree in lib/worker.js): only one
      // that really is below this worker, with everything it started
      child.on("message", (m) => {
        if (m?.type !== "end" || !endTree() || !Number.isInteger(m.pid) || !descendants(child.pid).includes(m.pid)) return
        signalAll([...descendants(m.pid), m.pid], "SIGTERM")
      })
      child.on("message", (m) => inOrder(async () => {
        if (m.type === "local" && m.key === "url") m = { ...m, value: await local(m.value) }
        if (m.type === "open" || m.type === "ready") m = { ...m, url: await local(m.url) }
        // inside bubblewrap a shell's id is the sandbox's own, not one Obstat could end
        if (m.type === "pid" && pidsInside()) {}
        else if (m.type === "pid" && Number.isInteger(m.pid) && entry.pids.length < 100) { entry.pids.push(m.pid); if (entry.shells.length < 100) entry.shells.push(m.pid); savePids(id, entry.pids) }
        else if (m.type === "pid-done") { entry.pids = entry.pids.filter((p) => p !== m.pid); savePids(id, entry.pids) }
        else if (m.type === "log") { quietSince = Date.now(); out.write(m.text); entry.tail = (entry.tail + m.text).slice(-100000); emit({ type: "log", id, text: m.text }) }
        else if (m.type === "local" && m.key === "url") { entry.url = m.value; emit({ type: "state", id }) }
        else if (m.type === "open") {
          // an app that only says where it is by opening it can still be opened in Obstat
          if (!entry.url && /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/.test(String(m.url)) && script !== "install.js") { entry.url = m.url; emit({ type: "state", id }) }
          emit({ type: "open", id, url: m.url })
        }
        else if (m.type === "ready") { entry.url = m.url || entry.url; emit({ type: "state", id }); resolve({ ok: true, running: true }) }
        else if (m.type === "done") {
          if (script === "install.js") { const reg = read(); if (reg[id]) { reg[id].installed = true; reg[id].installedAt = new Date().toISOString(); write(reg) } }
          if (script === "reset.js") { const reg = read(); if (reg[id]) { reg[id].installed = false; write(reg) } }
          finish({ ok: true })
        } else if (m.type === "error") {
          const port = /(?:Port|port) (\d{2,5}) is (?:already )?in use|EADDRINUSE[^\n]*?:(\d{2,5})/.exec(entry.tail)
          const fail = () => {
            // say what to do when the app's port is taken
            if (port) m.message += `. Something is already using port ${port[1] || port[2]}. Restart your PC, or close whatever else is using it`
            out.write(`\nStopped: ${m.message}\n`); emit({ type: "log", id, text: `\nStopped: ${m.message}\n` }); finish({ ok: false, error: m.message, ...(process.platform === "win32" && needsCompiler(entry.tail) ? { needsCompiler: true } : {}) })
          }
          // a copy of this app left running from before holds the port: end it and start again, once
          if (port && process.platform === "win32" && !retried && !entry.stopped) {
            entry.checkingPort = true
            endPortOwners(port[1] || port[2], dir).then((n) => {
              if (!n || entry.stopped) return fail()
              const text = `\nA copy of this app from before was still using port ${port[1] || port[2]}. Obstat ended it and is starting the app again.\n`
              out.write(text); emit({ type: "log", id, text })
              finish()
              resolve(run(id, script, null, true))
            }, fail)
          } else fail()
        }
      }))
      child.on("exit", () => inOrder(() => { if (!entry.checkingPort) finish({ ok: true }) }))
      // a reviewed app's pins (lib/pins.js), so its scripts can't fetch code nobody reviewed
      const pins = app?.reviewed && app.pins ? app.pins : null
      child.send({ type: "run", job: { appDir: dir, script, env, paths: runtimes.paths(), python: runtimes.python(), ctx, approved: approval ? approval.approved : null, hfEnv: hfEnv(id), ...(pins ? { pins } : {}), ...jobExtra(id) } })
    })
  }

  function stop(id) {
    const r = running.get(id)
    if (!r) return false
    // still getting ready (say, downloading ffmpeg): nothing has started yet
    if (!r.child) { r.stopped = true; running.delete(id); emit({ type: "state", id }); return true }
    r.stopped = true
    // what the worker started, found now while it is still their parent (see descendants)
    const tree = endTree() && r.child.pid ? descendants(r.child.pid) : []
    try { r.child.send({ type: "stop" }) } catch {}
    signalAll(tree, "SIGTERM")
    // anything still below the worker then is ended for good (looked up again, not
    // remembered: an id from before may since belong to another program)
    setTimeout(() => { if (tree.length && r.child.exitCode === null) signalAll(descendants(r.child.pid), "SIGKILL"); try { r.child.kill() } catch {} }, 3000)
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
    wrapJsonScripts(dir)
    const to = await headOf(dir)
    const reg = read()
    reg[entry.id] = { ...reg[entry.id], commit: to, sha: entry.sha || null, reviewed: !!entry.reviewed, pins: entry.reviewed ? pinsLib.clean(entry.clones) : null, updatedAt: new Date().toISOString() }
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

  // What's changed: the newest commits in the app's folder, and in its app/
  // folder when the launcher cloned the real app there. Commit messages are the
  // repo's own text, so the window shows them as plain text.
  const SEP = "\x1f", END = "\x1e"
  const gitOut = (args, cwd) => new Promise((resolve) => execFile(runtimes.git(), args, { cwd, env: { ...process.env, ...gitEnv() }, windowsHide: true, timeout: 10000, maxBuffer: 1 << 22 }, (err, out) => resolve(err ? null : String(out))))
  const githubBase = (url) => { const m = /^(?:https:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || "").trim()); return m ? `https://github.com/${m[1]}/${m[2]}` : null }
  async function historyOf(dir, title, url) {
    if (!fs.existsSync(path.join(dir, ".git"))) return null
    const out = await gitOut(["log", "-n", "30", `--format=%H${SEP}%an${SEP}%aI${SEP}%s${END}`], dir)
    if (out === null) return null
    const commits = out.split(END).map((r) => r.trim()).filter(Boolean).map((r) => {
      const [sha, author, at, message] = r.split(SEP)
      return { sha, author: (author || "").slice(0, 80), at, message: (message || "").slice(0, 200) }
    }).filter((c) => /^[0-9a-f]{40}$/.test(c.sha))
    return { title, link: githubBase(url || (await gitOut(["remote", "get-url", "origin"], dir))), commits }
  }
  async function changes(id) {
    const dir = need(id)
    const app = read()[id] || {}
    const sections = [await historyOf(dir, app.local ? "This app" : "Launcher", app.url), await historyOf(path.join(dir, "app"), "The app itself")].filter((s) => s && s.commits.length)
    return { sections, current: app.commit || null, reviewed: app.reviewed ? app.sha : null }
  }

  // The Obstat list's pins for reviewed apps already installed at that reviewed commit
  // (installed before pins existed, or whose pins were corrected since).
  function setPins(entries) {
    const reg = read()
    let changed = false
    for (const e of entries || []) {
      const a = reg[e.id]
      if (!a || !a.reviewed || a.local || !e.reviewedSha || a.sha !== e.reviewedSha) continue
      const pins = pinsLib.clean(e.clones)
      if (JSON.stringify(pins) !== JSON.stringify(a.pins || null)) { a.pins = pins; changed = true }
    }
    if (changed) write(reg)
  }

  return { setPins, cleanup, changes, list, get, fetchApp, preview, run, stop, remove, stopAll, setAutostart, appDir, launchers, runOptions, update, reset, copy, createLocal, readScript, writeScript }
}

module.exports = { descendants, killShell, gitMissing, leftovers, endLeftovers, portOwners, endPortOwners, create, wrapJsonScripts, gpuModel, needsFfmpeg }
