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
  // /home/a goes with /home, which is emptied whole
  assert.ok(at("--tmpfs", "/home") >= 0 && at("--tmpfs", "/tmp") >= 0 && at("--tmpfs", "/run/user") >= 0 && at("--tmpfs", "/run/dbus") >= 0)
  assert.equal(at("--tmpfs", "/home/a"), -1)
  // the binds come after the folders they sit in are emptied, or they'd be hidden too
  assert.ok(at("--bind", "/home/a/obstat/sandboxes/x") > at("--tmpfs", "/home"))
  assert.ok(at("--ro-bind-try", "/home/a/obstat/bin") > at("--tmpfs", "/home"))
  // and then made read-only, except the throwaway /tmp
  assert.ok(at("--remount-ro", "/home") > at("--bind", "/home/a/obstat/sandboxes/x"))
  assert.equal(at("--remount-ro", "/tmp"), -1)
  for (const f of ["--die-with-parent", "--unshare-pid", "--new-session"]) assert.ok(args.includes(f), f)
  assert.ok(!args.includes("--unshare-net"))
  // a network of its own: all of /run goes (D-Bus, the Docker socket), so /run/user needn't
  const own = confine.bwrapArgs({ writable: ["/tmp/obstat-net-x"], ownNetwork: true, exists: () => true })
  assert.ok(own.includes("--unshare-net"))
  assert.ok(own.join(" ").includes("--tmpfs /run "))
  assert.ok(!own.join(" ").includes("--tmpfs /run/user"))
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
  // no program can be signalled: Obstat ends a test's processes itself
  assert.ok(profile.includes("(deny signal (target others))") && !/allow signal/.test(profile))
  // allows come after the denies they make exceptions to (later rules win)
  assert.ok(profile.indexOf('(param "WRITE0")') > profile.indexOf('(subpath "/Users")'))
})

test("without bubblewrap, or where it can't run, tests fall back with a reason and a fix", async () => {
  const none = await confine.detect({ platform: "linux", bundled: null, exists: () => false })
  assert.equal(none.kind, null)
  assert.match(none.fix, /sudo apt install bubblewrap/)
  const blocked = await confine.detect({ platform: "linux", bundled: null, exists: (f) => f === "/usr/bin/bwrap", run: (_f, _a, _o, cb) => cb(new Error("x"), "", "bwrap: setting up uid map: Permission denied") })
  assert.equal(blocked.kind, null)
  assert.match(blocked.reason, /Permission denied/)
  const ok = await confine.detect({ platform: "linux", exists: (f) => f === "/usr/bin/bwrap", run: (_f, _a, _o, cb) => cb(null, "", ""), bundled: null })
  assert.deepEqual(ok, { kind: "bwrap", file: "/usr/bin/bwrap" })
  // Obstat's own comes first; when it can't run, the system's is tried
  const tried = []
  const both = await confine.detect({ platform: "linux", bundled: "/opt/Obstat/resources/bwrap", exists: () => true, run: (f, _a, _o, cb) => { tried.push(f); f.startsWith("/opt") ? cb(new Error("x"), "", "denied") : cb(null, "", "") } })
  assert.equal(tried[0], "/opt/Obstat/resources/bwrap")
  assert.deepEqual(both, { kind: "bwrap", file: "/usr/bin/bwrap" })
  const own = await confine.detect({ platform: "linux", bundled: "/opt/Obstat/resources/bwrap", exists: () => true, run: (_f, _a, _o, cb) => cb(null, "", "") })
  assert.equal(own.file, "/opt/Obstat/resources/bwrap")
  assert.equal((await confine.detect({ platform: "win32" })).kind, null)
})

