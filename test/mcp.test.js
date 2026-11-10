// Your apps as tools for any AI (lib/mcp.js, lib/mcp-bridge.cjs, lib/connect.js): the
// protocol, the real bridge process talking to the real agent link, which files an AI tool
// may hand an app, and the settings Obstat writes for Claude Desktop and Cursor.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")
const homeLib = require("../lib/home")
const autopilotLib = require("../lib/autopilot")
const recipesLib = require("../lib/recipes")
const mcpLib = require("../lib/mcp")
const controlLib = require("../lib/control")
const connectLib = require("../lib/connect")
const { fakeApp, TTS, FX } = require("./fake-gradio")

async function setup() {
  const tts = await fakeApp(TTS, { generate_speech: ([text, voice]) => [{ makeFile: "/tmp/gradio/speech.wav", bytes: `RIFF ${voice} ${text}` }] })
  const fx = await fakeApp(FX, { add_echo: () => [{ makeFile: "/tmp/gradio/echo.wav", bytes: "RIFF echo" }] })
  // not under a hidden or temp-dot folder name, so its run files count as the user's
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-mcp-"))); h.ensure()
  const url = (s) => `http://127.0.0.1:${s.address().port}`
  const list = [
    { id: "a/kokoro", name: "Kokoro TTS", description: "Text to speech", installed: true, running: { url: url(tts) } },
    { id: "b/fx", name: "Echo FX", installed: true, running: { url: url(fx) } },
    { id: "c/chat", name: "Chat", installed: true, running: null },
  ]
  const apps = { list: () => list, appDir: (id) => path.join(h.dir("apps"), id.replace("/", "-")), ensureRunning: async (id) => list.find((a) => a.id === id).running.url }
  const events = []
  const autopilot = autopilotLib.create({ home: h, keys: { envFor: () => ({}) }, apps, emit: (e) => events.push(e) })
  const recipes = recipesLib.create(h)
  const mcp = mcpLib.create({ autopilot, recipes, apps, version: "1.2.3" })
  let id = 0
  const ask = (method, params) => mcp.handle({ jsonrpc: "2.0", id: ++id, method, params })
  return { tts, fx, h, list, apps, events, autopilot, recipes, mcp, ask, close: () => { tts.close(); fx.close(); fs.rmSync(h.root, { recursive: true, force: true }) } }
}

test("an AI tool connects, sees each app's actions as tools, and chains two apps", async () => {
  const s = await setup()
  try {
    const hello = await s.ask("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test" } })
    assert.equal(hello.result.protocolVersion, "2025-03-26")
    assert.equal(hello.result.serverInfo.name, "obstat")
    assert.deepEqual(hello.result.capabilities, { tools: {} })
    assert.equal((await s.ask("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, mcpLib.PROTOCOLS[0], "an unknown version gets Obstat's newest")
    assert.equal(await s.mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null)
    assert.deepEqual((await s.ask("ping")).result, {})

    const { tools } = (await s.ask("tools/list")).result
    assert.deepEqual(tools.map((t) => t.name), ["obstat_list_apps", "obstat_list_recipes", "obstat_run_recipe", "kokoro_tts__generate_speech", "echo_fx__add_echo"])
    const speak = tools.find((t) => t.name === "kokoro_tts__generate_speech")
    assert.deepEqual(speak.inputSchema.properties.voice.enum, ["af_heart", "bm_george"])
    assert.ok(tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && t.inputSchema.type === "object"))

    const apps = JSON.parse((await s.ask("tools/call", { name: "obstat_list_apps" })).result.content[0].text)
    assert.deepEqual(apps.map((a) => [a.name, a.running, a.actionsKnown]), [["Kokoro TTS", true, true], ["Echo FX", true, true], ["Chat", false, false]])

    // one app, then its file into the next
    const first = (await s.ask("tools/call", { name: "kokoro_tts__generate_speech", arguments: { text: "Hello", voice: "bm_george" } })).result
    assert.equal(first.isError, undefined)
    const made = JSON.parse(first.content[0].text)
    assert.equal(fs.readFileSync(made.files[0], "utf8"), "RIFF bm_george Hello")
    assert.match(made.receipt, /couldn't look|No app connected/)
    const second = JSON.parse((await s.ask("tools/call", { name: "echo_fx__add_echo", arguments: { audio: made.files[0] } })).result.content[0].text)
    assert.match(s.fx.uploads[0], /RIFF bm_george Hello/)
    assert.equal(second.files.length, 1)
    // each call left a receipt saying an AI tool asked, and showed in the Autopilot page
    const receipt = JSON.parse(fs.readFileSync(path.join(second.folder, "receipt.json"), "utf8"))
    assert.equal(receipt.kind, "agent")
    assert.equal(receipt.planner.kind, "agent")
    assert.deepEqual(s.events.filter((e) => e.type === "start").map((e) => e.planner), ["agent", "agent"])

    // mistakes come back as tool errors the AI can read, not protocol failures
    const bad = (await s.ask("tools/call", { name: "nope__x", arguments: {} })).result
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /no action called nope__x/)
    assert.equal((await s.ask("resources/list")).error.code, -32601)
    assert.equal((await s.mcp.handle({ id: 1, method: "ping" })).error.code, -32600)
  } finally { s.close() }
})

