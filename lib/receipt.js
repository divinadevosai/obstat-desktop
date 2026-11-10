// Privacy receipts: for every Autopilot run (and every recipe run), a record of what
// happened, written next to what the run made (receipt.json): which apps ran, at which
// commit; every step; every file in and out with its SHA-256; who planned it and what
// that sent where; and the internet connections the apps' own processes held while the
// run went on.
//
// How connections are seen: every couple of seconds Obstat asks the operating system
// for the open TCP connections (Windows: Get-NetTCPConnection; Linux: /proc; Mac: lsof)
// and keeps the ones held by an app's processes (from its folder, or started by its
// running copy) that go somewhere other than this computer. It's an observation, not a
// firewall: a connection that opens and closes between two looks can be missed, and
// the receipt says so.
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile } = require("node:child_process")

const run = (file, args, opts = {}) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 16 << 20, encoding: "utf8", ...opts }, (err, out) => resolve(err && !out ? null : String(out || ""))))

// this computer itself (loopback): not "leaving" at all
function isLoopback(addr) {
  const a = String(addr).replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").replace(/%.*$/, "")
  return a === "" || a === "*" || a === "::" || a === "::1" || a === "0.0.0.0" || /^127\./.test(a)
}
// the local network (a router, a NAS, another computer at home): listed, but apart
function isPrivate(addr) {
  const a = String(addr).replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").replace(/%.*$/, "")
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^f[cd]/i.test(a) || /^fe80/i.test(a)
}
const isLocal = (a) => isLoopback(a) || isPrivate(a)
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

// What's connected right now, and every process (so an app's processes can be found by
// folder or by which process started which):
//   { conns: [{ pid, address, port }], procs: Map(pid -> { ppid, who: "exe\ncommand line" }) }
// null when the system wouldn't say.

// Linux, from /proc (no tools needed)
function linuxConnections({ proc = "/proc" } = {}) {
  const socks = new Map()
  for (const t of ["tcp", "tcp6"]) {
    let text = ""
    try { text = fs.readFileSync(`${proc}/net/${t}`, "utf8") } catch { continue }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length < 10 || (c[3] !== "01" && c[3] !== "02")) continue // established, or opening
      socks.set(c[9], procAddr(c[2]))
    }
  }
  const conns = [], procs = new Map()
  let pids = []
  try { pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)) } catch { return null }
  for (const pid of pids) {
    let exe = "", cmd = "", ppid = 0
    try { const st = fs.readFileSync(`${proc}/${pid}/stat`, "utf8"); ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]) || 0 } catch {}
    try { exe = fs.readlinkSync(`${proc}/${pid}/exe`) } catch {}
    try { cmd = fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").replace(/\0/g, " ") } catch {}
    procs.set(Number(pid), { ppid, who: `${exe}\n${cmd}` })
    let fds = []
    try { fds = fs.readdirSync(`${proc}/${pid}/fd`) } catch { continue } // another user's: not readable, not ours
    for (const fd of fds) {
      let link = ""
      try { link = fs.readlinkSync(`${proc}/${pid}/fd/${fd}`) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (m && socks.has(m[1])) conns.push({ pid: Number(pid), ...socks.get(m[1]) })
    }
  }
  return { conns, procs }
}

// Windows: every process (one query), then the open connections
const PS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-CimInstance Win32_Process | ForEach-Object { \"P`t{0}`t{1}`t{2}`t{3}\" -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath, ($_.CommandLine -replace \"[`t`r`n]\", ' ') }",
  "Get-NetTCPConnection -State Established,SynSent | ForEach-Object { \"C`t{0}`t{1}`t{2}\" -f $_.OwningProcess, $_.RemoteAddress, $_.RemotePort }",
].join("; ")

async function connections(platform = process.platform, exec = run, opts = {}) {
  if (platform === "linux") return linuxConnections(opts)
  const conns = [], procs = new Map()
  if (platform === "win32") {
    const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS])
    if (out === null) return null
    for (const line of out.split(/\r?\n/)) {
      const f = line.split("\t")
      if (f[0] === "P" && /^\d+$/.test(f[1] || "")) procs.set(Number(f[1]), { ppid: Number(f[2]) || 0, who: `${f[3] || ""}\n${f[4] || ""}` })
      else if (f[0] === "C" && /^\d+$/.test(f[1] || "") && f[2]) conns.push({ pid: Number(f[1]), address: f[2], port: Number(f[3]) })
    }
    return { conns, procs }
  }
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
    const ps = await exec("ps", ["-axo", "pid=,ppid=,command="])
    for (const line of String(ps || "").split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), who: `\n${m[3]}` })
    }
    return { conns, procs }
  }
  return null
}

