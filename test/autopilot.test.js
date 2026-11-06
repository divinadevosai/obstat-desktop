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

// ---------- recipes (lib/recipes.js): a run kept, and run again with no planner ----------
const recipesLib = require("../lib/recipes")
const noPlanner = { MODEL: "none", plan: () => { throw new Error("a recipe must not plan") } }

test("a run that worked becomes a recipe, and runs again with no planner and changed text", async () => {
  const s = await setup()
  try {
    const claude = scriptedClaude([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "kokoro_tts__generate_speech", input: { text: "Hello there", voice: "bm_george" } }] }),
      (req) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "echo_fx__add_echo", input: { audio: JSON.parse(req.messages.at(-1).content[0].content)[0].Audio.file } }] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
    ])
    const planner = { MODEL: "claude-opus-5-5", plan: (opts) => require("../lib/planner-claude").plan({ ...opts, client: claude }) }
    const deps = { home: s.h, keys: s.keys, emit: (e) => s.events.push(e), apps: { list: () => s.list, ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } }
    // a fresh Autopilot has nothing to keep yet
    await assert.rejects(async () => autopilotLib.create({ ...deps, plannerClaude: planner }).recipeFromLast("x"), /no finished run/)
    const store = recipesLib.create(s.h)
    const ran = autopilotLib.create({ ...deps, plannerClaude: planner })
    assert.equal((await ran.start({ goal: "Hello with echo" })).canKeep, true)
    const kept = store.save(ran.recipeFromLast("Echoed hello"))
    assert.equal(kept.id, "echoed-hello")
    assert.deepEqual(kept.steps.map((x) => [x.app, x.action]), [["a/kokoro", "/generate_speech"], ["b/fx", "/add_echo"]])
    assert.deepEqual(kept.steps[0].inputs[0], { label: "Text", value: "Hello there", edit: true })
    assert.deepEqual(kept.steps[0].inputs[1], { label: "Voice", value: "bm_george" }, "a choice from a list stays as it was")
    assert.deepEqual(kept.steps[1].inputs[0], { label: "Input audio", file: { step: 0, output: 0 } })
    assert.equal(store.list().length, 1)

    // run it again: no planner at all, the text changed, the second app given the first's new file
    const before = s.fx.uploads.length
    const again = autopilotLib.create({ ...deps, plannerClaude: noPlanner, plannerOllama: { models: async () => null, plan: noPlanner.plan } })
    const out = await again.replay(store.get("echoed-hello"), { values: { "0.0": "Goodbye", "0.1": "ignored: not changeable" } })
    assert.equal(out.files.length, 2)
    assert.equal(fs.readFileSync(out.files.find((f) => f.endsWith("speech.wav")), "utf8"), "RIFF bm_george Goodbye")
    assert.match(s.fx.uploads[before], /RIFF bm_george Goodbye/)
    assert.equal(s.events.filter((e) => e.type === "start").at(-1).planner, "recipe")
  } finally { s.close() }
})

test("a recipe made from a file asks for a file, and won't run without the apps it uses", async () => {
  const s = await setup()
  const mine = path.join(os.tmpdir(), `obstat-recipe-mine-${process.pid}.wav`)
  fs.writeFileSync(mine, "RIFF mine")
  const theirs = path.join(os.tmpdir(), `obstat-recipe-theirs-${process.pid}.wav`)
  fs.writeFileSync(theirs, "RIFF theirs")
  try {
    const claude = scriptedClaude([
      (req) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "echo_fx__add_echo", input: { audio: /Files the user gave you: (\S+)/.exec(req.system)[1] } }] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
    ])
    const deps = { home: s.h, keys: s.keys, apps: { list: () => s.list, ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } }
    const pilot = autopilotLib.create({ ...deps, plannerClaude: { MODEL: "m", plan: (o) => require("../lib/planner-claude").plan({ ...o, client: claude }) } })
    await pilot.start({ goal: "Echo my file", files: [mine] })
    const r = recipesLib.create(s.h).save(pilot.recipeFromLast(""))
    assert.equal(r.name, "Echo my file", "unnamed, it's named after what was asked")
    assert.deepEqual(r.files, [{ label: path.basename(mine) }])
    assert.deepEqual(r.steps[0].inputs[0].file, { input: 0 })

    await assert.rejects(pilot.replay(r, {}), /needs 1 file/)
    await pilot.replay(r, { files: [theirs] })
    assert.match(s.fx.uploads.at(-1), /RIFF theirs/)

    s.list[1].installed = false
    await assert.rejects(pilot.replay(r, { files: [theirs] }), /uses Echo FX, which isn't installed/)
  } finally { s.close(); fs.rmSync(mine, { force: true }); fs.rmSync(theirs, { force: true }) }
})

