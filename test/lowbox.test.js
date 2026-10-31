// Windows install walls (lib/lowbox.js, lib/lowbox.cs). The real test builds the helper
// and runs Obstat's worker at low integrity, on Windows only.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")
const lowbox = require("../lib/lowbox")

test("the helper is given what to label and what to start", () => {
  const w = lowbox.wrap({ file: "box.exe" }, { low: ["A", "C"], hide: ["K"], cwd: "H" }, "node.exe", ["worker.js"])
  assert.equal(w.file, "box.exe")
  assert.deepEqual(w.args, ["run", "--low", "A", "--low", "C", "--hide", "K", "--cwd", "H", "--", "node.exe", "worker.js"])
})

const WORKER = path.join(__dirname, "..", "lib", "worker.js")
test("at low integrity the worker installs into its own folder and the caches, can't write anywhere else or read Obstat's keys", { skip: process.platform !== "win32" && "Windows only", timeout: 180000 }, async () => {
  const top = fs.mkdtempSync(path.join(os.homedir(), ".obstat-lowbox-"))
  const cache = path.join(top, "cache"), app = path.join(top, "apps", "demo"), ihome = path.join(top, "install-home"), shared = path.join(top, "shared-cache")
  for (const d of [cache, app, ihome, shared]) fs.mkdirSync(d, { recursive: true })
  const keys = path.join(top, "keys.json")
  fs.writeFileSync(keys, '{"OPENAI_API_KEY":"sk-secret"}')
  const other = path.join(top, "apps", "other")
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, "data.txt"), "other app")
  try {
    const found = await lowbox.detect({ cacheDir: cache })
    assert.equal(found.kind, "lowbox", found.reason)
    const res = (name) => `${name}.result`
    const tryWrite = (f, out) => `(echo x> "${f}" 2> ${out}.err && echo yes || echo no) > ${res(out)}`
    fs.writeFileSync(path.join(app, "install.js"), `module.exports = { run: [{ method: "shell.run", params: { message: [
      ${JSON.stringify(`(type "${keys}" > keys.tmp 2>&1 && findstr sk-secret keys.tmp > nul && echo yes || echo no) > ${res("keys")}`)},
      ${JSON.stringify(tryWrite(path.join(top, "escaped.txt"), "escape"))},
      ${JSON.stringify(tryWrite(path.join(other, "changed.txt"), "other"))},
      ${JSON.stringify(tryWrite(path.join(os.homedir(), `.obstat-lowbox-escaped-${path.basename(top)}`), "home"))},
      ${JSON.stringify(tryWrite(path.join(shared, "cached.txt"), "cache"))},
      "(echo probe > nul && echo yes || echo no) > nul.result",
      "echo inside> done.txt",
    ] } }] }`)
    const w = lowbox.wrap(found, { low: [app, ihome, shared], hide: [keys], cwd: ihome }, process.execPath, [WORKER])
    const env = { ...require("../lib/confine").sandboxEnv(process.env), ELECTRON_RUN_AS_NODE: "1", HOME: ihome, USERPROFILE: ihome, TEMP: ihome, TMP: ihome, APPDATA: ihome, LOCALAPPDATA: ihome }
    const child = spawn(w.file, w.args, { env, cwd: ihome, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true })
    let err = ""
    child.stderr.on("data", (d) => { err += d })
    const out = await new Promise((resolve) => {
      const r = { log: "", end: null }
      const timer = setTimeout(() => { child.kill(); resolve({ ...r, end: "timeout" }) }, 90000)
      const end = () => { clearTimeout(timer); child.kill(); resolve(r) }
      child.on("message", (m) => { if (m.type === "log") r.log += m.text; else if (m.type === "done" || m.type === "error") { r.end = m.type; r.error = m.message; end() } })
      child.on("exit", (code) => { r.exit = code; end() })
      child.send({ type: "run", job: { appDir: app, script: "install.js", paths: [], python: "python", ctx: { platform: "win32", gpu: "none", args: {}, input: {}, port: 42021, env: {} }, approved: null, env: {} } })
    })
    assert.equal(out.end, "done", `end: ${out.end}, exit: ${out.exit}\n${out.log}\n${out.error}\n${err}`)
    const said = (f) => fs.readFileSync(path.join(app, f), "utf8").trim()
    assert.equal(said("done.txt"), "inside")
    assert.equal(said("nul.result"), "yes", "couldn't write to nul")
    assert.equal(said("cache.result"), "yes", "couldn't use the shared cache")
    assert.equal(said("keys.result"), "no", "read Obstat's keys")
    assert.equal(said("escape.result"), "no", "wrote in Obstat's folder")
    assert.equal(said("other.result"), "no", "changed another app's folder")
    assert.equal(said("home.result"), "no", "wrote in the home folder")
    assert.equal(fs.existsSync(path.join(top, "escaped.txt")), false)
  } finally {
    fs.rmSync(path.join(os.homedir(), `.obstat-lowbox-escaped-${path.basename(top)}`), { force: true })
    fs.rmSync(top, { recursive: true, force: true })
  }
})
