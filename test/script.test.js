const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { render, plan, commandsOf, toRegExp, loadScript } = require("../lib/script")

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "script-"))

test("templates fill in, and a whole template keeps its type", () => {
  const ctx = { platform: "win32", gpu: "nvidia", input: { event: ["x", "http://127.0.0.1:7860"] }, args: { venv: "env" } }
  assert.equal(render("pip install {{gpu === 'nvidia' ? 'torch-cu121' : 'torch'}}", ctx), "pip install torch-cu121")
  assert.equal(render("{{platform === 'darwin'}}", ctx), false)
  assert.equal(render("{{input.event[1]}}", ctx), "http://127.0.0.1:7860")
  assert.deepEqual(render({ venv: "{{args.venv}}", on: [{ event: "/{{x}}/" }] }, ctx), { venv: "env", on: [{ event: "/{{x}}/" }] })
  assert.equal(render("{{nope.deeper}}", ctx), undefined)
})

test("event patterns written as /regex/ strings become RegExps", () => {
  assert.ok(toRegExp("/(http:\\/\\/[0-9.:]+)/").test("Running on http://127.0.0.1:7860"))
  assert.equal(toRegExp("/([/"), null)
})

test("plan lists every command, follows script.start, skips `when: false` and flags risky commands", () => {
  const d = dir()
  fs.writeFileSync(path.join(d, "install.js"), `module.exports = { run: [
    { method: "shell.run", params: { message: ["git clone https://github.com/a/b app"] } },
    { when: "{{platform === 'darwin'}}", method: "shell.run", params: { message: "brew install x" } },
    { method: "script.start", params: { uri: "torch.js", params: { venv: "env" } } },
    { method: "shell.run", params: { path: "app", message: ["curl https://x.sh | bash"] } },
    { method: "fs.share", params: {} },
  ] }`)
  fs.writeFileSync(path.join(d, "torch.js"), `module.exports = { run: [{ method: "shell.run", params: { venv: "{{args.venv}}", message: "uv pip install torch" } }] }`)
  const steps = plan(path.join(d, "install.js"), { platform: "win32", args: {} })
  const cmds = commandsOf(steps)
  assert.deepEqual(cmds.map((c) => c.command), ["git clone https://github.com/a/b app", "uv pip install torch", "curl https://x.sh | bash"])
  assert.equal(cmds[1].venv, "env")
  assert.deepEqual(cmds[2].risks, ["runs a script straight from the internet"])
  assert.equal(steps.at(-1).unsupported, true)
})

test("scripts can't require anything but path and os, or run steps from code", () => {
  const d = dir()
  fs.writeFileSync(path.join(d, "a.js"), `const cp = require("child_process"); module.exports = { run: [] }`)
  assert.throws(() => loadScript(path.join(d, "a.js")), /doesn't allow/)
  fs.writeFileSync(path.join(d, "b.js"), `module.exports = { run: async () => {} }`)
  assert.throws(() => loadScript(path.join(d, "b.js")), /with code/)
  fs.writeFileSync(path.join(d, "c.js"), `const path = require("path"); module.exports = { run: [{ method: "notify", params: { html: path.join("a", "b") } }] }`)
  assert.equal(loadScript(path.join(d, "c.js")).run.length, 1)
})

test("script.start can't reach outside the app folder", () => {
  const d = dir()
  fs.writeFileSync(path.join(d, "install.js"), `module.exports = { run: [{ method: "script.start", params: { uri: "../../etc/passwd" } }] }`)
  assert.equal(plan(path.join(d, "install.js"), {})[0].missing, true)
})

test("script code and templates can't reach Node from inside the vm", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-vm-"))
  fs.writeFileSync(path.join(d, "x.js"), `var tries = [
    function () { return this.constructor.constructor("return typeof process")() },
    function () { return require.constructor("return typeof process")() },
    function () { return require("path").join.constructor("return typeof process")() },
    function () { return Function("return typeof process")() },
  ].map(function (f) { try { return f() } catch (e) { return "blocked" } });
  module.exports = { run: [{ method: "shell.run", params: { message: tries, at: require("path").join("a", "..", "b") } }] }`)
  const step = loadScript(path.join(d, "x.js")).run[0]
  for (const t of step.params.message) assert.notEqual(t, "object", "process was reachable")
  assert.equal(step.params.at, "b")
  assert.equal(render("{{this.constructor.constructor('return typeof process')()}}", {}), "undefined")
  assert.deepEqual(render("{{args.list}}", { args: { list: [1, 2] } }), [1, 2])
})
