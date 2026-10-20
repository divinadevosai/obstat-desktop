// Obstat UI: a small web page around a command-line app, made by Obstat for repos
// that have no screen of their own. It reads the app's --help, turns its options
// into a form, runs the command with what you fill in, and shows the output and any
// files it made. Only this PC can reach it (127.0.0.1), and only Obstat's own page
// can start a run. Plain Node, no packages. Edit obstat-ui/config.json to change
// which command it runs.
"use strict"
const http = require("http")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { spawn } = require("child_process")

const HERE = __dirname
const config = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"))
const ROOT = fs.realpathSync(path.resolve(HERE, config.cwd || "..")) // cwd is relative to this folder
const INPUTS = path.join(HERE, "inputs")
const SKIP = new Set(["node_modules", "env", "venv", ".venv", ".git", "obstat-ui", "__pycache__", ".cache"])

// ---------- reading --help ----------

const { parseHelp } = require("./help")
let help = { text: "", fields: [] }
function readHelp() {
  return new Promise((resolve) => {
    let out = ""
    let child
    try { child = spawn(config.command[0], [...config.command.slice(1), "--help"], { cwd: ROOT, env: process.env, windowsHide: true }) } catch (e) { return resolve({ text: String(e.message), fields: [] }) }
    const t = setTimeout(() => { try { child.kill() } catch {} }, 30000)
    const add = (d) => { if (out.length < 65536) out += d }
    child.stdout.on("data", add)
    child.stderr.on("data", add)
    child.on("error", (e) => { out += e.message })
    child.on("close", () => { clearTimeout(t); resolve({ text: out, fields: parseHelp(out) }) })
  })
}

// ---------- runs ----------

const runs = new Map() // id -> { args, out, done, code, files, started }
let active = null

function listFiles(dir, depth = 0, acc = new Map()) {
  if (depth > 3 || acc.size > 4000) return acc
  let names = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const d of names) {
    if (d.name.startsWith(".") && depth === 0 && d.name !== ".output") continue
    if (SKIP.has(d.name)) continue
    const p = path.join(dir, d.name)
    if (d.isDirectory()) listFiles(p, depth + 1, acc)
    else if (d.isFile()) { try { acc.set(p, fs.statSync(p).mtimeMs) } catch {} }
  }
  return acc
}

function startRun(args) {
  if (active && !runs.get(active).done) throw new Error("It's still running. Stop it first.")
  const id = crypto.randomBytes(6).toString("hex")
  const before = listFiles(ROOT)
  const run = { args, out: "", done: false, code: null, files: [], started: Date.now() }
  runs.set(id, run)
  active = id
  const child = spawn(config.command[0], [...config.command.slice(1), ...args], { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: "1" }, windowsHide: true })
  run.child = child
  const add = (d) => { run.out = (run.out + d).slice(-400000) }
  child.stdout.on("data", add)
  child.stderr.on("data", add)
  child.on("error", (e) => add(`\n${e.message}\n`))
  child.on("close", (code) => {
    run.done = true
    run.code = code
    const after = listFiles(ROOT)
    run.files = [...after].filter(([p, t]) => before.get(p) !== t).map(([p]) => path.relative(ROOT, p)).slice(0, 50)
  })
  return id
}

// ---------- the page ----------

const page = fs.readFileSync(path.join(HERE, "index.html"), "utf8")
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "text/plain; charset=utf-8",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".flac": "audio/flac", ".mp4": "video/mp4", ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8", ".pdf": "application/pdf" }

// no other website may show this page in a frame (and trick someone into clicking Run)
const SAFETY = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" }
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...SAFETY })
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
// Only plain relative paths inside the app. They are checked as text before the disk is
// touched: on Windows, even looking up \\server\share would send the PC's sign-in to that server.
const inside = (base, rel) => {
  if (!rel || path.isAbsolute(rel) || /^[\\/]|^[a-z]:|[\\/]{2}|\0/i.test(rel)) return null
  const raw = path.resolve(base, rel)
  if (raw !== base && !raw.startsWith(base + path.sep)) return null
  try { const p = fs.realpathSync(raw); return p === base || p.startsWith(base + path.sep) ? p : null } catch { return null }
}

let host = ""
const server = http.createServer(async (req, res) => {
  // only this PC, and only pages served from here (blocks other websites poking at it)
  if (req.headers.host !== host) return send(res, 403, { error: "Not allowed." })
  const url = new URL(req.url, `http://${host}`)
  const write = req.method !== "GET"
  if (write && req.headers["x-obstat-ui"] !== "1") return send(res, 403, { error: "Not allowed." })
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, page, "text/html; charset=utf-8")
    }
    if (req.method === "GET" && url.pathname === "/api/info") {
      return send(res, 200, { name: config.name, description: config.description, command: config.command, help: help.text, fields: help.fields, running: active && !runs.get(active).done ? active : null })
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      let body = ""
      for await (const c of req) { body += c; if (body.length > 100000) return send(res, 413, { error: "Too much." }) }
      const args = JSON.parse(body).args
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string") || args.length > 200) return send(res, 400, { error: "Bad arguments." })
      return send(res, 200, { id: startRun(args) })
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/run/")) {
      const run = runs.get(url.pathname.split("/").pop())
      if (!run) return send(res, 404, { error: "No such run." })
      return send(res, 200, { out: run.out, done: run.done, code: run.code, files: run.files, seconds: Math.round((Date.now() - run.started) / 1000) })
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const run = active && runs.get(active)
      if (run && !run.done) { try { run.child.kill() } catch {} }
      return send(res, 200, { stopped: true })
    }
    if (req.method === "PUT" && url.pathname === "/api/upload") {
      const name = path.basename(String(url.searchParams.get("name") || "file")).replace(/[^\w.-]+/g, "_").slice(0, 80) || "file"
      fs.mkdirSync(INPUTS, { recursive: true })
      const dest = path.join(INPUTS, `${Date.now().toString(36)}-${name}`)
      let size = 0
      const out = fs.createWriteStream(dest)
      for await (const c of req) { size += c.length; if (size > 2 * 1024 ** 3) { out.destroy(); fs.rmSync(dest, { force: true }); return send(res, 413, { error: "That file is too big." }) } out.write(c) }
      await new Promise((r) => out.end(r))
      return send(res, 200, { path: dest })
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const p = inside(ROOT, url.searchParams.get("p") || "")
      if (!p || !fs.statSync(p).isFile()) return send(res, 404, { error: "Not found." })
      const type = TYPES[path.extname(p).toLowerCase()] || "application/octet-stream"
      res.writeHead(200, { "content-type": type, "content-length": fs.statSync(p).size, "cache-control": "no-store", ...SAFETY,
        ...(type === "application/octet-stream" || url.searchParams.has("download") ? { "content-disposition": `attachment; filename="${path.basename(p).replace(/[^\w.-]/g, "_")}"` } : {}) })
      return fs.createReadStream(p).pipe(res)
    }
    send(res, 404, { error: "Not found." })
  } catch (err) {
    send(res, 400, { error: err.message })
  }
})

const port = Number(process.env.PORT) || 0
server.listen(port, "127.0.0.1", async () => {
  host = `127.0.0.1:${server.address().port}`
  help = await readHelp()
  console.log(`Obstat UI for ${config.name} is ready at http://${host}`)
})
