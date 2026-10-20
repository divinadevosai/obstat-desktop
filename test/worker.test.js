// The worker's new steps, run for real in a forked worker: fs.copy stays inside
// the app folder, jump goes to a step and can't loop forever, proxy steps are
// skipped, and hf.download runs a plain `hf download` from huggingface.co.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { fork } = require("node:child_process")
const { wrapJsonScripts, gpuModel } = require("../lib/apps")

const WORKER = path.join(__dirname, "..", "lib", "worker.js")
const posix = process.platform !== "win32"

function app(files) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-worker-"))
  const dir = path.join(top, "app")
  fs.mkdirSync(path.join(top, "secret"))
  fs.writeFileSync(path.join(top, "secret", "key.txt"), "secret")
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return { dir, top }
}

// runs one script and collects its log, local values and how it ended
function run(dir, script, ctx = {}, env = {}, approved = null, more = {}) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const out = { log: "", local: {}, end: null }
    const timer = setTimeout(() => { child.kill(); resolve({ ...out, end: "timeout" }) }, 20000)
    child.on("message", (m) => {
      if (m.type === "log") out.log += m.text
      else if (m.type === "open") (out.opened ||= []).push(m.url)
      else if (m.type === "local") out.local[m.key] = m.value
      else if (m.type === "done" || m.type === "error") { out.end = m.type; out.error = m.message }
    })
    child.on("exit", () => { clearTimeout(timer); resolve(out) })
    child.send({ type: "run", job: { appDir: dir, script, env, paths: [], python: "python3", ctx: { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42020, env: {}, ...ctx }, approved, ...more } })
  })
}
const steps = (run) => `module.exports = { run: ${JSON.stringify(run)} }`

test("fs.copy copies files and folders inside the app folder", async () => {
  const a = app({ "a.txt": "hello", "conf/x.yaml": "x: 1", "install.js": steps([
    { method: "fs.copy", params: { src: "a.txt", dest: "app/a.txt" } },
    { method: "fs.copy", params: { src: "conf", dest: "app/options/conf" } },
  ]) })
  const r = await run(a.dir, "install.js")
  assert.equal(r.end, "done", r.error)
  assert.equal(fs.readFileSync(path.join(a.dir, "app", "a.txt"), "utf8"), "hello")
  assert.equal(fs.readFileSync(path.join(a.dir, "app", "options", "conf", "x.yaml"), "utf8"), "x: 1")
})

test("fs.copy can't read or write outside the app folder", { skip: !posix }, async () => {
  const a = app({ "a.txt": "hello" })
  fs.symlinkSync(path.join(a.top, "secret", "key.txt"), path.join(a.dir, "link.txt"))
  fs.symlinkSync(path.join(a.top, "secret"), path.join(a.dir, "outdir"))
  const secretFile = path.join(a.top, "secret", "key.txt")
  const bad = [
    { src: "../secret/key.txt", dest: "stolen.txt" },
    { src: secretFile, dest: "stolen.txt" },
    { src: "link.txt", dest: "stolen.txt" },
    { src: "outdir/key.txt", dest: "stolen.txt" },
    { src: "a.txt", dest: "../secret/planted.txt" },
    { src: "a.txt", dest: path.join(a.top, "secret", "planted.txt") },
    { src: "a.txt", dest: "outdir/planted.txt" },
    { src: "a.txt", dest: "link.txt" },
    { src: "a.txt", dest: "." },
  ]
  for (const params of bad) {
    fs.writeFileSync(path.join(a.dir, "x.js"), steps([{ method: "fs.copy", params }]))
    const r = await run(a.dir, "x.js")
    assert.equal(r.end, "error", JSON.stringify(params))
    assert.match(r.error, /outside the app folder/)
  }
  assert.ok(!fs.existsSync(path.join(a.dir, "stolen.txt")))
  assert.deepEqual(fs.readdirSync(path.join(a.top, "secret")), ["key.txt"])
  assert.equal(fs.readFileSync(secretFile, "utf8"), "secret")
})

