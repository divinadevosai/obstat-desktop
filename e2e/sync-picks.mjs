// Copies the reviewed apps (id, commit, Obstat's own scripts and clone pins) from the Obstat
// site's list into picks.json, so the Windows test installs exactly what people get:
//   node e2e/sync-picks.mjs ../obstat/netlify/lib/picks.mjs
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const from = process.argv[2]
if (!from) { console.error("Usage: node e2e/sync-picks.mjs <path to obstat/netlify/lib/picks.mjs>"); process.exit(1) }
const { PICKS } = await import(pathToFileURL(path.resolve(from)).href)
const out = PICKS.map((p) => ({ id: p.id, sha: p.sha, ...(p.scripts ? { scripts: p.scripts } : {}), ...(p.clones ? { clones: p.clones } : {}) }))
const file = new URL("./picks.json", import.meta.url)
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
console.log(`Wrote ${out.length} apps to e2e/picks.json`)
