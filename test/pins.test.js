const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const pins = require("../lib/pins")

const A = "5171e1dcf31a33d1afeb14ef7c6aac6dadae5dc1"
const B = "c9ff851e7b509d3b6dd735aaefe438823319674e"
const M = "882222df1d7aed91e24958839f8700c9a2731f23"
const appDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "obstat-pins-"))
// a folder that looks like a clone of url
function cloned(dir, url) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
}

test("pins from the list are checked, and anything malformed means none", () => {
  assert.deepEqual(pins.clean({ "https://github.com/IAHispano/Applio.git": A }), { "https://github.com/iahispano/applio": { HEAD: A } })
  assert.deepEqual(pins.clean({ "https://github.com/x/y": { HEAD: B, "mac-os-fix": M } }), { "https://github.com/x/y": { HEAD: B, "mac-os-fix": M } })
  assert.deepEqual(pins.clean({}), {})
  for (const bad of [null, [], "x", { "https://evil.example/x/y": A }, { "https://github.com/x/y": "main" }, { "https://github.com/x/y": { "mac-os-fix": M } }, { "https://github.com/x/y": { HEAD: A, "a b": M } }]) {
    assert.equal(pins.clean(bad), null, JSON.stringify(bad))
  }
})

test("a launcher's git clone gets the reviewed commit, not the newest", () => {
  const dir = appDir()
  const p = pins.clean({ "https://github.com/IAHispano/Applio": A })
  const r = pins.apply(["git clone https://github.com/IAHispano/Applio app"], { cwd: dir, appDir: dir, pins: p })
  assert.deepEqual(r.lines, [
    'git clone https://github.com/iahispano/applio "app"',
    `git -C "app" -c advice.detachedHead=false checkout -q --detach ${A}`,
  ])
  assert.match(r.notes[0], /reviewed commit 5171e1d/)
  // shallow or branch clones become full clones on the pinned commit
  const s = pins.apply(["git clone --depth 1 -b dev https://github.com/IAHispano/Applio.git app"], { cwd: dir, appDir: dir, pins: p })
  assert.equal(s.lines[0], 'git clone https://github.com/iahispano/applio "app"')
})

test("installing again over an existing clone moves it to the reviewed commit instead", () => {
  const dir = appDir()
  cloned(path.join(dir, "app"), "https://github.com/IAHispano/Applio")
  const r = pins.apply(["git clone https://github.com/IAHispano/Applio app"], { cwd: dir, appDir: dir, pins: pins.clean({ "https://github.com/IAHispano/Applio": A }) })
  assert.deepEqual(r.lines, [
    `git -C "app" fetch -q https://github.com/iahispano/applio ${A}`,
    `git -C "app" -c advice.detachedHead=false checkout -q --detach ${A}`,
  ])
})

test("git pull: skipped in the launcher, the pinned commit in a pinned clone", () => {
  const dir = appDir()
  cloned(path.join(dir, "app"), "https://github.com/IAHispano/Applio.git")
  const p = pins.clean({ "https://github.com/IAHispano/Applio": A })
  const root = pins.apply(["git pull"], { cwd: dir, appDir: dir, pins: p })
  assert.deepEqual(root.lines, [])
  const app = pins.apply(["git pull"], { cwd: path.join(dir, "app"), appDir: dir, pins: p })
  assert.deepEqual(app.lines, [`git -C "." fetch -q https://github.com/iahispano/applio ${A}`, `git -C "." -c advice.detachedHead=false checkout -q --detach ${A}`])
  // and reset --hard HEAD (Whisper-WebUI's update) stays as it is
  assert.deepEqual(pins.apply(["git reset --hard HEAD"], { cwd: path.join(dir, "app"), appDir: dir, pins: p }).lines, ["git reset --hard HEAD"])
})