test("jump goes to a step by id or index, passes params along, and can't loop forever", async () => {
  const a = app({
    "a.js": steps([
      { method: "jump", params: { id: "set", params: { url: "http://127.0.0.1:1" } } },
      { method: "local.set", params: { skipped: "yes" } },
      { id: "set", method: "local.set", params: { url: "{{input.url}}" } },
    ]),
    "b.js": steps([{ id: "top", method: "jump", params: { index: 0 } }]),
    "c.js": steps([{ method: "jump", params: { id: "nowhere" } }]),
  })
  const r = await run(a.dir, "a.js")
  assert.equal(r.end, "done", r.error)
  assert.deepEqual(r.local, { url: "http://127.0.0.1:1" })
  assert.match((await run(a.dir, "b.js")).error, /more than 100 times/)
  assert.match((await run(a.dir, "c.js")).error, /isn't there/)
})

test("proxy.start and proxy.stop are skipped with a note", async () => {
  const a = app({ "a.js": steps([{ method: "proxy.start", params: { uri: "http://127.0.0.1:1", name: "Local Sharing" } }, { method: "proxy.stop", params: {} }]) })
  const r = await run(a.dir, "a.js")
  assert.equal(r.end, "done", r.error)
  assert.match(r.log, /Skipped Pinokio's sharing step/)
})

test("hf.download runs Obstat's own hf, never the app's, with huggingface.co as the only endpoint", { skip: !posix }, async () => {
  const a = app({ "install.js": steps([{ method: "hf.download", params: { path: "app", _: ["org/model", "w.bin"], "local-dir": "models/m" } }]) })
  const stub = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/sh\n${text}\n`); fs.chmodSync(file, 0o755) }
  // the app's own env has an hf of its own, which must not run
  stub(path.join(a.dir, "app", "env", "bin", "hf"), `echo "APP HF"`)
  // stand-ins for Obstat's download tool: python (pip) and hf that print what they were asked
  const tool = path.join(a.top, "cache", "hf-env")
  stub(path.join(tool, "bin", "python"), `echo "pip: $*"`)
  stub(path.join(tool, "bin", "hf"), `echo "hf args: $*"\necho "endpoint: $HF_ENDPOINT"`)
  // even when something set another endpoint
  const r = await run(a.dir, "install.js", {}, { HF_ENDPOINT: "https://evil.example" }, null, { hfEnv: tool })
  assert.equal(r.end, "done", r.error)
  assert.doesNotMatch(r.log, /APP HF/)
  assert.match(r.log, /pip: -I -m pip install --quiet huggingface_hub>=0\.34/)
  assert.match(r.log, /hf args: download org\/model w\.bin --local-dir models\/m/)
  assert.match(r.log, /endpoint: https:\/\/huggingface\.co\n/)
})

test("hf.download refuses to save outside the app folder", async () => {
  const a = app({ "install.js": steps([{ method: "hf.download", params: { path: "app", _: ["org/model"], "local-dir": "../../../x" } }]) })
  const r = await run(a.dir, "install.js")
  assert.equal(r.end, "error")
  assert.match(r.error, /can't use|outside the app folder/)
})

test("a launcher written as a function of kernel runs in the worker", async () => {
  const a = app({ "config.js": `module.exports = { name: "from config" }`, "start.js": `const config = require("./config.js")
    module.exports = async (kernel) => ({ run: [{ method: "local.set", params: { port: String(await kernel.port()), name: config.name, model: kernel.gpu_model } }] })` })
  const r = await run(a.dir, "start.js", { gpu: "nvidia", gpu_model: "NVIDIA GeForce RTX 5080" })
  assert.equal(r.end, "done", r.error)
  assert.deepEqual(r.local, { port: "42020", name: "from config", model: "NVIDIA GeForce RTX 5080" })
})

test("old install.json/start.json get a one-line .js wrapper; the GPU name comes from nvidia-smi", () => {
  const a = app({ "install.json": "{}", "start.json": "{}", "start.js": "// mine" })
  wrapJsonScripts(a.dir)
  assert.equal(fs.readFileSync(path.join(a.dir, "install.js"), "utf8"), 'module.exports = require("./install.json")\n')
  assert.equal(fs.readFileSync(path.join(a.dir, "start.js"), "utf8"), "// mine")
  assert.equal(gpuModel("GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-1234)\nGPU 1: NVIDIA GeForce RTX 3060 (UUID: GPU-5)\n"), "NVIDIA GeForce RTX 5090")
  assert.equal(gpuModel(""), null)
})

// An approved script runs as its plan showed it, even if the app's files change
// between the plan and the run (an earlier step can write them).
const { approve } = require("../lib/script")
const CTX = { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42020, env: {} }
const viaIpc = (x) => JSON.parse(JSON.stringify(x))

test("an approved run uses the scripts the plan read, not files changed since", async () => {
  const a = app({
    "install.js": steps([{ method: "shell.run", params: { message: "echo first > out.txt" } }, { method: "script.start", params: { uri: "more.js" } }]),
    "more.js": `module.exports = (kernel) => ({ run: [{ method: "shell.run", params: { message: kernel.exists("flag") ? "echo EVIL >> out.txt" : "echo fine >> out.txt" } }] })`,
  })
  const { approved } = approve(path.join(a.dir, "install.js"), CTX)
  // after the plan: the flag appears and more.js is rewritten
  fs.writeFileSync(path.join(a.dir, "flag"), "")
  fs.writeFileSync(path.join(a.dir, "more.js"), steps([{ method: "shell.run", params: { message: "echo EVIL2 >> out.txt" } }]))
  const r = await run(a.dir, "install.js", {}, {}, viaIpc(approved))
  assert.equal(r.end, "done", r.error)
  assert.match(fs.readFileSync(path.join(a.dir, "out.txt"), "utf8"), /^first\s+fine\s*$/)
})

test("an approved run stops at a step that differs from the plan", async () => {
  const a = app({ "install.js": steps([
    { method: "shell.run", params: { message: "echo hi", on: [{ event: "/(hi)/", done: true }] } },
    { method: "shell.run", params: { message: "echo {{input.event ? 'changed' : 'same'}} > out.txt" } },
  ]) })
  const { approved, steps: shown } = approve(path.join(a.dir, "install.js"), CTX)
  assert.equal(shown[1].commands[0], "echo same > out.txt")
  const r = await run(a.dir, "install.js", {}, {}, viaIpc(approved))
  assert.equal(r.end, "error")
  assert.match(r.error, /changed from the steps you approved/)
  assert.equal(fs.existsSync(path.join(a.dir, "out.txt")), false)
})

test("an approved run won't run a step the plan skipped", async () => {
  const a = app({ "install.js": steps([
    { method: "shell.run", params: { message: "echo hi", on: [{ event: "/(hi)/", done: true }] } },
    { when: "{{input.event}}", method: "shell.run", params: { message: "echo hidden > out.txt" } },
  ]) })
  const { approved, steps: shown } = approve(path.join(a.dir, "install.js"), CTX)
  assert.equal(shown.length, 1)
  const r = await run(a.dir, "install.js", {}, {}, viaIpc(approved))
  assert.equal(r.end, "error")
  assert.equal(fs.existsSync(path.join(a.dir, "out.txt")), false)
})

test("an approved run won't start a script the plan didn't read", async () => {
  const a = app({ "install.js": steps([{ method: "script.start", params: { uri: "{{input.event ? 'b.js' : 'a.js'}}" } }]), "a.js": steps([]), "b.js": steps([]) })
  const { approved } = approve(path.join(a.dir, "install.js"), CTX)
  delete approved.scripts[path.join(a.dir, "a.js")]
  const r = await run(a.dir, "install.js", {}, {}, viaIpc(approved))
  assert.equal(r.end, "error")
  assert.match(r.error, /wasn't in the steps you approved/)
})

// A tiny server for start scripts: prints its line, then listens (or listens, then prints).
const SERVE = `const [port, raw, first] = process.argv.slice(2)
const line = raw.replace(/\\\\x1b/g, "\\x1b")
const s = require("http").createServer((q, r) => r.end("hi"))
if (first === "print") { console.log(line); setTimeout(() => s.listen(Number(port), "127.0.0.1"), 300) }
else s.listen(Number(port), "127.0.0.1", () => console.log(line))
`
const freePort = () => new Promise((resolve) => { const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
// runs a daemon start script until it's ready, then stops it
function start(dir, script = "start.js") {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const out = { log: "", local: {}, opened: [], end: null }
    const timer = setTimeout(() => { child.kill(); resolve({ ...out, end: "timeout" }) }, 20000)
    child.on("message", (m) => {
      if (m.type === "log") out.log += m.text
      else if (m.type === "open") out.opened.push(m.url)
      else if (m.type === "local") out.local[m.key] = m.value
      else if (m.type === "ready" || m.type === "done" || m.type === "error") { out.end = m.type; out.error = m.message; child.send({ type: "stop" }) }
    })
    child.on("exit", () => { clearTimeout(timer); resolve(out) })
    child.send({ type: "run", job: { appDir: dir, script, env: {}, paths: [], python: "python3", ctx: { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42020, env: {} }, approved: null } })
  })
}
const daemon = (message, event = "/http:\\/\\/\\S+/") => `module.exports = { daemon: true, run: [
  { method: "shell.run", params: { message: ${JSON.stringify(message)}, on: [{ event: ${JSON.stringify(event)}, done: true }] } },
  { method: "local.set", params: { url: "{{input.event[0]}}" } },
] }`

test("the app's address is the one it answers at: placeholders and example addresses are passed over, and \"open the browser\" opens it in Obstat", { skip: !posix }, async () => {
  const [port, other] = [await freePort(), await freePort()]
  const { dir } = app({ "serve.js": SERVE, "start.js": daemon([
    `echo 'Visit http://ip:port for Web UI, e.g., http://127.0.0.1:${other}'`,
    `python3 -c "import webbrowser; webbrowser.open('http://127.0.0.1:${port}/')"`,
    `node serve.js ${port} 'Running on local URL:  http://127.0.0.1:${port}.' print`,
  ]) })
  const out = await start(dir)
  assert.equal(out.end, "ready", out.log)
  assert.equal(out.local.url, `http://127.0.0.1:${port}`)
  assert.deepEqual(out.opened, [`http://127.0.0.1:${port}/`])
})

test("a coloured address (Vite on Windows) is found, and one on another computer isn't taken", { skip: !posix }, async () => {
  const port = await freePort()
  const { dir } = app({ "serve.js": SERVE, "start.js": daemon([
    "echo 'Docs: http://example.com:8080/guide'",
    `node serve.js ${port} '  \\x1b[32m➜\\x1b[39m  Local:   \\x1b[36mhttp://localhost:\\x1b[1m${port}\\x1b[22m/\\x1b[39m'`,
  ]) })
  const out = await start(dir)
  assert.equal(out.end, "ready", out.log)
  assert.equal(out.local.url, `http://localhost:${port}/`)
})

test("Obstat's own settings reach every command, and a step's own env wins", { skip: !posix }, async () => {
  const { dir } = app({ "install.js": steps([
    { method: "shell.run", params: { message: ["echo \"B=$BROWSER G=$GRADIO_SERVER_NAME S=$STREAMLIT_SERVER_HEADLESS\""] } },
    { method: "shell.run", params: { env: { GRADIO_SERVER_NAME: "0.0.0.0" }, message: ["echo \"G2=$GRADIO_SERVER_NAME\""] } },
  ]) })
  const r = await run(dir, "install.js")
  assert.equal(r.end, "done", r.error)
  assert.match(r.log, /B=echo \[obstat-open\] %s G=127\.0\.0\.1 S=true/)
  assert.match(r.log, /G2=0\.0\.0\.0/)
})

test("an npm install that fails on peer dependencies is tried once more the way older npm did", { skip: !posix }, async () => {
  const { dir, top } = app({ "install.js": `module.exports = { run: [{ method: "shell.run", params: { message: ["npm install"] } }] }` })
  const bin = path.join(top, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nif [ "$npm_config_legacy_peer_deps" = "true" ]; then echo installed; exit 0; fi\necho "npm error code ERESOLVE" >&2; exit 1\n`, { mode: 0o755 })
  const out = await run(dir, "install.js", {}, {}, null, { paths: [bin] })
  assert.equal(out.end, "done", out.log)
  assert.match(out.log, /legacy-peer-deps/)
  assert.match(out.log, /installed/)

  // anything else that fails is not tried again
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "npm error code E404" >&2; exit 1\n`, { mode: 0o755 })
  const failed = await run(dir, "install.js", {}, {}, null, { paths: [bin] })
  assert.equal(failed.end, "error")
  assert.doesNotMatch(failed.log, /legacy-peer-deps/)
})
