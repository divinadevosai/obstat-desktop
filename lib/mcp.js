// Your apps as tools for any AI: the Model Context Protocol, served on Obstat's agent
// link (lib/control.js, POST /mcp). Claude Desktop, Claude Code, Cursor and anything else
// that speaks MCP start the small bridge (lib/mcp-bridge.cjs), which passes their
// messages here. Each installed app's actions (lib/appapi.js) and each recipe
// (lib/recipes.js) is a tool; a call runs on this computer through Autopilot's own path
// (lib/autopilot.js), so it gets the same checks on files and text and a privacy receipt.
//
// Plain JSON-RPC 2.0, one message in and at most one out: initialize, ping, tools/list,
// tools/call. Nothing else of MCP is offered (no resources, prompts or sampling).
"use strict"

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const text = (t, isError = false) => ({ content: [{ type: "text", text: String(t).slice(0, 60000) }], ...(isError ? { isError: true } : {}) })

function create({ autopilot, recipes, apps, version = "0", log = () => {} }) {
  const own = [
    {
      name: "obstat_list_apps",
      description: "The AI apps installed in Obstat on this computer: which are running, and which have actions you can call as tools. An app with no known actions needs starting once in Obstat.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const known = new Set((await autopilot.usable()).map((a) => a.id))
        return JSON.stringify(apps.list().filter((a) => a.installed).map((a) => ({ id: a.id, name: a.name, about: String(a.description || "").slice(0, 200), running: !!a.running, actionsKnown: known.has(a.id) })))
      },
    },
    {
      name: "obstat_list_recipes",
      description: "The user's saved recipes in Obstat: multi-step workflows across their apps that run the same way every time. Shows the files and the text each one takes.",
      inputSchema: { type: "object", properties: {} },
      run: async () => JSON.stringify(recipes.list().filter((r) => !r.imported).map((r) => ({
        id: r.id, name: r.name, about: r.about,
        files: r.files.map((f) => f.label),
        text: Object.fromEntries(r.steps.flatMap((s, i) => s.inputs.map((v, k) => (v.edit ? [[`${i}.${k}`, { for: `${s.appName}: ${v.label}`, now: v.value }]] : [])).flat())),
        steps: r.steps.map((s) => `${s.appName}: ${s.action.replace(/^\//, "")}`),
      }))),
    },
    {
      name: "obstat_run_recipe",
      description: "Run one of the user's saved Obstat recipes on this computer. Give `files` (full paths, one per file the recipe takes, in order) and optionally `text` to change its text inputs (keys from obstat_list_recipes). Returns the files it made.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "the recipe's id, from obstat_list_recipes" }, files: { type: "array", items: { type: "string" }, description: "full paths of the files it takes, in order" }, text: { type: "object", description: "text inputs to change, e.g. {\"0.0\": \"new words\"}", additionalProperties: { type: "string" } } }, required: ["id"] },
      run: async ({ id, files = [], text: changes = {} }) => {
        const r = recipes.get(String(id))
        if (r.imported) throw new Error("That recipe came from someone else and hasn't been looked at yet. Open Obstat's Autopilot page and run it there first.")
        const out = await autopilot.runRecipe(r, { files: Array.isArray(files) ? files : [], values: changes && typeof changes === "object" ? changes : {} })
        return JSON.stringify({ files: out.files, folder: out.dir, receipt: out.receipt?.summary })
      },
    },
  ]

  async function tools() {
    const actions = await autopilot.actions()
    return [...own.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), ...actions.map((a) => ({ name: a.name, description: `${a.description} Runs on this computer through Obstat; files it makes are saved and their paths returned.`, inputSchema: a.input_schema }))]
  }

  async function call(name, args) {
    const mine = own.find((t) => t.name === name)
    try {
      if (mine) return text(await mine.run(args || {}))
      log(`agent ran ${name}`)
      const r = await autopilot.runAction(name, args || {})
      return text(JSON.stringify({ results: r.results, files: r.files, folder: r.dir, receipt: r.receipt?.summary }))
    } catch (err) { return text(err.message, true) }
  }

  // One JSON-RPC message in; the reply, or null for a notification.
  async function handle(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Not a JSON-RPC 2.0 request." } }
    if (msg.id === undefined || msg.id === null) return null // notifications (initialized, cancelled…): nothing to answer
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result })
    try {
      if (msg.method === "initialize") {
        const asked = msg.params?.protocolVersion
        return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: "obstat", title: "Obstat", version }, instructions: "Obstat runs open-source AI apps on the user's own computer. Each tool is one action of one of their apps, or one of their saved recipes; all of it runs locally. Give files as full paths; files a tool makes come back as paths you can pass to another tool." })
      }
      if (msg.method === "ping") return ok({})
      if (msg.method === "tools/list") return ok({ tools: await tools() })
      if (msg.method === "tools/call") {
        if (typeof msg.params?.name !== "string") return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "tools/call needs a tool name." } }
        return ok(await call(msg.params.name, msg.params.arguments))
      }
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Obstat doesn't offer ${msg.method}.` } }
    } catch (err) { return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } } }
  }

  return { handle, tools, call }
}

module.exports = { create, PROTOCOLS }
