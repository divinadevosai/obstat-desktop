// What every Obstat install relies on, checked on a real machine (CI runs it on
// Windows, Mac and Linux):
//   - each runtime Obstat bundles downloads, passes its checksum and actually runs
//     (on Apple silicon an unsigned program wouldn't), and git clones with its settings
//   - on Mac and Linux, the OS sandbox for tests is there and works
//   - the community chat and news load from obstat.app through Obstat's own client
//
//   node e2e/smoke.js
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFile } = require("node:child_process")
const homeLib = require("../lib/home")
const runtimesLib = require("../lib/runtimes")
const confine = require("../lib/confine")
const api = require("../lib/api")
const { withPath } = require("../lib/env")

const problems = []
const say = (...a) => console.log(...a)
const fail = (m) => { problems.push(m); say(`FAIL: ${m}`) }
const run = (file, args, env) => new Promise((resolve) => execFile(file, args, { env, timeout: 300000, maxBuffer: 1 << 24 }, (err, out, stderr) => resolve(err ? { error: String(stderr || err.message).trim().slice(0, 400) } : { out: String(out || stderr).trim() })))

async function runtimes() {
  const home = homeLib.create(process.env.OBSTAT_E2E_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "obstat-smoke-")))
  home.ensure()
  const r = runtimesLib.create(home, { log: (l) => say(l) })
  await r.ensureAll(() => {}, ["ffmpeg"])
  const env = { ...withPath(process.env, r.paths()), ...r.gitEnv(), GIT_TERMINAL_PROMPT: "0" }
  const status = r.status()
  const checks = [
    ["python", r.python(), ["-c", "import ssl, sqlite3, venv; print('python', __import__('sys').version.split()[0])"]],
    ["node", r.exe("node"), ["-e", "console.log('node', process.version)"]],
    ["uv", r.exe("uv"), ["--version"]],
    ["git", r.git(), ["--version"]],
    ["ffmpeg", r.exe("ffmpeg"), ["-hide_banner", "-version"]],
  ]
  for (const [name, file, args] of checks) {
    if (!status[name].needed && name !== "ffmpeg") { say(`${name}: uses the system's own here`); continue }
    if (!file) { fail(`${name}: Obstat has no ${name} for ${process.platform}-${os.arch()}`); continue }
    const res = await run(file, args, env)
    if (res.error) fail(`${name} didn't run: ${res.error}`)
    else say(`${name}: ${res.out.split("\n")[0]}`)
  }
  if (r.exe("ffmpeg")) {
    const probe = await run(path.join(path.dirname(r.exe("ffmpeg")), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"), ["-hide_banner", "-version"], env)
    if (probe.error) fail(`ffprobe didn't run: ${probe.error}`)
    else say(`ffprobe: ${probe.out.split("\n")[0]}`)
  }
  // a real clone over HTTPS, the way Obstat downloads apps
  const dest = path.join(home.root, "clone-test")
  const clone = await run(r.git(), ["clone", "--depth", "1", "https://github.com/lincolnloop/python-qrcode", dest], env)
  if (clone.error || !fs.existsSync(path.join(dest, ".git"))) fail(`git couldn't clone: ${clone.error}`)
  else say("git: cloned over HTTPS")
  // a venv and a package install with uv, as the generated install steps do
  const venv = path.join(home.root, "venv-test")
  const mk = await run(r.python(), ["-m", "venv", venv], env)
  const pip = !mk.error && await run(r.exe("uv") || "uv", ["pip", "install", "--python", path.join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), "qrcode"], env)
  if (mk.error || pip.error) fail(`couldn't make a venv and install a package: ${mk.error || pip.error}`)
  else say("uv: installed a package into a venv")
}

async function sandbox() {
  if (process.platform === "win32") return say("sandbox: Windows uses Windows Sandbox (checked by the Windows app tests)")
  const w = await confine.detect()
  if (!w.kind) return fail(`no OS sandbox: ${w.reason}`)
  say(`sandbox: ${w.kind} works`)
  // the worker runs on Obstat's Electron (as Node), so that has to start inside it too
  let electron
  try { electron = require("electron") } catch { return say("sandbox: no Electron here to check") }
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".obstat-smoke-"))
  try {
    const wrapped = confine.wrap(w, { writable: [dir], readable: confine.programPaths({ execPath: electron, resourcesPath: null, libDir: __dirname }), hide: [os.homedir()], ownNetwork: w.kind === "bwrap" }, electron, ["-e", "require('node:fs').writeFileSync(process.argv[1] + '/ok', 'yes'); console.log('electron ok')", dir])
    const res = await run(wrapped.file, wrapped.args, { ...confine.sandboxEnv(process.env), ELECTRON_RUN_AS_NODE: "1", HOME: dir })
    if (res.error) fail(`Electron didn't start inside the sandbox: ${res.error}`)
    else if (!fs.existsSync(path.join(dir, "ok"))) fail(`Electron ran inside the sandbox but couldn't write its folder: ${res.out}`)
    else say(`sandbox: Electron runs inside it (${res.out})`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function chat() {
  try {
    const channels = await api.channels(fetch)
    const names = Object.keys(channels)
    if (!names.length) return fail("chat: no channels")
    const messages = await api.readChat(names[0], null, fetch)
    if (!Array.isArray(messages)) return fail("chat: reading a channel didn't return messages")
    say(`chat: ${names.length} channels, ${messages.length} messages in ${names[0]}`)
    const news = await api.news(fetch)
    say(`news: ${Array.isArray(news) ? news.length : "?"} items`)
    await api.sendChat(names[0], "hi", null, fetch).then(() => fail("chat: sending without signing in was allowed"), (e) => say(`chat: sending without signing in is refused ("${e.message}")`))
  } catch (err) {
    fail(`chat: ${err.message}`)
  }
}

;(async () => {
  for (const [name, check] of [["runtimes", runtimes], ["sandbox", sandbox], ["chat", chat]]) {
    say(`--- ${name}`)
    try { await check() } catch (err) { fail(`${name}: ${err.message}`) }
  }
  say(problems.length ? `FAILED: ${problems.join("; ")}` : "PASS")
  process.exit(problems.length ? 1 : 0)
})()
