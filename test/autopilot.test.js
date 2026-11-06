// Autopilot (lib/autopilot.js): two stand-in Gradio apps on this computer (text to a
// .wav, and a .wav in to a processed .wav out), and a scripted planner standing in for
// Claude, chaining them the way a real plan would.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const homeLib = require("../lib/home")
const autopilotLib = require("../lib/autopilot")

// a Gradio 5 app: `info` endpoints, and `handle(data, uploads) -> outputs` per endpoint
function fakeApp(info, handlers) {
  const files = new Map(), uploads = []
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}/gradio_api`
    if (req.url === "/gradio_api/info") return res.end(JSON.stringify({ named_endpoints: info, unnamed_endpoints: {} }))
    if (req.method === "POST" && req.url === "/gradio_api/upload") {
      const chunks = []
      req.on("data", (d) => chunks.push(d))
      req.on("end", () => { const p = `/tmp/gradio/up-${uploads.length}`; uploads.push(Buffer.concat(chunks).toString("latin1")); files.set(p, Buffer.from("uploaded")); res.end(JSON.stringify([p])) })
      return
    }
    const call = /^\/gradio_api\/call\/(\w+)$/.exec(req.url)
    if (req.method === "POST" && call) {
      let body = ""
      req.on("data", (d) => { body += d })
      req.on("end", () => { server.pending = handlers[call[1]](JSON.parse(body).data); res.end(JSON.stringify({ event_id: "e1" })) })
      return
    }
    if (/^\/gradio_api\/call\/\w+\/e1$/.test(req.url)) {
      const out = server.pending.map((o) => (o && o.makeFile ? (files.set(o.makeFile, Buffer.from(o.bytes)), { path: o.makeFile, url: `${base}/file=${o.makeFile}`, orig_name: path.basename(o.makeFile) }) : o))
      return res.end(`event: complete\ndata: ${JSON.stringify(out)}\n\n`)
    }
    const file = /^\/gradio_api\/file=(.*)$/.exec(req.url)
    if (file && files.has(file[1])) return res.end(files.get(file[1]))
    res.statusCode = 404
    res.end()
  }).listen(0, "127.0.0.1")
  server.uploads = uploads
  return new Promise((r) => server.once("listening", () => r(server)))
}

const TTS = {
  "/generate_speech": {
    parameters: [
      { label: "Text", parameter_name: "text", parameter_has_default: false, python_type: { type: "str" }, component: "Textbox" },
      { label: "Voice", parameter_name: "voice", parameter_has_default: true, parameter_default: "af_heart", python_type: { type: "Literal['af_heart', 'bm_george']" }, component: "Dropdown" },
    ],
    returns: [{ label: "Audio", python_type: { type: "filepath" }, component: "Audio" }],
  },
  "/refresh_voices": { parameters: [], returns: [{ label: "Voices", component: "Dropdown" }] },
  "/lambda": { parameters: [{ parameter_name: "x", component: "Textbox" }], returns: [{ component: "Textbox" }] },
}
const FX = {
  "/add_echo": {
    parameters: [{ label: "Input audio", parameter_name: "audio", parameter_has_default: false, python_type: { type: "filepath" }, component: "Audio" }],
    returns: [{ label: "Output", python_type: { type: "filepath" }, component: "Audio" }],
  },
}

// a stand-in for the Anthropic client: replies in turn, each seeing the messages so far
function scriptedClaude(replies) {
  const seen = []
  return { seen, beta: { messages: { create: async (req) => { seen.push(JSON.parse(JSON.stringify(req))); return replies[seen.length - 1](req) } } } }
}

async function setup() {
  const tts = await fakeApp(TTS, { generate_speech: ([text, voice]) => [{ makeFile: "/tmp/gradio/speech.wav", bytes: `RIFF ${voice} ${text}` }] })
  const fx = await fakeApp(FX, { add_echo: () => [{ makeFile: "/tmp/gradio/echo.wav", bytes: "RIFF echo" }] })
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-pilot-"))); h.ensure()
  const url = (s) => `http://127.0.0.1:${s.address().port}`
  const list = [
    { id: "a/kokoro", name: "Kokoro TTS", installed: true, running: { url: url(tts) } },
    { id: "b/fx", name: "Echo FX", installed: true, running: { url: url(fx) } },
  ]
  const events = []
  const keys = { envFor: (id) => (id === "obstat/autopilot" ? { AUTOPILOT_ANTHROPIC_KEY: "sk-ant-test" } : {}) }
  return { tts, fx, h, list, events, keys, close: () => { tts.close(); fx.close(); fs.rmSync(h.root, { recursive: true, force: true }) } }
}

test("only an app's real actions become tools, with their choices and defaults", async () => {
  const s = await setup()
  try {
    const pilot = autopilotLib.create({ home: s.h, keys: s.keys, apps: { list: () => s.list, ensureRunning: async () => null } })
    const usable = await pilot.usable()
    const tools = autopilotLib.toolsFor(usable, { run: async () => "" })
    assert.deepEqual(tools.map((t) => t.name), ["kokoro_tts__generate_speech", "echo_fx__add_echo"], "UI plumbing (refresh, lambda) is left out")
    const props = tools[0].input_schema.properties
    assert.deepEqual(props.voice.enum, ["af_heart", "bm_george"])
    assert.deepEqual(tools[0].input_schema.required, ["text"])
    assert.match(tools[1].input_schema.properties.audio.description, /a file/)
  } finally { s.close() }
})

