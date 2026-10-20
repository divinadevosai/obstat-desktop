// Obstat's skill library: SKILL.md files that teach AI agents to use Obstat
// apps. Installing one copies it into the agent's own skills folder, where
// Claude Code and Codex pick it up.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const AGENTS = {
  claude: { name: "Claude Code", dir: () => path.join(os.homedir(), ".claude", "skills") },
  codex: { name: "Codex", dir: () => path.join(os.homedir(), ".codex", "skills") },
}

function create(libraryDir) {
  const catalog = () => JSON.parse(fs.readFileSync(path.join(libraryDir, "index.json"), "utf8"))
  const find = (name) => {
    const s = catalog().find((x) => x.name === name)
    if (!s) throw new Error("No such skill.")
    return s
  }
  const agent = (id) => {
    if (!Object.hasOwn(AGENTS, id)) throw new Error("No such agent.")
    return AGENTS[id]
  }
  const source = (name) => fs.readFileSync(path.join(libraryDir, name, "SKILL.md"), "utf8")
  const target = (id, name) => path.join(agent(id).dir(), name, "SKILL.md")

  function list() {
    return catalog().map((s) => {
      const src = source(s.name)
      const installed = {}
      for (const id of Object.keys(AGENTS)) {
        let cur = null
        try { cur = fs.readFileSync(target(id, s.name), "utf8") } catch {}
        installed[id] = cur === null ? "no" : cur === src ? "yes" : "changed"
      }
      return { ...s, installed }
    })
  }

  // The core skill comes along with any other, since they all use it.
  function install(name, id) {
    const names = [...new Set([...catalog().filter((x) => x.core).map((x) => x.name), find(name).name])]
    for (const n of names) {
      fs.mkdirSync(path.dirname(target(id, n)), { recursive: true })
      fs.writeFileSync(target(id, n), source(n))
    }
    return list()
  }

  function remove(name, id) {
    find(name)
    fs.rmSync(path.dirname(target(id, name)), { recursive: true, force: true })
    return list()
  }

  const agents = () => Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name, folder: a.dir(), present: fs.existsSync(path.dirname(a.dir())) }))
  const read = (name) => source(find(name).name)
  return { list, install, remove, agents, read }
}

module.exports = { create, AGENTS }
