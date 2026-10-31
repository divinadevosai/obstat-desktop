// Windows installs in Windows Sandbox (lib/vminstall.js). Windows Sandbox can't run on
// CI machines, so the bridge is tested with its runner started here instead ("local"),
// with Obstat's real worker: everything but opening the sandbox itself.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("../lib/vminstall")

test("the sandbox gets only the folders named, at the same paths, and nothing else of this computer", () => {
  const x = vm.wsb([{ host: "C:\\Users\\u\\obstat\\apps\\a-b", readOnly: false }, { host: "C:\\Users\\u\\obstat\\bin", readOnly: true }, { host: "C:\\run", box: "C:\\obstat-run" }], "C:\\obstat-run\\run.cmd")
  assert.match(x, /<HostFolder>C:\\Users\\u\\obstat\\apps\\a-b<\/HostFolder><SandboxFolder>C:\\Users\\u\\obstat\\apps\\a-b<\/SandboxFolder><ReadOnly>false/)
  assert.match(x, /obstat\\bin<\/SandboxFolder><ReadOnly>true/)
  assert.match(x, /<SandboxFolder>C:\\obstat-run<\/SandboxFolder>/)
  for (const off of ["ClipboardRedirection", "PrinterRedirection", "AudioInput", "VideoInput", "vGPU"]) assert.match(x, new RegExp(`<${off}>Disable`))
  assert.equal(vm.wsb([{ host: "C:\\a&b<c>" }], "x").includes("C:\\a&amp;b&lt;c&gt;"), true, "folder names can't change the configuration")
  assert.ok(vm.onSystemDrive("c:\\x") && !vm.onSystemDrive("D:\\x"))
})

test("an already open Windows Sandbox is found by its process", async () => {
  const fake = (out) => (_f, _a, _o, cb) => cb(null, out)
  assert.equal(await vm.sandboxOpen(fake('"explorer.exe","1","Console","1","1 K"\r\n"WindowsSandboxRemoteSession.exe","2","Console","1","1 K"\r\n')), true)
  assert.equal(await vm.sandboxOpen(fake('"explorer.exe","1","Console","1","1 K"\r\n')), false)
})

// the bridge as Obstat runs it: messages in, messages out
function runBridge(cfg, job, opts = {}) {
  return new Promise((resolve) => {
    const got = []
    let handler
    vm.bridge(cfg, {
      send: (m) => { got.push(m); if (m.type === "done" || m.type === "error") setTimeout(() => resolve(got), 50) },
      onJob: (fn) => { handler = fn },
      exit: () => {},
      ...opts,
    })
    handler({ type: "run", job })
  })
}

const job = (appDir, extra = {}) => ({ appDir, script: "install.js", paths: [], python: "python3", ctx: { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42021, env: {} }, approved: null, env: {}, ...extra })

test("an install runs with Obstat's worker and its log and result come back", { timeout: 60000 }, async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-vm-"))
  const app = path.join(top, "app")
  fs.mkdirSync(app)
  const step = process.platform === "win32" ? "echo built> built.txt" : "echo built > built.txt"
  fs.writeFileSync(path.join(app, "install.js"), `module.exports = { run: [{ method: "shell.run", params: { message: [${JSON.stringify(step)}, "echo hello from the install"] } }] }`)
  const got = await runBridge({ runDir: path.join(top, "run"), node: process.execPath, workerDir: path.join(__dirname, "..", "lib"), local: true, maps: [] }, job(app))
  const last = got[got.length - 1]
  assert.equal(last.type, "done", JSON.stringify(got))
  assert.match(got.filter((m) => m.type === "log").map((m) => m.text).join(""), /hello from the install/)
  assert.equal(fs.readFileSync(path.join(app, "built.txt"), "utf8").trim(), "built")
})

test("a failing install says why, and nothing but text and status comes out of the sandbox", { timeout: 60000 }, async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-vm-"))
  const app = path.join(top, "app")
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, "install.js"), `module.exports = { run: [{ method: "shell.run", params: { message: ["exit 3"] } }] }`)
  const got = await runBridge({ runDir: path.join(top, "run"), node: process.execPath, workerDir: path.join(__dirname, "..", "lib"), local: true, maps: [] }, job(app))
  const last = got[got.length - 1]
  assert.equal(last.type, "error")
  assert.match(last.message, /exit code 3/)
  assert.deepEqual([...new Set(got.map((m) => Object.keys(m).sort().join(",")))].sort(), ["message,type", "text,type"].filter((k) => got.some((m) => Object.keys(m).sort().join(",") === k)))
})

test("events the install writes can't make Obstat do anything but log", () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-vm-"))
  const run = path.join(top, "run")
  const got = []
  let handler
  const b = vm.bridge({ runDir: run, node: "x", workerDir: path.join(__dirname, "..", "lib"), sandboxExe: "none", maps: [] }, { send: (m) => got.push(m), onJob: (fn) => { handler = fn }, exit: () => {}, checkOpen: async () => true, close: () => {} })
  handler({ type: "run", job: job(top) })
  return new Promise((resolve) => setTimeout(() => {
    // another sandbox was open: the install is refused, not run unwalled
    assert.equal(got[got.length - 1].type, "error")
    assert.match(got[got.length - 1].message, /already open/)
    b.finish({ type: "error", message: "x" })
    resolve()
  }, 300))
})

test("the bridge ignores everything but text, done and error in the events", { timeout: 20000 }, async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-vm-"))
  const run = path.join(top, "run")
  const got = []
  let handler
  vm.bridge({ runDir: run, node: "x", workerDir: path.join(__dirname, "..", "lib"), sandboxExe: process.execPath, maps: [] }, { send: (m) => got.push(m), onJob: (fn) => { handler = fn }, exit: () => {}, checkOpen: async () => false, close: () => {} })
  handler({ type: "run", job: job(top) })
  await new Promise((r) => setTimeout(r, 300))
  // what code inside the sandbox could write
  fs.appendFileSync(path.join(run, "events.jsonl"), [
    JSON.stringify({ type: "open", url: "https://evil.example" }),
    JSON.stringify({ type: "pid", pid: 4 }),
    JSON.stringify({ type: "local", key: "url", value: "file:///C:/" }),
    JSON.stringify({ type: "log", text: "hi\n" }),
    JSON.stringify({ type: "done", extra: "ignored" }),
  ].join("\n") + "\n")
  await new Promise((r) => setTimeout(r, 1200))
  assert.ok(got.every((m) => ["log", "done", "error"].includes(m.type)), JSON.stringify(got))
  assert.deepEqual(got[got.length - 1], { type: "done" })
  assert.ok(got.some((m) => m.type === "log" && m.text === "hi\n"))
})
