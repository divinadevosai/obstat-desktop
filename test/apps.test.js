// End to end on the machine running the tests: clone a local repo, run its
// install.js (with a venv) and a daemon start.js, wait for its URL, then stop and remove it.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const home = require("../lib/home")
const apps = require("../lib/apps")

const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true } catch { return false } })()

function makeRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"))
  fs.writeFileSync(path.join(d, "install.js"), `module.exports = { run: [
    { method: "shell.run", params: { venv: "env", message: ["python -c \\"import sys; print('venv', sys.prefix != sys.base_prefix)\\"", "echo installed > done.txt"] } },
  ] }`)
  fs.writeFileSync(path.join(d, "start.js"), `module.exports = { daemon: true, run: [
    { method: "shell.run", params: { venv: "env", message: ["python -u -m http.server {{port}} --bind 127.0.0.1"],
      on: [{ event: "/(http:\\\\/\\\\/[0-9.:]+)/", done: true }] } },
    { method: "local.set", params: { url: "{{input.event[1]}}" } },
  ] }`)
  execFileSync("git", ["init", "-q"], { cwd: d })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: d })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: d })
  return { dir: d, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: d }).toString().trim() }
}

test("install, start, stop and remove an app", { skip: !hasPython || process.platform === "win32", timeout: 60000 }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const runtimes = { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" }
  const events = []
  const a = apps.create(h, runtimes, { emit: (e) => events.push(e) })
  const repo = makeRepo()
  const id = "someone/demo"

  await a.fetchApp({ id, owner: "someone", name: "demo", url: repo.dir, sha: repo.sha, reviewed: true }, () => {})
  const preview = await a.preview(id, "install.js")
  assert.equal(preview.commands.length, 2)

  const installed = await a.run(id, "install.js")
  assert.deepEqual(installed, { ok: true })
  assert.ok(fs.existsSync(path.join(a.appDir(id), "done.txt")))
  assert.match(events.filter((e) => e.type === "log").map((e) => e.text).join(""), /venv True/)
  assert.equal(a.get(id).installed, true)

  const started = await a.run(id, "start.js")
  assert.equal(started.running, true)
  const url = a.get(id).running.url
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+/)
  const res = await fetch(url)
  assert.equal(res.status, 200)

  assert.equal(a.stop(id), true)
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(a.get(id).running, null)
  await assert.rejects(fetch(url))
  assert.ok(fs.existsSync(path.join(h.dir("logs"), "apps", "someone-demo", "start.txt")))

  await a.remove(id)
  assert.equal(a.get(id), null)
  assert.equal(fs.existsSync(a.appDir(id)), false)
})

test("a failing step stops the install and says why", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const dir = a.appDir("x/y")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "install.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["exit 3"] } }] }`)
  const r = await a.run("x/y", "install.js")
  assert.equal(r.ok, false)
  assert.match(r.error, /exit code 3/)
})

test("next: null ends a script, so torch.js installs one torch, not the CPU one on top", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const dir = a.appDir("x/torch")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "install.js"), `module.exports = { run: [{ method: "script.start", params: { uri: "torch.js" } }, { method: "shell.run", params: { message: ["echo after >> log.txt"] } }] }`)
  fs.writeFileSync(path.join(dir, "torch.js"), `module.exports = { run: [
    { when: "{{platform === 'nope'}}", method: "shell.run", params: { message: ["echo other >> log.txt"] }, next: null },
    { when: "{{platform === '${process.platform}'}}", method: "shell.run", params: { message: ["echo gpu >> log.txt"] }, next: null },
    { method: "shell.run", params: { message: ["echo cpu >> log.txt"] } },
  ] }`)
  const r = await a.run("x/torch", "install.js")
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(fs.readFileSync(path.join(dir, "log.txt"), "utf8").trim().split(/\s+/), ["gpu", "after"])
  const { plan, commandsOf } = require("../lib/script")
  assert.deepEqual(commandsOf(plan(path.join(dir, "install.js"), { platform: process.platform, args: {} })).map((c) => c.command), ["echo gpu >> log.txt", "echo after >> log.txt"])
})

