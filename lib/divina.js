// Divina, included free with Obstat: SWE3WE's app, installed from its official
// release in one click and opened inside Obstat's window. Like Obstat's runtimes, the link, size and
// SHA-256 are pinned here, never fetched from a website, so a swapped file on
// the release page is thrown away instead of installed. A new Divina version
// ships in an Obstat update.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile, spawn } = require("node:child_process")

// files in the public divina-releases repo, linked by commit so they can't change
const REL = "https://raw.githubusercontent.com/divinadevosai/divina-releases/175e7dd6b8b40d8ec0eaa2163c8e9a2adae4908e/obstat"
const DIVINA = {
  version: "1.0.0",
  site: "https://divinaos.site",
  win32: {
    url: `${REL}/1.0.0/Divina-Obstat-Setup-1.0.0-x64.exe`,
    // from the release's SHA256SUMS.txt, and checked against the file itself
    sha256: "1bb4ebd487eadcdb3153931b0a5f86c863ceeb2510e2243aa317314da470e8f6",
    size: 36131135,
    exe: "Divina.exe",
    uninstall: "Uninstall Divina.exe",
    // what Divina.exe itself runs: its own Node.js and its local web server
    node: "node/node.exe",
    server: "app/server.js",
  },
}
// the ports Divina's launcher uses; Obstat uses the same ones, so either finds the other's server
const PORTS = [47800, 47801, 47802, 47803, 47804, 47805]
// where the download may come from: GitHub, for releases and repo files
const HOSTS = new Set(["raw.githubusercontent.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"])
const okHost = (url) => { try { const u = new URL(url); return u.protocol === "https:" && HOSTS.has(u.hostname) } catch { return false } }

function create(home, { fetchImpl = fetch, platform = process.platform, env = process.env, run = execFile, start = spawn, log = () => {}, info = DIVINA, pollMs = 1000, startMs = 60000 } = {}) {
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
      installed: have, installedVersion: mine, running: running(),
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
      stop() // an update replaces the files the server runs from
      // a silent install for this Windows user only, into Divina's usual folder
      const err = await exec(file, ["/S"])
      if (err) throw new Error(err.code === "EACCES" || err.errno === 740 ? "Divina's installer asked for admin rights, which it shouldn't. Nothing was installed." : `Divina's installer stopped (${err.code ?? "error"}).`)
      if (!installed()) throw new Error("Divina's installer finished, but Divina isn't there. Try again.")
      fs.writeFileSync(record, JSON.stringify({ version: info.version, at: new Date().toISOString() }))
      log(`installed Divina ${info.version}`)
    } finally {
      busy = null
      await fsp.rm(file, { force: true })
    }
    return status()
  }

  // ---------- running Divina inside Obstat ----------
  // Divina is a web app served by its own Node.js on this PC. Obstat starts that
  // server the way Divina.exe does (127.0.0.1 only, the same ports and data folder)
  // and shows its page in Obstat's window, like any other app.
  const data = () => path.join(env.APPDATA || path.join(home.root, "divina-data"), "Divina")
  let server = null // { child, port, url, exited }
  let starting = null

  // "divina" when Divina answers on this port, "other" when something else does, "free" when nothing does
  async function probe(port) {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/api/ai`, { signal: AbortSignal.timeout(1500) })
      const j = await r.json().catch(() => null)
      return j && typeof j === "object" && "studioVoice" in j ? "divina" : "other"
    } catch (e) {
      return e?.name === "TimeoutError" ? "other" : "free"
    }
  }

  function serve() {
    if (server && !server.exited) return Promise.resolve(server.url)
    if (!starting) starting = startServer().finally(() => { starting = null })
    return starting
  }

  async function startServer() {
    if (!installed()) throw new Error("Install Divina first.")
    const s = info[platform] || info.win32
    let port = 0
    for (const p of PORTS) {
      const state = await probe(p)
      // already running (Divina.exe started it): show that one
      if (state === "divina") return `http://127.0.0.1:${p}`
      if (state === "free") { port = p; break }
    }
    if (!port) throw new Error(`Divina couldn't find a free port (${PORTS[0]} to ${PORTS.at(-1)}). Close other apps and try again.`)
    fs.mkdirSync(data(), { recursive: true })
    const out = fs.openSync(path.join(home.dir("logs"), "divina.log"), "w")
    const child = start(path.join(dir(), s.node), [path.join(dir(), s.server)], {
      cwd: path.join(dir(), path.dirname(s.server)),
      env: { ...env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", DIVINA_DATA_DIR: data(), NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", out, out],
      windowsHide: true,
    })
    fs.closeSync(out)
    const me = { child, port, url: `http://127.0.0.1:${port}`, exited: false }
    server = me
    child.on("error", (err) => { me.exited = true; log(`Divina: ${err.message}`) })
    child.on("exit", () => { me.exited = true; if (server === me) server = null })
    log(`started Divina on port ${port}`)
    const until = Date.now() + startMs
    while ((await probe(port)) !== "divina") {
      if (me.exited) throw new Error("Divina stopped while starting. Its log is in Tools > Logs (divina.log).")
      if (Date.now() > until) { stop(); throw new Error("Divina took too long to start. Its log is in Tools > Logs (divina.log).") }
      await wait(250)
    }
    return me.url
  }

  // Stops the server Obstat started; one that Divina.exe started is left alone
  function stop() {
    const me = server
    if (!me) return false
    server = null
    if (!me.exited) try { me.child.kill() } catch {}
    log("stopped Divina")
    return true
  }
  const running = () => (server && !server.exited ? server.url : null)

  // Divina in its own window instead: Divina.exe opens one (on Obstat's server, if it's running)
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
    stop()
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
    } finally {
      busy = null
    }
    return status()
  }

  return { status, install, open, remove, dir, serve, stop, running }
}

module.exports = { create, DIVINA, okHost }
