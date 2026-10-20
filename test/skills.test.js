const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

test("every library skill has valid frontmatter and is listed", () => {
  const dir = path.join(__dirname, "..", "skills")
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))
  const folders = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory())
  assert.deepEqual(index.map((s) => s.name).sort(), folders.sort())
  for (const s of index) {
    const md = fs.readFileSync(path.join(dir, s.name, "SKILL.md"), "utf8")
    const m = md.match(/^---\nname: (.+)\ndescription: (".*")\n---\n/)
    assert.ok(m, `${s.name} frontmatter`)
    assert.equal(m[1], s.name)
    assert.ok(JSON.parse(m[2]).length < 1024)
    assert.match(md, /control\.json/)
  }
})

test("installing copies the skill and the core skill into the agent's folder, and removing takes it out", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-skills-"))
  const prev = process.env.HOME; process.env.HOME = home; process.env.USERPROFILE = home
  try {
    delete require.cache[require.resolve("../lib/skills")]
    const skills = require("../lib/skills").create(path.join(__dirname, "..", "skills"))
    skills.install("obstat-image", "claude")
    assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "obstat-image", "SKILL.md")))
    assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "obstat", "SKILL.md")))
    const img = skills.list().find((s) => s.name === "obstat-image")
    assert.deepEqual(img.installed, { claude: "yes", codex: "no" })
    fs.appendFileSync(path.join(home, ".claude", "skills", "obstat-image", "SKILL.md"), "\nmine")
    assert.equal(skills.list().find((s) => s.name === "obstat-image").installed.claude, "changed")
    skills.remove("obstat-image", "claude")
    assert.equal(skills.list().find((s) => s.name === "obstat-image").installed.claude, "no")
    assert.throws(() => skills.install("../../etc", "claude"), /No such skill/)
    assert.throws(() => skills.install("obstat", "evil"), /No such agent/)
  } finally { process.env.HOME = prev }
})
