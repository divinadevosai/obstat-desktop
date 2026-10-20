// Obstat's own folder (like C:\pinokio for Pinokio): apps, sandboxes, logs and cache
// all live under ~/obstat, so removing Obstat's data is removing one folder.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { execFile } = require("node:child_process")

const FOLDERS = ["apps", "sandboxes", "bin", "logs", "cache"]

function create(root = path.join(os.homedir(), "obstat")) {
  const dir = (name) => {
    if (name !== "home" && !FOLDERS.includes(name)) throw new Error("Unknown folder.")
    return name === "home" ? root : path.join(root, name)
  }

  function ensure() {
    for (const f of FOLDERS) fs.mkdirSync(dir(f), { recursive: true })
  }

  function log(line) {
    try {
      fs.appendFileSync(path.join(dir("logs"), "obstat.log"), `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }

  // A path inside the logs folder, or an error; never anywhere else.
  function inLogs(rel) {
    const base = dir("logs")
    const file = path.resolve(base, String(rel || ""))
    if (!file.startsWith(base + path.sep)) throw new Error("That file isn't in the logs folder.")
    return file
  }

  async function listLogs() {
    const base = dir("logs"), out = []
    async function walk(d, depth) {
      for (const ent of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, ent.name)
        if (ent.isDirectory() && depth < 4) await walk(p, depth + 1)
        else if (ent.isFile()) out.push({ path: path.relative(base, p).split(path.sep).join("/"), size: (await fsp.stat(p)).size })
      }
    }
    await walk(base, 0)
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  // The last 256 KB of a log file, enough for the viewer without loading huge files.
  async function readLog(rel, max = 256 * 1024) {
    const file = inLogs(rel)
    const { size } = await fsp.stat(file)
    const fh = await fsp.open(file, "r")
    try {
      const start = Math.max(0, size - max)
      const buf = Buffer.alloc(size - start)
      await fh.read(buf, 0, buf.length, start)
      return { text: buf.toString("utf8"), truncated: start > 0, size }
    } finally {
      await fh.close()
    }
  }

  async function clearLogs() {
    await fsp.rm(dir("logs"), { recursive: true, force: true })
    ensure()
  }

  async function resetCache() {
    await fsp.rm(dir("cache"), { recursive: true, force: true })
    ensure()
  }

  async function size(d) {
    let total = 0
    for (const ent of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) total += await size(p)
      else if (ent.isFile()) total += (await fsp.stat(p)).size
    }
    return total
  }

  async function disk() {
    const used = {}
    for (const f of FOLDERS) used[f] = await size(dir(f))
    let free = null
    try {
      const s = await fsp.statfs(root)
      free = s.bavail * s.bsize
    } catch {}
    return { folder: root, used, free }
  }

  // Small settings the window keeps, like the name you chat under. Only known keys.
  const PREFS = { agentLink: (v) => typeof v === "boolean", terms: (v) => typeof v === "string" && v.length <= 20 }
  const prefsFile = path.join(root, "prefs.json")
  function prefs() {
    try { return JSON.parse(fs.readFileSync(prefsFile, "utf8")) || {} } catch { return {} }
  }
  function setPref(key, value) {
    if (!Object.hasOwn(PREFS, key) || !PREFS[key](value)) throw new Error("Unknown setting.")
    const next = { ...prefs(), [key]: value }
    fs.writeFileSync(prefsFile, JSON.stringify(next, null, 2))
    return next
  }

  return { root, dir, ensure, log, listLogs, readLog, clearLogs, resetCache, disk, prefs, setPref }
}

// Coding tools Obstat can hand an app's folder to, found on the PATH.
const TOOLS = [
  { id: "vscode", name: "VS Code", kind: "Editor", cmd: "code", url: "https://code.visualstudio.com" },
  { id: "cursor", name: "Cursor", kind: "Editor", cmd: "cursor", url: "https://cursor.com" },
  { id: "claude", name: "Claude Code", kind: "Terminal", cmd: "claude", url: "https://claude.com/claude-code" },
  { id: "codex", name: "OpenAI Codex", kind: "Terminal", cmd: "codex", url: "https://github.com/openai/codex" },
  { id: "gemini", name: "Gemini CLI", kind: "Terminal", cmd: "gemini", url: "https://github.com/google-gemini/gemini-cli" },
  { id: "git", name: "Git", kind: "Tool", cmd: "git", url: "https://git-scm.com" },
]

function which(cmd, platform = process.platform) {
  return new Promise((resolve) => {
    execFile(platform === "win32" ? "where" : "which", [cmd], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0].trim() || null)
    })
  })
}

async function findTools() {
  return Promise.all(TOOLS.map(async (t) => ({ ...t, found: await which(t.cmd) })))
}

module.exports = { create, findTools, TOOLS, FOLDERS }
