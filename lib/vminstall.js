// Windows: reviewed apps' installs (install.js, update.js, reset.js) inside Windows
// Sandbox, a throwaway copy of Windows that's wiped when it closes. See lib/walls.js.
//
// Obstat starts this file as an ordinary worker would be started (same IPC
// messages), so lib/apps.js runs a walled install like any other. This "bridge"
// runs outside, on this computer, and:
//   - writes the job, Obstat's worker and a small runner into a run folder
//   - opens Windows Sandbox with only these folders shared, each at the same path
//     inside as here, so what the install builds (venvs, node_modules, launchers
//     with absolute paths) works when the app starts here:
//       the app's own folder and its install home        read and write
//       the package and model caches every app shares     read and write
//       Obstat's runtimes (Python, Node, uv, git)          read only
//       the run folder                                     read and write
//   - passes on what the install prints, and whether it finished, from events.jsonl
//     in the run folder (written by code nobody reviewed: only text and a few status
//     words are taken from it)
//   - closes the sandbox when the install ends, is stopped, or Obstat goes away.
// Inside, the install can't see your files, Obstat's keys or other apps, or this
// computer's localhost: it's another Windows, on its own network.
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { spawn, execFile } = require("node:child_process")

const BOX_RUN = "C:\\obstat-run"
const WORKER_FILES = ["worker.js", "script.js", "env.js", "pins.js", "npmsafe.js"]
const SANDBOX_PROCESSES = ["WindowsSandboxRemoteSession.exe", "WindowsSandboxServer.exe", "WindowsSandboxClient.exe", "WindowsSandbox.exe"]

// Runs inside the sandbox with Obstat's Node, from the run folder.
const RUNNER = `const { fork, execFile } = require("node:child_process")
const fs = require("node:fs"), path = require("node:path")
const run = __dirname
const job = JSON.parse(fs.readFileSync(path.join(run, "job.json"), "utf8"))
const say = (m) => fs.appendFileSync(path.join(run, "events.jsonl"), JSON.stringify(m) + "\\n")
let ended = false
const end = (m) => {
  if (ended) return
  ended = true
  say(m)
  // closing this copy of Windows ends everything the install started
  if (!job.stay) setTimeout(() => execFile("shutdown.exe", ["/s", "/t", "0"], () => process.exit(0)), 1500)
  else setTimeout(() => process.exit(0), 200)
}
say({ type: "started" })
const c = fork(path.join(run, "worker.js"), [], { env: { ...process.env, ...job.env }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
c.on("message", (m) => {
  if (m.type === "log") say({ type: "log", text: String(m.text) })
  else if (m.type === "done") end({ type: "done" })
  else if (m.type === "error") end({ type: "error", message: String(m.message) })
})
c.on("exit", (code) => end({ type: "error", message: "The install stopped (exit code " + code + ")." }))
c.send({ type: "run", job })
`

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// The sandbox's configuration: networking on, nothing of this computer's shared but
// the folders named, no clipboard, printers, microphone or camera.
function wsb(maps, command) {
  const map = (m) => `    <MappedFolder><HostFolder>${xml(m.host)}</HostFolder><SandboxFolder>${xml(m.box || m.host)}</SandboxFolder><ReadOnly>${m.readOnly ? "true" : "false"}</ReadOnly></MappedFolder>`
  return [
    "<Configuration>",
    "  <Networking>Enable</Networking>",
    "  <vGPU>Disable</vGPU>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <MappedFolders>",
    ...maps.map(map),
    "  </MappedFolders>",
    `  <LogonCommand><Command>${xml(command)}</Command></LogonCommand>`,
    "</Configuration>", ""].join("\r\n")
}

// Folders can be shared at the same path inside only on the sandbox's one drive, C:.
const onSystemDrive = (p) => /^c:\\/i.test(String(p))

// Is a Windows Sandbox already open (a sandbox test, or another install)? Windows
// runs one at a time.
function sandboxOpen(run = execFile) {
  return new Promise((resolve) => run("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => {
    if (err) return resolve(false)
    const names = new Set(String(out).split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean).map((n) => n.toLowerCase()))
    resolve(SANDBOX_PROCESSES.some((n) => names.has(n.toLowerCase())))
  }))
}

function closeSandbox(run = execFile) {
  for (const name of SANDBOX_PROCESSES) run("taskkill", ["/IM", name, "/F"], { windowsHide: true }, () => {})
}

// ---------- the bridge, run by Obstat as a worker ----------

