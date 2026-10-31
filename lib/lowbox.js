// Windows install walls: lib/lowbox.cs, compiled once on this computer with the C#
// compiler every Windows 10 and 11 has (.NET Framework 4), starts a reviewed app's
// install at low integrity (see lib/walls.js for what it may touch).
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile } = require("node:child_process")

const SOURCE = path.join(__dirname, "lowbox.cs")

function compilers(env = process.env) {
  const win = env.WINDIR || env.SystemRoot || "C:\\Windows"
  return ["Framework64", "Framework"].map((f) => path.join(win, "Microsoft.NET", f, "v4.0.30319", "csc.exe"))
}

// Compiles the helper into Obstat's cache (again only when its source changes). The
// source is read, not copied: inside the packaged app it's in app.asar.
function helper(cacheDir, { run = execFile, exists = fs.existsSync, env = process.env } = {}) {
  const src = fs.readFileSync(SOURCE)
  const tag = crypto.createHash("sha256").update(src).digest("hex").slice(0, 12)
  const dir = path.join(cacheDir, "lowbox")
  const exe = path.join(dir, `lowbox-${tag}.exe`)
  if (exists(exe)) return Promise.resolve(exe)
  const csc = compilers(env).find((f) => exists(f))
  if (!csc) return Promise.reject(new Error("this Windows has no .NET Framework 4 C# compiler"))
  fs.mkdirSync(dir, { recursive: true })
  const cs = path.join(dir, `lowbox-${tag}.cs`)
  fs.writeFileSync(cs, src)
  const tmp = `${exe}.${process.pid}.tmp.exe`
  return new Promise((resolve, reject) => run(csc, ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${tmp}`, cs], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
    if (err) return reject(new Error(`couldn't build the install walls: ${String(stdout || err.message).trim().slice(0, 400)}`))
    try { fs.renameSync(tmp, exe) } catch (e) { if (!exists(exe)) return reject(e) }
    resolve(exe)
  }))
}

const why = (err, stderr) => {
  const code = err && typeof err.code === "number" ? ` exit ${err.code < 0 || err.code > 0x7fffffff ? `0x${(err.code >>> 0).toString(16)}` : err.code}` : err ? ` ${err.code || String(err.message).split("\n")[0].slice(0, 120)}` : ""
  return `${code}${String(stderr || "").trim() ? `: ${String(stderr).trim().slice(0, 300)}` : ""}`.trim()
}

// Builds the helper, then checks it the way installs use it: Windows' cmd.exe at low
// integrity, then Obstat's own Node starting a program with its output piped back
// (which is what installs do all the time). Works -> { kind: "lowbox", file }.
async function detect({ cacheDir, execPath = process.execPath, run = execFile, env = process.env } = {}) {
  let exe
  try { exe = await helper(cacheDir, { run, env }) } catch (err) { return { kind: null, reason: err.message } }
  const basic = await new Promise((resolve) => run(exe, ["test"], { windowsHide: true, timeout: 60000 }, (err, _o, stderr) => resolve(err ? why(err, stderr) : null)))
  if (basic) return { kind: null, reason: `Windows didn't start a low-integrity program (${basic})` }
  const probe = "const r = require('node:child_process').spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo ok'], { encoding: 'utf8' }); process.exit(/ok/.test(r.stdout || '') ? 7 : 1)"
  const sys = path.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "System32")
  return new Promise((resolve) => run(exe, ["run", "--cwd", sys, "--", execPath, "-e", probe], { windowsHide: true, timeout: 60000, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }, (err, _o, stderr) => {
    if (err && err.code === 7) return resolve({ kind: "lowbox", file: exe })
    resolve({ kind: null, reason: `Obstat's worker couldn't run at low integrity (${why(err, stderr) || "it ended without error"})` })
  }))
}

// How to start `file args` at low integrity. `low`: the folders it may write;
// `hide`: what it may not even read (Obstat's secrets).
function wrap(found, { low = [], hide = [], cwd }, file, args) {
  return { file: found.file, args: ["run", ...low.flatMap((p) => ["--low", p]), ...hide.flatMap((p) => ["--hide", p]), ...(cwd ? ["--cwd", cwd] : []), "--", file, ...args] }
}

module.exports = { detect, helper, wrap, compilers, SOURCE }
