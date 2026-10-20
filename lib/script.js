// Reads Pinokio scripts (install.js, start.js…) and fills in their {{…}} templates.
// Obstat runs a subset of Pinokio's format: shell.run, script.start, local.set,
// fs.download, fs.copy, hf.download, jump, input, notify and web.open (proxy.*
// and fs.link are skipped). Anything else stops with a clear message.
//
// Scripts are JavaScript, so they're evaluated in a vm context that gets only
// JSON from Obstat (see loadScript). vm isn't a hard security boundary, so the
// main process reads scripts through lib/inspect.js, a separate process with no
// keys; the protection that remains is that people see every command first,
// reviewed apps are pinned to a reviewed commit, and unreviewed ones are meant
// for the sandbox.
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const os = require("node:os")
const { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData } = require("node:worker_threads")
const { inside } = require("./env")

const SUPPORTED = new Set(["shell.run", "script.start", "local.set", "fs.download", "input", "notify", "web.open", "fs.link",
  "fs.copy", "hf.download", "jump", "proxy.start", "proxy.stop"])

// How far a launcher's own code may go while it builds its steps: time per
// run, how many times Obstat re-runs it to answer what it asked for, and how
// many files (and how big) it may read.
const LIMITS = { ms: 1000, templateMs: 200, rounds: 8, modules: 40, exists: 100, bytes: 1 << 20 }

// A small path module, written inside the context.
const PATH_CODE = `
var __sep = __info.sep;
function __norm(p) {
  var abs = /^([a-zA-Z]:)?[\\\\/]/.test(p), out = [];
  p.split(/[\\\\/]+/).forEach(function (s, i) {
    if (!s || s === ".") return;
    if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); return }
    out.push(s);
  });
  var head = /^[a-zA-Z]:/.test(p) ? p.slice(0, 2) + __sep : abs ? __sep : "";
  if (/^[a-zA-Z]:/.test(p) && out[0] === p.slice(0, 2)) out.shift();
  return head + out.join(__sep) || ".";
}
var __path = {
  sep: __sep,
  join: function () { return __norm([].slice.call(arguments).join("/")) },
  resolve: function () { var r = __dirname; [].slice.call(arguments).forEach(function (a) { a = String(a); r = /^([a-zA-Z]:)?[\\\\/]/.test(a) ? a : r + "/" + a }); return __norm(r) },
  basename: function (p, ext) { var b = String(p).split(/[\\\\/]/).filter(Boolean).pop() || ""; return ext && b.slice(-ext.length) === ext ? b.slice(0, -ext.length) : b },
  dirname: function (p) { var parts = String(p).split(/[\\\\/]/); parts.pop(); return parts.join(__sep) || "." },
  extname: function (p) { var m = String(p).match(/(\\.[^.\\\\/]*)$/); return m && !/^\\.[^.]*$/.test(this.basename(p)) ? m[1] : (/\\./.test(this.basename(p).slice(1)) ? m[1] : "") },
};
__path.posix = __path; __path.win32 = __path;
`

// Script code runs in a fresh vm context that is handed nothing from Obstat:
// no host objects or functions (those would lead back to Node), only JSON going
// in and out. Everything a launcher can call is written here, inside the context:
// `require("path")` and `require("os")` get small stand-ins, and `kernel` is a
// frozen object with the PC's platform, GPU and port.
//
// The code can't read files itself. When it asks for one (require("./config.js"),
// kernel.exists("app")), the question is written down in __asks; Obstat answers
// it outside, for files inside the app folder only, and runs everything again
// from the start with the answer in __answers. Re-running is safe because the
// code has no way to change anything outside its own context.
// The same launcher must give the same steps every time it's read, so the code
// gets no clock, no randomness and nothing that changes with memory use.
const STEADY_CODE = `
(function (g) {
  var D = g.Date, T = 1767225600000;
  function Date(a, b, c, d, e, f, h) {
    var n = arguments.length, x = n === 0 ? new D(T) : n === 1 ? new D(a) : new D(D.UTC(a, b, c === undefined ? 1 : c, d || 0, e || 0, f || 0, h || 0));
    return this instanceof Date ? x : x.toString();
  }
  Date.now = function () { return T };
  Date.UTC = D.UTC;
  Date.parse = D.parse;
  Date.prototype = D.prototype;
  D.prototype.constructor = Date;
  g.Date = Date;
  g.Math.random = function () { return 0.5 };
  delete g.Intl; delete g.WeakRef; delete g.FinalizationRegistry; delete g.SharedArrayBuffer; delete g.Atomics; delete g.WebAssembly;
})(this);
`

