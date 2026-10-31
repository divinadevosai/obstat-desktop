// Reviewed apps whose launcher clones another repo when it installs (most Pinokio
// launchers run `git clone https://github.com/<author>/<app> app`) would otherwise get
// that repo's newest commit, which nobody reviewed. The Obstat list gives each
// reviewed app its pins: for every repo it may clone, the commit that was reviewed
//   { "https://github.com/IAHispano/Applio": "5171e1d…" }
// or, when the launcher also checks out a branch, one commit per branch name
//   { "https://github.com/x/y": { "HEAD": "c9ff851…", "mac-os-fix": "882222d…" } }
// With pins (even none: {}), the git steps of a reviewed app's scripts are rewritten
// before they run, and anything they can't be held to stops the step:
//   git clone URL [DIR]     clone, then check out the pinned commit (or, when DIR is
//                           already there from an earlier install, fetch and check it out)
//   git pull                in a pinned clone: go to its pinned commit instead
//                           in the app's own folder: skipped (Obstat updates it to its
//                           reviewed commit itself)
//   git checkout REF        in a pinned clone: the commit pinned for REF
// A clone of a repo that has no pin, or any other way of fetching code with git
// that can't be checked, stops the install.
"use strict"
const fs = require("node:fs")
const path = require("node:path")

const SHA = /^[0-9a-f]{40}$/
const REF = /^[\w.][\w./-]{0,99}$/

// "https://github.com/Owner/Repo.git/" -> "https://github.com/owner/repo"
function repoKey(url) {
  const m = /^(?:https:\/\/|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || "").trim())
  return m ? `https://github.com/${m[1]}/${m[2]}`.toLowerCase() : null
}

// Pins as the list sends them, checked: null when they aren't valid (so nothing is enforced
// from a malformed entry), or { [repoKey]: { HEAD: sha, [branch]: sha } }.
function clean(pins) {
  if (!pins || typeof pins !== "object" || Array.isArray(pins)) return null
  const out = {}
  const entries = Object.entries(pins)
  if (entries.length > 20) return null
  for (const [url, v] of entries) {
    const key = repoKey(url)
    if (!key) return null
    const refs = typeof v === "string" ? { HEAD: v } : v
    if (!refs || typeof refs !== "object" || Array.isArray(refs) || !SHA.test(String(refs.HEAD))) return null
    out[key] = {}
    for (const [ref, sha] of Object.entries(refs)) {
      if (!(ref === "HEAD" || REF.test(ref)) || !SHA.test(String(sha))) return null
      out[key][ref] = sha
    }
  }
  return out
}

