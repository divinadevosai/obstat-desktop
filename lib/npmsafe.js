// npm installs without the dependencies' install scripts, where installs aren't walled
// (Windows; lib/walls.js walls them on Mac and Linux). npm runs every dependency's
// preinstall, install and postinstall script as it installs, and nobody reads those for
// every package an app pulls in. In an install step:
//   npm install / npm i / npm ci / npm add / npm update ...
// runs with --ignore-scripts (that command only), then Obstat's after-install step:
//   - runs the install scripts of the dependencies on ALLOW only (packages that need them
//     to work: native modules and tools that fetch their own binaries), with npm rebuild
//   - runs the app's own install scripts (preinstall, install, postinstall, prepare),
//     which are the app's reviewed code, not a dependency's
//   - lists every other dependency whose install scripts were skipped, in the log
// Commands that run a script by name (npm run build, npm start) aren't affected.
"use strict"
const fs = require("node:fs")
const path = require("node:path")

// Well-known packages whose install scripts they need to work.
const ALLOW = [
  "esbuild", "@swc/core", "sharp", "better-sqlite3", "sqlite3", "node-pty", "@homebridge/node-pty-prebuilt-multiarch",
  "bcrypt", "canvas", "onnxruntime-node", "@tensorflow/tfjs-node", "node-llama-cpp", "electron", "puppeteer",
  "lmdb", "msgpackr-extract", "@parcel/watcher", "bufferutil", "utf-8-validate", "unrs-resolver", "protobufjs",
]

const NPM_INSTALL = /(^|&&\s*|\|\|\s*|;\s*)npm(\.cmd)?\s+(install|i|ci|add|update|up)(\s|$)/
const HELPER = ".obstat-npm-after.js"

// The after-install step, written into the step's folder and run with Obstat's Node.
const helperSource = (allow) => `// written by Obstat for one install step; see lib/npmsafe.js
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process")
const ALLOW = new Set(${JSON.stringify(allow)})
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const run = (args) => spawnSync(npm, args, { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, npm_config_ignore_scripts: "false" } }).status
const HOOKS = ["preinstall", "install", "postinstall"]
const allowed = new Set(), skipped = new Set()
function walk(dir, depth) {
  if (depth > 8) return
  let names
  try { names = fs.readdirSync(dir) } catch { return }
  for (const n of names) {
    if (n.startsWith(".")) continue
    if (n.startsWith("@")) { walk(path.join(dir, n), depth); continue }
    const pkgDir = path.join(dir, n)
    let pkg
    try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) } catch { continue }
    const name = pkg.name || n
    const hasHook = HOOKS.some((h) => pkg.scripts && pkg.scripts[h]) || fs.existsSync(path.join(pkgDir, "binding.gyp"))
    if (hasHook) (ALLOW.has(name) ? allowed : skipped).add(name)
    walk(path.join(pkgDir, "node_modules"), depth + 1)
  }
}
walk(path.join(process.cwd(), "node_modules"), 0)
if (allowed.size) {
  console.log("(Obstat runs the install scripts of " + [...allowed].join(", ") + ", which need them to work.)")
  if (run(["rebuild", "--foreground-scripts", ...allowed])) process.exit(1)
}
if (skipped.size) console.log("(Obstat skipped the install scripts of " + skipped.size + " dependenc" + (skipped.size === 1 ? "y" : "ies") + ": " + [...skipped].sort().join(", ") + ".)")
let own = {}
try { own = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts || {} } catch {}
for (const s of [...HOOKS, "prepare"]) if (own[s]) { if (run(["run", s])) process.exit(1) }
try { fs.unlinkSync(${JSON.stringify(HELPER)}) } catch {}
`

// Rewrites a step's lines: returns the new lines and whether it changed anything.
// `cwd`: the step's folder, where the helper is written.
function apply(lines, { cwd, allow = ALLOW, write = fs.writeFileSync } = {}) {
  if (!lines.some((l) => NPM_INSTALL.test(l))) return { lines, changed: false }
  write(path.join(cwd, HELPER), helperSource(allow))
  return {
    // right after the npm install itself, so later commands on the line (npm run build) find the built modules
    lines: lines.map((l) => (NPM_INSTALL.test(l) ? l.split(/\s*&&\s*/).map((part) => (NPM_INSTALL.test(part) ? `${part} --ignore-scripts && node ${HELPER}` : part)).join(" && ") : l)),
    changed: true,
  }
}

module.exports = { apply, ALLOW, HELPER, NPM_INSTALL }
