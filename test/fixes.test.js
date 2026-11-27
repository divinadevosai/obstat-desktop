// Fixes for reviewed apps (lib/fixes.js): version corrections handed to uv and pip as
// constraints, for one app at its reviewed commit only, and safe in a folder with a space.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { fileURLToPath } = require("node:url")
const fixes = require("../lib/fixes")

const RMBG = "a2c3a0d0f1618c74c115d3221eb665bab5e8df10"

test("a correction applies to its app at its reviewed commit, and nowhere else", () => {
  assert.deepEqual(fixes.forApp("pinokiofactory/RMBG-2-Studio", RMBG).map((f) => f.python), [["fastapi<0.164"]])
  assert.deepEqual(fixes.forApp("pinokiofactory/rmbg-2-studio", "0".repeat(40)), [], "a newer reviewed commit isn't held back")
  assert.deepEqual(fixes.forApp("someone/else", RMBG), [])
})

test("the constraints file is written in the app's folder, as a file:// address so a space in the path can't split it", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obstat fixes ")), "Sam Smith", "app")
  try {
    const env = fixes.env("pinokiofactory/rmbg-2-studio", RMBG, dir, { base: {} })
    assert.match(env.UV_CONSTRAINT, /^file:\/\/\S+$/, "no spaces")
    assert.equal(env.UV_CONSTRAINT, env.PIP_CONSTRAINT)
    const file = fileURLToPath(env.UV_CONSTRAINT)
    assert.equal(file, path.join(dir, fixes.FILE))
    assert.match(fs.readFileSync(file, "utf8"), /^fastapi<0\.164$/m)
    // the person's own constraints file is kept, ours added
    const mine = fixes.env("pinokiofactory/rmbg-2-studio", RMBG, dir, { base: { UV_CONSTRAINT: "/home/me/c.txt" } })
    assert.match(mine.UV_CONSTRAINT, /^\/home\/me\/c\.txt file:\/\//)
    // nothing applies: no settings, and an old file goes
    assert.deepEqual(fixes.env("pinokiofactory/rmbg-2-studio", "0".repeat(40), dir, { base: {} }), {})
    assert.equal(fs.existsSync(file), false)
    // only plain version rules reach the file
    const odd = fixes.env("a/b", null, dir, { base: {}, list: { "a/b": [{ python: ["numpy<2", "-r https://evil.example/req.txt", "--index-url x"] }] } })
    assert.equal(fs.readFileSync(fileURLToPath(odd.UV_CONSTRAINT), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).join("|"), "numpy<2")
  } finally { fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true }) }
})

// uv really honours it, from a folder with a space (where uv is installed: it is on a
// developer's machine; CI's real check is the RMBG-2-Studio app test)
let uv = null
try { uv = execFileSync(process.platform === "win32" ? "where" : "which", ["uv"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() || null } catch {}
test("uv picks a FastAPI that fits, given the correction", { skip: !uv && "uv isn't installed here", timeout: 120000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obstat fixes uv "))
  try {
    execFileSync(uv, ["venv", "-q", path.join(root, "env")])
    const env = fixes.env("pinokiofactory/rmbg-2-studio", RMBG, path.join(root, "app dir"), { base: {} })
    // uv prints its plan on stderr
    const r = require("node:child_process").spawnSync(uv, ["pip", "install", "--dry-run", "fastapi"], { env: { ...process.env, ...env, VIRTUAL_ENV: path.join(root, "env") }, encoding: "utf8" })
    const picked = /fastapi==([\d.]+)/.exec(`${r.stdout}\n${r.stderr}`)
    const v = (picked ? picked[1] : "").split(".").map(Number)
    assert.ok(v[0] === 0 && v[1] < 164, `picked ${picked && picked[1]}`)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
