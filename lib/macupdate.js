// Updates on a Mac. Electron's own Mac updater (Squirrel.Mac) only accepts updates
// signed with an Apple Developer ID, which Obstat doesn't have yet, so this does the
// same job: it reads latest-mac.yml from the update feed, downloads the new version's
// .zip for this Mac's chip, and only keeps it if
//   - its SHA-512 matches the one latest-mac.yml gives (as the Windows updater checks),
//   - the app inside passes macOS's own signature check (codesign --verify), and
//   - it is Obstat (dev.swe3we.obstat) at exactly the version the feed says.
// On Restart (or when Obstat quits) a small script waits for Obstat to close, swaps
// the new Obstat.app in for the old one, keeping the old one until the new one is in
// place, and opens it. It speaks electron-updater's events, so lib/updates.js drives
// it like the Windows and Linux updaters.
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile, spawn } = require("node:child_process")
const yaml = require("js-yaml")
const semver = require("semver")

const APP_ID = "dev.swe3we.obstat"

// The .app folder Obstat runs from, from its executable (…/Obstat.app/Contents/MacOS/Obstat)
const bundleOf = (execPath) => { const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath); return m ? m[1] : null }

// Whether Obstat can replace itself where it is. Not when it runs from the .dmg, from
// macOS's App Translocation (a read-only copy macOS makes of a downloaded app that
// hasn't been moved), or from a folder this account can't change.
function whereProblem(bundle, access = fs.accessSync) {
  const move = "Move Obstat to your Applications folder (drag it there from the window it came in), open it from there, and it will update itself."
  if (!bundle) return "Obstat isn't running as an installed app."
  if (bundle.startsWith("/Volumes/")) return `Obstat is running from its download. ${move}`
  if (bundle.includes("/AppTranslocation/")) return `macOS is running Obstat from a temporary copy. ${move}`
  try { access(path.dirname(bundle), fs.constants.W_OK) } catch { return `This account can't change the folder Obstat is in (${path.dirname(bundle)}). ${move}` }
  return null
}

// Waits for Obstat (pid $1) to quit, then puts $3 where $2 was. If the swap fails
// halfway, the old app goes back. $4 = 1: open Obstat again afterwards.
const SWAP = `pid="$1"; old="$2"; new="$3"; reopen="$4"
n=0; while kill -0 "$pid" 2>/dev/null && [ $n -lt 120 ]; do sleep 0.5; n=$((n+1)); done
backup="$old.obstat-previous"
rm -rf "$backup"
if mv "$old" "$backup"; then
  if mv "$new" "$old"; then rm -rf "$backup"; else mv "$backup" "$old"; fi
fi
[ "$reopen" = 1 ] && open "$old"
exit 0`

class MacUpdater extends EventEmitter {
  constructor({ feed, app, cacheDir, fetchImpl = fetch, arch = process.arch, execPath = process.execPath, run = execFile, start = spawn, access = fs.accessSync }) {
    super()
    Object.assign(this, { feed: feed.replace(/\/+$/, ""), app, cacheDir, fetchImpl, arch, run, start, access })
    this.bundle = bundleOf(execPath)
    this.autoDownload = true
    this.autoInstallOnAppQuit = true
    this.logger = null
    this.ready = null // { version, app: the staged Obstat.app }
    this.scheduled = false
    // installs on an ordinary quit too, without reopening, like the other updaters
    app?.on?.("will-quit", () => { if (this.autoInstallOnAppQuit && this.ready && !this.scheduled) this.swap(false) })
  }

  log(m) { this.logger?.info?.(m) }
  fail(err) { this.emit("error", err); return null }

  async get(url) {
    const res = await this.fetchImpl(url)
    if (!res.ok) throw new Error(`The update feed answered ${res.status} for ${path.basename(url)}`)
    return res
  }

  exec(file, args) {
    return new Promise((resolve, reject) => this.run(file, args, { timeout: 120000, maxBuffer: 1 << 20 }, (err, out, stderr) => (err ? reject(new Error(`${path.basename(file)}: ${String(stderr || err.message).trim().slice(0, 300)}`)) : resolve(String(out).trim()))))
  }

  async checkForUpdates() {
    this.emit("checking-for-update")
    try {
      const info = yaml.load(await (await this.get(`${this.feed}/latest-mac.yml`)).text(), { schema: yaml.FAILSAFE_SCHEMA })
      const version = String(info?.version || "")
      if (!semver.valid(version)) throw new Error("latest-mac.yml has no valid version")
      if (!semver.gt(version, this.app.getVersion())) { this.emit("update-not-available", { version }); return null }
      if (this.ready?.version === version) { this.emit("update-downloaded", { version }); return null }
      // only a file named for this chip, from the same feed (never a link elsewhere)
      const file = (Array.isArray(info.files) ? info.files : []).find((f) => typeof f?.url === "string" && new RegExp(`^Obstat-${version.replace(/\./g, "\\.")}-mac-${this.arch}\\.zip$`).test(f.url))
      if (!file || !/^[A-Za-z0-9+/]{86}==$/.test(String(file.sha512 || ""))) throw new Error(`latest-mac.yml has no .zip for ${this.arch}`)
      const problem = whereProblem(this.bundle, this.access)
      if (problem) return this.fail(Object.assign(new Error(problem), { userMessage: problem }))
      this.emit("update-available", { version })
      if (this.autoDownload) await this.download(version, file)
    } catch (err) {
      this.fail(err)
    }
    return null
  }

  async download(version, file) {
    const dir = path.join(this.cacheDir, "mac-update")
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    const zip = path.join(dir, file.url)
    const res = await this.get(`${this.feed}/${encodeURIComponent(file.url)}`)
    const total = Number(file.size) || Number(res.headers.get("content-length")) || 0
    const hash = crypto.createHash("sha512")
    const out = fs.createWriteStream(zip)
    let got = 0
    for await (const chunk of res.body) {
      hash.update(chunk)
      got += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
      if (total) this.emit("download-progress", { percent: (got / total) * 100, transferred: got, total })
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())))
    if (hash.digest("base64") !== file.sha512) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error("The update didn't match its checksum, so Obstat threw it away.") }
    // unpack with Apple's ditto, which keeps the app's signature and permissions intact
    const staged = path.join(dir, "new")
    await this.exec("/usr/bin/ditto", ["-x", "-k", zip, staged])
    await fsp.rm(zip, { force: true })
    const app = path.join(staged, "Obstat.app")
    await this.exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app])
    const plist = path.join(app, "Contents", "Info.plist")
    const id = await this.exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist])
    const ver = await this.exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist])
    if (id !== APP_ID || ver !== version) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error(`The update isn't Obstat ${version} (it says ${id} ${ver}).`) }
    this.ready = { version, app }
    this.log(`downloaded ${version}`)
    this.emit("update-downloaded", { version })
  }

  swap(reopen) {
    if (!this.ready || !this.bundle) return false
    this.scheduled = true
    const child = this.start("/bin/sh", ["-c", SWAP, "obstat-update", String(process.pid), this.bundle, this.ready.app, reopen ? "1" : "0"], { detached: true, stdio: "ignore" })
    child.unref()
    return true
  }

  quitAndInstall() {
    if (this.swap(true)) this.app.quit()
  }
}

module.exports = { MacUpdater, bundleOf, whereProblem, SWAP, APP_ID }
