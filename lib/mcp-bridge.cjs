#!/usr/bin/env node
// Obstat's MCP bridge: what Claude Desktop, Claude Code, Cursor (or any MCP client) start.
// It speaks MCP over stdin/stdout (one JSON message per line) and passes each message to
// Obstat's agent link on this computer (POST /mcp), whose address and key it reads from
// Obstat's control.json every time, so it keeps working when Obstat restarts.
// Run:  node obstat-mcp.cjs [path to Obstat's folder, default ~/obstat]
// No dependencies; plain Node 18+. Obstat copies this file to ~/obstat/mcp/ on Connect.
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const HOME = process.argv[2] || path.join(os.homedir(), "obstat")
const DOWN = "Obstat isn't reachable. Open Obstat on this computer and turn on “Let AI agents use Obstat” (Skills page), then try again."

function link() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, "control.json"), "utf8"))
    if (/^http:\/\/127\.0\.0\.1:\d+$/.test(j.url) && typeof j.token === "string") return j
  } catch {}
  return null
}

// what to say when Obstat isn't running, so the client still connects and can say why
function offline(msg) {
  if (msg.id === undefined || msg.id === null) return null
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result })
  if (msg.method === "initialize") return ok({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "obstat", title: "Obstat", version: "0" }, instructions: DOWN })
  if (msg.method === "ping") return ok({})
  if (msg.method === "tools/list") return ok({ tools: [{ name: "obstat_list_apps", description: `The AI apps installed in Obstat on this computer. (${DOWN})`, inputSchema: { type: "object", properties: {} } }] })
  if (msg.method === "tools/call") return ok({ content: [{ type: "text", text: DOWN }], isError: true })
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: DOWN } }
}

async function pass(msg) {
  const l = link()
  if (!l) return offline(msg)
  try {
    const res = await fetch(`${l.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${l.token}` }, body: JSON.stringify(msg) })
    if (res.status === 202 || res.status === 204) return null
    if (!res.ok) return msg.id == null ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `Obstat said ${res.status}.` } }
    return await res.json()
  } catch { return offline(msg) }
}

let buf = "", open = 0, ended = false
const done = () => { if (ended && !open) process.exit(0) }
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => {
  buf += d
  let at
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at).trim()
    buf = buf.slice(at + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON." } })}\n`); continue }
    // each is answered when it's ready (a long app run doesn't hold up a ping); ids match them up
    open++
    pass(msg).then((out) => { if (out) process.stdout.write(`${JSON.stringify(out)}\n`) }).finally(() => { open--; done() })
  }
})
process.stdin.on("end", () => { ended = true; done() })