test("a branch the launcher checks out (AudioCraft on a Mac) has its own reviewed commit", () => {
  const dir = appDir()
  cloned(path.join(dir, "app"), "https://github.com/GrandaddyShmax/audiocraft_plus")
  const p = pins.clean({ "https://github.com/GrandaddyShmax/audiocraft_plus": { HEAD: B, "mac-os-fix": M } })
  const r = pins.apply(["git checkout mac-os-fix"], { cwd: path.join(dir, "app"), appDir: dir, pins: p })
  assert.equal(r.lines[1], `git -C "." -c advice.detachedHead=false checkout -q --detach ${M}`)
  assert.throws(() => pins.apply(["git checkout main"], { cwd: path.join(dir, "app"), appDir: dir, pins: p }), /wasn't part of its review/)
})

test("anything that would fetch unreviewed code stops the step", () => {
  const dir = appDir()
  const p = pins.clean({ "https://github.com/IAHispano/Applio": A })
  const run = (line, cwd = dir) => pins.apply([line], { cwd, appDir: dir, pins: p })
  assert.throws(() => run("git clone https://github.com/someone/else app"), /wasn't part of its review/)
  assert.throws(() => run("git clone https://github.com/IAHispano/Applio ../outside"), /outside its own folder/)
  assert.throws(() => run("cd app && git pull"), /can't check/)
  assert.throws(() => run("git clone $URL app"), /can't check/)
  fs.mkdirSync(path.join(dir, "other"))
  assert.throws(() => run("git pull", path.join(dir, "other")), /wasn't part of its review/)
  // with no pins at all ({}), a reviewed app can't clone anything
  assert.throws(() => pins.apply(["git clone https://github.com/IAHispano/Applio app"], { cwd: dir, appDir: dir, pins: {} }), /wasn't part of its review/)
  // other commands are untouched
  assert.deepEqual(run("uv pip install -r requirements.txt").lines, ["uv pip install -r requirements.txt"])
})

// The real worker running a launcher's install.js and update.js, with git's
// url.insteadOf sending "https://github.com/" to a local upstream repo that has
// moved on past the reviewed commit.
const { fork, execFileSync } = require("node:child_process")
const WORKER = path.join(__dirname, "..", "lib", "worker.js")
const gitOk = (() => { try { execFileSync("git", ["--version"]); return true } catch { return false } })()
// Windows git may check text out with CRLF line endings
const text = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n")
const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim()

function runWorker(dir, script, job) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const out = { log: "", end: null }
    const timer = setTimeout(() => { child.kill(); resolve({ ...out, end: "timeout" }) }, 30000)
    child.on("message", (m) => { if (m.type === "log") out.log += m.text; else if (m.type === "done" || m.type === "error") { out.end = m.type; out.error = m.message } })
    child.on("exit", () => { clearTimeout(timer); resolve(out) })
    child.send({ type: "run", job: { appDir: dir, script, paths: [], python: "python3", ctx: { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42021, env: {} }, approved: null, ...job } })
  })
}

test("a reviewed launcher installs and updates its app at the pinned commit, through the real worker", { skip: !gitOk && "needs git" }, async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-pins-run-"))
  // upstream: the reviewed commit, then a newer one nobody reviewed
  const up = path.join(top, "github", "author", "tool")
  fs.mkdirSync(up, { recursive: true })
  g(up, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(up, "app.py"), "reviewed\n"); g(up, "add", "."); g(up, "commit", "-qm", "reviewed")
  const reviewed = g(up, "rev-parse", "HEAD")
  fs.writeFileSync(path.join(up, "app.py"), "NOT reviewed\n"); g(up, "commit", "-qam", "newer")
  // the launcher, as Pinokio's are
  const dir = path.join(top, "launcher")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "install.js"), 'module.exports = { run: [{ method: "shell.run", params: { message: ["git clone https://github.com/author/tool app"] } }] }\n')
  fs.writeFileSync(path.join(dir, "update.js"), 'module.exports = { run: [{ method: "shell.run", params: { message: "git pull" } }, { method: "shell.run", params: { path: "app", message: "git pull" } }] }\n')
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${path.join(top, "github")}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/", GIT_TERMINAL_PROMPT: "0" }
  const job = { env, pins: pins.clean({ "https://github.com/author/tool": reviewed }) }

  const install = await runWorker(dir, "install.js", job)
  assert.equal(install.end, "done", install.log + install.error)
  assert.equal(g(path.join(dir, "app"), "rev-parse", "HEAD"), reviewed)
  assert.equal(text(path.join(dir, "app", "app.py")), "reviewed\n")

  const update = await runWorker(dir, "update.js", job)
  assert.equal(update.end, "done", update.log + update.error)
  assert.equal(g(path.join(dir, "app"), "rev-parse", "HEAD"), reviewed, "git pull doesn't move it to the newer commit")

  // installing again (after Obstat updates the launcher) moves the existing clone to the pin
  const again = await runWorker(dir, "install.js", job)
  assert.equal(again.end, "done", again.log + again.error)
  assert.equal(g(path.join(dir, "app"), "rev-parse", "HEAD"), reviewed)

  // without pins (an unreviewed app) the same launcher gets the newest commit, as before
  const loose = path.join(top, "loose")
  fs.mkdirSync(loose); fs.copyFileSync(path.join(dir, "install.js"), path.join(loose, "install.js"))
  const free = await runWorker(loose, "install.js", { env })
  assert.equal(free.end, "done", free.log + free.error)
  assert.equal(text(path.join(loose, "app", "app.py")), "NOT reviewed\n")
})