test("app menu: run options, edit launcher, reset, copy, update and made-here apps", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const repo = makeRepo()
  fs.writeFileSync(path.join(repo.dir, "run_webcam.js"), `module.exports = { daemon: true, run: [{ method: "shell.run", params: { message: ["echo cam"] } }] }`)
  fs.writeFileSync(path.join(repo.dir, "torch.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["echo torch"] } }] }`)
  fs.writeFileSync(path.join(repo.dir, "install.js"), `module.exports = { run: [{ method: "script.start", params: { uri: "torch.js" } }] }`)
  fs.writeFileSync(path.join(repo.dir, "notes.js"), "this is not a script")
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo.dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "more"], { cwd: repo.dir })
  const id = "someone/demo"
  await a.fetchApp({ id, owner: "someone", name: "demo", url: repo.dir, sha: repo.sha, reviewed: false }, () => {})

  // pinned at the first commit; Update moves to the newest code
  assert.equal(fs.existsSync(path.join(a.appDir(id), "run_webcam.js")), false)
  const up = await a.update({ id, url: repo.dir, sha: null, reviewed: false }, () => {})
  assert.equal(up.changed, true)
  assert.deepEqual(await a.runOptions(id), [{ script: "start.js", label: "Start" }, { script: "run_webcam.js", label: "Run webcam" }])
  fs.writeFileSync(path.join(a.appDir(id), "obstat.json"), JSON.stringify({ run: [{ label: "Webcam", script: "run_webcam.js" }, { label: "Bad", script: "../x.js" }] }))
  assert.deepEqual(await a.runOptions(id), [{ script: "run_webcam.js", label: "Webcam" }])

  // names from the window can't leave the app folder
  await assert.rejects(a.run(id, "../../evil.js"), /isn't one of this app's scripts/)
  assert.throws(() => a.readScript(id, "..\\x.js"), /isn't one/)
  a.writeScript(id, "start.js", "module.exports = { run: [] }")
  assert.equal(a.readScript(id, "start.js"), "module.exports = { run: [] }")
  assert.equal(a.get(id).edited, true)

  fs.mkdirSync(path.join(a.appDir(id), "env", "lib"), { recursive: true })
  fs.writeFileSync(path.join(a.appDir(id), "output.png"), "x")
  assert.deepEqual((await a.reset(id)).removed, ["env"])
  assert.ok(fs.existsSync(path.join(a.appDir(id), "output.png")))
  assert.equal(a.get(id).installed, false)

  const c = await a.copy(id)
  assert.equal(c.id, "someone/demo-2")
  assert.ok(fs.existsSync(path.join(a.appDir(c.id), "output.png")))
  assert.equal(a.get(c.id).local, true)
  await assert.rejects(a.update({ id: c.id, url: repo.dir }, () => {}), /made on this PC/)

  const made = a.createLocal({ name: "Voice-Notes", task: "Turn my voice notes into text\nmore", files: { "OBSTAT_TASK.md": "task" } })
  assert.equal(made.id, "me/voice-notes")
  assert.equal(made.description, "Turn my voice notes into text")
  assert.ok(fs.existsSync(path.join(a.appDir(made.id), "OBSTAT_TASK.md")))
  assert.throws(() => a.createLocal({ name: "voice-notes", task: "x" }), /already have/)
  assert.throws(() => a.createLocal({ name: "../x", task: "x" }), /lowercase/)
  assert.equal(await a.fetchApp(made, () => {}), a.appDir(made.id))
})

test("an unreviewed app's steps show before they first run, and again when they change", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const dir = a.appDir("x/u")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(h.root, "apps.json"), JSON.stringify({ "x/u": { id: "x/u", owner: "x", name: "u", reviewed: false, installed: true } }))
  const write = (cmd) => fs.writeFileSync(path.join(dir, "start.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["${cmd}"] } }] }`)
  write("echo one >> out.txt")

  const first = await a.run("x/u", "start.js")
  assert.equal(first.needsApproval, true)
  assert.deepEqual(first.preview.commands.map((c) => c.command), ["echo one >> out.txt"])
  assert.equal(fs.existsSync(path.join(dir, "out.txt")), false)
  await assert.rejects(a.run("x/u", "start.js", "made-up"), /out of date/)

  assert.deepEqual(await a.run("x/u", "start.js", first.preview.token), { ok: true })
  await assert.rejects(a.run("x/u", "start.js", first.preview.token), /out of date/) // a token works once
  assert.deepEqual(await a.run("x/u", "start.js"), { ok: true }) // seen and unchanged: runs
  assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "one\none\n")

  write("echo two >> out.txt")
  const changed = await a.run("x/u", "start.js")
  assert.equal(changed.needsApproval, true)
  assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "one\none\n")
})

test("a change to only a step's environment still counts as changed steps", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const dir = a.appDir("x/e")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(h.root, "apps.json"), JSON.stringify({ "x/e": { id: "x/e", owner: "x", name: "e", reviewed: false, installed: true } }))
  const write = (env) => fs.writeFileSync(path.join(dir, "start.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["echo hi"], env: ${JSON.stringify(env)} } }] }`)
  write({ A: "1" })
  const first = await a.run("x/e", "start.js")
  assert.deepEqual(await a.run("x/e", "start.js", first.preview.token), { ok: true })
  assert.deepEqual(await a.run("x/e", "start.js"), { ok: true })
  write({ A: "1", PYTHONSTARTUP: "evil.py" })
  assert.equal((await a.run("x/e", "start.js")).needsApproval, true)
})

