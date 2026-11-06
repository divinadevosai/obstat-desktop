// Reading and calling a running app's own API (lib/appapi.js), against a stand-in
// Gradio app on this computer: Gradio 5 (/gradio_api/...) and Gradio 4 paths.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const appapi = require("../lib/appapi")

const INFO = {
  named_endpoints: {
    "/generate": {
      parameters: [
        { label: "Text", parameter_name: "text", parameter_has_default: false, type: { type: "string" }, python_type: { type: "str" }, component: "Textbox" },
        { label: "Voice", parameter_name: "voice", parameter_has_default: true, parameter_default: "af_heart", type: { type: "string" }, python_type: { type: "Literal['af_heart', 'bm_george']" }, component: "Dropdown" },
        { label: "Speed", parameter_name: "speed", parameter_has_default: true, parameter_default: 1, python_type: { type: "float" }, component: "Slider" },
      ],
      returns: [{ label: "Audio", python_type: { type: "filepath" }, component: "Audio" }],
    },
    "/bad name<script>": { parameters: [], returns: [] },
  },
  unnamed_endpoints: {},
}

function fakeGradio({ prefix = "/gradio_api", fail = false } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === `${prefix}/info`) return res.end(JSON.stringify(INFO))
    if (req.method === "POST" && req.url === `${prefix}/call/generate`) {
      let body = ""
      req.on("data", (d) => { body += d })
      req.on("end", () => { server.lastBody = JSON.parse(body); res.end(JSON.stringify({ event_id: "abc123" })) })
      return
    }
    if (req.method === "GET" && req.url === `${prefix}/call/generate/abc123`) {
      res.setHeader("content-type", "text/event-stream")
      if (fail) return res.end("event: error\ndata: null\n\n")
      return res.end(`event: generating\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([{ path: "/tmp/x.wav", url: `http://127.0.0.1:${server.address().port}${prefix}/file=/tmp/x.wav`, orig_name: "x.wav" }])}\n\n`)
    }
    res.statusCode = 404
    res.end("not found")
  }).listen(0, "127.0.0.1")
  return new Promise((r) => server.once("listening", () => r(server)))
}

test("a running Gradio 5 app's endpoints, inputs and outputs are read from the app itself", async () => {
  const s = await fakeGradio()
  try {
    const api = await appapi.discover(`http://127.0.0.1:${s.address().port}/`)
    assert.equal(api.kind, "gradio")
    assert.equal(api.prefix, "/gradio_api")
    assert.deepEqual(api.endpoints.map((e) => e.name), ["/generate"], "names that aren't paths are dropped")
    const [text, voice, speed] = api.endpoints[0].inputs
    assert.deepEqual([text.name, text.component, text.required], ["text", "Textbox", true])
    assert.deepEqual([voice.name, voice.default, voice.required], ["voice", "af_heart", false])
    assert.equal(speed.default, 1)
    assert.equal(api.endpoints[0].outputs[0].file, true, "an audio output is a file")
  } finally { s.close() }
})

test("an app's endpoint can be called, and its answer comes back", async () => {
  const s = await fakeGradio()
  try {
    // apps often give their address as 0.0.0.0
    const api = await appapi.discover(`http://0.0.0.0:${s.address().port}`)
    const out = await appapi.call(api, "/generate", ["Hello", "bm_george", 1.2])
    assert.deepEqual(s.lastBody, { data: ["Hello", "bm_george", 1.2] })
    assert.equal(out[0].file, true)
    assert.match(out[0].fileUrl, /file=\/tmp\/x\.wav$/)
    assert.equal(out[0].name, "x.wav")
  } finally { s.close() }
})

test("older Gradio (4) paths work too, and an app's error comes back as an error", async () => {
  const s = await fakeGradio({ prefix: "", fail: true })
  try {
    const api = await appapi.discover(`http://localhost:${s.address().port}`)
    assert.equal(api.kind, "gradio")
    assert.equal(api.prefix, "")
    await assert.rejects(appapi.call(api, "/generate", ["x"]), /The app said/)
    await assert.rejects(appapi.call(api, "/nope", []), /no \/nope endpoint/)
  } finally { s.close() }
})

test("only apps on this computer are asked, and a non-Gradio app is said so", async () => {
  assert.equal((await appapi.discover("https://example.com")).kind, null)
  assert.equal((await appapi.discover("http://192.168.1.5:7860")).kind, null)
  const plain = http.createServer((q, r) => r.end("<html>hi</html>")).listen(0, "127.0.0.1")
  await new Promise((r) => plain.once("listening", r))
  try {
    const api = await appapi.discover(`http://127.0.0.1:${plain.address().port}`)
    assert.equal(api.kind, null)
    assert.match(api.reason, /isn't a Gradio app/)
  } finally { plain.close() }
})
