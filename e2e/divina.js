// End-to-end check of Divina, included free with Obstat, on a real Windows PC,
// through lib/divina.js: download the pinned file, check it, install it silently,
// open Divina and see it keeps running, then remove it again.
//
//   node e2e/divina.js
"use strict"
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const homeLib = require("../lib/home")
const divinaLib = require("../lib/divina")

const t0 = Date.now()
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a)
const fail = (msg) => { console.error(`FAILED: ${msg}`); process.exit(1) }
const running = () => { try { return /Divina\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq Divina.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" })) } catch { return false } }

;(async () => {
  if (process.platform !== "win32") fail("this check is for Windows")
  const home = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-divina-"))); home.ensure()
  const divina = divinaLib.create(home, { log: say })
  if (!divina.status().available) fail("Divina isn't pinned")
  let last = -1
  const st = await divina.install((got, total) => { const p = Math.floor((got / total) * 4) * 25; if (p !== last) { last = p; say(`downloaded ${p}%`) } })
  say("status after install:", JSON.stringify(st))
  if (!st.installed || st.installedVersion !== divinaLib.DIVINA.version || st.busy) fail("not installed as expected")
  say("files:", fs.readdirSync(divina.dir()).join(", "))

  divina.open()
  await new Promise((r) => setTimeout(r, 20000))
  if (!running()) fail("Divina.exe didn't keep running after Open")
  say("Divina is running")
  execFileSync("taskkill", ["/IM", "Divina.exe", "/T", "/F"], { stdio: "ignore" })
  await new Promise((r) => setTimeout(r, 3000))

  const after = await divina.remove()
  if (after.installed || fs.existsSync(divina.dir())) fail("Remove left Divina behind")
  say("removed; Divina's data folder", fs.existsSync(path.join(process.env.APPDATA, "Divina")) ? "kept" : "was never made")
  say("OK")
})().catch((err) => fail(err.message))
