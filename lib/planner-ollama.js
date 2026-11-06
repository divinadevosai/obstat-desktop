// Autopilot's planner on a local model through Ollama (http://127.0.0.1:11434), for
// people who want nothing to leave their computer: the same loop as lib/planner-claude.js,
// with Ollama's own chat API and its tool calls.
"use strict"

const BASE = "http://127.0.0.1:11434"

// Ollama running here, and its models, the ones that can use tools first (Autopilot needs
// tools; a model without them fails on the first step); null when Ollama isn't running.
async function models({ fetchImpl = fetch } = {}) {
  let names
  try {
    const res = await fetchImpl(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const j = await res.json()
    names = (Array.isArray(j?.models) ? j.models : []).map((m) => String(m.name || m.model || "")).filter(Boolean)
  } catch { return null }
  // newer Ollama says what each model can do; an older one doesn't, and the order stays
  const tools = await Promise.all(names.slice(0, 30).map(async (model) => {
    try {
      const res = await fetchImpl(`${BASE}/api/show`, { method: "POST", signal: AbortSignal.timeout(3000), headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) })
      const caps = res.ok ? (await res.json())?.capabilities : null
      return Array.isArray(caps) ? caps.includes("tools") : null
    } catch { return null }
  }))
  const rank = (i) => (tools[i] === true ? 0 : tools[i] === null || tools[i] === undefined ? 1 : 2)
  return names.map((n, i) => [n, i]).sort((a, b) => rank(a[1]) - rank(b[1]) || a[1] - b[1]).map(([n]) => n)
}

async function plan({ model, goal, system, tools, onEvent = () => {}, maxSteps = 16, signal, fetchImpl = fetch } = {}) {
  const messages = [{ role: "system", content: system }, { role: "user", content: goal }]
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error("Stopped.")
    // read each turn: a step can add tools (an app the plan installed)
    const byName = new Map(tools.map((t) => [t.name, t]))
    const defs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }))
    const res = await fetchImpl(`${BASE}/api/chat`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages, tools: defs, stream: false }) })
    if (!res.ok) {
      // Ollama says why (a model that can't use tools, one that isn't downloaded)
      let why = ""
      try { why = String((await res.json())?.error || "").slice(0, 300) } catch {}
      throw new Error(`Ollama couldn't plan with ${model}${why ? `: ${why}` : ` (${res.status})`}. Autopilot needs a model that can use tools, like qwen3.`)
    }
    const msg = (await res.json())?.message || {}
    messages.push(msg)
    if (msg.content?.trim()) onEvent({ type: "say", text: msg.content.trim() })
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    if (!calls.length) return { text: msg.content?.trim() || "" }
    for (const c of calls) {
      const name = c.function?.name
      let input = c.function?.arguments || {}
      if (typeof input === "string") { try { input = JSON.parse(input) } catch { input = {} } }
      onEvent({ type: "step", tool: name, input })
      let text
      try {
        const tool = byName.get(name)
        if (!tool) throw new Error(`There's no action called ${name}.`)
        text = await tool.run(input)
        onEvent({ type: "result", tool: name, text })
      } catch (err) {
        text = `Error: ${err.message}`
        onEvent({ type: "result", tool: name, text: err.message, error: true })
      }
      messages.push({ role: "tool", tool_name: name, content: text })
    }
  }
  throw new Error(`Autopilot stopped after ${maxSteps} steps without finishing.`)
}

module.exports = { plan, models, BASE }
