// Autopilot's planner on Claude (Anthropic's API, with the user's own key): given what
// the user asked for and the actions their local apps offer (lib/autopilot.js builds
// them), Claude picks which to run, in what order, with what inputs. Obstat runs each
// one on this computer and hands the result back, until Claude says it's done.
// A manual loop, so every step goes through Obstat (and is shown) before it runs.
"use strict"
const Anthropic = require("@anthropic-ai/sdk")
const Client = Anthropic.default || Anthropic

const MODEL = "claude-opus-5-5"

// tools: [{ name, description, input_schema, run(input) -> string }]
// onEvent({ type: "say", text } | { type: "step", tool, input } | { type: "result", tool, text, error })
async function plan({ apiKey, client = null, goal, system, tools, onEvent = () => {}, maxSteps = 16, signal } = {}) {
  client = client || new Client({ apiKey })
  const messages = [{ role: "user", content: goal }]
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error("Stopped.")
    // read each turn: a step can add tools (an app the plan installed)
    const byName = new Map(tools.map((t) => [t.name, t]))
    const defs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // if Claude's safety checks decline, Anthropic's recommended model answers instead
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      tools: defs,
      messages,
    }, { signal })
    if (res.stop_reason === "refusal") throw new Error("Claude declined this request.")
    // the whole reply goes back next time, as the API expects (thinking blocks included)
    messages.push({ role: "assistant", content: res.content })
    const said = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
    if (said) onEvent({ type: "say", text: said })
    if (res.stop_reason === "pause_turn") continue
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer ran too long.")
    const uses = res.content.filter((b) => b.type === "tool_use")
    if (!uses.length) return { text: said }
    const results = []
    for (const u of uses) {
      const tool = byName.get(u.name)
      onEvent({ type: "step", tool: u.name, input: u.input })
      try {
        if (!tool) throw new Error(`There's no action called ${u.name}.`)
        if (signal?.aborted) throw new Error("Stopped.")
        const text = await tool.run(u.input || {})
        onEvent({ type: "result", tool: u.name, text })
        results.push({ type: "tool_result", tool_use_id: u.id, content: text })
      } catch (err) {
        onEvent({ type: "result", tool: u.name, text: err.message, error: true })
        results.push({ type: "tool_result", tool_use_id: u.id, content: err.message, is_error: true })
      }
    }
    // every result in one message, so Claude keeps calling tools in parallel when it can
    messages.push({ role: "user", content: results })
  }
  throw new Error(`Autopilot stopped after ${maxSteps} steps without finishing.`)
}

// One question, one answer in plain text (the install doctor's explanation, lib/doctor.js)
async function ask({ apiKey, client = null, system, text, signal } = {}) {
  client = client || new Client({ apiKey })
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: text }],
  }, { signal })
  if (res.stop_reason === "refusal") throw new Error("Claude declined this request.")
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
}

module.exports = { plan, ask, MODEL }