// Splits a command line into words, keeping "quoted words" together. null if it has
// anything a shell would treat specially (pipes, &&, redirection, variables).
function words(line) {
  if (/[|&;<>`$()]/.test(line)) return null
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

// The origin of the git repo in a folder, read from its config (no git needed).
function originOf(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8")
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg)
    return m ? m[1] : null
  } catch { return null }
}

const q = (s) => `"${s}"`
const goTo = (dir, url, sha) => [
  `git -C ${q(dir)} fetch -q ${url} ${sha}`,
  `git -C ${q(dir)} -c advice.detachedHead=false checkout -q --detach ${sha}`,
]

class PinError extends Error {}

// Rewrites one shell step's lines. cwd: the folder the step runs in; appDir: the app's
// own folder. Returns the new lines and notes for the log.
function apply(lines, { cwd, appDir, pins }) {
  const out = [], notes = []
  for (const line of lines) {
    if (!/\bgit\b/.test(line)) { out.push(line); continue }
    const w = words(line.trim())
    const git = w && w[0] === "git" ? w : null
    const cmd = git ? git[1] : null
    if (!git || !["clone", "pull", "checkout", "fetch", "reset", "submodule", "status", "log", "config", "lfs"].includes(cmd)) {
      // a git command Obstat can't follow (inside a longer command, or another kind)
      if (/\bgit\s+(clone|pull|fetch|checkout|switch|reset|merge|rebase)\b/.test(line)) throw new PinError(`This app runs "${line.trim()}", and Obstat can't check that it stays on the reviewed code, so it stopped.`)
      out.push(line); continue
    }
    if (cmd === "clone") {
      const args = git.slice(2)
      const pos = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === "--depth" || a === "-b" || a === "--branch") { i++; continue } // pinned clones are full and on the pinned commit
        if (a.startsWith("-")) continue
        pos.push(a)
      }
      const [url, dirArg] = pos
      const key = repoKey(url)
      const pin = key && pins[key]
      if (!pin) throw new PinError(`This app clones ${url || "a repo"}, which wasn't part of its review, so Obstat stopped. Its reviewed version will come with the next review.`)
      const dir = dirArg || key.split("/").pop()
      const abs = path.resolve(cwd, dir)
      if (!abs.startsWith(appDir + path.sep) && abs !== appDir) throw new PinError(`This app clones into ${dir}, outside its own folder, so Obstat stopped.`)
      if (fs.existsSync(path.join(abs, ".git"))) {
        out.push(...goTo(dir, key, pin.HEAD))
        notes.push(`(${dir} is already there: Obstat moves it to the reviewed commit ${pin.HEAD.slice(0, 7)}.)`)
      } else {
        out.push(`git clone ${key} ${q(dir)}`, `git -C ${q(dir)} -c advice.detachedHead=false checkout -q --detach ${pin.HEAD}`)
        notes.push(`(Obstat installs ${key.replace("https://github.com/", "")} at the reviewed commit ${pin.HEAD.slice(0, 7)}.)`)
      }
      continue
    }
    // the other commands act on the repo in cwd (Obstat's scripts don't use -C)
    const origin = repoKey(originOf(cwd))
    const pin = origin && pins[origin]
    if (cmd === "pull") {
      if (path.resolve(cwd) === path.resolve(appDir)) { notes.push("(Skipped git pull: Obstat updates this app to its newest reviewed version itself.)"); continue }
      if (!pin) throw new PinError(`This app pulls new code into ${path.relative(appDir, cwd) || "its folder"}, which wasn't part of its review, so Obstat stopped.`)
      out.push(...goTo(".", origin, pin.HEAD))
      notes.push(`(Instead of git pull, Obstat keeps ${origin.replace("https://github.com/", "")} at the reviewed commit ${pin.HEAD.slice(0, 7)}.)`)
      continue
    }
    if (cmd === "checkout" || cmd === "fetch" || cmd === "submodule") {
      // submodules are named by commit in the pinned commit itself
      if (cmd === "submodule") { out.push(line); continue }
      if (!pin) throw new PinError(`This app runs "${line.trim()}" in a folder Obstat didn't pin, so it stopped.`)
      if (cmd === "fetch") { notes.push("(Skipped git fetch: this app stays on its reviewed commit.)"); continue }
      const ref = git.slice(2).filter((a) => !a.startsWith("-"))
      if (ref.length !== 1 || !Object.hasOwn(pin, ref[0])) throw new PinError(`This app checks out "${ref.join(" ")}", which wasn't part of its review, so Obstat stopped.`)
      out.push(...goTo(".", origin, pin[ref[0]]))
      notes.push(`(Obstat checks out ${ref[0]} at its reviewed commit ${pin[ref[0]].slice(0, 7)}.)`)
      continue
    }
    if (cmd === "reset" && !git.slice(2).some((a) => /^(origin\/|FETCH_HEAD|@\{u\})/.test(a))) { out.push(line); continue }
    if (cmd === "reset") throw new PinError(`This app runs "${line.trim()}", which could move it off the reviewed code, so Obstat stopped.`)
    out.push(line) // status, log, config, lfs: nothing new from the internet beyond what the commit names
  }
  return { lines: out, notes }
}

module.exports = { apply, clean, repoKey, words, PinError }
