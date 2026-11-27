// Phone access: use Obstat from your phone. The phone is a remote control: it asks this
// computer to run a recipe or an Autopilot job, and gets the files back. The apps, the
// models and the work all stay here.
//
// - Off until the person turns it on. Then Obstat listens on this computer's home-network
//   address and answers only devices on a private network: the home Wi-Fi, or the
//   person's own Tailscale/VPN (100.64.0.0/10). Nothing goes through an Obstat server.
// - A phone is paired by scanning a QR code. The code holds a key made for that phone,
//   after the "#", which a browser never sends over the network. Every request and every
//   answer, files included, is sealed with it (NaCl secretbox: XSalsa20-Poly1305), so
//   anyone else on the Wi-Fi sees only noise, and can't forge or replay a request.
//   (The phone's page itself is plain HTTP on the home network: a device that actively
//   tampers with that network's traffic could still change the page. Obstat says so.)
// - Each phone can be removed at any time, and is allowed recipes, Autopilot, or both.
// - What a phone asks for runs through Autopilot's own path, so every run has a privacy
//   receipt, which names the phone that asked.
"use strict"
const http = require("node:http")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const nacl = require("tweetnacl")

const MAX_BODY = 72 << 20 // a sealed request: up to 50 MB of file, base64 and all
const MAX_FILE = 50 << 20
const SKEW = 5 * 60000 // how far a phone's clock may be off

const b64 = (u8) => Buffer.from(u8).toString("base64")
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ""), "base64"))
const b64url = (u8) => Buffer.from(u8).toString("base64url")

// a private network: this computer, the home network, link-local, or Tailscale's range
function privateAddress(addr) {
  const a = String(addr || "").replace(/^::ffff:/i, "")
  if (a === "::1" || /^127\./.test(a)) return true
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true
  return /^f[cd]/i.test(a) || /^fe80:/i.test(a)
}

// this computer's addresses a phone can reach: home network first, then Tailscale/VPN
function addresses(ifaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.internal || i.family !== "IPv4" || !privateAddress(i.address) || /^169\.254\./.test(i.address)) continue
      out.push({ address: i.address, name, kind: /^100\./.test(i.address) ? "tailscale" : "home" })
    }
  }
  return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "home" ? -1 : 1))
}

