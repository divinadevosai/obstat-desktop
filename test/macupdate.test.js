const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { MacUpdater, bundleOf, whereProblem, SWAP } = require("../lib/macupdate")
const updates = require("../lib/updates")

const zipBytes = Buffer.from("pretend zip of Obstat.app")
const sha512 = (b) => crypto.createHash("sha512").update(b).digest("base64")
const feedYml = (over = {}) => {
  const v = over.version || "0.3.0"
  return [`version: ${v}`, "files:",
    `  - url: Obstat-${v}-mac-arm64.zip`, `    sha512: ${over.sha512 || sha512(zipBytes)}`, `    size: ${zipBytes.length}`,
    `  - url: Obstat-${v}-mac-x64.zip`, `    sha512: ${sha512(Buffer.from("other"))}`, "    size: 5",
    `path: Obstat-${v}-mac-arm64.zip`, "releaseDate: '2026-10-26T00:00:00.000Z'", ""].join("\n")
}

// a fake feed, fake Apple tools, and a fake Obstat 0.2.0 in a writable /Applications stand-in
function setup({ yml = feedYml(), body = zipBytes, plist = { CFBundleIdentifier: "dev.swe3we.obstat", CFBundleShortVersionString: "0.3.0" }, codesignFails = false, execPath = "/Applications/Obstat.app/Contents/MacOS/Obstat", access = () => {} } = {}) {
  const fetched = [], ran = [], started = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    if (url.endsWith("/latest-mac.yml")) return new Response(yml)
    return new Response(body, { headers: { "content-length": String(body.length) } })
  }
  const run = (file, args, _o, cb) => {
    ran.push([path.basename(file), ...args])
    if (file.endsWith("ditto")) { fs.mkdirSync(path.join(args[3], "Obstat.app", "Contents"), { recursive: true }); return cb(null, "", "") }
    if (file.endsWith("codesign")) return codesignFails ? cb(new Error("x"), "", "invalid signature (code or signature have been modified)") : cb(null, "", "")
    if (file.endsWith("plutil")) return cb(null, plist[args[1]] + "\n", "")
    cb(new Error("unexpected " + file))
  }
  const start = (file, args, opts) => { started.push({ file, args, opts }); return { unref() {} } }
  const app = { getVersion: () => "0.2.0", quit() { app.quitted = true }, on() {} }
  const u = new MacUpdater({ feed: "https://obstat.app/update/", app, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "mu-")), fetchImpl, arch: "arm64", execPath, run, start, access })
  const events = []
  for (const e of ["checking-for-update", "update-not-available", "update-available", "download-progress", "update-downloaded", "error"]) u.on(e, (x) => events.push([e, e === "error" ? x.message : x?.version]))
  return { u, fetched, ran, started, events, app }
}

test("downloads this chip's .zip, checks it, verifies the app inside, and swaps it in on Restart", async () => {
  const { u, fetched, ran, started, events, app } = setup()
  await u.checkForUpdates()
  assert.deepEqual(fetched, ["https://obstat.app/update/latest-mac.yml", "https://obstat.app/update/Obstat-0.3.0-mac-arm64.zip"])
  assert.deepEqual(events.map((e) => e[0]).filter((e) => e !== "download-progress"), ["checking-for-update", "update-available", "update-downloaded"])
  assert.deepEqual(ran.map((r) => r[0]), ["ditto", "codesign", "plutil", "plutil"])
  assert.deepEqual(ran[1].slice(1, 4), ["--verify", "--deep", "--strict"])
  u.quitAndInstall()
  assert.equal(app.quitted, true)
  assert.equal(started[0].file, "/bin/sh")
  assert.deepEqual(started[0].args.slice(4), ["/Applications/Obstat.app", u.ready.app, "1"])
  assert.equal(started[0].opts.detached, true)
})

test("nothing newer, a tampered download, a bad signature or the wrong app: nothing is installed", async () => {
  let s = setup({ yml: feedYml({ version: "0.2.0" }) })
  await s.u.checkForUpdates()
  assert.deepEqual(s.events.map((e) => e[0]), ["checking-for-update", "update-not-available"])

  s = setup({ body: Buffer.from("swapped on the release") })
  await s.u.checkForUpdates()
  assert.match(s.events.at(-1)[1], /checksum/)
  assert.equal(s.u.ready, null)
  assert.equal(s.ran.length, 0, "never unpacked")

  s = setup({ codesignFails: true })
  await s.u.checkForUpdates()
  assert.match(s.events.at(-1)[1], /codesign: invalid signature/)
  assert.equal(s.u.ready, null)

  s = setup({ plist: { CFBundleIdentifier: "com.evil.app", CFBundleShortVersionString: "0.3.0" } })
  await s.u.checkForUpdates()
  assert.match(s.events.at(-1)[1], /isn't Obstat 0\.3\.0/)
  assert.equal(s.u.ready, null)
  s.u.quitAndInstall()
  assert.equal(s.started.length, 0)

  // a file named for another app, or linking somewhere else, is never fetched
  s = setup({ yml: feedYml().replace(/Obstat-0\.3\.0-mac-arm64\.zip/, "https://evil.example/x.zip") })
  await s.u.checkForUpdates()
  assert.match(s.events.at(-1)[1], /no \.zip for arm64/)
  assert.equal(s.fetched.length, 1)
})

test("a copy that can't replace itself says to move Obstat to Applications", async () => {
  assert.match(whereProblem("/Volumes/Obstat/Obstat.app"), /running from its download/)
  assert.match(whereProblem("/private/var/folders/x/T/AppTranslocation/ABC/d/Obstat.app"), /temporary copy/)
  assert.match(whereProblem("/Applications/Obstat.app", () => { throw new Error("EACCES") }), /can't change the folder/)
  assert.equal(whereProblem("/Applications/Obstat.app", () => {}), null)
  assert.equal(bundleOf("/Users/a/Applications/Obstat.app/Contents/MacOS/Obstat"), "/Users/a/Applications/Obstat.app")
  const s = setup({ execPath: "/Volumes/Obstat 0.2.0/Obstat.app/Contents/MacOS/Obstat" })
  await s.u.checkForUpdates()
  assert.equal(s.fetched.length, 1, "doesn't download what it can't install")
  // lib/updates.js shows that message instead of the generic one
  const u = updates.create(s.u, { enabled: true })
  await u.check()
  assert.match(u.state().error, /Move Obstat to your Applications folder/)
})

test("the swap script puts the new app in place, and puts the old one back if it can't", { skip: process.platform === "win32" }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "swap-"))
  const old = path.join(d, "Obstat.app"), fresh = path.join(d, "staged", "Obstat.app")
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, "v"), "old")
  fs.mkdirSync(fresh, { recursive: true }); fs.writeFileSync(path.join(fresh, "v"), "new")
  // pid 999999 isn't running, so it swaps at once; 0: don't reopen
  execFileSync("/bin/sh", ["-c", SWAP, "x", "999999", old, fresh, "0"])
  assert.equal(fs.readFileSync(path.join(old, "v"), "utf8"), "new")
  assert.equal(fs.existsSync(`${old}.obstat-previous`), false)
  // the new one is missing: the old one stays
  execFileSync("/bin/sh", ["-c", SWAP, "x", "999999", old, path.join(d, "gone", "Obstat.app"), "0"])
  assert.equal(fs.readFileSync(path.join(old, "v"), "utf8"), "new")
})

test("every platform's updater uses the feed package.json publishes to", () => {
  const pkg = require("../package.json")
  assert.equal(pkg.build.publish[0].url, updates.FEED)
})
