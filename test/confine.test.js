const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile } = require("node:child_process")
const confine = require("../lib/confine")

test("bubblewrap: the home folder and /tmp are emptied, only the test's folders are writable", () => {
  const args = confine.bwrapArgs({ writable: ["/home/a/obstat/sandboxes/x"], readable: ["/home/a/obstat/bin"], hide: ["/home/a"], exists: () => true })
  const at = (flag, p) => args.findIndex((a, i) => a === flag && args[i + 1] === p)
  assert.ok(at("--ro-bind", "/") >= 0)
  assert.ok(at("--tmpfs", "/home/a") >= 0 && at("--tmpfs", "/tmp") >= 0 && at("--tmpfs", "/run/user") >= 0)
  // the binds come after the folders they sit in are emptied, or they'd be hidden too
  assert.ok(at("--bind", "/home/a/obstat/sandboxes/x") > at("--tmpfs", "/home/a"))
  assert.ok(at("--ro-bind-try", "/home/a/obstat/bin") > at("--tmpfs", "/home/a"))
  for (const f of ["--die-with-parent", "--unshare-pid", "--new-session"]) assert.ok(args.includes(f), f)
  assert.ok(!args.includes("--unshare-net"), "installs need the network")
})

test("Apple's sandbox: paths go in as parameters, never into the rules", () => {
  const odd = '/Users/a/My "Apps") (allow file-read* (subpath "/'
  const args = confine.seatbeltArgs({ writable: [odd], readable: ["/opt/x"], hide: [] })
  const profile = args[args.indexOf("-p") + 1]
  assert.ok(!profile.includes("My"), "the folder name isn't in the profile")
  assert.ok(args.includes(`WRITE0=${path.resolve(odd)}`))
  assert.match(profile, /\(deny file-write\*\)/)
  assert.match(profile, /\(deny file-read\* \(subpath "\/Volumes"\) \(subpath "\/Users"\)/)
  assert.match(profile, /com\.apple\.SecurityServer/)
  // allows come after the denies they make exceptions to (later rules win)
  assert.ok(profile.indexOf('(param "WRITE0")') > profile.indexOf('(subpath "/Users")'))
})

test("without bubblewrap, or where it can't run, tests fall back with a reason and a fix", async () => {
  const none = await confine.detect({ platform: "linux", exists: () => false })
  assert.equal(none.kind, null)
  assert.match(none.fix, /sudo apt install bubblewrap/)
  const blocked = await confine.detect({ platform: "linux", exists: (f) => f === "/usr/bin/bwrap", run: (_f, _a, _o, cb) => cb(new Error("x"), "", "bwrap: setting up uid map: Permission denied") })
  assert.equal(blocked.kind, null)
  assert.match(blocked.reason, /Permission denied/)
  const ok = await confine.detect({ platform: "linux", exists: (f) => f === "/usr/bin/bwrap", run: (_f, _a, _o, cb) => cb(null, "", "") })
  assert.deepEqual(ok, { kind: "bwrap", file: "/usr/bin/bwrap" })
  assert.equal((await confine.detect({ platform: "win32" })).kind, null)
})

// A pretend hostile app, inside the real sandbox: it tries to read your files and
// Obstat's keys, write outside its folder, and see other programs. Runs wherever
// the sandbox does: Linux with bubblewrap, and every Mac.
const HOSTILE = `
const fs = require("node:fs"), path = require("node:path")
const [secret, keys, outside, inside, runtime] = process.argv.slice(1)
const can = (f) => { try { f(); return true } catch { return false } }
const procs = (() => { try { return fs.readdirSync("/proc").filter((d) => /^\\d+$/.test(d)).length } catch { return -1 } })()
process.stdout.write(JSON.stringify({
  readSecret: can(() => fs.readFileSync(secret)),
  readKeys: can(() => fs.readFileSync(keys)),
  listHome: can(() => fs.readdirSync(path.dirname(secret))),
  writeOutside: can(() => fs.writeFileSync(outside, "x")),
  writeInside: can(() => fs.writeFileSync(path.join(inside, "ok.txt"), "x")),
  readRuntime: can(() => fs.readFileSync(runtime)),
  procs,
}))
`
test("a hostile app in the real sandbox can't read your files or Obstat's keys, or write outside its folder", async (t) => {
  const walls = await confine.detect()
  if (!walls.kind) return t.skip(`no sandbox here: ${walls.reason}`)
  const id = crypto.randomBytes(4).toString("hex")
  // a secret in the real home folder, and a stand-in for ~/obstat with keys and runtimes
  const secret = path.join(os.homedir(), `.obstat-sandbox-test-${id}.txt`)
  const root = fs.mkdtempSync(path.join(os.homedir(), ".obstat-test-root-"))
  fs.writeFileSync(secret, "private")
  fs.writeFileSync(path.join(root, "keys.json"), "[]")
  fs.mkdirSync(path.join(root, "bin"))
  fs.writeFileSync(path.join(root, "bin", "runtime.txt"), "python")
  const inside = path.join(root, "sandboxes", "evil-app")
  fs.mkdirSync(inside, { recursive: true })
  try {
    const opts = { writable: [inside], readable: [path.join(root, "bin"), ...confine.programPaths()], hide: [os.homedir(), root] }
    const w = confine.wrap(walls, opts, process.execPath, ["-e", HOSTILE, secret, path.join(root, "keys.json"), path.join(os.homedir(), `.obstat-escaped-${id}`), inside, path.join(root, "bin", "runtime.txt")])
    const out = await new Promise((resolve, reject) => execFile(w.file, w.args, { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout)))))
    assert.equal(out.readSecret, false, "read a file in the home folder")
    assert.equal(out.readKeys, false, "read Obstat's keys")
    assert.equal(out.listHome, walls.kind === "bwrap", "the home folder is listable only as bubblewrap's empty stand-in")
    assert.equal(out.writeOutside, false, "wrote outside its folder")
    assert.equal(fs.existsSync(path.join(os.homedir(), `.obstat-escaped-${id}`)), false)
    assert.equal(out.writeInside, true, "couldn't write its own folder")
    assert.equal(fs.readFileSync(path.join(inside, "ok.txt"), "utf8"), "x", "its own folder is the real one")
    assert.equal(out.readRuntime, true, "couldn't read Obstat's runtimes")
    if (walls.kind === "bwrap") assert.ok(out.procs > 0 && out.procs < 5, `sees ${out.procs} processes`)
  } finally {
    fs.rmSync(secret, { force: true })
    fs.rmSync(path.join(os.homedir(), `.obstat-escaped-${id}`), { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
