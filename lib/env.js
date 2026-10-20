// Windows spells it "Path" and treats env names case-insensitively, but a copied
// env object doesn't, so two PATH entries could end up fighting. This keeps one.
const fs = require("node:fs")
const path = require("node:path")

function withPath(env, front = []) {
  const out = {}
  let current = ""
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === "PATH") current = current || v
    else out[k] = v
  }
  out.PATH = [...front, current].filter(Boolean).join(path.delimiter)
  return out
}

// Is `p` the folder `base` or inside it? (A plain startsWith would let "app-evil" pass for "app".)
const inside = (p, base) => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep)

// Which file a command name runs with this env's PATH, the way a shell picks it:
// the first folder that has it, trying Windows' PATHEXT endings. null if none.
function which(cmd, env, platform = process.platform, exists = (f) => { try { return fs.statSync(f).isFile() } catch { return false } }) {
  if (!/^[\w.+-]{1,64}$/.test(cmd)) return null
  const p = platform === "win32" ? path.win32 : path.posix
  const entry = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")
  const dirs = (entry ? entry[1] : "").split(platform === "win32" ? ";" : ":").filter(Boolean)
  // cmd.exe only runs a bare name through PATHEXT; a name with its ending runs as is
  const exts = platform === "win32" ? (/\.[a-z0-9]+$/i.test(cmd) ? [""] : (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())) : [""]
  for (const d of dirs) for (const e of exts) {
    const f = p.join(d, cmd + e)
    if (exists(f)) return f
  }
  return null
}

module.exports = { withPath, inside, which }
