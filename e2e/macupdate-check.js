// The Mac updater for real, on a Mac, with the build CI just made: an "installed"
// Obstat (a copy of dist/mac-arm64/Obstat.app in a stand-in Applications folder)
// finds the new version in dist/latest-mac.yml, downloads the .zip from a local
// feed, checks its SHA-512, unpacks it with ditto, checks Apple's signature and the
// version, and the swap script puts it in place.
//
//   node e2e/macupdate-check.js        (after npm run dist:mac)
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { execFileSync } = require("node:child_process")
const yaml = require("js-yaml")
const { MacUpdater, SWAP } = require("../lib/macupdate")

const DIST = path.join(__dirname, "..", "dist")
const arch = process.arch
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1) }

;(async () => {
  const feedInfo = yaml.load(fs.readFileSync(path.join(DIST, "latest-mac.yml"), "utf8"))
  console.log(`feed: Obstat ${feedInfo.version}, ${feedInfo.files.map((f) => f.url).join(", ")}`)
  // the "installed" copy, in a folder this user can change
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), "Applications-"))
  const installed = path.join(apps, "Obstat.app")
  execFileSync("/usr/bin/ditto", [path.join(DIST, arch === "arm64" ? "mac-arm64" : "mac", "Obstat.app"), installed])
  fs.writeFileSync(path.join(installed, "Contents", "obstat-old-marker"), "old")

  const server = http.createServer((q, r) => {
    const f = path.join(DIST, path.basename(decodeURIComponent(q.url)))
    if (!fs.existsSync(f)) { r.statusCode = 404; return r.end() }
    r.setHeader("content-length", fs.statSync(f).size)
    fs.createReadStream(f).pipe(r)
  }).listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))

  const events = []
  const app = { getVersion: () => "0.0.1", quit() {}, on() {} }
  const u = new MacUpdater({ feed: `http://127.0.0.1:${server.address().port}`, app, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "obstat-cache-")), arch, execPath: path.join(installed, "Contents", "MacOS", "Obstat") })
  for (const e of ["checking-for-update", "update-available", "update-not-available", "update-downloaded", "error"]) u.on(e, (x) => { events.push(e); console.log(e, e === "error" ? x.message : x?.version || "") })
  await u.checkForUpdates()
  server.close()
  if (!events.includes("update-downloaded")) fail(`no update was downloaded: ${events.join(", ")}`)

  // the swap, as on Restart (the "running" Obstat here is a process that has already ended)
  execFileSync("/bin/sh", ["-c", SWAP, "obstat-update", "999999", installed, u.ready.app, "0"])
  if (fs.existsSync(path.join(installed, "Contents", "obstat-old-marker"))) fail("the old app is still in place")
  if (fs.existsSync(`${installed}.obstat-previous`)) fail("the previous app was left behind")
  const version = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(installed, "Contents", "Info.plist")], { encoding: "utf8" }).trim()
  if (version !== feedInfo.version) fail(`the installed app is ${version}, not ${feedInfo.version}`)
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed])
  console.log(`PASS: updated to ${version}, and its signature checks out`)
  fs.rmSync(apps, { recursive: true, force: true })
})().catch((err) => fail(err.message))
