const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const usageLib = require("../lib/usage")

const H = 3600000
const home = () => ({ root: fs.mkdtempSync(path.join(os.tmpdir(), "obstat-usage-")), log() {} })
// noon on a fixed day, so day boundaries are predictable
const NOON = new Date(2026, 9, 30, 12, 0, 0).getTime()

test("Insights counts the hours apps ran, split by day, with apps running now counted up to now", () => {
  const h = home()
  const u = usageLib.create(h, { now: () => NOON })
  // 2 h this morning, and a run from 23:00 yesterday to 01:00 today
  u.record({ id: "a/plazai", script: "start.js", at: NOON - 4 * H, end: NOON - 2 * H, ok: true })
  u.record({ id: "a/kokoro", script: "start.js", at: NOON - 13 * H, end: NOON - 11 * H, ok: true })
  // installs and sandbox tests are activity, not time used
  u.record({ id: "a/kokoro", script: "install.js", at: NOON - 30 * H, end: NOON - 29 * H, ok: true })
  u.record({ id: "b/evil", script: "install.js", area: "sandboxes", at: NOON - 5 * H, end: NOON - 5 * H + 1000, ok: false })
  const s = u.summary({ days: 7, live: [{ id: "a/plazai", since: NOON - H }] })
  assert.equal(s.hours, 5) // 2 + 2 + 1 still running
  assert.equal(s.perDay.length, 7)
  const today = s.perDay.at(-1), yesterday = s.perDay.at(-2)
  assert.equal(today.hours, 4) // 2 + 1 (past midnight) + 1 (running)
  assert.equal(yesterday.hours, 1)
  assert.deepEqual(s.byApp.map((a) => a.id), ["a/plazai", "a/kokoro"])
  assert.equal(s.installs, 1)
  assert.equal(s.recent[0].area, "sandboxes")
  assert.equal(s.recent[0].ok, false)
  assert.ok(!s.recent.some((r) => r.script === "start.js"), "starting an app isn't listed as activity")
})

test("Insights compares with the time before, and ignores bad lines", () => {
  const h = home()
  const u = usageLib.create(h, { now: () => NOON })
  u.record({ id: "x/y", script: "start.js", at: NOON - 9 * 24 * H, end: NOON - 9 * 24 * H + 3 * H })
  fs.appendFileSync(u.file, "not json\n{\"id\":1}\n")
  u.record({ id: "x/y", script: "start.js", at: NOON - 2 * H, end: NOON - H })
  const s = u.summary({ days: 7 })
  assert.equal(s.hours, 1)
  assert.equal(s.prevHours, 3)
  // runs that end before they start are refused
  u.record({ id: "x/y", script: "start.js", at: NOON, end: NOON - H })
  assert.equal(u.summary({ days: 7 }).hours, 1)
})

test("the usage file stays small: old runs go once it passes its size limit", () => {
  const h = home()
  let t = NOON
  const u = usageLib.create(h, { now: () => t })
  const old = JSON.stringify({ at: NOON - 200 * 24 * H, end: NOON - 200 * 24 * H + H, id: "o/ld", script: "start.js", area: "apps", ok: true }) + "\n"
  fs.writeFileSync(u.file, old.repeat(Math.ceil((2.1 * 1024 * 1024) / old.length)))
  u.record({ id: "n/ew", script: "start.js", at: t - H, end: t })
  const lines = fs.readFileSync(u.file, "utf8").trim().split("\n")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /n\/ew/)
})