test("an AI tool can't hand an app a file from a private folder, or a path as text", async () => {
  const s = await setup()
  const hidden = path.join(s.h.root, "..", `.obstat-mcp-secret-${process.pid}`)
  fs.mkdirSync(hidden, { recursive: true })
  fs.writeFileSync(path.join(hidden, "id_rsa"), "PRIVATE")
  fs.writeFileSync(path.join(s.h.root, "control.json"), "{}")
  // an ordinary file of the user's (the temp folder is under AppData on Windows: private)
  const mine = path.join(os.homedir(), `obstat-mcp-test-${process.pid}.wav`)
  fs.writeFileSync(mine, "RIFF mine")
  try {
    const call = async (args) => (await s.ask("tools/call", { name: "echo_fx__add_echo", arguments: args })).result
    for (const [file, why] of [[path.join(hidden, "id_rsa"), /private folder/], [path.join(s.h.root, "control.json"), /private folder/], ["relative.wav", /isn't a full path/], [path.join(os.tmpdir(), "obstat-nothing-here.wav"), /no file at/]]) {
      const r = await call({ audio: file })
      assert.equal(r.isError, true, file)
      assert.match(r.content[0].text, why)
    }
    assert.equal(s.fx.uploads.length, 0)
    const text = (await s.ask("tools/call", { name: "kokoro_tts__generate_speech", arguments: { text: process.platform === "win32" ? "C:\\Users\\me\\notes.txt" : "/home/me/notes.txt" } })).result
    assert.match(text.content[0].text, /is a place on this computer/)
    // an ordinary file of the user's is fine
    const ok = await call({ audio: mine })
    assert.equal(ok.isError, undefined)
    assert.match(s.fx.uploads[0], /RIFF mine/)
  } finally { s.close(); fs.rmSync(hidden, { recursive: true, force: true }); fs.rmSync(mine, { force: true }) }
})

test("recipes are tools too, except one from someone else that hasn't been looked at", async () => {
  const s = await setup()
  try {
    const mine = s.recipes.save({ obstatRecipe: 1, name: "Say it", steps: [{ app: "a/kokoro", appName: "Kokoro TTS", action: "/generate_speech", inputs: [{ label: "Text", value: "Hi", edit: true }, { label: "Voice", value: "af_heart" }] }] })
    const file = path.join(s.h.root, "theirs.json")
    fs.writeFileSync(file, JSON.stringify({ obstatRecipe: 1, name: "Theirs", steps: [{ app: "a/kokoro", appName: "Kokoro TTS", action: "/generate_speech", inputs: [{ label: "Text", value: "x" }] }] }))
    const theirs = s.recipes.importFile(file)
    const listed = JSON.parse((await s.ask("tools/call", { name: "obstat_list_recipes" })).result.content[0].text)
    assert.deepEqual(listed.map((r) => r.id), [mine.id], "an unlooked-at import isn't offered")
    assert.deepEqual(listed[0].text, { "0.0": { for: "Kokoro TTS: Text", now: "Hi" } })
    const ran = JSON.parse((await s.ask("tools/call", { name: "obstat_run_recipe", arguments: { id: mine.id, text: { "0.0": "Bye" } } })).result.content[0].text)
    assert.equal(fs.readFileSync(ran.files[0], "utf8"), "RIFF af_heart Bye")
    const refused = (await s.ask("tools/call", { name: "obstat_run_recipe", arguments: { id: theirs.id } })).result
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /came from someone else/)
  } finally { s.close() }
})

// the bridge as a tool would run it: a real process, lines in, lines out
function bridge(homeRoot) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "lib", "mcp-bridge.cjs"), homeRoot], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })
  const waiting = new Map()
  let buf = ""
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d
    for (let at; (at = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1); waiting.get(m.id)?.(m); waiting.delete(m.id) }
  })
  let id = 0
  const ask = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`) })
  const tell = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  return { ask, tell, end: () => new Promise((r) => { child.once("exit", r); child.stdin.end() }) }
}

test("the bridge passes a tool's messages to Obstat's agent link, and says so when Obstat is closed", async () => {
  const s = await setup()
  const control = controlLib.create(s.h, s.apps, { mcp: s.mcp })
  try {
    // Obstat closed (no link): the tool still connects, and is told what to do
    const off = bridge(s.h.root)
    assert.equal((await off.ask("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "obstat")
    assert.deepEqual((await off.ask("tools/list")).result.tools.map((t) => t.name), ["obstat_list_apps"])
    const told = (await off.ask("tools/call", { name: "obstat_list_apps" })).result
    assert.equal(told.isError, true)
    assert.match(told.content[0].text, /Open Obstat/)
    await off.end()

    // the link on: the same bridge reaches the real thing, key and all
    const st = await control.start()
    const on = bridge(s.h.root)
    assert.equal((await on.ask("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.version, "1.2.3")
    on.tell("notifications/initialized")
    assert.equal((await on.ask("tools/list")).result.tools.length, 5)
    const made = JSON.parse((await on.ask("tools/call", { name: "kokoro_tts__generate_speech", arguments: { text: "Through the bridge" } })).result.content[0].text)
    assert.equal(fs.readFileSync(made.files[0], "utf8"), "RIFF af_heart Through the bridge")
    await on.end()

    // the link itself: no key, no MCP; a web page (it sends Origin) neither
    const post = (headers) => fetch(`${st.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
    assert.equal((await post({})).status, 401)
    const token = JSON.parse(fs.readFileSync(path.join(s.h.root, "control.json"), "utf8")).token
    assert.equal((await post({ authorization: `Bearer ${token}`, origin: "https://evil.example" })).status, 403)
    assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200)
  } finally { control.stop(); s.close() }
})