const PRELUDE = `${STEADY_CODE}
var __JSON = { stringify: JSON.stringify.bind(JSON), parse: JSON.parse.bind(JSON) }, __Function = Function, __String = String;
var __has = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);
var module = { exports: {} }, exports = module.exports;
var console = { log: function () {}, error: function () {}, warn: function () {}, info: function () {} };
${PATH_CODE}
var __os = { platform: function () { return __info.platform }, arch: function () { return __info.arch }, homedir: function () { return __info.homedir }, EOL: __info.platform === "win32" ? "\\r\\n" : "\\n" };
var __asks = { modules: [], exists: [] }, __cache = {}, __done = null, __err = null;
function __ask(kind, p) { if (__asks[kind].indexOf(p) < 0) __asks[kind].push(p) }
function __exists(p) {
  p = __path.resolve(__String(p));
  if (__has(__answers.exists, p)) return __answers.exists[p] === true;
  __ask("exists", p);
  return false;
}
function __message(e) { try { return __String(e && e.message ? e.message : e).slice(0, 500) } catch (x) { return "it threw an error" } }
function __require(dir) {
  return function require(name) {
    name = __String(name).replace(/^node:/, "");
    if (name === "path") return __path;
    if (name === "os") return __os;
    if (!/^\\.\\.?([\\\\/]|$)/.test(name)) throw new Error("needs \\"" + name + "\\", which Obstat doesn't allow in scripts");
    var p = __path.resolve(dir, name);
    if (!__has(__answers.modules, p)) { __ask("modules", p); throw new Error("(still reading " + name + ")") }
    var m = __answers.modules[p];
    if (!m) throw new Error("needs \\"" + name + "\\", which isn't a .js or .json file inside the app folder");
    if (__cache[m.file]) return __cache[m.file].exports;
    var mod = { exports: {} };
    __cache[m.file] = mod;
    if (m.json) mod.exports = __JSON.parse(m.text);
    else __Function("module", "exports", "require", "__dirname", "__filename", m.text)(mod, mod.exports, __require(__path.dirname(m.file)), __path.dirname(m.file), m.file);
    return mod.exports;
  };
}
var require = __require(__dirname);
function __freeze(o) {
  Object.freeze(o);
  Object.getOwnPropertyNames(o).forEach(function (n) { var d = Object.getOwnPropertyDescriptor(o, n), v = d && d.value; if (v && (typeof v === "object" || typeof v === "function") && !Object.isFrozen(v)) __freeze(v) });
  return o;
}
var __kernel = __freeze({
  platform: __info.platform, arch: __info.arch, gpu: __info.gpu, gpu_model: __info.gpu_model,
  gpus: __info.gpu !== "none" ? [{ vendor: __info.gpu, model: __info.gpu_model || "", name: __info.gpu_model || "" }] : [],
  port: function () { return Promise.resolve(__info.port) },
  // Pinokio's own folders don't exist here; kernel.path() names a folder inside the app instead
  path: function () {
    var p = __path.resolve.apply(null, [__root].concat([].slice.call(arguments).map(__String)));
    return p === __root || p.indexOf(__root + __sep) === 0 ? p : __root;
  },
  exists: function () { return __exists(__path.resolve.apply(null, [].slice.call(arguments).map(__String))) },
  script: { exists: function () { return __exists(__path.resolve.apply(null, [].slice.call(arguments).map(__String))) } },
});
var __infoArg = __freeze({ cwd: __dirname, exists: function (p) { return __exists(p) }, local: function () { return {} }, running: function () { return false } });
`

