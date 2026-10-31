// Reviewed apps' installs inside the OS sandbox (lib/walls.js): which scripts are
// walled, what they may write, and a real install on this computer that tries to read
// your files and keys, write outside its folders and reach another app's server.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { execFileSync } = require("node:child_process")
const homeLib = require("../lib/home")
const appsLib = require("../lib/apps")
const wallsLib = require("../lib/walls")

const fakeHome = () => { const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-walls-"))); h.ensure(); return h }

test("only install, update and reset are walled, and only where there are walls", async () => {
  const h = fakeHome()
  const appDir = (id) => path.join(h.root, "apps", id.replace("/", "-"))
  const none = wallsLib.create(h, { appDir, platform: "linux", detect: async () => ({ kind: null, reason: "no bwrap" }), mkdir: () => {} })
  await none.ready
  assert.equal(none.wrap("a/b", "/node", ["w.js"], {}, "install.js"), null)
  assert.equal(none.env("a/b", "install.js"), null)

  const seen = []
  // (a stand-in for Obstat's proxy: this test only looks at the arguments, on any system)
  const proxies = []
  const proxy = (sock) => { const p = { sock, closed: false, close() { this.closed = true } }; proxies.push(p); return p }
  const yes = wallsLib.create(h, { appDir, platform: "linux", homeDir: "/home/u", detect: async () => ({ kind: "bwrap", file: "/usr/bin/bwrap" }), mkdir: (d) => seen.push(d), proxy })
  await yes.ready
  for (const s of ["start.js", "tensorboard.js", "link.js"]) assert.equal(yes.wrap("a/b", "/node", ["w.js"], {}, s), null, s)
  const w = yes.wrap("a/b", "/node", ["w.js"], {}, "install.js")
  assert.equal(w.kind, "bwrap")
  const args = w.args.join(" ")
  const esc = (x) => x.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  assert.match(args, new RegExp(`--bind ${esc(appDir("a/b"))} `), "its own folder is writable")
  assert.match(args, /--bind \/home\/u\/\.cache\/uv /, "so are the shared caches")
  assert.match(args, /--unshare-net/, "with a network of its own")
  assert.ok(!/--bind \/home\/u /.test(args), "but not the home folder")
  const env = yes.env("a/b", "update.js")
  assert.equal(env.UV_CACHE_DIR, "/home/u/.cache/uv")
  assert.equal(env.HF_HOME, "/home/u/.cache/huggingface")
  assert.ok(env.HOME.startsWith(path.join(h.dir("cache"), "install-home")))
  assert.equal(yes.env("a/b", "start.js"), null)
  assert.match(yes.hfEnv("a/b", "reset.js"), /install-home/)
  yes.done("a/b")
  assert.equal(proxies.length, 1)
  assert.ok(proxies[0].closed, "the install's network closes when it ends")

  // Windows: at low integrity, where the helper starts
  const winNone = wallsLib.create(h, { appDir, platform: "win32", detect: async () => ({ kind: null, reason: "no csc" }), mkdir: () => {} })
  await winNone.ready
  assert.equal(winNone.wrap("a/b", "C:\\o\\Obstat.exe", ["w.js"], {}, "install.js"), null)
  assert.deepEqual(winNone.jobExtra("a/b", "install.js"), { npmSafe: true }, "without it, npm still skips dependencies' scripts")
  const winHome = { root: "C:\\Users\\u\\obstat", dir: (n) => `C:\\Users\\u\\obstat\\${n}` }
  const winApp = (id) => `C:\\Users\\u\\obstat\\apps\\${id.replace("/", "-")}`
  const win = wallsLib.create(winHome, { appDir: winApp, platform: "win32", homeDir: "C:\\Users\\u", localAppData: "C:\\Users\\u\\AppData\\Local", detect: async () => ({ kind: "lowbox", file: "C:\\cache\\lowbox.exe" }), mkdir: () => {}, hide: ["C:\\Users\\u\\AppData\\Roaming\\Obstat"] })
  await win.ready
  const ww = win.wrap("a/b", "C:\\o\\Obstat.exe", ["C:\\o\\worker.js"], {}, "install.js")
  assert.equal(ww.kind, "lowbox")
  assert.equal(ww.file, "C:\\cache\\lowbox.exe")
  const wa = ww.args
  const after = (flag) => wa.flatMap((a, i) => (a === flag ? [wa[i + 1]] : []))
  assert.equal(wa[0], "run")
  assert.ok(after("--low").includes(winApp("a/b")), "its own folder")
  assert.ok(after("--low").includes("C:\\Users\\u\\AppData\\Local\\uv\\cache"), "the shared caches where Windows tools keep them")
  assert.ok(!after("--low").some((d) => d === "C:\\Users\\u" || d === winHome.root), "not the home folder or Obstat's own")
  for (const f of ["keys.json", "account.json", "control.json", "logs"]) assert.ok(after("--hide").includes(`C:\\Users\\u\\obstat\\${f}`), `${f} can't be read`)
  assert.ok(after("--hide").includes("C:\\Users\\u\\AppData\\Roaming\\Obstat"), "nor Electron's own data")
  assert.deepEqual(wa.slice(wa.indexOf("--") + 1), ["C:\\o\\Obstat.exe", "C:\\o\\worker.js"])
  assert.equal(win.wrap("a/b", "x", [], {}, "start.js"), null, "starting the app isn't walled")
  assert.deepEqual(win.jobExtra("a/b", "install.js"), { npmSafe: true }, "npm still skips dependencies' scripts inside")
  const wenv = win.env("a/b", "install.js")
  assert.equal(wenv.UV_CACHE_DIR, "C:\\Users\\u\\AppData\\Local\\uv\\cache")
  assert.ok(wenv.USERPROFILE.includes("install-home"))
})

test("the shared caches are where each tool keeps them by default", () => {
  const lin = wallsLib.caches("linux", "/home/u"), mac = wallsLib.caches("darwin", "/Users/u")
  assert.equal(lin.pip[1], "/home/u/.cache/pip")
  assert.equal(mac.pip[1], "/Users/u/Library/Caches/pip")
  assert.equal(mac.uv[1], "/Users/u/.cache/uv")
  assert.equal(mac["node-gyp"][1], "/Users/u/Library/Caches/node-gyp")
})

const hasPython = (() => { try { execFileSync("python3", ["--version"]); return true } catch { return false } })()
const runtimes = { ensureAll: async () => {}, paths: () => [], python: () => "python3", git: () => "git", gitEnv: () => ({}) }
function makeRepo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text)
  execFileSync("git", ["init", "-q"], { cwd: d })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: d })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: d })
  return d
}