test("a shared recipe is checked before it's kept: only apps, actions, plain values and earlier steps", () => {
  const ok = { obstatRecipe: 1, name: "Two steps", files: [{ label: "photo" }], steps: [
    { app: "a/one", appName: "One", action: "/go", inputs: [{ label: "in", file: { input: 0 } }, { label: "t", value: "hi", edit: true }] },
    { app: "b/two", appName: "Two", action: "/next", inputs: [{ label: "in", file: { step: 0, output: 1 } }] },
  ] }
  assert.equal(recipesLib.check(ok).steps.length, 2)
  const bad = (change, why) => { const r = JSON.parse(JSON.stringify(ok)); change(r); assert.throws(() => recipesLib.check(r), why) }
  bad((r) => { r.obstatRecipe = 2 }, /newer Obstat/)
  bad((r) => { r.steps[0].app = "../../etc" }, /doesn't name an app/)
  bad((r) => { r.steps[0].action = "/x; rm -rf" }, /doesn't name an action/)
  bad((r) => { r.steps[0].inputs[0].file = { input: 1 } }, /isn't one you give/)
  bad((r) => { r.steps[1].inputs[0].file = { step: 1, output: 0 } }, /isn't one you give/)
  bad((r) => { r.steps[0].inputs[0].file = { path: "C:/Users/me/secret.txt" } }, /isn't one you give/)
  bad((r) => { r.steps[0].inputs[1].value = { nested: "object" } }, /isn't a plain value/)
  bad((r) => { r.steps = [] }, /1 to 20 steps/)
  // unknown fields are dropped
  assert.equal("run" in recipesLib.check({ ...ok, run: "evil()" }), false)

  // export, then import on another computer
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-recipes-"))); h.ensure()
  try {
    const store = recipesLib.create(h)
    const kept = store.save(ok)
    const file = path.join(h.root, "shared.json")
    fs.writeFileSync(file, store.exportText(kept.id))
    const imported = store.importFile(file)
    assert.equal(imported.id, "two-steps-2", "a recipe never overwrites another")
    assert.deepEqual(store.get(imported.id).steps, kept.steps)
    fs.writeFileSync(file, "not json")
    assert.throws(() => store.importFile(file), /isn't a recipe/)
    assert.throws(() => store.get("../../x"), /isn't a recipe/)
  } finally { fs.rmSync(h.root, { recursive: true, force: true }) }
})

// ---------- privacy receipts (lib/receipt.js) on runs ----------
const receiptLib = require("../lib/receipt")

test("every run and every recipe run leaves a receipt: apps, steps, files and what went where", async () => {
  const s = await setup()
  try {
    // the stand-in apps "connect" somewhere: Kokoro's process reaches 8.8.8.8
    const look = async () => ({ conns: [{ pid: 5, address: "8.8.8.8", port: 443 }], who: { 5: "/apps/kokoro/env/bin/python\n" } })
    const receipts = { ...receiptLib, watch: (apps) => receiptLib.watch(apps, { look, every: 5 }) }
    const claude = scriptedClaude([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "kokoro_tts__generate_speech", input: { text: "Hi" } }] }),
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }),
    ])
    const deps = { home: s.h, keys: s.keys, receipts, emit: (e) => s.events.push(e), apps: { list: () => s.list.map((a) => ({ ...a, commit: "abc1234def" })), dirOf: (id) => (id === "a/kokoro" ? "/apps/kokoro" : "/apps/fx"), ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url } }
    const pilot = autopilotLib.create({ ...deps, plannerClaude: { MODEL: "m", plan: (o) => require("../lib/planner-claude").plan({ ...o, client: claude }) } })
    const r = await pilot.start({ goal: "Say hi" })
    const onDisk = JSON.parse(fs.readFileSync(path.join(r.dir, "receipt.json"), "utf8"))
    assert.deepEqual(onDisk, r.receipt)
    assert.equal(onDisk.kind, "autopilot")
    assert.equal(onDisk.goal, "Say hi")
    assert.equal(onDisk.planner.kind, "claude")
    assert.deepEqual(onDisk.apps, [{ id: "a/kokoro", name: "Kokoro TTS", commit: "abc1234def", reviewed: false }])
    assert.deepEqual(onDisk.steps, [{ app: "a/kokoro", action: "/generate_speech", ok: true }])
    assert.equal(onDisk.files.out.length, 1)
    assert.equal(onDisk.files.out[0].sha256.length, 64)
    assert.deepEqual(onDisk.network.connections.map((c) => [c.appName, c.address]), [["Kokoro TTS", "8.8.8.8"]])
    assert.match(onDisk.summary, /connected to 1 address/)
    assert.ok(s.events.some((e) => e.type === "receipt"), "the receipt is shown")
    assert.ok(!r.files.some((f) => f.endsWith("receipt.json")), "the receipt isn't one of the things the run made")

    // the recipe from it: a receipt too, with no planner
    const recipe = recipesLib.create(s.h).save(pilot.recipeFromLast("Hi"))
    const again = await pilot.replay(recipe)
    assert.equal(again.receipt.kind, "recipe")
    assert.equal(again.receipt.planner.sentTo, "nowhere")

    // a run that fails still leaves one, saying what failed
    s.tts.close()
    const failing = autopilotLib.create({ ...deps, plannerClaude: noPlanner })
    await assert.rejects(failing.replay(recipe))
    const dirs = fs.readdirSync(s.h.dir("autopilot")).sort()
    const last = JSON.parse(fs.readFileSync(path.join(s.h.dir("autopilot"), dirs.at(-1), "receipt.json"), "utf8"))
    assert.equal(last.ok, false)
    assert.equal(last.steps[0].ok, false)
  } finally { s.close() }
})

// ---------- installing apps a plan needs (reviewed ones, after a yes) ----------
function withInstall(s, { answer = true } = {}) {
  // Echo FX isn't installed yet; it's on the reviewed list
  s.list[1].installed = false
  const asked = [], installs = []
  const deps = {
    catalog: async () => [{ id: "b/fx", name: "Echo FX", description: "Adds echo to audio" }, { id: "a/kokoro", name: "Kokoro TTS" }],
    confirm: async (q) => { asked.push(q); return answer },
  }
  const apps = {
    list: () => s.list,
    ensureRunning: async (id) => s.list.find((a) => a.id === id).running.url,
    install: async (id) => { installs.push(id); s.list.find((a) => a.id === id).installed = true },
  }
  return { deps, apps, asked, installs }
}

test("a plan can install a reviewed app it needs, once the person says yes, and then use it", async () => {
  const s = await setup()
  try {
    const w = withInstall(s)
    const claude = scriptedClaude([
      (req) => {
        const install = req.tools.find((t) => t.name === "install_app")
        assert.deepEqual(install.input_schema.properties.app.enum, ["b/fx"], "only reviewed apps that aren't installed")
        assert.ok(!req.tools.some((t) => t.name.startsWith("echo_fx")))
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "kokoro_tts__generate_speech", input: { text: "Hi" } }, { type: "tool_use", id: "t2", name: "install_app", input: { app: "b/fx", why: "To add the echo." } }] }
      },
      (req) => {
        assert.match(req.messages.at(-1).content[1].content, /Installed Echo FX\. New tools: echo_fx__add_echo/)
        assert.ok(req.tools.some((t) => t.name === "echo_fx__add_echo"), "its actions are offered from the next turn")
        const speech = JSON.parse(req.messages.at(-1).content[0].content)[0].Audio.file
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t3", name: "echo_fx__add_echo", input: { audio: speech } }] }
      },
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }),
    ])
    const pilot = autopilotLib.create({ home: s.h, keys: s.keys, apps: w.apps, ...w.deps, emit: (e) => s.events.push(e), plannerClaude: { MODEL: "m", plan: (o) => require("../lib/planner-claude").plan({ ...o, client: claude }) } })
    const r = await pilot.start({ goal: "Say hi with an echo" })
    assert.deepEqual(w.asked.map((q) => [q.apps.map((a) => a.id), q.why]), [[["b/fx"], "To add the echo."]])
    assert.deepEqual(w.installs, ["b/fx"])
    assert.equal(s.fx.uploads.length, 1)
    assert.deepEqual(r.receipt.steps.map((x) => [x.app, x.action, x.ok]), [["a/kokoro", "/generate_speech", true], ["b/fx", "install", true], ["b/fx", "/add_echo", true]])
  } finally { s.close() }
})