// After the launcher's code: call it if it's a function of kernel, and keep
// what it gives back. Async launchers finish inside the same run, because the
// context drains its own promise jobs before runInContext returns.
const FINISH = `
try {
  if (typeof module.exports === "function") {
    var __p = module.exports(__kernel, __infoArg);
    if (__p && typeof __p.then === "function") __p.then(function (v) { __done = { v: v } }, function (e) { __err = __message(e) });
    else __done = { v: __p };
  } else __done = { v: module.exports };
} catch (e) { __err = __message(e) }
`

// Reads the outcome as one JSON string, built inside the context under its timeout.
const RESULT = `(function () {
  var asks = { modules: __asks.modules.slice(0, 50).map(__String), exists: __asks.exists.slice(0, 50).map(__String) };
  if (__err !== null || !__done) return __JSON.stringify({ asks: asks, error: __err === null ? (__done ? null : "its code never finished") : __String(__err) });
  var s = __done.v;
  try {
    if (!s || typeof s !== "object") return __JSON.stringify({ asks: asks, kind: "none" });
    if (typeof s.run === "function") return __JSON.stringify({ asks: asks, kind: "code" });
    var out = __JSON.stringify({ asks: asks, kind: Array.isArray(s.run) ? "ok" : "steps", script: s }, function (k, v) { return v instanceof RegExp ? String(v) : v });
    return out.length > ${LIMITS.bytes} ? __JSON.stringify({ asks: asks, error: "its steps are too big" }) : out;
  } catch (e) { return __JSON.stringify({ asks: asks, error: __message(e) }) }
})()`

// The real file `p` names (relative to `root`), if it's inside the app folder
// once every symlink is followed. Anything else, absolute paths elsewhere and
// ../ included, comes back null.
function within(p, root) {
  try {
    const base = path.resolve(root)
    const abs = path.resolve(base, String(p))
    if (!inside(abs, base)) return null
    const realRoot = fs.realpathSync(base)
    const real = fs.realpathSync(abs)
    return inside(real, realRoot) ? real : null
  } catch {
    return null
  }
}

// A launcher-local module: a .js or .json file inside the app folder, found the
// way Node would for "./config" (config, config.js, config.json, config/index.js).
function moduleFile(p, root) {
  for (const f of [p, p + ".js", p + ".json", path.join(p, "index.js")]) {
    if (!/\.(c?js|json)$/i.test(f)) continue
    const real = within(f, root)
    if (!real) continue
    const st = fs.statSync(real)
    if (!st.isFile() || st.size > LIMITS.bytes) continue
    return { file: path.resolve(root, f), text: fs.readFileSync(real, "utf8"), json: /\.json$/i.test(f) }
  }
  return null
}

// Answers new questions the code asked. False when there was nothing new to answer.
function answer(asks, answers, root) {
  let fresh = false
  for (const p of [].concat(asks && asks.modules || [])) {
    if (typeof p !== "string" || p in answers.modules) continue
    if (Object.keys(answers.modules).length >= LIMITS.modules) throw new Error("it reads too many files")
    answers.modules[p] = moduleFile(p, root)
    fresh = true
  }
  for (const p of [].concat(asks && asks.exists || [])) {
    if (typeof p !== "string" || p in answers.exists) continue
    if (Object.keys(answers.exists).length >= LIMITS.exists + (answers.preset || 0)) throw new Error("it checks too many files")
    answers.exists[p] = !!within(p, root)
    fresh = true
  }
  return fresh
}

const kernelInfo = (ctx = {}) => ({
  sep: path.sep, platform: ctx.platform || process.platform, arch: ctx.arch || os.arch(), homedir: os.homedir(),
  gpu: ctx.gpu || "none", gpu_model: typeof ctx.gpu_model === "string" ? ctx.gpu_model : null, port: Number(ctx.port) || 42000,
})

