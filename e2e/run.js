// End-to-end check of one app, through Obstat's own code: download it at its
// reviewed commit (lib/apps.js fetchApp), install and start it from the steps
// Obstat shows (preview, then run with that plan's token, in lib/worker.js), then
// open its address in Obstat's viewer (lib/viewer.js) and check the page renders.
// With "buildui:" it installs a command-line app, runs Build a UI (lib/buildui.js)
// and uses the generated page to run the command.
//
//   npx electron e2e/run.js divinadevosai/plazai
//   npx electron e2e/run.js buildui:lincolnloop/python-qrcode
//   npx electron e2e/run.js sandbox:divinadevosai/plazai
//
// With "sandbox:" the app is tested the way an unreviewed repo is (lib/sandbox.js):
// on Mac and Linux inside the OS sandbox (lib/confine.js), which the check requires.
//
// Under plain Node (no Electron) the page check is an HTTP request instead.
// Logs and a screenshot go to e2e-out/<app>/. Exits non-zero when the app fails.
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const { execFile } = require("node:child_process")

const electron = process.versions.electron ? require("electron") : null
const ROOT = path.join(__dirname, "..")
const homeLib = require("../lib/home")
const runtimesLib = require("../lib/runtimes")
const appsLib = require("../lib/apps")
const sandboxLib = require("../lib/sandbox")
const wallsLib = require("../lib/walls")
const buildUi = require("../lib/buildui")
const api = require("../lib/api")

const LIST = JSON.parse(fs.readFileSync(path.join(__dirname, "apps.json"), "utf8"))
const PICKS = JSON.parse(fs.readFileSync(path.join(__dirname, "picks.json"), "utf8"))

// (Electron may put its own switches before the script)
const arg = process.argv.slice(1).find((a) => !a.startsWith("-") && path.resolve(a) !== __filename && path.resolve(a) !== path.dirname(__filename))
if (!arg) { console.error("Name an app from e2e/apps.json, or buildui:<id>."); process.exit(2) }
const isBuild = arg.startsWith("buildui:")
const isSandbox = arg.startsWith("sandbox:")
const want = arg.replace(/^(buildui|sandbox):/, "")
const spec = (isBuild ? LIST.buildui : LIST.apps).find((a) => a.id.toLowerCase() === want.toLowerCase())
if (!spec) { console.error(`${want} isn't in e2e/apps.json.`); process.exit(2) }

