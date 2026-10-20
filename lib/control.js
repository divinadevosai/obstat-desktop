// The local control link for AI agents. When it's on, Obstat listens on
// 127.0.0.1 only and writes the port and a random token to ~/obstat/control.json,
// which skills read. Every request needs that token. Requests from web pages
// are refused (they send an Origin header), and so is any Host other than
// 127.0.0.1:<port>, so a website can't reach it through DNS tricks.
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

function create(home, apps, { log = () => {} } = {}) {
  const file = path.join(home.root, "control.json")
  let server = null, token = null, port = null

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(JSON.stringify(body))
  }
  const sameToken = (got) => {
    const a = Buffer.from(String(got || "")), b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  const appInfo = (a) => ({ id: a.id, name: a.name, description: a.description, installed: !!a.installed, running: !!a.running, url: a.running?.url || null, folder: apps.appDir(a.id) })

  async function route(req, res) {
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, { error: "Not allowed." })
    if (!sameToken((req.headers.authorization || "").replace(/^Bearer\s+/i, ""))) return send(res, 401, { error: "Wrong or missing token. Read it from control.json." })
    const parts = new URL(req.url, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const id = parts.length >= 3 ? `${parts[1]}/${parts[2]}`.toLowerCase() : null
    const app = id && apps.list().find((a) => a.id === id)
    if (req.method === "GET" && parts[0] === "apps" && parts.length === 1) return send(res, 200, { apps: apps.list().map(appInfo) })
    if (!app) return send(res, 404, { error: "No app with that id. GET /apps lists them." })
    if (req.method === "GET" && parts.length === 3) return send(res, 200, appInfo(app))
    if (req.method === "POST" && parts[3] === "start") {
      if (!app.installed) return send(res, 409, { error: "That app isn't installed. Install it in Obstat first." })
      if (!app.running) {
        log(`agent started ${id}`)
        const r = await apps.run(id, "start.js")
        if (r && r.needsApproval) return send(res, 409, { error: "Nobody has reviewed this app, and its start steps are new or have changed. Open it in Obstat and look at them first." })
      }
      return send(res, 200, appInfo(apps.list().find((a) => a.id === id)))
    }
    if (req.method === "POST" && parts[3] === "stop") {
      log(`agent stopped ${id}`)
      await apps.stop(id)
      return send(res, 200, { stopped: id })
    }
    if (req.method === "GET" && parts[3] === "logs") {
      const script = /^(install|start)$/.test(parts[4] || "") ? parts[4] : "start"
      const r = await home.readLog(`apps/${path.basename(apps.appDir(id))}/${script}.txt`).catch(() => ({ text: "" }))
      return send(res, 200, { text: r.text.slice(-20000) })
    }
    return send(res, 404, { error: "Unknown request." })
  }

  async function start() {
    if (server) return status()
    token = crypto.randomBytes(24).toString("hex")
    server = http.createServer((req, res) => route(req, res).catch((e) => send(res, 500, { error: e.message })))
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
    port = server.address().port
    fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, token, note: "Obstat's control link for AI agents. Keep it private." }, null, 2), { mode: 0o600 })
    log(`control link on 127.0.0.1:${port}`)
    return status()
  }

  function stop() {
    if (server) server.close()
    server = null; token = null; port = null
    fs.rmSync(file, { force: true })
    return status()
  }

  const status = () => ({ on: !!server, url: server ? `http://127.0.0.1:${port}` : null, file })
  return { start, stop, status }
}

module.exports = { create }
