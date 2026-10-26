const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const platform = require("../lib/platform")
const apps = require("../lib/apps")

test("a Mac app finds what the login shell finds, plus Homebrew", async () => {
  const calls = []
  const run = (file, args, _o, cb) => { calls.push([file, ...args]); cb(null, "Last login: today\n__OBSTAT_PATH__/Users/a/.nvm/bin:/usr/bin:/bin__OBSTAT_PATH__") }
  const p = await platform.loginPath({ platform: "darwin", env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", HOME: "/Users/a" }, run })
  assert.equal(calls[0][0], "/bin/zsh")
  assert.equal(calls[0][1], "-ilc")
  assert.deepEqual(p.split(":"), ["/Users/a/.nvm/bin", "/usr/bin", "/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Users/a/.local/bin"])
  // a shell that fails still gets Homebrew's folders; relative entries are dropped
  const broken = await platform.loginPath({ platform: "darwin", env: { PATH: "/usr/bin:relative", HOME: "/Users/a" }, run: (_f, _a, _o, cb) => cb(new Error("timeout")) })
  assert.deepEqual(broken.split(":"), ["/usr/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Users/a/.local/bin"])
  // elsewhere PATH is left as it is
  assert.equal(await platform.loginPath({ platform: "linux", env: { PATH: "/x" } }), "/x")
})

test("terminals: Terminal on a Mac with the folder and command as arguments, the first one found on Linux", () => {
  const mac = platform.terminal('claude "Read it"', "/Users/a/My \"Apps\"", { platform: "darwin" })
  assert.equal(mac.file, "osascript")
  // never spliced into the AppleScript itself
  assert.ok(!mac.args.slice(0, -2).some((a) => a.includes("My")))
  assert.deepEqual(mac.args.slice(-2), ["/Users/a/My \"Apps\"", 'claude "Read it"; exec "${SHELL:-sh}"'])
  const found = (have) => (name) => (have.includes(name) ? `/usr/bin/${name}` : null)
  assert.deepEqual(platform.terminal("codex", "/x", { platform: "linux", find: found(["konsole", "xterm"]) }), { file: "/usr/bin/konsole", args: ["-e", "sh", "-c", 'codex; exec "${SHELL:-sh}"'] })
  assert.deepEqual(platform.terminal("codex", "/x", { platform: "linux", find: found(["gnome-terminal"]) }).args.slice(0, 1), ["--"])
  assert.equal(platform.terminal("codex", "/x", { platform: "linux", find: found([]) }), null)
})

test("on Linux, starting at sign-in is an autostart file that starts the AppImage", () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-xdg-"))
  const a = platform.autostart({ env: { XDG_CONFIG_HOME: cfg, APPIMAGE: '/home/a/Apps/Obst"at $1.AppImage' }, execPath: "/tmp/.mount_x/obstat" })
  assert.equal(a.enabled(), false)
  assert.equal(a.set(true), true)
  const text = fs.readFileSync(path.join(cfg, "autostart", "obstat.desktop"), "utf8")
  assert.match(text, /^\[Desktop Entry\]\n/)
  assert.ok(text.includes('Exec="/home/a/Apps/Obst\\"at \\$1.AppImage"\n'), text)
  assert.equal(a.enabled(), true)
  assert.equal(a.set(false), false)
  assert.equal(a.enabled(), false)
  // installed from the .deb: its own path
  assert.match(fs.readFileSync((platform.autostart({ env: { XDG_CONFIG_HOME: cfg }, execPath: "/opt/Obstat/obstat-desktop" }).set(true), path.join(cfg, "autostart", "obstat.desktop")), "utf8"), /Exec="\/opt\/Obstat\/obstat-desktop"/)
})

test("a missing git says how to get it", () => {
  const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })
  assert.match(apps.gitMissing(enoent, "", "linux"), /sudo apt install git/)
  assert.match(apps.gitMissing({ code: 1 }, "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)", "darwin"), /xcode-select --install/)
  assert.match(apps.gitMissing(enoent, "", "darwin"), /Command Line Tools/)
  assert.equal(apps.gitMissing({ code: 128 }, "fatal: repository not found", "linux"), null)
  assert.equal(apps.gitMissing(enoent, "", "win32"), null)
})

test("on a Mac, leftover shells are found with ps (there's no /proc)", async () => {
  const calls = []
  const run = (file, args, _o, cb) => { calls.push([file, ...args]); cb(null, args[3] === "4242" ? "/bin/bash\n" : "/Applications/Safari.app/Contents/MacOS/Safari\n") }
  // a real kill would fail for these made-up ids, which is what killShell reports
  assert.equal(await apps.killShell(4243, "darwin", run), false)
  assert.deepEqual(calls[0], ["ps", "-o", "comm=", "-p", "4243"])
  const killed = []
  const kill = process.kill
  process.kill = (pid, sig) => { killed.push([pid, sig]) }
  try { assert.equal(await apps.killShell(4242, "darwin", run), true) } finally { process.kill = kill }
  assert.deepEqual(killed, [[-4242, "SIGTERM"]])
})

test("Linux without a keyring doesn't count as encrypted", () => {
  const store = (available, backend) => ({ isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend })
  assert.equal(platform.encryptionReal(store(true, "basic_text"), "linux"), false)
  assert.equal(platform.encryptionReal(store(true, "unknown"), "linux"), false)
  assert.equal(platform.encryptionReal(store(true, "gnome_libsecret"), "linux"), true)
  assert.equal(platform.encryptionReal(store(true, "kwallet6"), "linux"), true)
  assert.equal(platform.encryptionReal(store(false, "gnome_libsecret"), "linux"), false)
  assert.equal(platform.encryptionReal(store(true, "basic_text"), "darwin"), true, "only Linux has the fallback")
  assert.equal(platform.encryptionReal({ isEncryptionAvailable: () => true }, "win32"), true)
})