// Runs a script file and returns { daemon, run, self }. `root` is the app folder
// (the only place it may read from); `ctx` gives kernel its platform, GPU and port.
// Old-style install.json/start.json files are the same steps without code.
function loadHere(file, { root = path.dirname(file), ctx = {} } = {}) {
  file = path.resolve(file)
  const name = path.basename(file)
  let code = fs.readFileSync(file, "utf8")
  if (/\.json$/i.test(file)) {
    try { code = `module.exports = ${JSON.stringify(JSON.parse(code))}` } catch { throw new Error(`Couldn't read ${name}: it isn't valid JSON.`) }
  }
  const info = kernelInfo(ctx)
  const answers = { modules: Object.create(null), exists: Object.create(null) }
  let result = null
  for (let round = 0; round < LIMITS.rounds; round++) {
    const context = vm.createContext(Object.create(null), { microtaskMode: "afterEvaluate" })
    let out
    try {
      vm.runInContext(`var __info = ${JSON.stringify(info)}; var __dirname = ${JSON.stringify(path.dirname(file))}; var __filename = ${JSON.stringify(file)}; var __root = ${JSON.stringify(path.resolve(root))}; var __answers = ${JSON.stringify(answers)};` + PRELUDE, context, { timeout: LIMITS.ms })
      // the launcher's own code, compiled and run inside the context so whatever it throws stays there
      vm.runInContext(`try { __Function("module", "exports", "require", "__dirname", "__filename", ${JSON.stringify(code)})(module, exports, require, __dirname, __filename) } catch (e) { __err = __message(e) }`, context, { filename: file, timeout: LIMITS.ms })
      vm.runInContext(`if (__err === null) {${FINISH}}`, context, { timeout: LIMITS.ms })
      out = vm.runInContext(RESULT, context, { timeout: LIMITS.ms })
    } catch {
      // only a timeout gets here; the value thrown isn't looked at, it may be the script's own
      throw new Error(`Couldn't read ${name}: its code took too long.`)
    }
    try { result = typeof out === "string" ? JSON.parse(out) : null } catch { result = null }
    if (!result) throw new Error(`Couldn't read ${name}: it gave back something that isn't a script.`)
    let fresh
    try { fresh = answer(result.asks, answers, root) } catch (err) { throw new Error(`Couldn't read ${name}: ${err.message}.`) }
    if (!fresh) break
    if (round === LIMITS.rounds - 1) throw new Error(`Couldn't read ${name}: it kept asking for more files.`)
  }
  if (result.error) throw new Error(`Couldn't read ${name}: ${String(result.error)}`)
  if (result.kind === "none") throw new Error(`${name} doesn't export a script.`)
  if (result.kind === "code") throw new Error(`${name} builds its steps with code, which Obstat can't run yet.`)
  if (result.kind !== "ok") throw new Error(`${name} has no steps to run.`)
  if (result.script.run.length > 2000) throw new Error(`Couldn't read ${name}: it has too many steps.`)
  return { daemon: !!result.script.daemon, run: result.script.run, self: result.script }
}

// "{{platform === 'win32' ? 'a' : 'b'}}" -> evaluated against ctx. A string that is
// exactly one template keeps the value's type (so `when` can be a real boolean).
// `root` is the app folder, which exists() in a template may look inside.
// `memo.exists` holds exists() answers: a plan writes down every answer it got,
// and the run that follows gives templates those same answers.
function render(value, ctx, root, memo = null) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{((?:(?!\{\{|\}\})[\s\S])+)\}\}$/)
    if (whole) return evaluate(whole[1], ctx, root, memo)
    return value.replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr) => {
      const v = evaluate(expr, ctx, root, memo)
      return v == null ? "" : String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx, root, memo))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "on" ? v : render(v, ctx, root, memo)]))
  return value
}

