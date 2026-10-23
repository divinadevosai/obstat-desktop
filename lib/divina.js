// Divina, included free with Obstat: SWE3WE's desktop app, installed from its
// official release in one click. Like Obstat's runtimes, the link, size and
// SHA-256 are pinned here, never fetched from a website, so a swapped file on
// the release page is thrown away instead of installed. A new Divina version
// ships in an Obstat update.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile, spawn } = require("node:child_process")

const REL = "https://github.com/divinadevosai/divina-releases/releases/download"
const DIVINA = {
  version: "1.0.0",
  site: "https://divinaos.site",
  win32: {
    url: `${REL}/obstat-v1.0.0/Divina-Obstat-Setup-1.0.0-x64.exe`,
    // filled in from the release's SHA256SUMS.txt; until then Divina isn't offered
    sha256: null,
    size: null,
    exe: "Divina.exe",
    uninstall: "Uninstall Divina.exe",
  },
}
// where the download may come from (GitHub sends release files on to its own download hosts)
const HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"])
const okHost = (url) => { try { const u = new URL(url); return u.protocol === "https:" && HOSTS.has(u.hostname) } catch { return false } }

function create(home, { fetchImpl = fetch, platform = process.platform, env = process.env, run = execFile, start = spawn, log = () => {}, info = DIVINA, pollMs = 1000 } = {}) {
  const spec = () => {
    const s = info[platform]
    return s && /^[0-9a-f]{64}$/.test(s.sha256 || "") && Number.isInteger(s.size) && s.size > 0 ? s : null
  }
  // the folder Divina's own installer uses by default, so it's the same Divina either way
  const dir = () => path.join(env.LOCALAPPDATA || path.join(home.root, "divina"), "Programs", "Divina")
  const record = path.join(home.root, "divina.json")
  const installedVersion = () => { try { return JSON.parse(fs.readFileSync(record, "utf8")).version || null } catch { return null } }
  const exe = () => path.join(dir(), (info[platform] || info.win32).exe)
  const installed = () => fs.existsSync(exe())
  let busy = null // "installing" | "removing"

  function status() {
    const s = spec()
    const have = installed()
    const mine = have ? installedVersion() : null
    return {
      available: !!s, version: info.version, size: s?.size || null, site: info.site, busy,
      installed: have, installedVersion: mine,
      // installed some other way (no record), or an older version: offer the pinned one
      update: !!s && have && mine !== info.version,
    }
  }

  async function download(s, file, onProgress) {
    if (!okHost(s.url)) throw new Error("Divina's download link isn't one Obstat trusts.")
    let res
    try { res = await fetchImpl(s.url) } catch { throw new Error("Couldn't reach Divina's download. Check your internet connection and try again.") }
    if (!res.ok || !res.body) throw new Error(`Divina's download isn't available right now (${res.status}).`)
    if (res.url && !okHost(res.url)) throw new Error("Divina's download went somewhere unexpected, so Obstat stopped.")
    const hash = crypto.createHash("sha256")
    const out = fs.createWriteStream(file)
    let got = 0
    try {
      for await (const chunk of res.body) {
        got += chunk.length
        if (got > s.size) throw new Error("mismatch")
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
        onProgress?.(got, s.size)
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())))
      if (got !== s.size || hash.digest("hex") !== s.sha256) throw new Error("mismatch")
    } catch (err) {
      out.destroy()
      await fsp.rm(file, { force: true })
      throw err.message === "mismatch" ? new Error("This download didn't match the one Obstat expects, so Obstat threw it away. Try again later.") : err
    }
  }

  const exec = (file, args) => new Promise((resolve) => run(file, args, { windowsHide: true, timeout: 15 * 60 * 1000 }, (err) => resolve(err)))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  async function install(onProgress) {
    if (busy) throw new Error("Divina is already being set up.")
    const s = spec()
    if (!s) throw new Error(info[platform] ? "Divina isn't ready to download yet." : "Divina for this computer is coming later.")
    busy = "installing"
    const file = path.join(home.dir("cache"), path.basename(new URL(s.url).pathname))
    try {
      log(`downloading Divina ${info.version}`)
      await download(s, file, onProgress)
      log(`installing Divina ${info.version}`)
      // a silent install for this Windows user only, into Divina's usual folder
      const err = await exec(file, ["/S"])
      if (err) throw new Error(err.code === "EACCES" || err.errno === 740 ? "Divina's installer asked for admin rights, which it shouldn't. Nothing was installed." : `Divina's installer stopped (${err.code ?? "error"}).`)
      if (!installed()) throw new Error("Divina's installer finished, but Divina isn't there. Try again.")
      fs.writeFileSync(record, JSON.stringify({ version: info.version, at: new Date().toISOString() }))
      log(`installed Divina ${info.version}`)
      return status()
    } finally {
      busy = null
      await fsp.rm(file, { force: true })
    }
  }

  // Divina is a desktop app: it opens in its own window and stays open if Obstat closes
  function open() {
    if (!installed()) throw new Error("Install Divina first.")
    const child = start(exe(), [], { cwd: dir(), detached: true, stdio: "ignore", windowsHide: false })
    child.on("error", (err) => log(`Divina: ${err.message}`))
    child.unref()
    log("opened Divina")
  }

  // Divina keeps people's data in its own AppData folder, which its uninstaller leaves alone
  async function remove() {
    if (busy) throw new Error("Divina is busy. Try again in a moment.")
    if (!installed()) { await fsp.rm(record, { force: true }); return status() }
    busy = "removing"
    try {
      const un = path.join(dir(), (info[platform] || info.win32).uninstall)
      if (fs.existsSync(un)) {
        const err = await exec(un, ["/S"])
        if (err) throw new Error(`Divina's uninstaller stopped (${err.code ?? "error"}).`)
        // NSIS uninstallers hand over to a copy of themselves and return at once
        for (let i = 0; i < 120 && installed(); i++) await wait(pollMs)
      }
      await fsp.rm(dir(), { recursive: true, force: true, maxRetries: 3 })
      await fsp.rm(record, { force: true })
      log("removed Divina")
      return status()
    } finally {
      busy = null
    }
  }

  return { status, install, open, remove, dir }
}

module.exports = { create, DIVINA, okHost }