test("when the person says no, nothing is installed and the plan is told", async () => {
  const s = await setup()
  try {
    const w = withInstall(s, { answer: false })
    const claude = scriptedClaude([
      () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "install_app", input: { app: "b/fx", why: "echo" } }] }),
      (req) => ({ stop_reason: "end_turn", content: [{ type: "text", text: req.messages.at(-1).content[0].content }] }),
    ])
    const pilot = autopilotLib.create({ home: s.h, keys: s.keys, apps: w.apps, ...w.deps, plannerClaude: { MODEL: "m", plan: (o) => require("../lib/planner-claude").plan({ ...o, client: claude }) } })
    const r = await pilot.start({ goal: "echo" })
    assert.match(r.text, /The user said no/)
    assert.deepEqual(w.installs, [])
  } finally { s.close() }
})

test("a recipe that needs a reviewed app asks to install it; one that isn't reviewed says to install it first", async () => {
  const s = await setup()
  const mine = path.join(os.tmpdir(), `obstat-recipe-install-${process.pid}.wav`)
  fs.writeFileSync(mine, "RIFF mine")
  try {
    const recipe = recipesLib.check({ obstatRecipe: 1, name: "Echo it", files: [{ label: "audio" }], steps: [{ app: "b/fx", appName: "Echo FX", action: "/add_echo", inputs: [{ label: "Input audio", file: { input: 0 } }] }] })
    const no = withInstall(s, { answer: false })
    await assert.rejects(autopilotLib.create({ home: s.h, keys: s.keys, apps: no.apps, ...no.deps }).replay(recipe, { files: [mine] }), /weren't installed/)
    assert.deepEqual(no.installs, [])

    const yes = withInstall(s)
    const r = await autopilotLib.create({ home: s.h, keys: s.keys, apps: yes.apps, ...yes.deps }).replay(recipe, { files: [mine] })
    assert.match(yes.asked[0].why, /Echo it/)
    assert.deepEqual(yes.installs, ["b/fx"])
    assert.equal(r.files.length, 1)

    const unlisted = withInstall(s)
    s.list[1].installed = false
    unlisted.deps.catalog = async () => []
    await assert.rejects(autopilotLib.create({ home: s.h, keys: s.keys, apps: unlisted.apps, ...unlisted.deps }).replay(recipe, { files: [mine] }), /Echo FX, which isn't installed\. Install it from Discover first/)
    assert.deepEqual(unlisted.asked, [])
  } finally { s.close(); fs.rmSync(mine, { force: true }) }
})