const slug = want.replace(/[^\w.-]+/g, "_")
const OUT = path.join(ROOT, "e2e-out", slug)
fs.mkdirSync(OUT, { recursive: true })
const HOME = process.env.OBSTAT_E2E_HOME || path.join(os.homedir(), "obstat-e2e")

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`
// everything also goes to run.log, in case the console doesn't show a GUI app's output
const runLog = fs.openSync(path.join(OUT, "run.log"), "w")
const out = (text) => { process.stdout.write(text); try { fs.writeSync(runLog, text) } catch {} }
const say = (...a) => out(`${stamp()} ${a.join(" ")}\n`)
const problems = []
const fail = (msg) => { problems.push(msg); say(`FAIL: ${msg}`) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Every browser window running on this PC, so the test can tell if the app opened one.
// Browsers Windows itself starts (Firefox's scheduled background updater, run by the
// Task Scheduler's svchost) aren't the app's doing, and don't count.
const BROWSERS = /^(msedge|chrome|firefox|brave|iexplore|opera)\.exe$/i
const SYSTEM = /^(svchost|taskhostw|services|wininit|sihost)\.exe$/i
const PROCESSES = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"
function browsers() {
  if (process.platform !== "win32") return Promise.resolve(new Map())
  return new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESSES], { windowsHide: true, maxBuffer: 1 << 25 }, (err, out) => {
    const found = new Map()
    if (err) return resolve(found)
    const rows = String(out).split(/\r?\n/).map((l) => l.trim().split("|")).filter((r) => r.length >= 3)
    const names = new Map(rows.map(([name, pid]) => [pid, name]))
    for (const [name, pid, parent, ...cmd] of rows) {
      const line = cmd.join("|")
      if (!BROWSERS.test(name) || /--backgroundtask|--type=|-contentproc|--headless/i.test(line)) continue
      if (SYSTEM.test(names.get(parent) || "")) continue
      found.set(`${name}:${pid}`, `${name} ${line}`.slice(0, 300))
    }
    resolve(found)
  }))
}

const listening = (url) => new Promise((resolve) => {
  const u = new URL(url)
  const s = net.connect({ host: u.hostname === "0.0.0.0" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 80, autoSelectFamily: true })
  const end = (ok) => { s.destroy(); resolve(ok) }
  s.setTimeout(1000, () => end(false)); s.once("connect", () => end(true)); s.once("error", () => end(false))
})

async function main() {
  const home = homeLib.create(HOME)
  home.ensure()
  const runtimes = runtimesLib.create(home, { log: (l) => say(l) })
  const events = []
  let echo = true
  // installs inside the OS sandbox on Mac and Linux, as Obstat runs them (lib/walls.js)
  const walls = wallsLib.create(home, { appDir: (id) => apps.appDir(id), execPath: process.execPath })
  const w = await walls.info()
  if (process.platform !== "win32") {
    if (!w.kind) fail(`installs aren't walled here: ${w.reason || "no OS sandbox"}`)
    else say(`installs run inside ${w.kind === "bwrap" ? "bubblewrap" : "Apple's sandbox"}`)
  }
  const apps = appsLib.create(home, runtimes, {
    wrap: (id, file, args, env, script) => walls.wrap(id, file, args, env, script),
    jobEnv: (id, script) => walls.env(id, script) || {},
    jobExtra: (id, script) => walls.jobExtra(id, script),
    hfEnv: (id, script) => walls.hfEnv(id, script) || path.join(home.dir("cache"), "hf-env"),
    onRun: (r) => walls.done(r.id),
    emit: (e) => {
      events.push(e)
      if (e.type === "log" && echo) out(e.text)
      else if (e.type === "open") say(`the app asked to open ${e.url}`)
    },
    execPath: process.execPath,
    // Electron runs the worker as plain Node, as in main.js
    workerEnv: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  })
  await apps.cleanup()

  const [owner, name] = spec.id.split("/")
  const id = spec.id.toLowerCase()
  const pick = PICKS.find((p) => p.id.toLowerCase() === id)
  if (!isBuild && !pick) throw new Error(`${spec.id} isn't in e2e/picks.json; run e2e/sync-picks.mjs.`)
  const scripts = isBuild
    ? { "install.js": `module.exports = {\n  run: [\n    { method: "shell.run", params: { venv: "env", message: [${JSON.stringify(spec.install)}] } },\n  ],\n}\n` }
    : pick.scripts
  const entry = { id, owner, name, url: `https://github.com/${spec.id}`, sha: isBuild ? spec.sha : pick.sha, reviewed: !isBuild, description: spec.about || "", ...(scripts ? { scripts } : {}) }

  if (isSandbox) return sandboxRun(home, runtimes, entry, events, (v) => { echo = v })

  // a fresh copy every time
  if (fs.existsSync(apps.appDir(id))) await apps.remove(id)
  say(`downloading ${spec.id} at ${entry.sha}`)
  await apps.fetchApp(entry, out)
  const dir = apps.appDir(id)

  // steps run only as the plan showed them, as when someone clicks Run install
  async function runPlanned(script) {
    const p = await apps.preview(id, script)
    say(`${script}: ${p.commands.length} commands${p.unsupported.length ? `, unsupported: ${p.unsupported.join(", ")}` : ""}`)
    if (!p.env.some((e) => e.startsWith("BROWSER="))) fail("the plan doesn't show the settings Obstat adds")
    const r = await apps.run(id, script, p.token)
    if (!r.ok) throw new Error(`${script} stopped: ${r.error}`)
    return r
  }

  await runPlanned("install.js")
  say("installed")

  let script = "start.js"
  if (isBuild) {
    const found = buildUi.detect(dir)
    if (!found) throw new Error("Build a UI found no command to run.")
    say(`Build a UI found: ${found.command.join(" ")}${found.venv ? ` (in ${found.venv})` : ""}`)
    buildUi.build(dir, { name, description: spec.about })
    const options = await apps.runOptions(id)
    if (!options.some((o) => o.script === buildUi.LAUNCHER)) fail(`the app's Run menu doesn't offer ${buildUi.LAUNCHER}`)
    script = buildUi.LAUNCHER
  }

  const before = await browsers()
  const started = await runPlanned(script)
  if (!started.running) throw new Error(`${script} finished instead of staying up.`)
  const url = apps.get(id)?.running?.url || events.filter((e) => e.type === "open").map((e) => e.url).pop()
  if (!url) throw new Error("The app is running but never said its address.")
  if (!api.isLocalUrl(url)) fail(`its address isn't on this PC: ${url}`)
  say(`running at ${url}`)
  echo = false

  const page = electron ? await viewPage(id, url) : await fetchPage(url)
  if (isBuild && electron) await useBuiltUi(page)

  // let the app settle, then see whether it opened a browser of its own
  await wait(5000)
  const opened = [...(await browsers())].filter(([p]) => !before.has(p)).map(([, line]) => line)
  if (opened.length) fail(`a browser started while the app ran (${opened.join("; ")}): the app opened the system browser instead of staying in Obstat`)
  const outside = events.filter((e) => e.type === "open" && !api.isLocalUrl(e.url))
  if (outside.length) fail(`the app asked to open pages on other sites: ${outside.map((e) => e.url).join(", ")}`)

  // Stop must leave nothing behind holding its port
  apps.stop(id)
  const until = Date.now() + 20000
  while (Date.now() < until && (apps.get(id)?.running || (await listening(url)))) await wait(500)
  if (await listening(url)) fail(`something still answers at ${url} after Stop`)
  else say("stopped, and nothing answers at its address any more")

  // A copy of the app an older Obstat left running holds the port: Obstat ends it and starts again
  if (spec.leftover && process.platform === "win32") {
    const port = Number(new URL(url).port)
    const holder = path.join(dir, "obstat-e2e-holder.cjs")
    fs.writeFileSync(holder, `require("node:http").createServer((q, r) => r.end("old copy")).listen(${port}, "127.0.0.1")\n`)
    // its command line names a file in the app's folder, as a real leftover's does
    const holderLog = fs.openSync(path.join(OUT, "holder.log"), "w")
    const old = require("node:child_process").spawn(process.execPath, [holder], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: ["ignore", holderLog, holderLog], windowsHide: true })
    old.on("error", (e) => say(`stand-in old copy: ${e.message}`))
    old.on("exit", (code) => say(`stand-in old copy exited (${code}): ${fs.readFileSync(path.join(OUT, "holder.log"), "utf8").slice(-500)}`))
    old.unref()
    for (let i = 0; i < 30 && !(await listening(url)); i++) await wait(500)
    if (!(await listening(url))) { fail(`the stand-in old copy didn't start on port ${port}`); return page }
    const again = await runPlanned(script)
    if (!again.running) fail("the app didn't start again while an old copy held its port")
    else if (!events.some((e) => e.type === "log" && /A copy of this app from before was still using port/.test(e.text))) fail("Obstat didn't say it ended the old copy")
    else say("an old copy holding the port was ended and the app started again")
    apps.stop(id)
    const end = Date.now() + 20000
    while (Date.now() < end && (apps.get(id)?.running || (await listening(url)))) await wait(500)
  }
  return page
}