// cfg: { runDir, sandboxExe, node, maps: [{ host, readOnly }], workerDir, hostEnv, local? }
// local: start the runner here instead of in a sandbox (the tests, on any system)
function bridge(cfg, { send = (m) => process.send(m), onJob = (fn) => process.on("message", fn), exit = (c) => process.exit(c), checkOpen = sandboxOpen, close = closeSandbox, startMs = 5 * 60000 } = {}) {
  let done = false, child = null, timer = null, offset = 0, started = false
  const finish = (m) => {
    if (done) return
    done = true
    clearInterval(timer)
    if (!cfg.local) close()
    else if (child && child.exitCode === null) child.kill()
    send(m)
    setTimeout(() => exit(0), 200)
  }
  const log = (text) => send({ type: "log", text })

  function tail() {
    const file = path.join(cfg.runDir, "events.jsonl")
    let st
    try { st = fs.lstatSync(file) } catch { return }
    if (!st.isFile() || st.size <= offset) return
    const len = Math.min(st.size - offset, 1 << 20)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, "r")
    try { fs.readSync(fd, buf, 0, len, offset) } finally { fs.closeSync(fd) }
    const text = buf.toString("utf8")
    const nl = text.lastIndexOf("\n")
    if (nl < 0) return
    offset += Buffer.byteLength(text.slice(0, nl + 1))
    for (const line of text.slice(0, nl).split("\n")) {
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (!m || typeof m !== "object") continue
      if (m.type === "started") { started = true; log("(Windows Sandbox is open; the install runs inside it.)\n") }
      else if (m.type === "log" && typeof m.text === "string") log(m.text.slice(0, 20000))
      else if (m.type === "done") return finish({ type: "done" })
      else if (m.type === "error") return finish({ type: "error", message: String(m.message).slice(0, 500) })
    }
  }

  async function start(job) {
    const run = cfg.runDir
    fs.rmSync(run, { recursive: true, force: true })
    fs.mkdirSync(run, { recursive: true })
    // read and written, not copied: inside the packaged app these are in app.asar
    for (const f of WORKER_FILES) fs.writeFileSync(path.join(run, f), fs.readFileSync(path.join(cfg.workerDir, f)))
    fs.writeFileSync(path.join(run, "runner.js"), RUNNER)
    fs.writeFileSync(path.join(run, "events.jsonl"), "")
    fs.writeFileSync(path.join(run, "job.json"), JSON.stringify({ ...job, stay: !!cfg.local }))
    const boxRun = cfg.local ? run : BOX_RUN
    fs.writeFileSync(path.join(run, "run.cmd"), `@echo off\r\ntitle Obstat install\r\n"${cfg.node}" "${boxRun}\\runner.js"\r\n`)
    if (cfg.local) {
      child = spawn(cfg.node, [path.join(run, "runner.js")], { stdio: "ignore", windowsHide: true })
    } else {
      if (await checkOpen()) return finish({ type: "error", message: "Windows Sandbox is already open (a sandbox test, or another install). Windows runs one at a time: close it, then install again." })
      const file = path.join(run, "install.wsb")
      fs.writeFileSync(file, wsb([...cfg.maps, { host: run, box: BOX_RUN, readOnly: false }], `${BOX_RUN}\\run.cmd`))
      log("Opening Windows Sandbox for this install. Inside it the install can't see your files, Obstat's keys or other apps. It takes a moment to start, and closes when the install ends.\n")
      child = spawn(cfg.sandboxExe, [file], { detached: true, stdio: "ignore", ...(cfg.hostEnv ? { env: cfg.hostEnv } : {}) })
      child.on("error", (e) => finish({ type: "error", message: `Windows Sandbox didn't open: ${e.message}` }))
      child.unref()
    }
    const opened = Date.now()
    timer = setInterval(() => {
      tail()
      if (!done && !started && Date.now() - opened > startMs) finish({ type: "error", message: "Windows Sandbox didn't start the install in time. Check that Windows Sandbox opens from the Start menu, then try again." })
    }, 500)
  }

  onJob((m) => {
    if (m?.type === "run" && m.job && !child && !done) start(m.job).catch((e) => finish({ type: "error", message: e.message }))
    else if (m?.type === "stop") finish({ type: "error", message: "Stopped." })
  })
  // Obstat went away or stopped the install: the sandbox goes too
  process.on?.("disconnect", () => { if (!done) { done = true; clearInterval(timer); if (!cfg.local) close(); else child?.kill(); exit(0) } })
  return { finish }
}

const encode = (cfg) => Buffer.from(JSON.stringify(cfg)).toString("base64")
const decode = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"))

if (require.main === module) bridge(decode(process.argv[2]))

module.exports = { bridge, wsb, encode, decode, sandboxOpen, closeSandbox, onSystemDrive, RUNNER, BOX_RUN, WORKER_FILES, BRIDGE: __filename }
