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
function run(dir, script, ctx = {}, env = {}, approved = null) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const out = { log: "", local: {}, end: null }
    const timer = setTimeout(() => { child.kill(); resolve({ ...out, end: "timeout" }) }, 20000)
    child.on("message", (m) => {
      if (m.type === "log") out.log += m.text
      else if (m.type === "local") out.local[m.key] = m.value
      else if (m.type === "done" || m.type === "error") { out.end = m.type; out.error = m.message }
    })
    child.on("exit", () => { clearTimeout(timer); resolve(out) })
    child.send({ type: "run", job: { appDir: dir, script, env, paths: [], python: "python3", ctx: { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42020, env: {}, ...ctx }, approved } })
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

test("hf.download runs the app venv's hf with huggingface.co as the only endpoint", { skip: !posix }, async () => {
  const a = app({ "install.js": steps([{ method: "hf.download", params: { path: "app", _: ["org/model", "w.bin"], "local-dir": "models/m" } }]) })
  // a stand-in hf that prints what it was asked
  fs.mkdirSync(path.join(a.dir, "app", "env", "bin"), { recursive: true })
  const hf = path.join(a.dir, "app", "env", "bin", "hf")
  fs.writeFileSync(hf, `#!/bin/sh\necho "hf args: $*"\necho "endpoint: $HF_ENDPOINT"\n`)
  fs.chmodSync(hf, 0o755)
  // even when something set another endpoint
  const r = await run(a.dir, "install.js", {}, { HF_ENDPOINT: "https://evil.example" })
  assert.equal(r.end, "done", r.error)
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
