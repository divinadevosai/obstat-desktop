// Fixes for reviewed apps that break on their own. A reviewed app is held to the commit
// that was reviewed, but its Python packages aren't: when a package it doesn't pin
// releases a version that doesn't fit one it does, the app's install still finishes and
// the app crashes on start. Obstat keeps a short list of corrections here, each for one
// app at its reviewed commit, and hands them to the installers as constraints
// (UV_CONSTRAINT for uv, PIP_CONSTRAINT for pip): they only ever narrow which versions
// may be picked, never add a package or change the app's own steps.
//
// Remove a fix when the app's reviewed commit moves past the bug (it then no longer
// applies anyway: each fix names the commit it's for).
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const FIXES = {
  // RMBG-2-Studio pins starlette==0.52.1 but not FastAPI; FastAPI 0.164 (18 Nov 2026)
  // needs Starlette 1.6 and imports starlette.middleware.body_limit, so the app failed to
  // start ("cannot import name 'body_limit'"). FastAPI 0.163.2 works with 0.52.1.
  "pinokiofactory/rmbg-2-studio": [
    { commit: "a2c3a0d0f1618c74c115d3221eb665bab5e8df10", python: ["fastapi<0.164"], why: "FastAPI 0.164 needs a newer Starlette than the app pins" },
  ],
}

const FILE = ".obstat-constraints.txt"
const SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?\s*(==|!=|<=|>=|<|>|~=)\s*[A-Za-z0-9.*+!_-]+(\s*,\s*(==|!=|<=|>=|<|>|~=)\s*[A-Za-z0-9.*+!_-]+)*$/

// the corrections for an app at a commit: [{ python, why }]
function forApp(id, commit, list = FIXES) {
  return (list[String(id || "").toLowerCase()] || []).filter((f) => !f.commit || f.commit === commit)
}

// The installers' settings for an app, with its constraints file written into its folder
// (where a walled install can read it); {} when nothing applies. Any constraints file the
// person set themselves is kept: theirs is used and ours is added to it.
function env(id, commit, dir, { list = FIXES, base = process.env } = {}) {
  const lines = [...new Set(forApp(id, commit, list).flatMap((f) => f.python || []))].filter((s) => SPEC.test(s))
  const file = path.join(dir, FILE)
  if (!lines.length) { fs.rmSync(file, { force: true }); return {} }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `# Written by Obstat: version corrections for this reviewed app (lib/fixes.js)\n${lines.join("\n")}\n`)
  // uv and pip split these settings on spaces, and a home folder can have one
  // (C:\Users\Sam Smith): as a file:// address the path has none (%20), and both take it
  const url = pathToFileURL(file).href
  const theirs = (k) => (base[k] && !String(base[k]).includes(FILE) ? `${base[k]} ` : "")
  return { UV_CONSTRAINT: `${theirs("UV_CONSTRAINT")}${url}`, PIP_CONSTRAINT: `${theirs("PIP_CONSTRAINT")}${url}` }
}

module.exports = { env, forApp, FIXES, FILE }