test("a reviewed app's install runs walled: no home folder, no keys, no other servers; its start doesn't", { skip: !hasPython || process.platform === "win32", timeout: 90000 }, async (t) => {
  const found = await require("../lib/confine").detect()
  if (!found.kind) return t.skip(`no sandbox here: ${found.reason}`)
  // Obstat's folder inside the real home folder, as it is for real
  const h = homeLib.create(fs.mkdtempSync(path.join(os.homedir(), ".obstat-wallstest-"))); h.ensure()
  const tag = path.basename(h.root)
  const secret = path.join(os.homedir(), `.obstat-secret-${tag}`)
  fs.writeFileSync(secret, "private")
  fs.writeFileSync(path.join(h.root, "keys.json"), '[{"name":"OPENAI_API_KEY"}]')
  const escaped = path.join(os.homedir(), `.obstat-escaped-${tag}`)
  const probe = `obstat-walls-probe-${tag}`
  const victim = http.createServer((q, r) => r.end("secret page")).listen(0, "127.0.0.1")
  await new Promise((r) => victim.once("listening", r))
  const reach = `"${process.execPath}" -e "fetch('http://127.0.0.1:${victim.address().port}/').then((r) => r.text()).then((t) => console.log(t), () => console.log('blocked'))" > victim.txt`
  const steal = (f, out) => `(cat '${f}' > /dev/null 2>&1 && echo yes || echo no) > ${out}`
  let apps
  const walls = wallsLib.create(h, { appDir: (id) => apps.appDir(id) })
  try {
    const events = []
    apps = appsLib.create(h, runtimes, {
      emit: (e) => events.push(e),
      wrap: (id, file, args, env, script) => walls.wrap(id, file, args, env, script),
      jobExtra: (id, script) => walls.jobExtra(id, script),
      hfEnv: (id, script) => walls.hfEnv(id, script) || path.join(h.dir("cache"), "hf-env"),
      jobEnv: (id, script) => walls.env(id, script) || { OPENAI_API_KEY: "sk-test" },
      onRun: (r) => walls.done(r.id),
    })
    const log = () => events.filter((e) => e.type === "log").map((e) => e.text).join("")
    const repo = makeRepo({
      "install.js": `module.exports = { run: [{ method: "shell.run", params: { message: [
        ${JSON.stringify(steal(secret, "secret.result"))},
        ${JSON.stringify(steal(path.join(h.root, "keys.json"), "keys.result"))},
        ${JSON.stringify(`(echo x > '${escaped}' 2>/dev/null && echo yes || echo no) > escape.result`)},
        "echo \\"[$OPENAI_API_KEY]\\" > key.txt",
        ${JSON.stringify(`(mkdir -p "$UV_CACHE_DIR" && echo cached > "$UV_CACHE_DIR/${probe}" && echo yes || echo no) > cache.result`)},
        "echo x > \\"$HOME/config-written\\" && echo $OBSTAT_WALLED_INSTALL > walled.txt",
        ${JSON.stringify(reach)},
      ] } }] }`,
      "start.js": `module.exports = { run: [{ method: "shell.run", params: { message: [
        "echo \\"[$OBSTAT_WALLED_INSTALL][$OPENAI_API_KEY]\\" > start.txt",
        ${JSON.stringify(steal(secret, "start-secret.result"))},
      ] } }] }`,
    })
    await walls.ready
    await apps.fetchApp({ id: "someone/demo", owner: "someone", name: "demo", url: repo, sha: null, reviewed: true }, () => {})
    const r = await apps.run("someone/demo", "install.js")
    assert.equal(r.ok, true, `${JSON.stringify(r)}\n${log()}`)
    const dir = apps.appDir("someone/demo")
    const said = (f) => fs.readFileSync(path.join(dir, f), "utf8").trim()
    assert.equal(said("walled.txt"), "1", "the install ran walled")
    assert.equal(said("secret.result"), "no", "read a file in your home folder")
    assert.equal(said("keys.result"), "no", "read Obstat's keys")
    assert.equal(said("escape.result"), "no", "wrote outside its folders")
    assert.equal(fs.existsSync(escaped), false)
    assert.equal(said("key.txt"), "[]", "got an API key")
    assert.equal(said("cache.result"), "yes", "couldn't use the shared cache")
    assert.equal(said("victim.txt"), "blocked", "reached another app's server on this computer")
    // what it wrote to "home" went to its own install home
    assert.ok(fs.existsSync(path.join(h.dir("cache"), "install-home", "someone-demo", "config-written")))

    // starting it is the reviewed app itself, unwalled, with its keys
    const s = await apps.run("someone/demo", "start.js")
    assert.equal(s.ok, true, log())
    assert.equal(said("start.txt"), "[][sk-test]")
    assert.equal(said("start-secret.result"), "yes")
  } finally {
    await apps?.stopAll()
    victim.close()
    for (const f of [secret, escaped, path.join(wallsLib.caches().uv[1], probe)]) fs.rmSync(f, { force: true })
    fs.rmSync(h.root, { recursive: true, force: true })
  }
})

test("where installs can't be walled, npm skips dependencies' scripts and secrets stay out", async () => {
  const h = fakeHome()
  const win = wallsLib.create(h, { appDir: (id) => path.join(h.root, "apps", id), platform: "win32", detect: async () => ({ kind: null }) })
  await win.ready
  assert.deepEqual(win.jobExtra("a/b", "install.js"), { npmSafe: true })
  assert.deepEqual(win.jobExtra("a/b", "update.js"), { npmSafe: true })
  assert.deepEqual(win.jobExtra("a/b", "start.js"), {})
  const env = wallsLib.withoutSecrets({ PATH: "p", SystemRoot: "C:\\Windows", USERPROFILE: "u", OPENAI_API_KEY: "sk", GITHUB_TOKEN: "t", AWS_REGION: "x", HF_TOKEN: "h", MY_SECRET: "s" })
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "SystemRoot", "USERPROFILE"])
})