// Templates see a JSON copy of ctx in a fresh context, and only plain values come
// back. Like Pinokio, they also get cwd, self, path, exists() and kernel, all
// written inside the context; exists() is answered the same way as in loadScript.
const TEMPLATE_CODE = `${STEADY_CODE}
var __JSON = { stringify: JSON.stringify.bind(JSON) }, __String = String;
var __has = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);
${PATH_CODE}
var __asks = { modules: [], exists: [] };
function __ask(kind, p) { if (__asks[kind].indexOf(p) < 0) __asks[kind].push(p) }
function __exists(p) {
  p = __path.resolve(__String(p));
  if (__has(__answers.exists, p)) return __answers.exists[p] === true;
  __ask("exists", p);
  return false;
}
var __kernel = Object.freeze({
  platform: __info.platform, arch: __info.arch, gpu: __info.gpu, gpu_model: __info.gpu_model,
  gpus: Object.freeze(__info.gpu !== "none" ? [Object.freeze({ vendor: __info.gpu, model: __info.gpu_model || "", name: __info.gpu_model || "" })] : []),
  path: function () {
    var p = __path.resolve.apply(null, [__root].concat([].slice.call(arguments).map(__String)));
    return p === __root || p.indexOf(__root + __sep) === 0 ? p : __root;
  },
  exists: function () { return __exists(__path.resolve.apply(null, [].slice.call(arguments).map(__String))) },
  script: Object.freeze({ exists: function () { return __exists(__path.resolve.apply(null, [].slice.call(arguments).map(__String))) } }),
});
var path = __path, exists = __exists, kernel = __kernel;
`
function evaluateHere(expr, ctx, root, preset = null) {
  const data = ctx ?? {}
  const cwd = typeof data.cwd === "string" ? data.cwd : root || "."
  const base = root || cwd
  const answers = { modules: {}, exists: Object.create(null), preset: 0 }
  for (const [k, v] of Object.entries(preset || {})) { answers.exists[k] = v === true; answers.preset++ }
  const done = (v) => ({ v, exists: answers.exists })
  for (let round = 0; round < 4; round++) {
    let out
    try {
      const context = vm.createContext(Object.create(null), { microtaskMode: "afterEvaluate" })
      vm.runInContext(`(function (d) { for (var k in d) this[k] = d[k] }).call(this, ${JSON.stringify(data)});
        var __info = ${JSON.stringify(kernelInfo(data))}; var __dirname = ${JSON.stringify(cwd)}; var __root = ${JSON.stringify(path.resolve(base))}; var __answers = ${JSON.stringify(answers)};` + TEMPLATE_CODE, context, { timeout: LIMITS.templateMs })
      out = vm.runInContext(`(function () {
        var v, failed = false, asks = [];
        try { v = (${expr}) } catch (e) { failed = true }
        try { asks = __asks.exists.slice(0, 20).map(__String) } catch (e) {}
        try { return __JSON.stringify({ asks: asks, error: failed, u: v === undefined, v: failed ? null : v }) } catch (e) { return __JSON.stringify({ asks: asks, error: true }) }
      })()`, context, { timeout: LIMITS.templateMs })
    } catch {
      return done(undefined)
    }
    let r
    try { r = typeof out === "string" ? JSON.parse(out) : null } catch { r = null }
    if (!r) return done(undefined)
    let fresh
    try { fresh = answer({ exists: r.asks }, answers, base) } catch { return done(undefined) }
    if (fresh) continue
    return done(r.error || r.u ? undefined : r.v)
  }
  return done(undefined)
}

// Script code and templates are evaluated on a separate thread (one per process,
// started on first use). The calling thread waits for each answer with a hard
// deadline; if it passes (an endless loop the vm timeout missed, or the thread
// ran out of its capped memory), the thread is thrown away and a fresh one
// starts next time. The thread gets an empty environment and nothing else.
const HARD_MS = { load: 10000, evaluate: 1500 }
let thread = null
function onThread(op, args) {
  if (!isMainThread && workerData && workerData.obstatScripts) return op === "load" ? loadHere(...args) : evaluateHere(...args)
  if (!thread) {
    const { port1, port2 } = new MessageChannel()
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(`require(${JSON.stringify(__filename)})`, { eval: true, workerData: { obstatScripts: true, port: port2, flag }, transferList: [port2], env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } })
    worker.unref()
    worker.on("error", () => {})
    port1.unref()
    thread = { worker, port: port1, flag }
  }
  const t = thread
  Atomics.store(t.flag, 0, 0)
  t.port.postMessage({ op, args })
  const waited = Atomics.wait(t.flag, 0, 0, HARD_MS[op])
  const got = receiveMessageOnPort(t.port)
  if (waited === "timed-out" || !got) {
    thread = null
    t.worker.terminate()
    if (op === "evaluate") return { v: undefined, exists: {} }
    throw new Error(`Couldn't read ${path.basename(String(args[0]))}: its code took too long.`)
  }
  if (got.message.error !== undefined) throw new Error(got.message.error)
  return got.message.value
}
if (!isMainThread && workerData && workerData.obstatScripts) {
  const { port, flag } = workerData
  port.on("message", ({ op, args }) => {
    let reply
    try { reply = { value: op === "load" ? loadHere(...args) : evaluateHere(...args) } } catch (err) { reply = { error: err.message } }
    port.postMessage(reply)
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
  })
}
const loadScript = (file, opts) => onThread("load", [file, opts])
function evaluate(expr, ctx, root, memo = null) {
  const { v, exists } = onThread("evaluate", [expr, ctx, root, memo && memo.exists])
  if (memo && memo.record) for (const [k, a] of Object.entries(exists)) if (Object.keys(memo.exists).length < 500) memo.exists[k] = a
  return v
}

