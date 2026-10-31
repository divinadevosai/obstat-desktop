// Windows install walls (lib/appbox.js, lib/appbox.cs). The last test builds the helper
// and runs Obstat's worker inside a real AppContainer, on Windows only.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { fork, execFileSync } = require("node:child_process")
const appbox = require("../lib/appbox")

test("each app's container is its own, and named the way Windows allows", () => {
  const a = appbox.containerName("someone/app"), b = appbox.containerName("someone/other")
  assert.notEqual(a, b)
  assert.equal(a, appbox.containerName("someone/app"))
  assert.ok(a.length <= 64 && /^[a-z0-9.]+$/.test(a))
})

test("the helper starts Node with paths kept as given, after the folders it may use", () => {
  const w = appbox.wrap({ file: "box.exe" }, { name: "n", own: ["A"], shared: ["C"], readable: ["R"], cwd: "H" }, "node.exe", ["worker.js"])
  assert.equal(w.file, "box.exe")
  assert.deepEqual(w.args, ["run", "--name", "n", "--rw", "A", "--shared-rw", "C", "--shared-ro", "R", "--cwd", "H", "--", "node.exe", "--preserve-symlinks", "--preserve-symlinks-main", "worker.js"])
})

test("the package.json files above a script are found", () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "appbox-pkg-"))
  fs.mkdirSync(path.join(top, "a", "b"), { recursive: true })
  fs.writeFileSync(path.join(top, "package.json"), "{}")
  fs.writeFileSync(path.join(top, "a", "package.json"), "{}")
  const found = appbox.packageFiles([path.join(top, "a", "b", "w.js")])
  assert.ok(found.includes(path.join(top, "package.json")) && found.includes(path.join(top, "a", "package.json")))
})

const WORKER = path.join(__dirname, "..", "lib", "worker.js")
test("inside a real AppContainer the worker installs into its own folder, talks over IPC, and can't read your files", { skip: process.platform !== "win32" && "Windows only", timeout: 180000 }, async () => {
  const top = fs.mkdtempSync(path.join(os.homedir(), ".obstat-appbox-"))
  const cache = path.join(top, "cache"), app = path.join(top, "apps", "demo"), ihome = path.join(top, "install-home")
  for (const d of [cache, app, ihome]) fs.mkdirSync(d, { recursive: true })
  const secret = path.join(os.homedir(), `.obstat-appbox-secret-${path.basename(top)}.txt`)
  fs.writeFileSync(secret, "private")
  const other = path.join(top, "apps", "other")
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, "data.txt"), "other app")
  try {
    const found = await appbox.detect({ cacheDir: cache, readable: [path.dirname(process.execPath), path.join(__dirname, "..", "lib")] })
    assert.equal(found.kind, "appcontainer", found.reason)
    const node = process.execPath
    const steal = (f, out) => `(type "${f}" > ${out}.tmp 2>&1 && echo yes || echo no) > ${out}`
    fs.writeFileSync(path.join(app, "install.js"), `module.exports = { run: [{ method: "shell.run", params: { message: [
      ${JSON.stringify(steal(secret, "secret.result"))},
      ${JSON.stringify(steal(path.join(other, "data.txt"), "other.result"))},
      ${JSON.stringify(`(echo x > "${path.join(top, "escaped.txt")}" 2> escape.err && echo yes || echo no) > escape.result`)},
      "(echo probe > nul && echo yes || echo no) > nul.result",
      "echo inside > done.txt",
    ] } }] }`)
    const w = appbox.wrap(found, { name: appbox.containerName(`test/${path.basename(top)}`), own: [app, ihome], readable: [path.dirname(node), path.join(__dirname, "..", "lib")], cwd: ihome }, node, [WORKER])
    const { spawn } = require("node:child_process")
    const env = { ...require("../lib/confine").sandboxEnv(process.env), ELECTRON_RUN_AS_NODE: "1", HOME: ihome, USERPROFILE: ihome, TEMP: ihome, TMP: ihome, APPDATA: ihome, LOCALAPPDATA: ihome }
    const child = spawn(w.file, w.args, { env, cwd: ihome, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true })
    child.stdin.end(); child.stdout.resume()
    let err = ""
    child.stderr.on("data", (d) => { err += d })
    const out = await new Promise((resolve) => {
      const r = { log: "", end: null }
      const timer = setTimeout(() => { child.kill(); resolve({ ...r, end: "timeout" }) }, 120000)
      child.on("message", (m) => { if (m.type === "log") r.log += m.text; else if (m.type === "done" || m.type === "error") { r.end = m.type; r.error = m.message; child.disconnect?.() } })
      child.on("exit", () => { clearTimeout(timer); resolve(r) })
      child.send({ type: "run", job: { appDir: app, script: "install.js", paths: [], python: "python", ctx: { platform: "win32", gpu: "none", args: {}, input: {}, port: 42021, env: {} }, approved: null, env: {} } })
    })
    assert.equal(out.end, "done", `${out.log}\n${out.error}\n${err}`)
    const said = (f) => fs.readFileSync(path.join(app, f), "utf8").trim()
    assert.equal(said("done.txt"), "inside")
    // scripts write to nul all the time ("> nul 2>&1"): it has to work inside
    assert.equal(said("nul.result"), "yes", "couldn't write to nul")
    assert.equal(said("secret.result"), "no", "read a file in your home folder")
    assert.equal(said("other.result"), "no", "read another app's folder")
    assert.equal(said("escape.result"), "no", "wrote outside its folders")
    assert.equal(fs.existsSync(path.join(top, "escaped.txt")), false)
  } finally {
    fs.rmSync(secret, { force: true })
    fs.rmSync(top, { recursive: true, force: true })
  }
})
