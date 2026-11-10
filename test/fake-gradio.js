// A stand-in Gradio 5 app for tests: `info` endpoints, and `handlers[name](data) -> outputs`
// (an output { makeFile, bytes } becomes a file the app serves).
const http = require("node:http")
const path = require("node:path")

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
}
const FX = {
  "/add_echo": {
    parameters: [{ label: "Input audio", parameter_name: "audio", parameter_has_default: false, python_type: { type: "filepath" }, component: "Audio" }],
    returns: [{ label: "Output", python_type: { type: "filepath" }, component: "Audio" }],
  },
}

module.exports = { fakeApp, TTS, FX }
