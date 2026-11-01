// Downloading an app (lib/apps.js fetchApp and update): the installed commit and the
// ones just before it, not the whole history, and a whole clone where that can't be done.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const homeLib = require("../lib/home")
const appsLib = require("../lib/apps")

const gitOk = (() => { try { execFileSync("git", ["--version"]); return true } catch { return false } })()
const g = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim()
const runtimes = { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git", gitEnv: () => ({}) }

// an upstream with a long history, served the way GitHub serves it: by commit, with filters
function upstream(commits, { serveLikeGitHub = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-up-"))
  g(d, "init", "-q", "-b", "main")
  if (serveLikeGitHub) { g(d, "config", "uploadpack.allowFilter", "true"); g(d, "config", "uploadpack.allowAnySHA1InWant", "true") }
  fs.writeFileSync(path.join(d, "install.js"), 'module.exports = { run: [] }\n')
  for (let i = 0; i < commits; i++) { fs.writeFileSync(path.join(d, "n.txt"), `${i}\n`); g(d, "add", "."); g(d, "commit", "-qm", `c${i}`) }
  return d
}
const count = (dir) => Number(g(dir, "rev-list", "--count", "HEAD"))

test("an app is downloaded at its commit with only the history before it that Obstat shows", { skip: !gitOk && "needs git" }, async () => {
  const up = upstream(60)
  const reviewed = g(up, "rev-parse", "HEAD~5")
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-fetch-"))); h.ensure()
  const logs = []
  const apps = appsLib.create(h, runtimes, {})
  try {
    const dir = await apps.fetchApp({ id: "a/b", owner: "a", name: "b", url: require("node:url").pathToFileURL(up).href, sha: reviewed, reviewed: true }, (l) => logs.push(l))
    assert.equal(g(dir, "rev-parse", "HEAD"), reviewed)
    assert.ok(fs.existsSync(path.join(dir, ".git", "shallow")), "not the whole history")
    assert.equal(count(dir), 30, "the installed commit and the 29 before it")
    assert.equal(fs.readFileSync(path.join(dir, "n.txt"), "utf8").trim(), "54")
    assert.ok(!logs.join("").includes("whole repo"))
    // updating to a newer reviewed commit stays quick
    const next = g(up, "rev-parse", "HEAD")
    const r = await apps.update({ id: "a/b", url: require("node:url").pathToFileURL(up).href, sha: next, reviewed: true }, () => {})
    assert.equal(r.to, next)
    assert.ok(fs.existsSync(path.join(dir, ".git", "shallow")))
    assert.equal(fs.readFileSync(path.join(dir, "n.txt"), "utf8").trim(), "59")
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
})

test("a server that can't send just one commit gets a whole clone, as before", { skip: !gitOk && "needs git" }, async () => {
  const up = upstream(5, { serveLikeGitHub: false })
  const reviewed = g(up, "rev-parse", "HEAD~2")
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-fetch-"))); h.ensure()
  const logs = []
  const apps = appsLib.create(h, runtimes, {})
  try {
    const dir = await apps.fetchApp({ id: "a/c", owner: "a", name: "c", url: up, sha: reviewed, reviewed: true }, (l) => logs.push(l))
    assert.equal(g(dir, "rev-parse", "HEAD"), reviewed)
    assert.equal(count(dir), 3)
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true })
  }
})
