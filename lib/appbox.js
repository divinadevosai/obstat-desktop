// Windows install walls: lib/appbox.cs, compiled once on this computer with the C#
// compiler every Windows 10 and 11 has (.NET Framework 4), starts a reviewed app's
// install inside an AppContainer (see lib/walls.js for what it may touch).
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile } = require("node:child_process")

const SOURCE = path.join(__dirname, "appbox.cs")

function compilers(env = process.env) {
  const win = env.WINDIR || env.SystemRoot || "C:\\Windows"
  return ["Framework64", "Framework"].map((f) => path.join(win, "Microsoft.NET", f, "v4.0.30319", "csc.exe"))
}

// Each AppContainer is named from the app's id, so each app's install gets its own.
const containerName = (id) => `obstat.install.${crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 24)}`

// Compiles the helper into Obstat's cache (again only when its source changes).
// The source is copied out first: inside the packaged app it's in app.asar.
function helper(cacheDir, { run = execFile, exists = fs.existsSync, env = process.env } = {}) {
  const src = fs.readFileSync(SOURCE)
  const tag = crypto.createHash("sha256").update(src).digest("hex").slice(0, 12)
  const dir = path.join(cacheDir, "appbox")
  const exe = path.join(dir, `appbox-${tag}.exe`)
  if (exists(exe)) return Promise.resolve(exe)
  const csc = compilers(env).find((f) => exists(f))
  if (!csc) return Promise.reject(new Error("this Windows has no .NET Framework 4 C# compiler"))
  fs.mkdirSync(dir, { recursive: true })
  const cs = path.join(dir, `appbox-${tag}.cs`)
  fs.writeFileSync(cs, src)
  const tmp = `${exe}.${process.pid}.tmp.exe`
  return new Promise((resolve, reject) => run(csc, ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${tmp}`, cs], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
    if (err) return reject(new Error(`couldn't build the install walls: ${String(stdout || err.message).trim().slice(0, 400)}`))
    try { fs.renameSync(tmp, exe) } catch (e) { if (!exists(exe)) return reject(e) }
    resolve(exe)
  }))
}

// Builds the helper, then starts Obstat's own Node (Electron) inside a test container,
// as installs will be: works -> { kind: "appcontainer", file }, else why not.
async function detect({ cacheDir, execPath = process.execPath, readable = [], run = execFile, env = process.env } = {}) {
  let exe
  try { exe = await helper(cacheDir, { run, env }) } catch (err) { return { kind: null, reason: err.message } }
  const why = (err, stderr) => {
    const code = err && typeof err.code === "number" ? ` exit ${err.code < 0 ? `0x${(err.code >>> 0).toString(16)}` : err.code}` : err ? ` ${err.code || err.message.split("\n")[0].slice(0, 120)}` : ""
    return `${code}${String(stderr || "").trim() ? `: ${String(stderr).trim().slice(0, 300)}` : ""}`.trim()
  }
  // first Windows' own cmd.exe, then Obstat's own Node with what installs may read
  const basic = await new Promise((resolve) => run(exe, ["test"], { windowsHide: true, timeout: 60000 }, (err, _o, stderr) => resolve(err ? why(err, stderr) : null)))
  if (basic) return { kind: null, reason: `Windows' AppContainer didn't start (${basic})` }
  const args = ["run", "--name", "obstat.walls.test", ...readable.flatMap((p) => ["--shared-ro", p]), "--cwd", path.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "System32"), "--", execPath, ...NODE_FLAGS, "-e", "process.exit(7)"]
  const testEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" }
  return new Promise((resolve) => run(exe, args, { windowsHide: true, timeout: 60000, env: testEnv }, (err, _o, stderr) => {
    if (err && err.code === 7) return resolve({ kind: "appcontainer", file: exe })
    resolve({ kind: null, reason: `Windows' AppContainer didn't start Obstat's worker (${why(err, stderr) || "it ended without error"})` })
  }))
}

// Node resolves every folder above a script it loads (fs.realpath), and an AppContainer
// may not look at the ones above its own (C:\Users\you): these keep paths as given.
const NODE_FLAGS = ["--preserve-symlinks", "--preserve-symlinks-main"]

// every existing package.json above these paths: Node reads the nearest one above
// each script it runs (Obstat's worker included)
function packageFiles(paths, exists = fs.existsSync) {
  const out = new Set()
  for (const p of paths) for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) { const f = path.join(d, "package.json"); if (exists(f)) out.add(f) }
  return [...out]
}

// How to start `file args` in an app's container. `own`: its own folders (read and
// write); `shared`: what every Obstat install may write (the package caches);
// `readable`: what every Obstat install may read (Obstat's runtimes and program).
function wrap(found, { name, own = [], shared = [], readable = [], cwd }, file, args) {
  const ro = [...readable, ...packageFiles([file, ...args.filter((a) => path.isAbsolute(a))])]
  return {
    file: found.file,
    args: ["run", "--name", name, ...own.flatMap((p) => ["--rw", p]), ...shared.flatMap((p) => ["--shared-rw", p]), ...ro.flatMap((p) => ["--shared-ro", p]), ...(cwd ? ["--cwd", cwd] : []), "--", file, ...NODE_FLAGS, ...args],
  }
}

module.exports = { detect, helper, wrap, containerName, compilers, packageFiles, NODE_FLAGS, SOURCE, tmp: os.tmpdir }
