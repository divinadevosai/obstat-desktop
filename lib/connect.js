// Connecting AI tools to Obstat's apps (lib/mcp.js): puts the bridge script where it can
// be run (~/obstat/mcp/obstat-mcp.cjs, with Obstat's own Node) and adds an "obstat" entry
// to the tool's MCP settings.
//   Claude Desktop  claude_desktop_config.json  { mcpServers: { obstat: { command, args } } }
//   Cursor          ~/.cursor/mcp.json          the same shape
//   Claude Code     a command to paste (it keeps its settings in a file it rewrites itself)
// A settings file is only ever added to: other servers and settings stay as they are, and
// a file that isn't readable JSON is left alone and said so.
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const NAME = "obstat"

function clients({ platform = process.platform, homeDir = os.homedir(), env = process.env } = {}) {
  const claude = platform === "win32" ? path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Claude")
    : platform === "darwin" ? path.join(homeDir, "Library", "Application Support", "Claude")
      : path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "Claude")
  return {
    "claude-desktop": { name: "Claude Desktop", file: path.join(claude, "claude_desktop_config.json"), after: "Quit Claude Desktop fully and open it again." },
    cursor: { name: "Cursor", file: path.join(homeDir, ".cursor", "mcp.json"), after: "Cursor picks it up; check Settings › MCP." },
  }
}

function create(home, { node, bridgeSource = path.join(__dirname, "mcp-bridge.cjs"), platform = process.platform, homeDir = os.homedir(), env = process.env } = {}) {
  const bridge = path.join(home.root, "mcp", "obstat-mcp.cjs")
  const list = clients({ platform, homeDir, env })
  const client = (id) => { if (!Object.hasOwn(list, id)) throw new Error("No such AI tool."); return list[id] }

  // the bridge, copied out of the app (kept up to date with this Obstat)
  function putBridge() {
    const src = fs.readFileSync(bridgeSource, "utf8")
    let cur = null
    try { cur = fs.readFileSync(bridge, "utf8") } catch {}
    if (cur !== src) { fs.mkdirSync(path.dirname(bridge), { recursive: true }); fs.writeFileSync(bridge, src) }
    return bridge
  }
  // how a tool starts the bridge: Obstat's own Node, the bridge, and Obstat's folder
  const entry = () => ({ command: node(), args: [bridge, home.root] })

  // { settings } or { broken } (there, but not JSON an object) or { settings: {} } when absent
  function read(file) {
    let raw
    try { raw = fs.readFileSync(file, "utf8") } catch { return { settings: {}, absent: true } }
    if (!raw.trim()) return { settings: {} }
    try { const j = JSON.parse(raw); if (j && typeof j === "object" && !Array.isArray(j)) return { settings: j } } catch {}
    return { broken: true }
  }
  const same = (a, b) => !!a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)

  function status() {
    const want = entry()
    return {
      bridge,
      // for tools Obstat doesn't write settings for
      command: `claude mcp add ${NAME} -- ${[want.command, ...want.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`,
      snippet: JSON.stringify({ mcpServers: { [NAME]: want } }, null, 2),
      clients: Object.entries(list).map(([id, c]) => {
        const r = read(c.file)
        const cur = r.settings?.mcpServers?.[NAME]
        return { id, name: c.name, file: c.file, present: fs.existsSync(path.dirname(c.file)), connected: same(cur, want) ? "yes" : cur ? "changed" : "no", broken: !!r.broken, after: c.after }
      }),
    }
  }

  function connect(id) {
    const c = client(id)
    putBridge()
    const r = read(c.file)
    if (r.broken) throw new Error(`${c.name}'s settings file isn't readable (${c.file}). Fix or remove it, then try again; Obstat left it alone.`)
    const servers = r.settings.mcpServers && typeof r.settings.mcpServers === "object" && !Array.isArray(r.settings.mcpServers) ? r.settings.mcpServers : {}
    const next = { ...r.settings, mcpServers: { ...servers, [NAME]: entry() } }
    fs.mkdirSync(path.dirname(c.file), { recursive: true })
    // written whole beside it, then swapped in: never a half-written settings file
    const tmp = `${c.file}.obstat-${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
    fs.renameSync(tmp, c.file)
    return status()
  }

  function disconnect(id) {
    const c = client(id)
    const r = read(c.file)
    if (r.broken || r.absent || !r.settings.mcpServers?.[NAME]) return status()
    const { [NAME]: _gone, ...rest } = r.settings.mcpServers
    const tmp = `${c.file}.obstat-${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ ...r.settings, mcpServers: rest }, null, 2)}\n`)
    fs.renameSync(tmp, c.file)
    return status()
  }

  return { status, connect, disconnect, putBridge, bridge }
}

module.exports = { create, clients, NAME }