// A sandbox test, as the Sandbox page runs one: cloned, installed and started inside
// the sandbox, then opened in the viewer, then deleted.
async function sandboxRun(home, runtimes, entry, events, setEcho) {
  const sb = sandboxLib.create(home, runtimes, {
    emit: (e) => { events.push(e); if (e.type === "log") out(e.text) },
    execPath: process.execPath,
    workerEnv: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  })
  const info = await sb.info()
  say(`sandbox: ${info.mode}${info.walls ? ` (${info.walls})` : ""}${info.reason ? `, ${info.reason}` : ""}`)
  if (process.platform !== "win32" && info.mode !== "walls") throw new Error(`no OS sandbox on this ${process.platform} machine: ${info.reason}`)
  if (sb.get(entry.id)) await sb.remove(entry.id)
  const { sha, ...unpinned } = entry // a test clones the repo's current code, as for any pasted link
  const r = await sb.test({ ...unpinned, sha, reviewed: false }, out)
  if (!r.running) throw new Error(`the sandbox test ${r.ok ? "finished" : `stopped: ${r.error}`} instead of running`)
  const test = sb.get(entry.id)
  if (test.mode !== "walls" && process.platform !== "win32") fail(`the test ran in ${test.mode}, not the OS sandbox`)
  const url = test.running.url
  if (!url) throw new Error("The test is running but never said its address.")
  say(`running in the sandbox at ${url}`)
  setEcho(false)
  const page = electron ? await viewPage(entry.id, url) : await fetchPage(url)
  await sb.remove(entry.id)
  const until = Date.now() + 20000
  while (Date.now() < until && (await listening(url))) await wait(500)
  if (await listening(url)) fail(`something still answers at ${url} after the test was deleted`)
  else say("deleted, and nothing answers at its address any more")
  return page
}

