// Walls around reviewed apps' installs (install.js, update.js and reset.js): on Mac
// and Linux the same OS sandbox sandbox tests run in (lib/confine.js); on Windows,
// low integrity (lib/lowbox.js), which is less (see below). Installs run
// code nobody reads in full: npm's preinstall and postinstall hooks, Python packages
// built from source (setup.py and build backends), node-gyp and CMake builds, any of
// them in any dependency. Inside the walls, all of that
//   - can write only the app's own folder, its own install home, and the package and
//     model caches every app shares (uv, pip, npm, node-gyp, Hugging Face, PyTorch);
//   - can't read the rest of your home folder, or Obstat's own (keys, chat sign-in);
//   - gets no API keys from Keys, and none of Obstat's environment beyond the basics;
//   - on Linux has a network of its own whose only way out is Obstat's proxy (no
//     localhost, no local network); on a Mac can't connect to this computer's localhost.
// On Windows the install runs at low integrity, the level browsers run their sandboxes
// at: it can write only the folders above, and can't read Obstat's own secrets (keys,
// sign-in, logs), but it can still read the rest of your files and reach this
// computer's localhost. Dependencies' npm scripts are skipped there too (lib/npmsafe.js).
// Starting the app isn't walled: it's the reviewed app itself, and it finds what the
// install put in the shared caches at their usual places.
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const confine = require("./confine")
const lowbox = require("./lowbox")
const netproxy = require("./netproxy")

const WALLED = new Set(["install.js", "update.js", "reset.js"])
const folderName = (id) => id.replace(/[^a-z0-9._-]+/gi, "-")

// The caches installs fill and started apps read, where each tool keeps them by default,
// so walled installs and unwalled starts share them. Name -> [env var, path].
function caches(platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA) {
  if (platform === "win32") {
    const w = path.win32, local = localAppData || w.join(home, "AppData", "Local")
    return {
      uv: ["UV_CACHE_DIR", w.join(local, "uv", "cache")],
      pip: ["PIP_CACHE_DIR", w.join(local, "pip", "Cache")],
      npm: ["npm_config_cache", w.join(local, "npm-cache")],
      "node-gyp": ["npm_config_devdir", w.join(local, "node-gyp", "Cache")],
      huggingface: ["HF_HOME", w.join(home, ".cache", "huggingface")],
      torch: ["TORCH_HOME", w.join(home, ".cache", "torch")],
    }
  }
  const mac = platform === "darwin"
  // Mac and Linux paths, whatever system this runs on (the tests run everywhere)
  const p = path.posix
  return {
    uv: ["UV_CACHE_DIR", p.join(home, ".cache", "uv")],
    pip: ["PIP_CACHE_DIR", mac ? p.join(home, "Library", "Caches", "pip") : p.join(home, ".cache", "pip")],
    npm: ["npm_config_cache", p.join(home, ".npm")],
    "node-gyp": ["npm_config_devdir", mac ? p.join(home, "Library", "Caches", "node-gyp") : p.join(home, ".cache", "node-gyp")],
    huggingface: ["HF_HOME", p.join(home, ".cache", "huggingface")],
    torch: ["TORCH_HOME", p.join(home, ".cache", "torch")],
  }
}

// Obstat's own files a Windows install mustn't read: API keys, the chat and account
// sign-in, the agents' control token, Divina's data, and every app's logs. `extra`:
// Electron's own data folder (its cookies, and the key safeStorage encrypts with).
function secrets(home, extra = []) {
  const P = path.win32
  return [...["keys.json", "account.json", "control.json", "divina.json", "divina-data", "divina", "logs"].map((n) => P.join(home.root, n)), ...extra]
}

