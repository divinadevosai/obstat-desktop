// Test runs for repos nobody has reviewed. Three ways, best first:
//   windows  Windows Sandbox (Windows Pro): a throwaway copy of Windows that's
//            wiped when it closes. The app installs and runs in there, and only
//            its log comes back out.
//   walls    Mac and Linux: the app runs in its own test folder inside the OS's
//            sandbox (lib/confine.js: bubblewrap on Linux, Apple's sandbox on a Mac),
//            which can't see your files, Obstat's keys or other apps.
//   folder   Everywhere else: the app runs in its own test folder with its home,
//            temp and cache folders pointed inside it. That keeps a well-behaved
//            app from scattering files, but a hostile one could still reach your
//            files, so the window says so plainly.
// Cloning runs no code from the repo, so it always happens on the host.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { spawn, execFile } = require("node:child_process")
const appsLib = require("./apps")
const confine = require("./confine")

const BOX = { app: "C:\\obstat-app", src: "C:\\obstat-src", run: "C:\\obstat-run", bin: "C:\\obstat-bin" }
const BOX_PORT = 7860
const WORKER_FILES = ["worker.js", "script.js", "env.js"]

// Runs inside Windows Sandbox. Copies the app off the read-only share, runs its
// scripts with Obstat's worker, writes what happens to events.jsonl (the only
// folder the sandbox can write back to) and opens the app in the sandbox's Edge.
const RUNNER = `const { fork, spawn } = require("node:child_process")
const fs = require("node:fs"), path = require("node:path")
const run = ${JSON.stringify(BOX.run)}
const job = JSON.parse(fs.readFileSync(path.join(run, "job.json"), "utf8"))
const say = (m) => fs.appendFileSync(path.join(run, "events.jsonl"), JSON.stringify(m) + "\\n")
fs.cpSync(${JSON.stringify(BOX.src)}, job.appDir, { recursive: true })
const step = (script) => new Promise((resolve) => {
  say({ type: "script", script })
  const c = fork(path.join(run, "worker.js"), [], { env: { ...process.env, ...job.env }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
  let url = null
  c.on("message", (m) => {
    if (m.type === "log") say({ type: "log", text: m.text })
    else if (m.type === "local" && m.key === "url") url = m.value
    else if (m.type === "open") url = m.url || url
    else if (m.type === "ready") { url = m.url || url; say({ type: "ready" }); if (url) spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }); resolve(true) }
    else if (m.type === "done") { say({ type: "done", script }); resolve(true) }
    else if (m.type === "error") { say({ type: "error", message: m.message }); resolve(false) }
  })
  c.on("exit", () => resolve(true))
  c.send({ type: "run", job: { ...job, script } })
})
;(async () => { for (const s of job.scripts) if (!(await step(s))) return; say({ type: "finished" }) })()
  .catch((e) => say({ type: "error", message: e.message }))
`

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function windowsSandboxExe(platform = process.platform, env = process.env) {
  if (platform !== "win32") return null
  const exe = path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsSandbox.exe")
  return fs.existsSync(exe) ? exe : null
}