test("connecting Claude Desktop or Cursor adds Obstat and keeps everything else in their settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-connect-"))
  try {
    const h = homeLib.create(path.join(root, "obstat")); h.ensure()
    const userHome = path.join(root, "user")
    const c = connectLib.create(h, { node: () => "/opt/obstat node/bin/node", platform: "linux", homeDir: userHome, env: {} })
    const desktop = path.join(userHome, ".config", "Claude", "claude_desktop_config.json")
    fs.mkdirSync(path.dirname(desktop), { recursive: true })
    fs.writeFileSync(desktop, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: [] } } }))

    assert.deepEqual(c.status().clients.map((x) => [x.id, x.present, x.connected]), [["claude-desktop", true, "no"], ["cursor", false, "no"]])
    const after = c.connect("claude-desktop")
    const written = JSON.parse(fs.readFileSync(desktop, "utf8"))
    assert.equal(written.theme, "dark")
    assert.deepEqual(written.mcpServers.other, { command: "x", args: [] })
    assert.deepEqual(written.mcpServers.obstat, { command: "/opt/obstat node/bin/node", args: [c.bridge, h.root] })
    assert.equal(after.clients[0].connected, "yes")
    assert.equal(fs.readFileSync(c.bridge, "utf8"), fs.readFileSync(path.join(__dirname, "..", "lib", "mcp-bridge.cjs"), "utf8"), "the bridge is put where the tool can run it")
    assert.equal(after.command, `claude mcp add obstat -- "/opt/obstat node/bin/node" ${c.bridge} ${h.root}`)
    assert.deepEqual(JSON.parse(after.snippet).mcpServers.obstat.args, [c.bridge, h.root])

    // Cursor had no settings at all
    c.connect("cursor")
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(userHome, ".cursor", "mcp.json"), "utf8")).mcpServers), ["obstat"])

    // disconnect removes only Obstat
    c.disconnect("claude-desktop")
    assert.deepEqual(JSON.parse(fs.readFileSync(desktop, "utf8")), { theme: "dark", mcpServers: { other: { command: "x", args: [] } } })

    // a settings file that isn't JSON is left exactly as it was
    fs.writeFileSync(desktop, "{ not json")
    assert.equal(c.status().clients[0].broken, true)
    assert.throws(() => c.connect("claude-desktop"), /isn't readable/)
    assert.equal(fs.readFileSync(desktop, "utf8"), "{ not json")
    assert.throws(() => c.connect("nope"), /No such AI tool/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
