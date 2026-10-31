// npm installs that skip the dependencies' install scripts where installs aren't walled
// (lib/npmsafe.js): which commands change, and a real npm install through the worker.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { fork, execFileSync } = require("node:child_process")
const npmsafe = require("../lib/npmsafe")

test("npm installs get --ignore-scripts and the after-install step; other commands don't change", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "npmsafe-"))
  const r = npmsafe.apply(["npm ci --omit=dev", "npm install --workspace web && npm run build -w web", "npm run build", "node server.js"], { cwd })
  assert.equal(r.changed, true)
  assert.deepEqual(r.lines, [
    `npm ci --omit=dev --ignore-scripts && node ${npmsafe.HELPER}`,
    `npm install --workspace web --ignore-scripts && node ${npmsafe.HELPER} && npm run build -w web`,
    "npm run build",
    "node server.js",
  ])
  assert.ok(fs.existsSync(path.join(cwd, npmsafe.HELPER)))
  const none = npmsafe.apply(["uv pip install -r requirements.txt", "npm run dev"], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "npmsafe-")) })
  assert.equal(none.changed, false)
  assert.ok(npmsafe.ALLOW.includes("esbuild") && npmsafe.ALLOW.includes("sharp"))
})

const hasNpm = (() => { try { execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["-v"], { shell: process.platform === "win32" }); return true } catch { return false } })()
const WORKER = path.join(__dirname, "..", "lib", "worker.js")
function runWorker(dir, script, job) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const out = { log: "", end: null }
    const timer = setTimeout(() => { child.kill(); resolve({ ...out, end: "timeout" }) }, 90000)
    child.on("message", (m) => { if (m.type === "log") out.log += m.text; else if (m.type === "done" || m.type === "error") { out.end = m.type; out.error = m.message } })
    child.on("exit", () => { clearTimeout(timer); resolve(out) })
    child.send({ type: "run", job: { appDir: dir, script, env: {}, paths: [path.dirname(process.execPath)], python: "python3", ctx: { platform: process.platform, gpu: "none", args: {}, input: {}, port: 42022, env: {} }, approved: null, ...job } })
  })
}

test("a real npm install: a dependency's postinstall is skipped, an allowed one runs, and the app's own runs", { skip: !hasNpm && "needs npm", timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmsafe-app-"))
  const dep = (name, script) => {
    const d = path.join(dir, "deps", name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, version: "1.0.0", scripts: { postinstall: script } }))
  }
  // a dependency's postinstall that writes outside its own folder
  dep("evil", `node -e "require('fs').writeFileSync('${path.join(dir, "pwned.txt").replace(/\\/g, "/")}', 'x')"`)
  // one on the allowlist (named like the real esbuild), which needs its script
  dep("esbuild", "node -e \"require('fs').writeFileSync('built.txt', 'ok')\"")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", private: true,
    dependencies: { evil: "file:./deps/evil", esbuild: "file:./deps/esbuild" },
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('own.txt', 'ok')\"" } }))
  fs.writeFileSync(path.join(dir, "install.js"), 'module.exports = { run: [{ method: "shell.run", params: { message: ["npm install --no-audit --no-fund --install-links"] } }] }\n')

  const r = await runWorker(dir, "install.js", { npmSafe: true })
  assert.equal(r.end, "done", r.log + r.error)
  assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false, "a dependency's postinstall ran")
  assert.equal(fs.readFileSync(path.join(dir, "node_modules", "esbuild", "built.txt"), "utf8"), "ok", "an allowed dependency's script didn't run")
  assert.equal(fs.readFileSync(path.join(dir, "own.txt"), "utf8"), "ok", "the app's own postinstall didn't run")
  assert.match(r.log, /skipped the install scripts of 1 dependency: evil/)
  assert.equal(fs.existsSync(path.join(dir, npmsafe.HELPER)), false, "the helper is cleaned up")

  // and without npmSafe (a walled install) npm behaves as usual
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true }); fs.rmSync(path.join(dir, "own.txt"), { force: true })
  const plain = await runWorker(dir, "install.js", {})
  assert.equal(plain.end, "done", plain.log + plain.error)
  assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), true)
})