// Under Electron: the viewer Obstat uses, in a real window.
async function viewPage(id, url) {
  const { BrowserWindow, webContents } = electron
  const win = new BrowserWindow({ width: 1280, height: 860, show: true, title: `Obstat e2e: ${spec.id}`, webPreferences: { sandbox: true, contextIsolation: true } })
  await win.loadURL("about:blank")
  const states = []
  const pageErrors = []
  const viewer = require("../lib/viewer").create(() => win, {
    log: (l) => say(l),
    emit: (e) => {
      if (e.type === "view") { states.push(e); if (e.state !== "title") say(`view: ${e.state}${e.message ? ` (${e.message})` : ""}${e.url ? ` ${e.url}` : ""}`) }
      if (e.type === "log") { pageErrors.push(e.text.trim()); out(e.text) }
    },
  })
  const [w, h] = win.getContentSize()
  await viewer.show(id, url, { x: 0, y: 0, width: w, height: h })
  const until = Date.now() + 10 * 60_000
  while (Date.now() < until && !states.some((s) => s.state === "ready" || s.state === "failed")) await wait(500)
  const ready = states.find((s) => s.state === "ready")
  if (!ready) { fail(`the page didn't load in Obstat's viewer: ${states.map((s) => s.message).filter(Boolean).pop() || "no answer"}`); return { ok: false } }
  const wc = webContents.getAllWebContents().find((c) => c !== win.webContents && /^https?:/.test(c.getURL()))
  if (!wc) { fail("couldn't find the app's page in the viewer"); return { ok: false } }

  // pages built in the browser (Gradio, React) fill in after load: give them time
  const STATS = `(() => {
    const b = document.body
    const visible = [...document.querySelectorAll("body *")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length
    return { title: document.title, text: b ? b.innerText.replace(/\\s+/g, " ").trim().slice(0, 400) : "", textLength: b ? b.innerText.trim().length : 0, visible, controls: document.querySelectorAll("input, textarea, select, button").length }
  })()`
  let stats = null
  const settle = Date.now() + 120_000
  while (Date.now() < settle) {
    stats = await wc.executeJavaScript(STATS).catch(() => null)
    if (stats && stats.visible >= 10 && (stats.textLength >= 20 || stats.controls >= 1)) break
    await wait(2000)
  }
  await wait(3000)
  stats = (await wc.executeJavaScript(STATS).catch(() => null)) || stats
  // under xvfb (no GPU) Chromium's GPU process sometimes fails to start the first time
  // and is started again: the screenshot is tried once more after that
  const shot = await wc.capturePage().catch(async (err) => { say(`screenshot: ${err.message}, trying again`); await wait(3000); return wc.capturePage() })
  fs.writeFileSync(path.join(OUT, "page.png"), shot.toPNG())
  const colours = distinctColours(shot)
  say(`page: "${stats?.title}" at ${wc.getURL()}, ${stats?.visible} visible elements, ${stats?.controls} controls, ${colours} colours`)
  say(`page text: ${stats?.text}`)
  if (!stats || stats.visible < 10 || (stats.textLength < 20 && stats.controls < 1)) fail("the page is blank or nearly empty")
  if (colours < 4) fail("the screenshot is one flat colour (a blank page)")
  if (!api.isLocalUrl(wc.getURL())) fail(`the viewer ended up on ${wc.getURL()}`)
  if (pageErrors.length) say(`${pageErrors.length} page errors (logged above; not counted as a failure)`)
  fs.writeFileSync(path.join(OUT, "page.json"), JSON.stringify({ url: wc.getURL(), stats, colours, pageErrors }, null, 2))
  return { ok: true, wc, stats }
}