// `hide`: on Windows, more of Obstat's own folders an install mustn't read (see secrets)
function create(home, { appDir, platform = process.platform, homeDir = os.homedir(), localAppData = process.env.LOCALAPPDATA, execPath = process.execPath, detect = null, programPaths = confine.programPaths, mkdir = (d) => fs.mkdirSync(d, { recursive: true }), proxy = netproxy.proxy, hide = [] } = {}) {
  let walls = null
  // Windows paths when walling for Windows (the tests run everywhere)
  const P = platform === "win32" ? path.win32 : path
  const find = detect || (platform === "win32" ? () => lowbox.detect({ cacheDir: home.dir("cache"), execPath }) : () => confine.detect({ platform }))
  const found = Promise.resolve().then(() => find({ platform })).then((w) => { walls = w; return w }, (err) => { walls = { kind: null, reason: err.message }; return walls })
  const sharedCaches = () => Object.values(caches(platform, homeDir, localAppData)).map(([, d]) => d)

  // walled: this script of a reviewed app, on a computer with walls
  const walled = (script) => !!walls?.kind && WALLED.has(script)
  const installHome = (id) => P.join(home.dir("cache"), "install-home", folderName(id))

  // Linux: each walled run's network (only way out: Obstat's proxy), closed when it ends
  const nets = new Map()
  function network(id) {
    let n = nets.get(id)
    if (!n) {
      const dir = fs.mkdtempSync(P.join(os.tmpdir(), "obstat-net-"))
      n = { dir, server: proxy(P.join(dir, "out.sock")) }
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
    const shared = sharedCaches()
    for (const d of [h, P.join(h, "tmp"), ...shared]) mkdir(d)
    if (walls.kind === "lowbox") {
      for (const d of [P.join(h, "AppData", "Roaming"), P.join(h, "AppData", "Local")]) mkdir(d)
      const w = lowbox.wrap(walls, { low: [appDir(id), h, ...shared], hide: secrets(home, hide), cwd: h }, file, args)
      return { ...w, kind: walls.kind, cwd: h }
    }
    const writable = [appDir(id), h, ...shared]
    const readable = [P.join(home.root, "bin"), ...programPaths({ execPath })]
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
      HOME: h, XDG_CONFIG_HOME: P.join(h, ".config"), XDG_DATA_HOME: P.join(h, ".local", "share"),
      TMPDIR: P.join(h, "tmp"), TEMP: P.join(h, "tmp"), TMP: P.join(h, "tmp"),
      OBSTAT_WALLED_INSTALL: "1",
      ...(walls.kind === "bwrap" ? netproxy.proxyEnv() : {}),
      // Windows programs find "home" and app data from these
      ...(walls.kind === "lowbox" ? { HOME: undefined } : {}),
    }
    for (const [k, d] of Object.values(caches(platform, homeDir, localAppData))) out[k] = d
    return out
  }

  // the job's way out to the internet (Linux); on Windows, whose walls are lower, and
  // where installs can't be walled, npm skips the dependencies' install scripts too
  // (lib/npmsafe.js)
  const jobExtra = (id, script) => {
    if (!walled(script)) return WALLED.has(script) ? { npmSafe: true } : {}
    if (walls.kind === "lowbox") return { npmSafe: true }
    if (walls.kind !== "bwrap") return {}
    const { dir } = network(id)
    return { net: { outSock: P.join(dir, "out.sock"), inSock: P.join(dir, "in.sock"), proxyPort: netproxy.PROXY_PORT } }
  }

  // a walled install keeps its own copy of Obstat's hf tool: it mustn't be able to change the one every app uses
  const hfEnv = (id, script) => (walled(script) ? P.join(installHome(id), "hf-env") : null)

  const info = async () => { await found; return { kind: walls?.kind || null, reason: walls?.reason || null } }
  return { wrap, env, jobExtra, hfEnv, walled, done, info, ready: found }
}

// Obstat's environment without what looks like a secret, for installs that aren't walled:
// an install shouldn't see the tokens someone exported in the terminal Obstat started from.
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|SESSION|AUTH)|^(AWS|AZURE|GCP|GOOGLE_APPLICATION|GH|GITHUB|GITLAB|NPM_TOKEN|HF_TOKEN|HUGGING_FACE|OPENAI|ANTHROPIC|GEMINI|MISTRAL|GROQ|REPLICATE|STRIPE|SLACK|DISCORD|TELEGRAM|TWILIO)_/i
const withoutSecrets = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET.test(k)))

module.exports = { create, caches, secrets, withoutSecrets, WALLED }
