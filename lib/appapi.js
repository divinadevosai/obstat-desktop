// What a running app can do, as a machine can use it: most local AI apps are Gradio
// apps, and every Gradio app describes its own API (each endpoint, its inputs and
// outputs) and serves it, with no code from the app's author. Obstat reads that
// description so it can show it on the app's page and, later, so Autopilot can chain
// apps together.
//   Gradio 5   GET  {app}/gradio_api/info,  POST {app}/gradio_api/call/{name}
//   Gradio 4   GET  {app}/info,             POST {app}/call/{name}
// Then GET .../call/{name}/{event_id} streams the result (server-sent events).
// Only apps on this computer are asked, and what they answer is untrusted: it's
// size-limited, checked field by field, and only plain values come out of it.
"use strict"

const MAX_BYTES = 1 << 20 // an API description is a few KB; a megabyte is plenty
const MAX_ENDPOINTS = 50
const MAX_PARAMS = 40
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/|$)/i

const str = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : v == null ? null : String(v).slice(0, n))
const base = (url) => String(url).replace(/[?#].*$/, "").replace(/\/+$/, "")

async function getJson(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > MAX_BYTES) return null
    try { return JSON.parse(text) } catch { return null }
  } catch { return null } finally { clearTimeout(timer) }
}

// one input or output, as the app describes it
function field(p) {
  if (!p || typeof p !== "object") return null
  const type = p.python_type?.type || p.type?.type || (typeof p.type === "string" ? p.type : null)
  return {
    name: str(p.parameter_name || p.label || null, 80),
    label: str(p.label || p.parameter_name || null, 80),
    component: str(p.component || null, 40),
    type: str(type, 120),
    required: p.parameter_has_default === undefined ? null : !p.parameter_has_default,
    default: p.parameter_has_default && ["string", "number", "boolean"].includes(typeof p.parameter_default) ? p.parameter_default : null,
    // a file goes in as a file (an upload), not as text
    file: /^(Audio|Image|Video|File|Model3D|Gallery|ImageEditor)$/i.test(String(p.component || "")) || /filepath|FileData/i.test(String(type || "")),
  }
}

// The app's endpoints, from Gradio's own description. null: not a Gradio app (or not answering).
function endpoints(info) {
  const named = info && typeof info === "object" && info.named_endpoints
  if (!named || typeof named !== "object") return null
  return Object.entries(named).slice(0, MAX_ENDPOINTS).map(([name, e]) => ({
    name: str(name, 120),
    inputs: (Array.isArray(e?.parameters) ? e.parameters : []).slice(0, MAX_PARAMS).map(field).filter(Boolean),
    outputs: (Array.isArray(e?.returns) ? e.returns : []).slice(0, MAX_PARAMS).map(field).filter(Boolean),
  })).filter((e) => /^\/[\w./-]{1,120}$/.test(e.name))
}

// What a running app at `url` (on this computer) offers: { kind: "gradio", prefix,
// endpoints } or { kind: null } when it doesn't describe an API Obstat can read.
async function discover(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  // apps often say they're at 0.0.0.0 (every address); this computer's own is the one to ask
  const root = base(String(url || "").replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, "$1127.0.0.1"))
  if (!LOCAL.test(root + "/")) return { kind: null, reason: "Only apps running on this computer can be asked." }
  for (const prefix of ["/gradio_api", ""]) {
    const info = await getJson(fetchImpl, `${root}${prefix}/info`, timeoutMs)
    const list = endpoints(info)
    if (list) return { kind: "gradio", url: root, prefix, endpoints: list }
  }
  return { kind: null, reason: "This app doesn't describe an API Obstat can read (it isn't a Gradio app, or it turned its API off)." }
}

// Calls one endpoint and returns its outputs. `data`: the inputs, in order.
// Files in the outputs come back as their address on the app (fileUrl).
async function call(api, name, data = [], { fetchImpl = fetch, timeoutMs = 10 * 60000 } = {}) {
  if (!api || api.kind !== "gradio" || !LOCAL.test(api.url)) throw new Error("That app's API isn't available.")
  const ep = api.endpoints.find((e) => e.name === name)
  if (!ep) throw new Error(`The app has no ${name} endpoint.`)
  const at = `${api.url}${api.prefix}/call${ep.name}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const start = await fetchImpl(at, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) })
    if (!start.ok) throw new Error(`The app refused the call (${start.status}).`)
    const { event_id: id } = JSON.parse((await start.text()).slice(0, 10000))
    if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new Error("The app didn't start the call.")
    const res = await fetchImpl(`${at}/${id}`, { signal: ctl.signal, headers: { accept: "text/event-stream" } })
    if (!res.ok) throw new Error(`The app didn't answer the call (${res.status}).`)
    const text = await res.text()
    // server-sent events: the last "complete" or "error" event is the answer
    let event = null, result = null, error = null
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:") && event === "complete") { try { result = JSON.parse(line.slice(5)) } catch { result = null } }
      else if (line.startsWith("data:") && event === "error") error = line.slice(5).trim().slice(0, 500) || "The app reported an error."
    }
    if (error !== null) throw new Error(`The app said: ${error === "null" ? "something went wrong" : error}`)
    if (!Array.isArray(result)) throw new Error("The app's answer wasn't readable.")
    return result.map((v) => (v && typeof v === "object" && typeof v.url === "string" ? { file: true, fileUrl: v.url, name: str(v.orig_name || v.path, 200) } : v))
  } finally { clearTimeout(timer) }
}

module.exports = { discover, call, endpoints, LOCAL }