function distinctColours(img) {
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  const seen = new Set()
  for (let y = 0; y < height; y += 7) for (let x = 0; x < width; x += 7) {
    const i = (y * width + x) * 4
    seen.add((bmp[i] << 16) | (bmp[i + 1] << 8) | bmp[i + 2])
    if (seen.size > 50) return seen.size
  }
  return seen.size
}

// Under plain Node: the address answers with a page.
async function fetchPage(url) {
  const until = Date.now() + 10 * 60_000
  while (Date.now() < until) {
    try {
      const res = await fetch(url.replace("0.0.0.0", "127.0.0.1"), { signal: AbortSignal.timeout(10000) })
      const text = await res.text()
      say(`GET ${url}: ${res.status}, ${text.length} bytes`)
      if (res.status >= 500 || !text.length) fail(`the page answered ${res.status} with ${text.length} bytes`)
      return { ok: true, html: text }
    } catch { await wait(1000) }
  }
  fail(`nothing answered at ${url}`)
  return { ok: false }
}

// Build a UI: fill in the generated form, click Run, and check what it made.
async function useBuiltUi(page) {
  if (!page.ok) return
  const fill = JSON.stringify(spec.form || {})
  const r = await page.wc.executeJavaScript(`(async () => {
    const want = ${fill}
    for (let i = 0; i < 100 && !fields.length; i++) await new Promise((r) => setTimeout(r, 200))
    const keys = fields.map((f) => f.key)
    for (const [k, v] of Object.entries(want)) {
      const i = keys.indexOf(k)
      if (i < 0) return { error: "the form has no field " + k, keys }
      document.getElementById("f" + i).value = v
    }
    document.getElementById("go").click()
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const s = document.getElementById("status").textContent
      if (/^Done|stopped with an error/.test(s)) return { status: s, keys, out: document.getElementById("out").textContent.slice(-2000), files: [...document.querySelectorAll("#files .file strong")].map((n) => n.textContent) }
    }
    return { error: "the run never finished", keys }
  })()`)
  say(`Build a UI form fields: ${(r.keys || []).join(" ")}`)
  if (r.error) return fail(`Build a UI: ${r.error}`)
  say(`Build a UI run: ${r.status} files: ${r.files.join(", ")}`)
  if (!/^Done/.test(r.status)) return fail(`Build a UI: the command failed: ${r.out}`)
  if (spec.makes && !r.files.includes(spec.makes)) return fail(`Build a UI: the page didn't show ${spec.makes}`)
  if (spec.makes) {
    const body = await page.wc.executeJavaScript(`fetch("/file?p=" + encodeURIComponent(${JSON.stringify(spec.makes)})).then((r) => r.text())`)
    if (!/<svg|PNG|\S/.test(body.slice(0, 200))) fail(`Build a UI: ${spec.makes} is empty`)
    else say(`Build a UI made ${spec.makes} (${body.length} bytes)`)
  }
}

async function finish(code) {
  try { fs.cpSync(path.join(HOME, "logs"), path.join(OUT, "logs"), { recursive: true }) } catch {}
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ app: arg, ok: code === 0, problems, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2))
  say(code === 0 ? `PASS ${arg}` : `FAILED ${arg}: ${problems.join("; ")}`)
  if (electron) electron.app.exit(code); else process.exit(code)
}

const limit = setTimeout(() => { fail(`took longer than ${spec.minutes || 30} minutes`); finish(1) }, (spec.minutes || 30) * 60_000)
limit.unref?.()
const go = () => main().then(() => finish(problems.length ? 1 : 0), (err) => { fail(err.message); finish(1) })
if (electron) {
  require("../lib/viewer").useSoftwareWebGL(electron.app)
  electron.app.on("window-all-closed", () => {})
  electron.app.whenReady().then(go)
} else go()