function create(home, runtimes, { emit = () => {}, execPath, workerEnv = {}, platform = process.platform, sandboxExe = windowsSandboxExe(platform), detectWalls = confine.detect, programPaths = confine.programPaths } = {}) {
  const folderName = (id) => id.replace(/[^a-z0-9._-]+/gi, "-")
  const homeDir = (id) => path.join(home.dir("sandboxes"), `${folderName(id)}.home`)
  const runDir = (id) => path.join(home.dir("sandboxes"), `${folderName(id)}.run`)

  // Folder mode: everything an app would normally write to your user folders goes into its test folder instead.
  const jobEnv = (id) => {
    const h = homeDir(id)
    const sub = (n) => { const d = path.join(h, n); fs.mkdirSync(d, { recursive: true }); return d }
    return {
      HOME: sub(""), USERPROFILE: sub(""), APPDATA: sub("AppData/Roaming"), LOCALAPPDATA: sub("AppData/Local"),
      TEMP: sub("tmp"), TMP: sub("tmp"), TMPDIR: sub("tmp"),
      XDG_CACHE_HOME: sub(".cache"), XDG_CONFIG_HOME: sub(".config"), XDG_DATA_HOME: sub(".local/share"),
      PIP_CACHE_DIR: sub(".cache/pip"), UV_CACHE_DIR: sub(".cache/uv"), HF_HOME: sub(".cache/huggingface"), npm_config_cache: sub(".npm"),
      OBSTAT_SANDBOX: walls?.kind ? "walls" : "folder",
    }
  }

  // Mac and Linux: which OS sandbox works here, found once at start (Windows uses its own)
  let walls = null
  const found = platform === "win32" ? Promise.resolve(null) : Promise.resolve().then(() => detectWalls({ platform })).then((w) => { walls = w; return w }, () => null)
  // Inside the walls a test can write only its own folders, and read Obstat's runtimes
  // and program. Everything else under your home folder, Obstat's own folder (keys,
  // chat sign-in, the agents' control token) included, is hidden. id null: reading scripts.
  const wrap = (id, file, args) => {
    if (!walls?.kind) return null
    const writable = id ? [box.appDir(id), homeDir(id)] : []
    const readable = [path.join(home.root, "bin"), ...programPaths({ execPath: execPath || process.execPath }), ...(id ? [] : [home.dir("sandboxes")])]
    return confine.wrap(walls, { writable, readable, hide: [os.homedir(), home.root] }, file, args)
  }
  const box = appsLib.create(home, runtimes, {
    emit: (e) => emit({ ...e, sandbox: true }), execPath, workerEnv, area: "sandboxes", jobEnv, wrap,
    // bubblewrap gives the test its own process ids; Apple's sandbox doesn't
    pidsInside: () => walls?.kind === "bwrap",
    // its own hf tool, not the one installed apps share: a test must not be able to change it
    hfEnv: (id) => path.join(homeDir(id), ".obstat-hf-env"),
  })
  const vms = new Map() // id -> { status, timer, offset } for Windows Sandbox runs

  const mode = () => (sandboxExe ? "windows" : walls?.kind ? "walls" : "folder")
  const info = async () => {
    await found
    return { mode: mode(), windowsSandbox: !!sandboxExe, walls: walls?.kind || null, reason: walls?.reason || null, fix: walls?.fix || null, platform }
  }

  function list() {
    return box.list().map((a) => {
      const vm = vms.get(a.id)
      return { ...a, mode: vm ? "windows" : mode() === "windows" ? "folder" : mode(), status: vm ? vm.status : a.running ? (a.running.url ? "running" : "busy") : a.installed ? "installed" : "ready" }
    })
  }
  const get = (id) => list().find((a) => a.id === id) || null

  // Clones the repo into the sandbox area and runs it there. In folder mode this
  // resolves when the app is running (or the install ends); in Windows Sandbox
  // mode, as soon as the sandbox is opening.
  async function test(entry, onLog = () => {}) {
    if (vms.has(entry.id) || box.get(entry.id)?.running) throw new Error("This test is already running.")
    await found
    if (mode() === "windows" && vms.size) throw new Error("Windows runs one sandbox at a time. Delete the other test first.")
    await box.fetchApp(entry, onLog)
    const scripts = box.get(entry.id).scripts.filter((s) => s === "install.js" || s === "start.js")
    if (!scripts.length) throw new Error("This app has no install or start script to test.")
    if (mode() === "windows") return openWindowsSandbox(entry.id, scripts)
    const say = (text) => emit({ type: "log", id: entry.id, text, sandbox: true })
    say(walls?.kind === "bwrap" ? "Testing in a sandbox (bubblewrap). The app can't see your files, Obstat's keys or other apps; it can only change its own test folder.\n"
      : walls?.kind === "seatbelt" ? "Testing in Apple's sandbox. The app can't see your files, Obstat's keys or other apps; it can only change its own test folder.\n"
      : "Testing in a separate folder. Its home, temp and cache folders point inside the test folder.\n")
    if (scripts.includes("install.js")) {
      const r = await box.run(entry.id, "install.js")
      if (!r.ok || !scripts.includes("start.js")) return r
    }
    return box.run(entry.id, "start.js")
  }

  const toBox = (p) => {
    const bin = path.join(home.root, "bin")
    return p && p.startsWith(bin) ? BOX.bin + p.slice(bin.length).replace(/\//g, "\\") : p
  }

  async function openWindowsSandbox(id, scripts) {
    const run = runDir(id)
    await fsp.rm(run, { recursive: true, force: true })
    fs.mkdirSync(run, { recursive: true })
    for (const f of WORKER_FILES) fs.copyFileSync(path.join(__dirname, f), path.join(run, f))
    const python = toBox(runtimes.python())
    const job = {
      appDir: BOX.app, scripts, python, paths: runtimes.paths().map(toBox),
      env: { PORT: String(BOX_PORT), PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", UV_PYTHON: python, OBSTAT_SANDBOX: "windows" },
      // Windows Sandbox has no CUDA, so apps pick their CPU builds
      ctx: { platform: "win32", arch: "x64", gpu: "none", gpu_model: null, gpus: [], args: {}, input: {}, port: BOX_PORT, env: {} },
    }
    fs.writeFileSync(path.join(run, "job.json"), JSON.stringify(job, null, 2))
    fs.writeFileSync(path.join(run, "runner.js"), RUNNER)
    fs.writeFileSync(path.join(run, "events.jsonl"), "")
    fs.writeFileSync(path.join(run, "run.cmd"), `@echo off\r\ntitle Obstat test run\r\n"${toBox(runtimes.exe("node"))}" "${BOX.run}\\runner.js"\r\n`)
    const map = (host, inBox, readOnly) => `    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${inBox}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`
    const wsb = path.join(run, "test.wsb")
    fs.writeFileSync(wsb, [
      "<Configuration>",
      "  <Networking>Enable</Networking>",
      "  <ClipboardRedirection>Disable</ClipboardRedirection>",
      "  <PrinterRedirection>Disable</PrinterRedirection>",
      "  <MappedFolders>",
      map(box.appDir(id), BOX.src, true),
      map(path.join(home.root, "bin"), BOX.bin, true),
      map(run, BOX.run, false),
      "  </MappedFolders>",
      `  <LogonCommand><Command>${BOX.run}\\run.cmd</Command></LogonCommand>`,
      "</Configuration>", ""].join("\n"))
    const vm = { status: "opening", offset: 0, timer: null }
    vms.set(id, vm)
    const child = spawn(sandboxExe, [wsb], { detached: true, stdio: "ignore" })
    child.on("error", (e) => { emit({ type: "log", id, text: `\nWindows Sandbox didn't open: ${e.message}\n`, sandbox: true }); vm.status = "failed"; emit({ type: "state", id, sandbox: true }) })
    child.unref()
    fs.rmSync(path.join(home.dir("logs"), "sandboxes", folderName(id), "windows.txt"), { force: true })
    say(id, "Opening Windows Sandbox. The app installs inside it and opens there when it's ready. Only this log comes back out.\n")
    emit({ type: "state", id, sandbox: true })
    vm.timer = setInterval(() => tail(id, vm), 1000)
    return { ok: true, windows: true }
  }

  // Windows Sandbox runs keep their log at logs/sandboxes/<app>/windows.txt
  const say = (id, text) => {
    const dir = path.join(home.dir("logs"), "sandboxes", folderName(id))
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "windows.txt"), text)
    emit({ type: "log", id, text, sandbox: true })
  }

  // events.jsonl is written by code we don't trust, so only log text and a few
  // status words come out of it. Nothing in it can open links or run anything here.
  function tail(id, vm) {
    const file = path.join(runDir(id), "events.jsonl")
    let st
    try { st = fs.lstatSync(file) } catch { return }
    if (!st.isFile() || st.size <= vm.offset) return
    const len = Math.min(st.size - vm.offset, 1 << 20)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, "r")
    try { fs.readSync(fd, buf, 0, len, vm.offset) } finally { fs.closeSync(fd) }
    const text = buf.toString("utf8")
    const end = text.lastIndexOf("\n")
    if (end < 0) return
    vm.offset += Buffer.byteLength(text.slice(0, end + 1))
    const before = vm.status
    for (const line of text.slice(0, end).split("\n")) {
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.type === "log" && typeof m.text === "string") say(id, m.text.slice(0, 20000))
      else if (m.type === "script") vm.status = m.script === "start.js" ? "starting" : "installing"
      else if (m.type === "ready") vm.status = "running"
      else if (m.type === "finished") vm.status = vm.status === "running" ? "running" : "finished"
      else if (m.type === "error") { vm.status = "failed"; say(id, `\nStopped: ${String(m.message).slice(0, 500)}\n`) }
    }
    if (vm.status !== before) emit({ type: "state", id, sandbox: true })
  }

  function closeWindowsSandbox(id) {
    const vm = vms.get(id)
    if (!vm) return
    clearInterval(vm.timer)
    vms.delete(id)
    // the process names differ between Windows versions
    for (const name of ["WindowsSandboxRemoteSession.exe", "WindowsSandboxServer.exe", "WindowsSandboxClient.exe", "WindowsSandbox.exe"]) {
      execFile("taskkill", ["/IM", name, "/F"], { windowsHide: true }, () => {})
    }
  }

  const stop = (id) => { closeWindowsSandbox(id); return box.stop(id) }

  // Delete: the test folder, its home folder and the Windows Sandbox all go.
  async function remove(id) {
    closeWindowsSandbox(id)
    await new Promise((r) => setTimeout(r, platform === "win32" ? 1500 : 0))
    await box.remove(id)
    await fsp.rm(homeDir(id), { recursive: true, force: true, maxRetries: 3 })
    await fsp.rm(runDir(id), { recursive: true, force: true, maxRetries: 3 })
  }

  // Keep installs the exact commit that was tested, fresh from its source;
  // nothing is copied out of the test.
  const testedCommit = (id) => box.list().find((x) => x.id === id)?.commit || null

  const stopAll = () => { for (const id of [...vms.keys()]) closeWindowsSandbox(id); box.stopAll() }

  return { info, mode, list, get, test, stop, remove, testedCommit, stopAll, appDir: box.appDir }
}

module.exports = { create, windowsSandboxExe }
