// Privacy receipts: for every Autopilot run (and every recipe run), a record of what
// happened, written next to what the run made (receipt.json): which apps ran, at which
// commit; every step; every file in and out with its SHA-256; who planned it and what
// that sent where; and the internet connections the apps' own processes held while the
// run went on.
//
// How connections are seen: every couple of seconds Obstat asks the operating system
// for the open TCP connections (Windows: Get-NetTCPConnection; Linux: /proc; Mac: lsof)
// and keeps the ones whose process runs from inside an app's own folder and go
// somewhere other than this computer. It's an observation, not a firewall: a connection
// that opens and closes between two looks can be missed, and the receipt says so.
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile } = require("node:child_process")

const run = (file, args, opts = {}) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 16 << 20, encoding: "utf8", ...opts }, (err, out) => resolve(err && !out ? null : String(out || ""))))

// addresses on this computer or the local network: not "leaving"
function isLocal(addr) {
  const a = String(addr).replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").replace(/%.*$/, "")
  return a === "" || a === "*" || a === "::" || a === "::1" || a === "0.0.0.0" || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a) || /^f[cd]/i.test(a) || /^fe80/i.test(a)
}
// "1.2.3.4:443" and "[2001:db8::1]:443" and lsof's "1.2.3.4:443"
function splitAddr(s) {
  const m = /^\[?(.*?)\]?[:.](\d+)$/.exec(String(s).trim())
  return m ? { address: m[1], port: Number(m[2]) } : null
}

