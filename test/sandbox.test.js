// The sandbox: a folder-mode test run end to end, and the Windows Sandbox
// setup (its .wsb, and that only log text comes back out of it).
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const home = require("../lib/home")
const sandboxLib = require("../lib/sandbox")

const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true } catch { return false } })()
const runtimes = { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git", exe: () => "/obstat/bin/node/node.exe" }

function makeRepo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text)
  execFileSync("git", ["init", "-q"], { cwd: d })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: d })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: d })
  return d
}
const freshHome = () => { const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure(); return h }
const entry = (url) => ({ id: "someone/demo", owner: "someone", name: "demo", url, sha: null, reviewed: false })

test("folder mode installs and starts the app with its home inside the test folder", { skip: !hasPython || process.platform === "win32", timeout: 60000 }, async () => {
  const h = freshHome()
  const events = []
  const sb = sandboxLib.create(h, runtimes, { emit: (e) => events.push(e), platform: "linux", sandboxExe: null, detectWalls: async () => ({ kind: null, reason: "test" }) })
  const repo = makeRepo({
    "install.js": `module.exports = { run: [{ method: "shell.run", params: { message: ["echo $HOME > home.txt", "echo $XDG_CACHE_HOME > cache.txt"] } }] }`,
    "start.js": `module.exports = { daemon: true, run: [
      { method: "shell.run", params: { message: ["python3 -u -m http.server {{port}} --bind 127.0.0.1"], on: [{ event: "/(http:\\\\/\\\\/[0-9.:]+)/", done: true }] } },
      { method: "local.set", params: { url: "{{input.event[1]}}" } },
    ] }`,
  })
  assert.equal(sb.mode(), "folder")
  const r = await sb.test(entry(repo))
  assert.equal(r.running, true)

  const dir = sb.appDir("someone/demo")
  assert.ok(dir.startsWith(h.dir("sandboxes")))
  const fakeHome = fs.readFileSync(path.join(dir, "home.txt"), "utf8").trim()
  assert.equal(fakeHome, path.join(h.dir("sandboxes"), "someone-demo.home"))
  assert.ok(fs.readFileSync(path.join(dir, "cache.txt"), "utf8").trim().startsWith(fakeHome))
  assert.ok(events.every((e) => e.sandbox))

  const t = sb.get("someone/demo")
  assert.equal(t.status, "running")
  assert.match(sb.testedCommit("someone/demo"), /^[0-9a-f]{40}$/)
  assert.equal((await fetch(t.running.url)).status, 200)

  await sb.remove("someone/demo")
  await new Promise((res) => setTimeout(res, 1500))
  assert.equal(sb.list().length, 0)
  assert.ok(!fs.existsSync(dir))
  assert.ok(!fs.existsSync(fakeHome))
})

// The real thing on Mac and Linux: an app whose install tries to take your files and
// Obstat's keys, run through Obstat's own sandbox code, inside bubblewrap or Apple's sandbox.
test("on Mac and Linux a test runs inside the OS sandbox: it can't read your files or Obstat's keys, and still runs", { skip: !hasPython || process.platform === "win32", timeout: 90000 }, async (t) => {
  const walls = await require("../lib/confine").detect()
  if (!walls.kind) return t.skip(`no sandbox here: ${walls.reason}`)
  // Obstat's folder inside the real home folder, as it is for real
  const h = home.create(fs.mkdtempSync(path.join(os.homedir(), ".obstat-sbtest-"))); h.ensure()
  const secret = path.join(os.homedir(), `.obstat-secret-${path.basename(h.root)}`)
  fs.writeFileSync(secret, "private")
  fs.writeFileSync(path.join(h.root, "keys.json"), '[{"name":"OPENAI_API_KEY"}]')
  fs.writeFileSync(path.join(h.root, "control.json"), '{"token":"t"}')
  const escaped = path.join(os.homedir(), `.obstat-escaped-${path.basename(h.root)}`)
  try {
    const sb = sandboxLib.create(h, runtimes, { platform: process.platform, sandboxExe: null })
    const steal = (f, out) => `(cat '${f}' > ${out} 2>/dev/null && echo yes || echo no) > ${out}.result`
    const repo = makeRepo({
      "install.js": `module.exports = { run: [{ method: "shell.run", params: { message: [
        ${JSON.stringify(steal(secret, "secret.txt"))},
        ${JSON.stringify(steal(path.join(h.root, "keys.json"), "keys.txt"))},
        ${JSON.stringify(steal(path.join(h.root, "control.json"), "control.txt"))},
        ${JSON.stringify(`(echo x > '${escaped}' 2>/dev/null && echo yes || echo no) > escape.result`)},
        "echo $OBSTAT_SANDBOX > mode.txt",
      ] } }] }`,
      "start.js": `module.exports = { daemon: true, run: [
        { method: "shell.run", params: { message: ["python3 -u -m http.server {{port}} --bind 127.0.0.1"], on: [{ event: "/(http:\\/\\/[0-9.:]+)/", done: true }] } },
        { method: "local.set", params: { url: "{{input.event[1]}}" } },
      ] }`,
    })
    assert.equal((await sb.info()).mode, "walls")
    const r = await sb.test(entry(repo))
    assert.equal(r.running, true, JSON.stringify(r))
    const dir = sb.appDir("someone/demo")
    const said = (f) => fs.readFileSync(path.join(dir, f), "utf8").trim()
    assert.equal(said("secret.txt.result"), "no", "read a file in your home folder")
    assert.equal(said("keys.txt.result"), "no", "read Obstat's keys")
    assert.equal(said("control.txt.result"), "no", "read the agents' control token")
    assert.equal(said("escape.result"), "no", "wrote outside its folder")
    assert.equal(fs.existsSync(escaped), false)
    assert.equal(said("mode.txt"), "walls")
    // and it still works: its page answers from outside the sandbox
    const page = sb.get("someone/demo")
    assert.equal(page.mode, "walls")
    assert.equal((await fetch(page.running.url)).status, 200)
    await sb.remove("someone/demo")
    await new Promise((res) => setTimeout(res, 1500))
    // Stop ended everything inside: nothing answers any more
    await assert.rejects(fetch(page.running.url))
  } finally {
    fs.rmSync(secret, { force: true })
    fs.rmSync(escaped, { force: true })
    fs.rmSync(h.root, { recursive: true, force: true })
  }
})

