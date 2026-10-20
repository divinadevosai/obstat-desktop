// Reads Pinokio scripts (install.js, start.js…) and fills in their {{…}} templates.
// Obstat runs a subset of Pinokio's format: shell.run, script.start, local.set,
// fs.download, input, notify and web.open. Anything else stops with a clear message.
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
const { inside } = require("./env")

const SUPPORTED = new Set(["shell.run", "script.start", "local.set", "fs.download", "input", "notify", "web.open", "fs.link"])
// Script code runs in a fresh vm context that is handed nothing from Obstat:
// no host objects or functions (those would lead back to Node), only JSON going
// in and out. `require("path")` and `require("os")` get small stand-ins written
// inside the context.
const PRELUDE = `
var module = { exports: {} }, exports = module.exports;
var console = { log: function () {}, error: function () {}, warn: function () {}, info: function () {} };
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
  resolve: function () { var r = __dirname; [].slice.call(arguments).forEach(function (a) { r = /^([a-zA-Z]:)?[\\\\/]/.test(a) ? a : r + "/" + a }); return __norm(r) },
  basename: function (p, ext) { var b = String(p).split(/[\\\\/]/).filter(Boolean).pop() || ""; return ext && b.slice(-ext.length) === ext ? b.slice(0, -ext.length) : b },
  dirname: function (p) { var parts = String(p).split(/[\\\\/]/); parts.pop(); return parts.join(__sep) || "." },
  extname: function (p) { var m = String(p).match(/(\\.[^.\\\\/]*)$/); return m && !/^\\.[^.]*$/.test(this.basename(p)) ? m[1] : (/\\./.test(this.basename(p).slice(1)) ? m[1] : "") },
};
__path.posix = __path; __path.win32 = __path;
var __os = { platform: function () { return __info.platform }, arch: function () { return __info.arch }, homedir: function () { return __info.homedir }, EOL: __info.platform === "win32" ? "\\r\\n" : "\\n" };
function require(name) {
  name = String(name).replace(/^node:/, "");
  if (name === "path") return __path;
  if (name === "os") return __os;
  throw new Error("needs \\"" + name + "\\", which Obstat doesn't allow in scripts");
}
`

function loadScript(file) {
  const code = fs.readFileSync(file, "utf8")
  const info = { sep: path.sep, platform: process.platform, arch: os.arch(), homedir: os.homedir() }
  const context = vm.createContext(Object.create(null))
  let out
  try {
    vm.runInContext(`var __info = ${JSON.stringify(info)}; var __dirname = ${JSON.stringify(path.dirname(file))}; var __filename = ${JSON.stringify(file)};` + PRELUDE, context, { timeout: 1000 })
    vm.runInContext(code, context, { filename: file, timeout: 1000 })
    out = vm.runInContext(`(function (s) {
      if (!s || typeof s !== "object") return JSON.stringify({ kind: "none" });
      if (typeof s.run === "function") return JSON.stringify({ kind: "code" });
      return JSON.stringify({ kind: Array.isArray(s.run) ? "ok" : "steps", daemon: !!s.daemon, run: s.run }, function (k, v) { return v instanceof RegExp ? String(v) : v });
    })(module.exports)`, context, { timeout: 1000 })
  } catch (err) {
    throw new Error(`Couldn't read ${path.basename(file)}: ${err && err.message ? String(err.message) : "it threw an error"}`)
  }
  const script = JSON.parse(out)
  if (script.kind === "none") throw new Error(`${path.basename(file)} doesn't export a script.`)
  if (script.kind === "code") throw new Error(`${path.basename(file)} builds its steps with code, which Obstat can't run yet.`)
  if (script.kind !== "ok") throw new Error(`${path.basename(file)} has no steps to run.`)
  return { daemon: script.daemon, run: script.run }
}

// "{{platform === 'win32' ? 'a' : 'b'}}" -> evaluated against ctx. A string that is
// exactly one template keeps the value's type (so `when` can be a real boolean).
function render(value, ctx) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([\s\S]+?)\}\}$/)
    if (whole) return evaluate(whole[1], ctx)
    return value.replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr) => {
      const v = evaluate(expr, ctx)
      return v == null ? "" : String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "on" ? v : render(v, ctx)]))
  return value
}

// Templates see a JSON copy of ctx in a fresh context, and only plain values come back.
function evaluate(expr, ctx) {
  try {
    const context = vm.createContext(Object.create(null))
    vm.runInContext(`(function (d) { for (var k in d) this[k] = d[k] }).call(this, ${JSON.stringify(ctx ?? {})})`, context, { timeout: 200 })
    const out = vm.runInContext(`(function (v) { return v === undefined ? "u" : JSON.stringify(v) })((${expr}))`, context, { timeout: 200 })
    return out === "u" || out === undefined ? undefined : JSON.parse(out)
  } catch {
    return undefined
  }
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

// The steps a script will take, with templates filled in, for showing before it runs.
function plan(file, ctx, depth = 0, root = path.dirname(file)) {
  const script = loadScript(file)
  const steps = []
  for (const raw of script.run) {
    if (raw && "when" in raw && skipped(render(raw.when, ctx))) continue
    const method = raw && raw.method
    const params = render((raw && raw.params) || {}, ctx)
    if (!SUPPORTED.has(method)) {
      steps.push({ method, unsupported: true })
      if (raw?.next === null) break
      continue
    }
    if (method === "shell.run") {
      const message = [].concat(params.message || []).filter((x) => x !== undefined && x !== null && x !== "")
      steps.push({ method, commands: message.map(String), path: params.path || ".", venv: params.venv || null })
    } else if (method === "script.start" && depth < 4) {
      const uri = String(params.uri || "")
      const child = path.resolve(path.dirname(file), uri)
      if (!inside(child, root) || !fs.existsSync(child)) {
        steps.push({ method, uri, missing: true })
      } else {
        steps.push({ method, uri, steps: plan(child, { ...ctx, args: params.params || {} }, depth + 1, root) })
      }
    } else if (method === "fs.download") {
      steps.push({ method, url: params.uri || params.url, dir: params.dir || params.path || "." })
    } else {
      steps.push({ method })
    }
    if (raw?.next === null) break
  }
  return steps
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
    if (s.commands) for (const c of s.commands) out.push({ command: c, path: s.path, venv: s.venv, risks: RISKY.filter(([re]) => re.test(c)).map(([, why]) => why) })
    if (s.steps) commandsOf(s.steps, out)
  }
  return out
}

module.exports = { loadScript, render, evaluate, toRegExp, plan, commandsOf, skipped, SUPPORTED }