test("a plan chains two apps: text to speech, then that speech through the other app, and the files are kept", async () => {
  const s = await setup()
  try {
    const claude = scriptedClaude([
      () => ({ stop_reason: "tool_use", content: [{ type: "text", text: "First the voice." }, { type: "tool_use", id: "t1", name: "kokoro_tts__generate_speech", input: { text: "Hello there", voice: "bm_george" } }] }),
      (req) => {
        // the planner sees the saved file's path in the result and passes it on
        const result = JSON.parse(req.messages.at(-1).content[0].content)
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "echo_fx__add_echo", input: { audio: result[0].Audio.file } }] }
      },
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Made an echoed reading." }] }),
    ])
    const planner = { MODEL: "claude-opus-5-5", plan: (opts) => require("../lib/planner-claude").plan({ ...opts, client: claude }) }
    const pilot = autopilotLib.create({ home: s.h, keys: s.keys, plannerClaude: planner, emit: (e) => s.events.push(e), apps: { list: () => s.list, ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } })
    const r = await pilot.start({ goal: "Say hello in George's voice with an echo" })
    assert.equal(r.text, "Made an echoed reading.")
    const names = r.files.map((f) => path.basename(f)).sort()
    assert.deepEqual(names, ["echo_fx-echo.wav", "kokoro_tts-speech.wav"])
    assert.equal(fs.readFileSync(r.files.find((f) => f.endsWith("speech.wav")), "utf8"), "RIFF bm_george Hello there")
    assert.equal(s.fx.uploads.length, 1, "the speech file was sent to the second app")
    assert.match(s.fx.uploads[0], /RIFF bm_george Hello there/)
    // what Claude was asked: the default model, effort and fallback, and the full reply passed back
    assert.equal(claude.seen[0].model, "claude-opus-5-5")
    assert.equal(claude.seen[0].fallbacks, "default")
    assert.equal(claude.seen[1].messages[1].content[0].text, "First the voice.")
    assert.deepEqual(s.events.filter((e) => e.type === "step").map((e) => e.tool), ["kokoro_tts__generate_speech", "echo_fx__add_echo"])
    assert.equal(s.events.at(-1).type, "done")
  } finally { s.close() }
})

test("a plan can't hand an app a file from elsewhere on this computer", async () => {
  const s = await setup()
  const secret = path.join(os.tmpdir(), `obstat-pilot-secret-${process.pid}.txt`)
  fs.writeFileSync(secret, "private")
  try {
    const claude = scriptedClaude([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "echo_fx__add_echo", input: { audio: secret } }] }),
      (req) => ({ stop_reason: "end_turn", content: [{ type: "text", text: req.messages.at(-1).content[0].is_error ? "refused" : "sent" }] }),
    ])
    const planner = { MODEL: "claude-opus-5-5", plan: (opts) => require("../lib/planner-claude").plan({ ...opts, client: claude }) }
    const pilot = autopilotLib.create({ home: s.h, keys: s.keys, plannerClaude: planner, emit: (e) => s.events.push(e), apps: { list: () => s.list, ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } })
    const r = await pilot.start({ goal: "x" })
    assert.equal(r.text, "refused")
    assert.equal(s.fx.uploads.length, 0)
    assert.match(s.events.find((e) => e.type === "result").text, /isn't a file from this run/)
  } finally { s.close(); fs.rmSync(secret, { force: true }) }
})

test("a file the user attached can be used, and Autopilot says what it needs when it can't plan", async () => {
  const s = await setup()
  const mine = path.join(os.tmpdir(), `obstat-pilot-mine-${process.pid}.wav`)
  fs.writeFileSync(mine, "RIFF mine")
  try {
    const claude = scriptedClaude([
      (req) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "echo_fx__add_echo", input: { audio: /Files the user gave you: (\S+)/.exec(req.system)[1] } }] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
    ])
    const planner = { MODEL: "claude-opus-5-5", plan: (opts) => require("../lib/planner-claude").plan({ ...opts, client: claude }) }
    const pilot = autopilotLib.create({ home: s.h, keys: s.keys, plannerClaude: planner, apps: { list: () => s.list, ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } })
    await pilot.start({ goal: "Add echo to my file", files: [mine] })
    assert.match(s.fx.uploads[0], /RIFF mine/)

    // no key and no Ollama: it says how to set it up
    const none = autopilotLib.create({ home: s.h, keys: { envFor: () => ({}) }, plannerOllama: { models: async () => null }, apps: { list: () => s.list, ensureRunning: async () => null } })
    await assert.rejects(none.start({ goal: "x" }), /Anthropic API key/)
  } finally { s.close(); fs.rmSync(mine, { force: true }) }
})

test("a local model through Ollama plans the same way", async () => {
  const s = await setup()
  try {
    let turn = 0
    const fetchImpl = async (url, opts) => {
      if (!String(url).startsWith("http://127.0.0.1:11434")) return fetch(url, opts)
      const body = JSON.parse(opts.body)
      turn++
      const message = turn === 1
        ? { role: "assistant", content: "", tool_calls: [{ function: { name: "kokoro_tts__generate_speech", arguments: { text: "Hi" } } }] }
        : { role: "assistant", content: body.messages.at(-1).role === "tool" ? "Done locally." : "?" }
      return new Response(JSON.stringify({ message }))
    }
    const ollama = { models: async () => ["qwen3"], plan: (opts) => require("../lib/planner-ollama").plan({ ...opts, fetchImpl }) }
    const pilot = autopilotLib.create({ home: s.h, keys: { envFor: () => ({}) }, plannerOllama: ollama, apps: { list: () => s.list, ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } })
    assert.deepEqual(await pilot.status(), { planner: "ollama", model: "qwen3", models: ["qwen3"] })
    const r = await pilot.start({ goal: "say hi" })
    assert.equal(r.text, "Done locally.")
    assert.equal(r.files.length, 1)
  } finally { s.close() }
})