test("Windows Sandbox mode maps the app read-only and only lets log text out", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const h = freshHome()
  const events = []
  // stands in for WindowsSandbox.exe: records the .wsb it was given
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wsb-")), "WindowsSandbox.sh")
  fs.writeFileSync(fake, `#!/bin/sh\necho "$1" > "${fake}.arg"\n`, { mode: 0o755 })
  const sb = sandboxLib.create(h, { ...runtimes, paths: () => [path.join(h.root, "bin", "python-3.11.10", "python")], python: () => path.join(h.root, "bin", "python-3.11.10", "python", "python.exe") }, { emit: (e) => events.push(e), platform: "win32", sandboxExe: fake })
  assert.equal(sb.mode(), "windows")
  const repo = makeRepo({ "install.js": `module.exports = { run: [{ method: "shell.run", params: { message: ["echo hi"] } }] }` })

  const r = await sb.test(entry(repo))
  assert.deepEqual(r, { ok: true, windows: true })
  await assert.rejects(sb.test({ ...entry(repo), id: "other/app" }), /one sandbox at a time/)

  const run = path.join(h.dir("sandboxes"), "someone-demo.run")
  const wsb = fs.readFileSync(path.join(run, "test.wsb"), "utf8")
  const mapped = [...wsb.matchAll(/<HostFolder>(.*?)<\/HostFolder><SandboxFolder>(.*?)<\/SandboxFolder><ReadOnly>(.*?)<\/ReadOnly>/g)].map((m) => [m[2], m[3]])
  assert.deepEqual(mapped, [["C:\\obstat-src", "true"], ["C:\\obstat-bin", "true"], ["C:\\obstat-run", "false"]])
  assert.match(wsb, /<LogonCommand><Command>C:\\obstat-run\\run\.cmd<\/Command><\/LogonCommand>/)
  for (const f of ["worker.js", "script.js", "env.js", "runner.js", "run.cmd"]) assert.ok(fs.existsSync(path.join(run, f)), f)
  const job = JSON.parse(fs.readFileSync(path.join(run, "job.json"), "utf8"))
  assert.equal(job.python, "C:\\obstat-bin\\python-3.11.10\\python\\python.exe")
  assert.deepEqual(job.scripts, ["install.js"])
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(fs.readFileSync(`${fake}.arg`, "utf8").trim(), path.join(run, "test.wsb"))

  // what the code inside the sandbox writes back
  fs.appendFileSync(path.join(run, "events.jsonl"), [
    { type: "script", script: "install.js" }, { type: "log", text: "hi\n" }, { type: "open", url: "https://evil.example" }, "not json", { type: "ready" },
  ].map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + "\n")
  await new Promise((res) => setTimeout(res, 1500))
  assert.ok(events.some((e) => e.type === "log" && e.text === "hi\n"))
  assert.ok(!events.some((e) => e.type === "open"))
  assert.equal(sb.get("someone/demo").status, "running")
  assert.match(fs.readFileSync(path.join(h.dir("logs"), "sandboxes", "someone-demo", "windows.txt"), "utf8"), /hi/)

  await sb.remove("someone/demo")
  assert.ok(!fs.existsSync(run))
  assert.equal(sb.list().length, 0)
})
