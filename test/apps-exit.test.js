// A worker that ends without saying it finished didn't finish: say an install's
// worker couldn't start inside its walls, or was ended from outside.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const homeLib = require("../lib/home")
const appsLib = require("../lib/apps")

const gitOk = (() => { try { execFileSync("git", ["--version"]); return true } catch { return false } })()
test("an install whose worker ends with an error and no result is a failed install, not a finished one", { skip: !gitOk && "needs git" }, async () => {
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-exit-"))); h.ensure()
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"))
  fs.writeFileSync(path.join(repo, "install.js"), 'module.exports = { run: [{ method: "shell.run", params: { message: "echo hi" } }] }')
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo })
  g("init", "-q"); g("add", "."); g("commit", "-qm", "init")
  const runtimes = { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git", gitEnv: () => ({}) }
  const events = []
  const apps = appsLib.create(h, runtimes, {
    emit: (e) => events.push(e),
    // a "worker" that dies at once, as a sandbox helper that can't start would
    wrap: (_id, _file, _args, _env, script) => (script === "install.js" ? { file: process.execPath, args: ["-e", "process.exit(3)"] } : null),
  })
  try {
    await apps.fetchApp({ id: "someone/demo", owner: "someone", name: "demo", url: repo, sha: null, reviewed: true }, () => {})
    const r = await apps.run("someone/demo", "install.js")
    assert.equal(r.ok, false)
    assert.match(r.error, /ended before it finished \(exit code 3\)/)
    assert.notEqual(apps.get("someone/demo")?.installed, true, "not marked installed")
  } finally {
    await apps.stopAll()
    fs.rmSync(h.root, { recursive: true, force: true })
  }
})