// Pinokio writes event patterns as "/regex/flags" strings.
function toRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern
  const m = String(pattern).match(/^\/([\s\S]*)\/([a-z]*)$/)
  try {
    return m ? new RegExp(m[1], m[2]) : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  } catch {
    return null
  }
}

const skipped = (when) => when === false || when === "false" || when === "" || when === 0 || when === null || when === undefined

// hf.download is Pinokio's step for Hugging Face downloads. Obstat turns it into
// one `hf download` command, checking every part so nothing else can ride along
// in the shell line: a repo id, file names, and a few known options.
// -I: Python ignores the app's folder (the current one) and PYTHON* variables, so nothing there stands in for pip
const HF_SETUP = 'python -I -m pip install --quiet "huggingface_hub>=0.34"'
const HF_SAFE = /^[\w.\/*@+=:, -]{1,200}$/
const HF_OPTIONS = { "local-dir": "path", include: "pattern", exclude: "pattern", revision: "word", "repo-type": "type" }
function hfCommand(params) {
  const list = [].concat(params._ ?? params.repo ?? []).map(String)
  const repo = list[0] || ""
  if (!/^[\w.-]{1,96}(\/[\w.-]{1,96})?$/.test(repo) || /(^|\/)\.\.?($|\/)/.test(repo)) throw new Error(`hf.download names a repo Obstat can't use (${repo}).`)
  const bad = (v) => !HF_SAFE.test(v) || v.split(/[\\/]/).includes("..") || /^[-\/\\]|^[a-z]:/i.test(v)
  const parts = ["hf", "download", repo]
  for (const f of list.slice(1)) {
    if (bad(f)) throw new Error(`hf.download names a file Obstat can't use (${f}).`)
    parts.push(`"${f}"`)
  }
  let localDir = null
  for (const [key, value] of Object.entries(params)) {
    if (["_", "repo", "path", "venv"].includes(key)) continue
    const kind = HF_OPTIONS[key]
    if (!kind) throw new Error(`hf.download uses the option "${key}", which Obstat doesn't pass on.`)
    for (const v of [].concat(value).map(String)) {
      if (kind === "type" ? !/^(model|dataset|space)$/.test(v) : kind === "word" ? !/^[\w.\/-]{1,100}$/.test(v) : bad(v)) throw new Error(`hf.download has an option Obstat can't use (${key}: ${v}).`)
      if (key === "local-dir") localDir = v
      parts.push(`--${key}`, `"${v}"`)
    }
  }
  return { repo, localDir, command: parts.join(" ") }
}

// Steps whose filled-in params must match the plan exactly when an approved script runs.
const CHECKED = new Set(["shell.run", "script.start", "fs.download", "fs.copy", "hf.download"])
const stepKey = (file, i) => `${file}#${i}`

// The steps a script will take, with templates filled in, for showing before it runs.
// `rec` writes down what the plan saw (see approve()).
function plan(file, ctx, depth = 0, root = path.dirname(file), rec = newRecord()) {
  file = path.resolve(file)
  if (++rec.loads > LIMITS.modules) throw new Error("This app starts too many scripts.")
  const script = loadScript(file, { root, ctx })
  rec.scripts[file] = script
  const c = { ...ctx, local: {}, cwd: path.dirname(file), self: script.self }
  const steps = []
  for (const [i, raw] of script.run.entries()) {
    if (raw && "when" in raw && skipped(render(raw.when, c, root, rec.memo))) continue
    const method = raw && raw.method
    const params = render((raw && raw.params) || {}, c, root, rec.memo)
    if (CHECKED.has(method)) (rec.params[stepKey(file, i)] ||= []).push(JSON.stringify(params))
    if (!SUPPORTED.has(method)) {
      steps.push({ method, unsupported: true })
      if (raw?.next === null) break
      continue
    }
    if (method === "shell.run") {
      const message = [].concat(params.message || []).filter((x) => x !== undefined && x !== null && x !== "")
      steps.push({ method, commands: message.map(String), path: params.path || ".", venv: params.venv || null, env: envOf(params) })
    } else if (method === "script.start" && depth < 4) {
      const uri = String(params.uri || "")
      const child = path.resolve(path.dirname(file), uri)
      if (!inside(child, root) || !fs.existsSync(child)) {
        steps.push({ method, uri, missing: true })
      } else {
        steps.push({ method, uri, steps: plan(child, { ...ctx, args: params.params || {} }, depth + 1, root, rec) })
      }
    } else if (method === "fs.download") {
      steps.push({ method, url: params.uri || params.url, dir: params.dir || params.path || "." })
    } else if (method === "fs.copy") {
      steps.push({ method, src: String(params.src ?? ""), dest: String(params.dest ?? "") })
    } else if (method === "hf.download") {
      // shown as the command it becomes; one Obstat can't build stops here like an unsupported step
      try { steps.push({ method, commands: [HF_SETUP, hfCommand(params).command], path: params.path || ".", venv: "Obstat's download tool" }) }
      catch (err) { steps.push({ method, unsupported: true, why: err.message }) }
    } else if (method === "jump") {
      // where a jump lands depends on what happens while the script runs, so the plan lists every step in order
      steps.push({ method, to: params.id ?? params.index ?? null })
    } else {
      steps.push({ method })
    }
    if (raw?.next === null) break
  }
  return steps
}

// A step's own environment variables, shown with its commands: they can change what a command does.
function envOf(params) {
  const env = params.env && typeof params.env === "object" ? Object.entries(params.env) : []
  return env.length ? env.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`) : null
}

function newRecord() {
  return { loads: 0, scripts: Object.create(null), params: Object.create(null), memo: { exists: Object.create(null), record: true } }
}

// A plan plus what's needed to run exactly it: every script as the plan read
// it, the filled-in params of each step it showed, and the exists() answers its
// templates got. The worker runs from this instead of reading the files again,
// so what people approve is what runs, even if the app's files change meanwhile.
function approve(file, ctx) {
  const rec = newRecord()
  const steps = plan(file, ctx, 0, path.dirname(path.resolve(file)), rec)
  return { steps, approved: { scripts: rec.scripts, params: rec.params, exists: rec.memo.exists } }
}

// Every shell command in a plan, flattened, plus the ones worth a warning.
const RISKY = [
  [/\brm\s+-rf?\s+[\/~]|\brmdir\s+\/s|\bdel\s+\/[sq]|\bformat\s+[a-z]:/i, "deletes files outside the app"],
  [/\breg(\.exe)?\s+(add|delete)\b|\bSet-ItemProperty\b.*HK(LM|CU)/i, "changes the Windows registry"],
  [/\b(runas|sudo)\b|Start-Process[^|]*-Verb\s+RunAs/i, "asks for admin rights"],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|iex|powershell)/i, "runs a script straight from the internet"],
  [/\b(setx|schtasks|sc\s+create)\b/i, "changes system settings or startup"],
  [/-enc(odedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, "runs hidden, encoded commands"],
]
function commandsOf(steps, out = []) {
  for (const s of steps) {
    if (s.commands) for (const c of s.commands) out.push({ command: c, path: s.path, venv: s.venv, env: s.env || null, risks: RISKY.filter(([re]) => re.test(c)).map(([, why]) => why) })
    if (s.steps) commandsOf(s.steps, out)
  }
  return out
}

module.exports = { loadScript, render, evaluate, toRegExp, plan, approve, commandsOf, skipped, hfCommand, within, stepKey, HF_SETUP, SUPPORTED, CHECKED }