function create({ home, crypt = null, autopilot, recipes, log = () => {}, version = "0", pageDir = path.join(__dirname, "..", "app", "phone"), naclFile = require.resolve("tweetnacl/nacl-fast.min.js"), remoteOf = (req) => req.socket.remoteAddress, listenHost = "0.0.0.0", ifaces }) {
  const file = path.join(home.root, "phone.json")
  const inbox = () => path.join(home.dir("autopilot"), "phone-inbox")

  // ---------- paired phones ----------
  const seal = (key) => (crypt?.available?.() ? { enc: crypt.encrypt(b64(key)).toString("base64") } : { key: b64(key) })
  const unseal = (d) => (d.enc ? unb64(crypt.decrypt(Buffer.from(d.enc, "base64"))) : unb64(d.key))
  function load() {
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return { port: j.port || null, devices: Array.isArray(j.devices) ? j.devices : [] } } catch { return { port: null, devices: [] } }
  }
  function save(s) { fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 }) }
  const shown = (d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen || null, can: d.can })
  const devices = () => load().devices.map(shown)

  // A new phone: its own key, in a link (and QR code) that carries it after the "#".
  async function pair(name, can = { recipes: true, autopilot: true }) {
    name = String(name || "").trim().slice(0, 40) || "Phone"
    if (!server) throw new Error("Turn phone access on first.")
    // a phone needs an address to reach: checked before anything is kept
    const at = addresses(ifaces)
    if (!at.length) throw new Error("This computer isn't on a home network right now, so a phone can't reach it.")
    const s = load()
    if (s.devices.length >= 20) throw new Error("That's 20 phones already. Remove one first.")
    const key = nacl.randomBytes(32)
    const id = crypto.randomBytes(9).toString("base64url")
    s.devices.push({ id, name, ...seal(key), createdAt: new Date().toISOString(), can: { recipes: can.recipes !== false, autopilot: can.autopilot !== false } })
    save(s)
    log(`phone access: paired ${name}`)
    const links = at.map((a) => ({ ...a, url: `http://${a.address}:${status().port}/#${id}.${b64url(key)}` }))
    const qr = await require("qrcode").toDataURL(links[0].url, { margin: 1, width: 320, errorCorrectionLevel: "M" })
    return { device: shown(s.devices.at(-1)), links, qr }
  }
  function remove(id) {
    const s = load()
    s.devices = s.devices.filter((d) => d.id !== id)
    save(s)
    seen.delete(id)
    return devices()
  }
  function allow(id, can) {
    const s = load()
    const d = s.devices.find((x) => x.id === id)
    if (!d) throw new Error("That phone isn't paired.")
    d.can = { recipes: !!can?.recipes, autopilot: !!can?.autopilot }
    save(s)
    return devices()
  }

  // ---------- runs a phone started, and what they did ----------
  // events from Autopilot (main.js passes each one in), kept for phones to read
  const events = []
  let running = null // { device, deviceId, kind, startedAt, ended }
  const runDirs = new Map() // device id -> folders of the runs it started: the only files it may fetch
  function event(e) {
    // only the run a phone started: nothing of what's run at the computer afterwards
    if (!running || running.ended) return
    if (e.type === "start" && e.dir) { const set = runDirs.get(running.deviceId) || new Set(); set.add(e.dir); runDirs.set(running.deviceId, set) }
    events.push({ n: events.length, ...e })
    if (events.length > 500) events.splice(0, events.length - 500)
    if (e.type === "done" || e.type === "error") running = { ...running, ended: true }
  }

  // ---------- the server ----------
  let server = null
  const seen = new Map() // device id -> Map(nonce -> time): a request is answered once
  const strikes = new Map() // address -> [times] of requests that didn't open
  function blocked(addr) {
    const now = Date.now(), list = (strikes.get(addr) || []).filter((t) => now - t < 60000)
    strikes.set(addr, list)
    return list.length >= 20
  }
  const strike = (addr) => strikes.set(addr, [...(strikes.get(addr) || []), Date.now()])

  const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  function serveFile(res, f, type) {
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" })
    fs.createReadStream(f).pipe(res)
  }

  async function body(req) {
    const chunks = []
    let size = 0
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error("too big"), { status: 413 }); chunks.push(c) }
    return Buffer.concat(chunks).toString("utf8")
  }

  // Opens a sealed request: { device, key, msg } or null (unknown phone, wrong key,
  // too old, or a repeat).
  function open(raw) {
    let env
    try { env = JSON.parse(raw) } catch { return null }
    if (!env || typeof env.d !== "string" || typeof env.n !== "string" || typeof env.c !== "string") return null
    const d = load().devices.find((x) => x.id === env.d)
    if (!d) return null
    const key = unseal(d), nonce = unb64(env.n)
    if (nonce.length !== nacl.secretbox.nonceLength) return null
    const plain = nacl.secretbox.open(unb64(env.c), nonce, key)
    if (!plain) return null
    let msg
    try { msg = JSON.parse(Buffer.from(plain).toString("utf8")) } catch { return null }
    const now = Date.now()
    if (typeof msg.t !== "number" || Math.abs(now - msg.t) > SKEW) return { device: d, key, stale: true }
    const mine = seen.get(d.id) || new Map()
    for (const [n, t] of mine) if (now - t > 2 * SKEW) mine.delete(n)
    if (mine.has(env.n)) return null
    mine.set(env.n, now)
    seen.set(d.id, mine)
    return { device: d, key, msg }
  }
  const sealed = (key, value) => {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
    return JSON.stringify({ n: b64(nonce), c: b64(nacl.secretbox(Buffer.from(JSON.stringify({ ...value, t: Date.now() })), nonce, key)) })
  }

  // what a phone may ask
  async function op(device, msg) {
    const via = { device: device.name, id: device.id }
    const args = msg.args && typeof msg.args === "object" ? msg.args : {}
    const busy = () => running && !running.ended
    switch (msg.op) {
      case "hello":
        return { computer: os.hostname(), device: device.name, can: device.can, version }
      case "list": {
        const st = await autopilot.status().catch(() => ({ planner: null }))
        return {
          recipes: device.can.recipes ? recipes.list().filter((r) => !r.imported).map((r) => ({
            id: r.id, name: r.name, about: r.about, files: r.files.map((f) => f.label),
            text: r.steps.flatMap((s, i) => s.inputs.map((v, k) => (v.edit ? { key: `${i}.${k}`, label: `${s.appName}: ${v.label || "text"}`, value: v.value } : null))).filter(Boolean),
          })) : [],
          autopilot: device.can.autopilot ? { ready: !!st.planner, planner: st.planner || null, reason: st.reason || null } : null,
          busy: busy(),
        }
      }
      case "upload": {
        const data = Buffer.from(String(args.data || ""), "base64")
        if (!data.length) throw new Error("That file was empty.")
        if (data.length > MAX_FILE) throw new Error("That file is over 50 MB.")
        const dir = path.join(inbox(), device.id)
        fs.mkdirSync(dir, { recursive: true })
        const name = String(args.name || "file").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file"
        const id = `${crypto.randomBytes(6).toString("hex")}-${name}`
        fs.writeFileSync(path.join(dir, id), data)
        return { upload: id }
      }
      case "recipe":
      case "autopilot": {
        if (msg.op === "recipe" && !device.can.recipes) throw new Error("This phone isn't allowed to run recipes. Change it on the computer, in Home Server.")
        if (msg.op === "autopilot" && !device.can.autopilot) throw new Error("This phone isn't allowed to use Autopilot. Change it on the computer, in Home Server.")
        if (busy()) throw new Error("Obstat is already running something from a phone. Wait for it to finish.")
        // files the phone uploaded, from its own inbox only
        const files = (Array.isArray(args.files) ? args.files : []).map((u) => {
          if (typeof u !== "string" || !/^[0-9a-f]{12}-[\w.-]{1,80}$/.test(u)) throw new Error("That isn't a file this phone sent.")
          const f = path.join(inbox(), device.id, u)
          if (!fs.existsSync(f)) throw new Error("A file this phone sent is gone. Send it again.")
          return f
        })
        events.length = 0
        running = { device: device.name, deviceId: device.id, kind: msg.op, startedAt: new Date().toISOString() }
        log(`phone access: ${device.name} started ${msg.op === "recipe" ? `the recipe ${args.id}` : "an Autopilot job"}`)
        const job = msg.op === "recipe"
          ? autopilot.replay(recipes.get(String(args.id)), { files, values: args.text && typeof args.text === "object" ? args.text : {}, via })
          : autopilot.start({ goal: String(args.goal || ""), files, via })
        job.catch((err) => { if (!events.some((e) => e.type === "error")) event({ type: "error", text: err.message }) }).finally(() => { if (running) running = { ...running, ended: true } })
        return { started: true }
      }
      case "progress": {
        const since = Number(args.since) || 0
        return { events: events.filter((e) => e.n >= since).map(phoneEvent), running: busy(), next: events.length }
      }
      case "stop":
        if (busy()) autopilot.stop()
        return { stopped: true }
      case "file": {
        // a file one of this phone's own runs made, and nothing else
        let real
        try { real = fs.realpathSync(String(args.path || "")) } catch { throw new Error("That file isn't there any more.") }
        const mine = [...(runDirs.get(device.id) || [])].map((d) => { try { return fs.realpathSync(d) + path.sep } catch { return null } }).filter(Boolean)
        if (!mine.some((d) => real.startsWith(d))) throw new Error("That isn't something a run from this phone made.")
        const size = fs.statSync(real).size
        if (size > MAX_FILE) throw new Error("That file is over 50 MB, too big to send to a phone. It's on the computer, in Obstat's Autopilot folder.")
        return { name: path.basename(real), type: mime(real), data: fs.readFileSync(real).toString("base64") }
      }
      default:
        throw new Error("Obstat doesn't know that request.")
    }
  }

  async function route(req, res) {
    const addr = remoteOf(req)
    // only devices on this computer's own networks; everything else is closed at once
    if (!privateAddress(addr)) { res.writeHead(403); return res.end() }
    if (blocked(addr)) { res.writeHead(429); return res.end() }
    const url = new URL(req.url, "http://x")
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return serveFile(res, path.join(pageDir, "index.html"), "text/html; charset=utf-8")
    if (req.method === "GET" && url.pathname === "/phone.js") return serveFile(res, path.join(pageDir, "phone.js"), "text/javascript; charset=utf-8")
    if (req.method === "GET" && url.pathname === "/nacl.js") return serveFile(res, naclFile, "text/javascript; charset=utf-8")
    if (req.method !== "POST" || url.pathname !== "/api") { res.writeHead(404); return res.end() }
    const opened = open(await body(req))
    if (!opened) { strike(addr); res.writeHead(401); return res.end() }
    const { device, key, msg } = opened
    const reply = (value) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(sealed(key, value)) }
    if (opened.stale) return reply({ error: "This phone's clock is more than 5 minutes off from the computer's. Set both to the right time." })
    const s = load(), d = s.devices.find((x) => x.id === device.id)
    // "last used", kept to the minute (a phone checks on a run every couple of seconds)
    if (d && (!d.lastSeen || Date.now() - Date.parse(d.lastSeen) > 60000)) { d.lastSeen = new Date().toISOString(); save(s) }
    try { reply({ ok: true, result: await op(device, msg) }) } catch (err) { reply({ error: err.message }) }
  }

  // what phones sent, kept a day: long enough for the run it was for
  function tidyInbox(now = Date.now()) {
    let dirs = []
    try { dirs = fs.readdirSync(inbox()) } catch { return }
    for (const d of dirs) {
      const dir = path.join(inbox(), d)
      for (const f of fs.readdirSync(dir)) { try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > 86400000) fs.rmSync(path.join(dir, f), { force: true }) } catch {} }
    }
  }

  async function start() {
    if (server) return status()
    tidyInbox()
    const s = load()
    server = http.createServer((req, res) => route(req, res).catch((e) => { try { res.writeHead(e.status || 500); res.end() } catch {} }))
    server.requestTimeout = 5 * 60000
    const listen = (port) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, listenHost, () => { server.off("error", reject); resolve() }) })
    // the same port every time, so a paired phone's link keeps working
    try { await listen(s.port || 0) } catch { await listen(0) }
    if (s.port !== server.address().port) { s.port = server.address().port; save(s) }
    log(`phone access on, port ${s.port}`)
    return status()
  }
  function stop() {
    if (server) { server.close(); server.closeAllConnections?.() }
    server = null
    return status()
  }
  function status() {
    return { on: !!server, port: server ? server.address().port : load().port, addresses: addresses(ifaces), devices: devices() }
  }

  return { start, stop, status, pair, remove, allow, devices, event, op, open, sealed, tidyInbox }
}

// what a phone is shown of an Autopilot event: no paths on this computer but the files
function phoneEvent(e) {
  const short = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t && t.length > 400 ? `${t.slice(0, 400)}…` : t }
  if (e.type === "file") return { n: e.n, type: "file", path: e.file, name: path.basename(e.file), app: e.app }
  if (e.type === "receipt") return { n: e.n, type: "receipt", summary: e.receipt?.summary, apps: (e.receipt?.apps || []).map((a) => a.name) }
  if (e.type === "ask") return { n: e.n, type: "note", text: `Waiting on the computer: ${e.why || "it wants to install an app"}. Answer it there.` }
  return { n: e.n, type: e.type, text: short(e.text ?? e.tool ?? ""), tool: e.tool, model: e.model, planner: e.planner }
}

const TYPES = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain", ".json": "application/json", ".pdf": "application/pdf" }
const mime = (f) => TYPES[path.extname(f).toLowerCase()] || "application/octet-stream"

module.exports = { create, privateAddress, addresses, phoneEvent }