// Watches the connections of the given apps' processes until stop(). An app's processes
// are the ones running from inside its folder, and everything its running copy started
// (`root()`: the pid Obstat started it with), so an interpreter that lives elsewhere
// (Windows' venv python hands over to the real one) still counts.
// `apps`: [{ id, name, dir, root?: () => pid }]; add() watches one more (an app a plan installed).
function watch(apps, { platform = process.platform, exec = run, every = 2000, look = connections, away = (a) => !isLoopback(a) } = {}) {
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, "/")
  const folders = []
  const add = (a) => { if (a?.dir && !folders.some((f) => f.id === a.id)) folders.push({ ...a, inside: norm(a.dir).replace(/\/+$/, "") + "/" }) }
  apps.forEach(add)
  const seen = new Map()
  let looks = 0, failed = 0, stopped = false, timer = null, pending = null
  async function once() {
    const got = await look(platform, exec)
    if (!got) { failed++; return }
    looks++
    const kids = new Map()
    for (const [pid, p] of got.procs) if (p.ppid && p.ppid !== pid) kids.set(p.ppid, [...(kids.get(p.ppid) || []), pid])
    const owner = new Map() // pid -> app
    for (const app of folders) {
      for (const [pid, p] of got.procs) if (!owner.has(pid) && norm(p.who).includes(app.inside)) owner.set(pid, app)
      const root = Number(typeof app.root === "function" ? app.root() : app.root)
      if (Number.isInteger(root) && root > 0) {
        const todo = [root]
        while (todo.length && owner.size < 20000) { const p = todo.pop(); if (!owner.has(p)) owner.set(p, app); for (const k of kids.get(p) || []) if (!owner.has(k)) todo.push(k) }
      }
    }
    for (const c of got.conns) {
      const app = owner.get(c.pid)
      if (!app || !away(c.address)) continue
      const key = `${app.id} ${c.address} ${c.port}`
      if (!seen.has(key)) seen.set(key, { app: app.id, appName: app.name, address: c.address, port: c.port, where: isPrivate(c.address) ? "local network" : "internet", at: new Date().toISOString() })
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
    add,
    async stop() {
      stopped = true
      clearTimeout(timer)
      await pending
      await once().catch(() => { failed++ }) // one last look
      return { looks, failed, connections: [...seen.values()] }
    },
  }
}

// a file's SHA-256, read in pieces (outputs can be gigabytes of video)
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256")
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")))
  })
}
async function fileInfo(f) {
  try { return { name: path.basename(f), bytes: fs.statSync(f).size, sha256: await hashFile(f) } } catch { return { name: path.basename(f), missing: true } }
}

// The receipt, written to <dir>/receipt.json and returned.
async function write({ dir, kind, goal, recipe, planner, apps, steps, inputs, outputs, network, startedAt, endedAt, ok, error }) {
  const plannerNote = planner?.kind === "claude"
    ? { kind: "claude", model: planner.model, sentTo: "api.anthropic.com", sent: "What you asked, the list of actions your apps offer, and each step's result as text (file names and paths, never the files themselves)." }
    : planner?.kind === "ollama" ? { kind: "ollama", model: planner.model, sentTo: "this computer (Ollama)", sent: "Nothing left this computer to plan the run." }
      : planner?.kind === "agent" ? { kind: "agent", sentTo: "the AI tool that asked", sent: "An AI tool on this computer asked for this through Obstat's agent link and got the result back. Obstat itself sent nothing anywhere; what that tool does with the result is up to it." }
        : { kind: "recipe", sentTo: "nowhere", sent: "No planner: a recipe runs its saved steps." }
  const all = network?.connections || []
  const away = all.filter((c) => c.where !== "local network"), near = all.filter((c) => c.where === "local network")
  const receipt = {
    obstatReceipt: 1,
    kind, goal: goal || null, recipe: recipe || null,
    startedAt, endedAt, ok: !!ok, ...(error ? { error } : {}),
    planner: plannerNote,
    apps: apps.map((a) => ({ id: a.id, name: a.name, commit: a.commit || null, reviewed: !!a.reviewed })),
    steps,
    files: { in: await Promise.all(inputs.map(fileInfo)), out: await Promise.all(outputs.map(fileInfo)) },
    network: {
      method: "Open TCP connections of each app's processes (the ones running from its folder, and everything its running copy started), looked at every 2 seconds and once at the end. Connections within this computer aren't listed; ones to the local network are, apart. A connection that opened and closed between two looks can be missed.",
      looks: network?.looks || 0,
      couldNotLook: network ? network.looks === 0 : true,
      connections: all,
    },
    summary: !network || network.looks === 0 ? "Obstat couldn't look at the apps' connections on this computer."
      : away.length ? `The apps connected to ${away.length} internet address${away.length === 1 ? "" : "es"} while this ran${near.length ? `, and ${near.length} on your local network` : ""}.`
        : near.length ? `No app connected to the internet while this ran; ${near.length === 1 ? "one connection" : `${near.length} connections`} went to your local network.`
          : "No app connected to anything outside this computer while this ran.",
  }
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2))
  return receipt
}

module.exports = { connections, linuxConnections, procAddr, watch, write, isLocal, isLoopback, isPrivate, splitAddr, hashFile }