test("a copy of an unreviewed app still shows its steps before they first run", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  fs.mkdirSync(a.appDir("x/c"), { recursive: true })
  fs.writeFileSync(path.join(a.appDir("x/c"), "start.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["echo hi"] } }] }`)
  fs.writeFileSync(path.join(h.root, "apps.json"), JSON.stringify({ "x/c": { id: "x/c", owner: "x", name: "c", reviewed: false, installed: true } }))
  const copy = await a.copy("x/c")
  assert.equal((await a.run(copy.id, "start.js")).needsApproval, true)
})

test("Run install runs the steps that were shown, even if the files change after", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const dir = a.appDir("x/i")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(h.root, "apps.json"), JSON.stringify({ "x/i": { id: "x/i", owner: "x", name: "i", reviewed: false } }))
  const write = (cmd) => fs.writeFileSync(path.join(dir, "install.js"), `module.exports = (kernel) => ({ run: [{ method: "shell.run", params: { message: [${JSON.stringify(cmd)}] } }] })`)
  write("echo shown > out.txt")
  const p = await a.preview("x/i", "install.js")
  write("echo hidden > out.txt")
  assert.deepEqual(await a.run("x/i", "install.js", p.token), { ok: true })
  assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "shown\n")
})

test("spots apps that call ffmpeg, without reading their installed packages", () => {
  const { needsFfmpeg } = apps
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-ff-"))
  fs.mkdirSync(path.join(d, "app", "env", "lib"), { recursive: true })
  fs.writeFileSync(path.join(d, "app", "env", "lib", "x.py"), "import subprocess; subprocess.run(['ffmpeg'])")
  fs.writeFileSync(path.join(d, "app", "main.py"), "print('hi')")
  assert.equal(needsFfmpeg(d), false)
  fs.writeFileSync(path.join(d, "app", "ui.py"), "out = gr.make_waveform(audio)")
  assert.equal(needsFfmpeg(d), true)
})

test("What's changed lists the app's newest commits, the launcher's and the app's own", { skip: process.platform === "win32" }, async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const a = apps.create(h, { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git" })
  const dir = a.appDir("x/w")
  const commit = (d, msg) => {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${msg.length}.txt`), msg)
    if (!fs.existsSync(path.join(d, ".git"))) execFileSync("git", ["init", "-q"], { cwd: d })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=Ada", "add", "."], { cwd: d })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=Ada", "commit", "-qm", msg], { cwd: d })
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: d }).toString().trim()
  }
  commit(dir, "first launcher")
  const head = commit(dir, "fix the start step")
  commit(path.join(dir, "app"), "upstream: faster model loading")
  fs.writeFileSync(path.join(h.root, "apps.json"), JSON.stringify({ "x/w": { id: "x/w", url: "https://github.com/x/w.git", commit: head, installed: true } }))
  const c = await a.changes("x/w")
  assert.deepEqual(c.sections.map((s) => s.title), ["Launcher", "The app itself"])
  assert.deepEqual(c.sections[0].commits.map((x) => x.message), ["fix the start step", "first launcher"])
  assert.equal(c.sections[0].commits[0].author, "Ada")
  assert.equal(c.sections[0].link, "https://github.com/x/w")
  assert.equal(c.current, head)
  assert.equal(c.sections[1].commits[0].message, "upstream: faster model loading")
})

test("an app is busy (and can be stopped) while Obstat is still downloading ffmpeg for it", async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  let release, asked = 0
  const runtimes = { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git", ensure: () => { asked++; return new Promise((r) => { release = r }) } }
  const a = apps.create(h, runtimes)
  const id = "x/sound"
  fs.mkdirSync(a.appDir(id), { recursive: true })
  fs.writeFileSync(path.join(a.appDir(id), "start.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["echo hi"] } }] }`)
  fs.writeFileSync(path.join(h.root, "apps.json"), JSON.stringify({ [id]: { id, reviewed: true, installed: true, ffmpeg: true } }))
  const first = a.run(id, "start.js")
  await new Promise((r) => setImmediate(r))
  assert.equal(asked, 1)
  assert.equal(a.get(id).running.script, "start.js")
  await assert.rejects(a.run(id, "start.js"), /already busy/)
  assert.equal(asked, 1)
  assert.equal(a.stop(id), true)
  assert.equal(a.get(id).running, null)
  release()
  assert.deepEqual(await first, { ok: false, error: "Stopped." })
})
