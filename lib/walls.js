// Walls around reviewed apps' installs, on Mac and Linux: the same OS sandbox sandbox
// tests run in (lib/confine.js), for install.js, update.js and reset.js. Installs run
// code nobody reads in full: npm's preinstall and postinstall hooks, Python packages
// built from source (setup.py and build backends), node-gyp and CMake builds, any of
// them in any dependency. Inside the walls, all of that
//   - can write only the app's own folder, its own install home, and the package and
//     model caches every app shares (uv, pip, npm, node-gyp, Hugging Face, PyTorch);
//   - can't read the rest of your home folder, or Obstat's own (keys, chat sign-in);
//   - gets no API keys from Keys, and none of Obstat's environment beyond the basics;
//   - on Linux has a network of its own whose only way out is Obstat's proxy (no
//     localhost, no local network); on a Mac can't connect to this computer's localhost.
// Starting the app isn't walled: it's the reviewed app itself, and it finds what the
// install put in the shared caches at their usual places. Windows has no such walls
// (Windows Sandbox is a separate copy of Windows), so installs there run as before.
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const confine = require("./confine")
const netproxy = require("./netproxy")

const WALLED = new Set(["install.js", "update.js", "reset.js"])
const folderName = (id) => id.replace(/[^a-z0-9._-]+/gi, "-")

// The caches installs fill and started apps read, where each tool keeps them by default,
// so walled installs and unwalled starts share them. Name -> [env var, path].
function caches(platform = process.platform, home = os.homedir()) {
  const mac = platform === "darwin"
  return {
    uv: ["UV_CACHE_DIR", path.join(home, ".cache", "uv")],
    pip: ["PIP_CACHE_DIR", mac ? path.join(home, "Library", "Caches", "pip") : path.join(home, ".cache", "pip")],
    npm: ["npm_config_cache", path.join(home, ".npm")],
    "node-gyp": ["npm_config_devdir", mac ? path.join(home, "Library", "Caches", "node-gyp") : path.join(home, ".cache", "node-gyp")],
    huggingface: ["HF_HOME", path.join(home, ".cache", "huggingface")],
    torch: ["TORCH_HOME", path.join(home, ".cache", "torch")],
  }
}

function create(home, { appDir, platform = process.platform, homeDir = os.homedir(), execPath = process.execPath, detect = confine.detect, programPaths = confine.programPaths, mkdir = (d) => fs.mkdirSync(d, { recursive: true }) } = {}) {
  let walls = null
  const found = platform === "win32" ? Promise.resolve(null) : Promise.resolve().then(() => detect({ platform })).then((w) => { walls = w; return w }, () => null)

  // walled: this script of a reviewed app, on a computer with walls
  const walled = (script) => !!walls?.kind && WALLED.has(script)
  const installHome = (id) => path.join(home.dir("cache"), "install-home", folderName(id))

  // Linux: each walled run's network (only way out: Obstat's proxy), closed when it ends
  const nets = new Map()
  function network(id) {
    let n = nets.get(id)
    if (!n) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-net-"))
      n = { dir, server: netproxy.proxy(path.join(dir, "out.sock")) }
      nets.set(id, n)
    }
    return n
  }
  function done(id) {
    const n = nets.get(id)
    if (!n) return
    nets.delete(id)
    n.server.close()
    fs.rmSync(n.dir, { recursive: true, force: true })
  }

  // How to start the worker for this script: inside the walls, or null to start it as usual.
  function wrap(id, file, args, env = {}, script) {
    if (!id || !walled(script)) return null
    const h = installHome(id)
    const shared = Object.values(caches(platform, homeDir)).map(([, d]) => d)
    for (const d of [h, path.join(h, "tmp"), ...shared]) mkdir(d)
    const writable = [appDir(id), h, ...shared]
    const readable = [path.join(home.root, "bin"), ...programPaths({ execPath })]
    if (walls.kind === "bwrap") writable.push(network(id).dir)
    const w = confine.wrap(walls, { writable, readable, hide: [homeDir, home.root], ownNetwork: walls.kind === "bwrap", ports: env.PORT ? [Number(env.PORT)] : [] }, file, args)
    return { ...w, kind: walls.kind }
  }

  // What a walled install's steps get instead of your home folder and keys: its own install
  // home for anything that writes there, and the shared caches at their usual places.
  function env(id, script) {
    if (!walled(script)) return null
    const h = installHome(id)
    const out = {
      HOME: h, XDG_CONFIG_HOME: path.join(h, ".config"), XDG_DATA_HOME: path.join(h, ".local", "share"),
      TMPDIR: path.join(h, "tmp"), TEMP: path.join(h, "tmp"), TMP: path.join(h, "tmp"),
      OBSTAT_WALLED_INSTALL: "1",
      ...(walls.kind === "bwrap" ? netproxy.proxyEnv() : {}),
    }
    for (const [k, d] of Object.values(caches(platform, homeDir))) out[k] = d
    return out
  }

  // the job's way out to the internet (Linux)
  const jobExtra = (id, script) => {
    if (!walled(script) || walls.kind !== "bwrap") return {}
    const { dir } = network(id)
    return { net: { outSock: path.join(dir, "out.sock"), inSock: path.join(dir, "in.sock"), proxyPort: netproxy.PROXY_PORT } }
  }

  // a walled install keeps its own copy of Obstat's hf tool: it mustn't be able to change the one every app uses
  const hfEnv = (id, script) => (walled(script) ? path.join(installHome(id), "hf-env") : null)

  const info = async () => { await found; return { kind: walls?.kind || null, reason: walls?.reason || null } }
  return { wrap, env, jobExtra, hfEnv, walled, done, info, ready: found }
}

module.exports = { create, caches, WALLED }
