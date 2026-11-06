// Recipes: an Autopilot run that worked, kept as its exact steps, so it runs again in one
// click with no planner (no Claude, no Ollama, nothing to pay for, the same result every
// time). A recipe names which app and which action each step uses, what it was given
// (text and settings as they were, files as "the file you pick" or "what step N made"),
// and can be exported to a file and imported by someone else.
//
// Recipes from other people are data, checked here before Obstat keeps one: only app ids,
// action names, plain values and references to earlier steps, nothing that runs.
"use strict"
const fs = require("node:fs")
const path = require("node:path")

const VERSION = 1
const APP_ID = /^[\w.-]{1,100}\/[\w.-]{1,100}$/
const MAX_STEPS = 20, MAX_INPUTS = 40, MAX_FILES = 10

const str = (v, n) => String(v ?? "").slice(0, n)
const plain = (v) => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 20000)
const int = (v) => Number.isInteger(v) && v >= 0

// A recipe as Obstat keeps it, or an Error saying what's wrong with it.
function check(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("That isn't a recipe.")
  if (r.obstatRecipe !== VERSION) throw new Error("That isn't an Obstat recipe (or it's from a newer Obstat).")
  const name = str(r.name, 80).trim()
  if (!name) throw new Error("The recipe has no name.")
  const files = Array.isArray(r.files) ? r.files : []
  if (files.length > MAX_FILES) throw new Error("The recipe asks for too many files.")
  const steps = Array.isArray(r.steps) ? r.steps : []
  if (!steps.length || steps.length > MAX_STEPS) throw new Error("A recipe has 1 to 20 steps.")
  return {
    obstatRecipe: VERSION,
    name,
    about: str(r.about, 2000),
    files: files.map((f) => ({ label: str(f?.label, 120) || "a file" })),
    steps: steps.map((s, i) => {
      if (!s || typeof s !== "object") throw new Error(`Step ${i + 1} isn't readable.`)
      if (!APP_ID.test(String(s.app))) throw new Error(`Step ${i + 1} doesn't name an app.`)
      if (!/^\/[\w.-]{1,100}$/.test(String(s.action))) throw new Error(`Step ${i + 1} doesn't name an action.`)
      const inputs = Array.isArray(s.inputs) ? s.inputs : []
      if (inputs.length > MAX_INPUTS) throw new Error(`Step ${i + 1} has too many inputs.`)
      return {
        app: String(s.app).toLowerCase(),
        appName: str(s.appName, 80) || String(s.app),
        action: String(s.action),
        inputs: inputs.map((v, k) => {
          const label = str(v?.label, 120)
          if (v && typeof v === "object" && v.file) {
            const f = v.file
            if (int(f.input) && f.input < files.length) return { label, file: { input: f.input } }
            if (int(f.step) && f.step < i && int(f.output) && f.output < 20) return { label, file: { step: f.step, output: f.output } }
            throw new Error(`Step ${i + 1}, input ${k + 1}: its file isn't one you give or one an earlier step makes.`)
          }
          if (!v || typeof v !== "object" || !plain(v.value)) throw new Error(`Step ${i + 1}, input ${k + 1} isn't a plain value.`)
          return { label, value: v.value, ...(v.edit ? { edit: true } : {}) }
        }),
      }
    }),
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "recipe"

function create(home) {
  const dir = () => home.dir("recipes")
  const file = (id) => {
    if (!/^[a-z0-9-]{1,70}$/.test(String(id))) throw new Error("That isn't a recipe.")
    return path.join(dir(), `${id}.json`)
  }
  function list() {
    const out = []
    for (const n of fs.readdirSync(dir()).filter((n) => n.endsWith(".json")).sort()) {
      try { const j = JSON.parse(fs.readFileSync(path.join(dir(), n), "utf8")); out.push({ id: n.slice(0, -5), ...check(j), ...(j.imported === true ? { imported: true } : {}) }) } catch {}
    }
    return out
  }
  const get = (id) => { const j = JSON.parse(fs.readFileSync(file(id), "utf8")); return { id, ...check(j), ...(j.imported === true ? { imported: true } : {}) } }
  // keeps a recipe under a name of its own (never over another one). `imported`: from
  // someone else, so it's shown step by step before its first run.
  function save(recipe, { imported = false } = {}) {
    const r = { ...check(recipe), ...(imported ? { imported: true } : {}) }
    let id = slug(r.name), n = 2
    while (fs.existsSync(path.join(dir(), `${id}.json`))) id = `${slug(r.name)}-${n++}`
    fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify(r, null, 2))
    return { id, ...r }
  }
  const remove = (id) => fs.rmSync(file(id), { force: true })
  // from a file someone shared: at most 1 MB of JSON, checked like any other
  function importFile(p) {
    if (fs.statSync(p).size > 1 << 20) throw new Error("That file is too big to be a recipe.")
    let j
    try { j = JSON.parse(fs.readFileSync(p, "utf8")) } catch { throw new Error("That file isn't a recipe.") }
    return save(j, { imported: true })
  }
  // looked at and run once: no longer marked as someone else's
  function trust(id) {
    const f = file(id)
    const r = check(JSON.parse(fs.readFileSync(f, "utf8")))
    fs.writeFileSync(f, JSON.stringify(r, null, 2))
  }
  const exportText = (id) => { const { id: _, imported: __, ...r } = get(id); return JSON.stringify(r, null, 2) }
  return { list, get, save, remove, importFile, exportText, trust }
}

module.exports = { create, check, VERSION }