// /proc/net/tcp's addresses: hex, each 32-bit word little-endian
function procAddr(hex) {
  const [ip, port] = hex.split(":")
  const words = ip.match(/.{8}/g) || []
  const bytes = words.flatMap((w) => w.match(/../g).reverse().map((b) => parseInt(b, 16)))
  if (bytes.length === 4) return { address: bytes.join("."), port: parseInt(port, 16) }
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  const v6 = groups.join(":")
  const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(v6)
  return { address: mapped ? [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join(".") : v6, port: parseInt(port, 16) }
}
// Linux, from /proc (no tools needed): open TCP connections (established or opening),
// and which process holds each, for processes `match(who)` picks
function linuxConnections({ proc = "/proc", match = () => true } = {}) {
  const socks = new Map()
  for (const t of ["tcp", "tcp6"]) {
    let text = ""
    try { text = fs.readFileSync(`${proc}/net/${t}`, "utf8") } catch { continue }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length < 10 || (c[3] !== "01" && c[3] !== "02")) continue
      socks.set(c[9], procAddr(c[2]))
    }
  }
  const conns = [], who = {}
  let pids = []
  try { pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)) } catch { return null }
  for (const pid of pids) {
    let exe = "", cmd = ""
    try { exe = fs.readlinkSync(`${proc}/${pid}/exe`) } catch {}
    try { cmd = fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").replace(/\0/g, " ") } catch {}
    const w = `${exe}\n${cmd}`
    if (!match(w)) continue
    let fds = []
    try { fds = fs.readdirSync(`${proc}/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      let link = ""
      try { link = fs.readlinkSync(`${proc}/${pid}/fd/${fd}`) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (m && socks.has(m[1])) { conns.push({ pid: Number(pid), ...socks.get(m[1]) }); who[pid] = w }
    }
  }
  return { conns, who }
}

// Open connections: [{ pid, address, port }], plus { pid: "exe\ncommand line" } for
// those processes, or null when the system wouldn't say.
const PS = "Get-NetTCPConnection -State Established,SynSent -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess); '{0}\t{1}\t{2}\t{3}\t{4}' -f $_.OwningProcess, $_.RemoteAddress, $_.RemotePort, $p.ExecutablePath, $p.CommandLine }"
async function connections(platform = process.platform, exec = run, opts = {}) {
  const conns = [], who = {}
  if (platform === "win32") {
    const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS])
    if (out === null) return null
    for (const line of out.split(/\r?\n/)) {
      const [pid, address, port, exe = "", cmd = ""] = line.split("\t")
      if (!/^\d+$/.test(pid || "") || !address) continue
      conns.push({ pid: Number(pid), address, port: Number(port) })
      who[pid] = `${exe}\n${cmd}`
    }
    return { conns, who }
  }
  if (platform === "linux") return linuxConnections(opts)
  if (platform === "darwin") {
    // -F: p<pid> then n<local>-><remote> per connection
    const out = await exec("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED,SYN_SENT", "-Fpn"])
    if (out === null) return null
    let pid = null
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("p")) pid = Number(line.slice(1))
      else if (line.startsWith("n") && pid) {
        const to = splitAddr(line.slice(1).split("->")[1] || "")
        if (to) conns.push({ pid, ...to })
      }
    }
    const pids = [...new Set(conns.map((c) => c.pid))]
    if (pids.length) {
      const ps = await exec("ps", ["-o", "pid=,command=", "-p", pids.join(",")])
      for (const line of String(ps || "").split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line)
        if (m) who[m[1]] = `\n${m[2]}`
      }
    }
    return { conns, who }
  }
  return null
}

// Watches the connections of the given apps' processes until stop().
// `apps`: [{ id, name, dir }]
function watch(apps, { platform = process.platform, exec = run, every = 2000, look = connections, away = (a) => !isLocal(a) } = {}) {
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, "/")
  const folders = apps.map((a) => ({ ...a, inside: norm(a.dir).replace(/\/+$/, "") + "/" }))
  const seen = new Map()
  let looks = 0, failed = 0, stopped = false, timer = null, pending = null
  async function once() {
    const got = await look(platform, exec, { match: (w) => folders.some((a) => norm(w).includes(a.inside)) })
    if (!got) { failed++; return }
    looks++
    for (const c of got.conns) {
      if (!away(c.address)) continue
      const where = norm(got.who[c.pid] || "")
      const app = folders.find((a) => where.includes(a.inside))
      if (!app) continue
      const key = `${app.id} ${c.address} ${c.port}`
      if (!seen.has(key)) seen.set(key, { app: app.id, appName: app.name, address: c.address, port: c.port, at: new Date().toISOString() })
    }
  }
  const loop = async () => {
    if (stopped) return
    pending = once().catch(() => { failed++ })
    await pending
    if (!stopped) timer = setTimeout(loop, every)
  }
  loop()
  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await pending
      await once().catch(() => { failed++ }) // one last look
      return { looks, failed, connections: [...seen.values()] }
    },
  }
}

function hashFile(file) {
  const h = crypto.createHash("sha256")
  h.update(fs.readFileSync(file))
  return h.digest("hex")
}
const fileInfo = (f) => { try { return { name: path.basename(f), bytes: fs.statSync(f).size, sha256: hashFile(f) } } catch { return { name: path.basename(f), missing: true } } }

// The receipt, written to <dir>/receipt.json and returned.
function write({ dir, kind, goal, recipe, planner, apps, steps, inputs, outputs, network, startedAt, endedAt, ok, error }) {
  const plannerNote = planner?.kind === "claude"
    ? { kind: "claude", model: planner.model, sentTo: "api.anthropic.com", sent: "What you asked, the list of actions your apps offer, and each step's result as text (file names and paths, never the files themselves)." }
    : planner?.kind === "ollama" ? { kind: "ollama", model: planner.model, sentTo: "this computer (Ollama)", sent: "Nothing left this computer to plan the run." }
      : { kind: "recipe", sentTo: "nowhere", sent: "No planner: a recipe runs its saved steps." }
  const away = network?.connections || []
  const receipt = {
    obstatReceipt: 1,
    kind, goal: goal || null, recipe: recipe || null,
    startedAt, endedAt, ok: !!ok, ...(error ? { error } : {}),
    planner: plannerNote,
    apps: apps.map((a) => ({ id: a.id, name: a.name, commit: a.commit || null, reviewed: !!a.reviewed })),
    steps,
    files: { in: inputs.map(fileInfo), out: outputs.map(fileInfo) },
    network: {
      method: "Open TCP connections of each app's own processes, looked at every 2 seconds and once at the end. Connections to this computer and the local network aren't listed. A connection that opened and closed between two looks can be missed.",
      looks: network?.looks || 0,
      couldNotLook: network ? network.looks === 0 : true,
      connections: away,
    },
    summary: !network || network.looks === 0 ? "Obstat couldn't look at the apps' connections on this computer."
      : away.length ? `The apps connected to ${away.length} address${away.length === 1 ? "" : "es"} outside this computer while this ran.`
        : "No app connected to anything outside this computer while this ran.",
  }
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2))
  return receipt
}

module.exports = { connections, linuxConnections, procAddr, watch, write, isLocal, splitAddr, hashFile }