// A pretend hostile app, inside the real sandbox: it tries to read your files and
// Obstat's keys, write outside its folder, and see other programs. Runs wherever
// the sandbox does: Linux with bubblewrap, and every Mac.
const HOSTILE = `
const fs = require("node:fs"), path = require("node:path")
const [secret, keys, outside, inside, runtime, otherPid] = process.argv.slice(1)
const can = (f) => { try { f(); return true } catch { return false } }
const procs = (() => { try { return fs.readdirSync("/proc").filter((d) => /^\\d+$/.test(d)).length } catch { return -1 } })()
process.stdout.write(JSON.stringify({
  readSecret: can(() => fs.readFileSync(secret)),
  readKeys: can(() => fs.readFileSync(keys)),
  listHome: can(() => fs.readdirSync(path.dirname(secret))),
  writeOutside: can(() => fs.writeFileSync(outside, "x")),
  writeInside: can(() => fs.writeFileSync(path.join(inside, "ok.txt"), "x")),
  readRuntime: can(() => fs.readFileSync(runtime)),
  signalOther: can(() => process.kill(Number(otherPid), "SIGTERM")),
  signalOwn: (() => { const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" }); const ok = can(() => process.kill(c.pid, "SIGTERM")); return ok })(),
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
  // another program of yours, outside the sandbox
  const other = require("node:child_process").spawn("sleep", ["60"])
  try {
    const opts = { writable: [inside], readable: [path.join(root, "bin"), ...confine.programPaths()], hide: [os.homedir(), root] }
    const w = confine.wrap(walls, opts, process.execPath, ["-e", HOSTILE, secret, path.join(root, "keys.json"), path.join(os.homedir(), `.obstat-escaped-${id}`), inside, path.join(root, "bin", "runtime.txt"), String(other.pid)])
    const out = await new Promise((resolve, reject) => execFile(w.file, w.args, { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout)))))
    assert.equal(out.readSecret, false, "read a file in the home folder")
    assert.equal(out.readKeys, false, "read Obstat's keys")
    assert.equal(out.listHome, walls.kind === "bwrap", "the home folder is listable only as bubblewrap's empty stand-in")
    assert.equal(out.writeOutside, false, "wrote outside its folder")
    assert.equal(fs.existsSync(path.join(os.homedir(), `.obstat-escaped-${id}`)), false)
    assert.equal(out.writeInside, true, "couldn't write its own folder")
    assert.equal(fs.readFileSync(path.join(inside, "ok.txt"), "utf8"), "x", "its own folder is the real one")
    assert.equal(out.readRuntime, true, "couldn't read Obstat's runtimes")
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(other.exitCode === null && other.signalCode === null, `ended a program outside the sandbox (${other.signalCode})`)
    assert.equal(out.signalOther, false, "could signal a program outside the sandbox")
    // bubblewrap's own processes are all the test's; on a Mac Obstat ends them on Stop
    if (walls.kind === "bwrap") assert.equal(out.signalOwn, true, "couldn't end a program it started itself")
    if (walls.kind === "bwrap") assert.ok(out.procs > 0 && out.procs < 5, `sees ${out.procs} processes`)
  } finally {
    other.kill()
    fs.rmSync(secret, { force: true })
    fs.rmSync(path.join(os.homedir(), `.obstat-escaped-${id}`), { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a test sees only a short list of Obstat's settings: no exported secrets, no way to the desktop", () => {
  const env = confine.sandboxEnv({ PATH: "/usr/bin", LANG: "en_GB.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://p:3128", no_proxy: "localhost", OPENAI_API_KEY: "sk-x", GITHUB_TOKEN: "ghp_x", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SSH_AUTH_SOCK: "/tmp/ssh-x/agent", AWS_SECRET_ACCESS_KEY: "x", HOME: "/home/a" })
  assert.deepEqual(Object.keys(env).sort(), ["HTTPS_PROXY", "LANG", "LC_ALL", "PATH", "no_proxy"])
})

test("Apple's sandbox: the folders above what a test may use can be looked up, not read", { skip: process.platform === "win32" }, () => {
  const args = confine.seatbeltArgs({ writable: ["/Users/a/obstat/sandboxes/x"], readable: ["/Applications/Obstat.app"], hide: [] })
  const profile = args[args.indexOf("-p") + 1]
  const ups = args.filter((a, i) => args[i - 1] === "-D" && a.startsWith("UP")).map((a) => a.split("=")[1])
  for (const d of ["/Users/a/obstat/sandboxes", "/Users/a/obstat", "/Users/a", "/Users", "/Applications"]) assert.ok(ups.includes(d), d)
  assert.ok(!ups.includes("/"))
  assert.match(profile, /\(allow file-read-metadata \(literal \(param "UP0"\)\)\)/)
  // looking up isn't reading: the home folder's files stay unreadable, bar a package.json
  assert.ok(!/allow file-read\* \(subpath \(param "UP/.test(profile))
  assert.ok(args.includes("PKG2=/Users/a/package.json"))
})
