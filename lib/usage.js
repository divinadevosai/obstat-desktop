// Insights: what Obstat's apps did, kept on this computer only and never sent
// anywhere. One line per finished run in ~/obstat/usage.jsonl:
//   { at, end, id, script, area, ok }
// at and end are times in ms; area is "apps" for installed apps, "sandboxes" for tests.
// Runs older than KEEP_DAYS are dropped when the file is tidied.
"use strict"
const fs = require("node:fs")
const path = require("node:path")

const KEEP_DAYS = 120
const MAX_BYTES = 2 * 1024 * 1024
const DAY = 86400000

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }

function create(home, { now = () => Date.now() } = {}) {
  const file = path.join(home.root, "usage.jsonl")

  function readAll() {
    let text
    try { text = fs.readFileSync(file, "utf8") } catch { return [] }
    const out = []
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const r = JSON.parse(line)
        if (Number.isFinite(r.at) && Number.isFinite(r.end) && r.end >= r.at && typeof r.id === "string") out.push(r)
      } catch {}
    }
    return out
  }

  // keeps the file small: drops runs older than KEEP_DAYS once it passes MAX_BYTES
  function tidy() {
    let size = 0
    try { size = fs.statSync(file).size } catch { return }
    if (size < MAX_BYTES) return
    const keep = readAll().filter((r) => r.end > now() - KEEP_DAYS * DAY).slice(-5000)
    fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""))
  }

  function record({ id, script, area = "apps", at, end = now(), ok = null }) {
    if (typeof id !== "string" || !Number.isFinite(at) || end < at) return
    const line = JSON.stringify({ at, end, id, script: String(script || ""), area: String(area), ok: ok === null ? null : !!ok })
    try { fs.appendFileSync(file, line + "\n"); tidy() } catch (err) { home.log?.(`usage: ${err.message}`) }
  }

  // Hours apps were running over the last `days` days (started apps only, with the
  // ones running now counted up to now), most used, and what happened lately.
  // `live`: [{ id, since }] for apps running right now.
  function summary({ days = 30, live = [] } = {}) {
    const t = now()
    const from = startOfDay(t) - (days - 1) * DAY
    const prevFrom = from - days * DAY
    const runs = readAll()
    const usageRuns = [...runs.filter((r) => r.area === "apps" && r.script === "start.js"),
      ...live.filter((l) => Number.isFinite(l.since)).map((l) => ({ id: l.id, at: l.since, end: t, area: "apps", script: "start.js" }))]
    // hours per day, split across midnights
    const perDay = new Map()
    for (let d = 0; d < days; d++) perDay.set(dayKey(from + d * DAY + DAY / 2), 0)
    const perApp = new Map()
    let hours = 0
    let prevHours = 0
    for (const r of usageRuns) {
      const a = Math.max(r.at, prevFrom)
      if (r.end <= a) continue
      for (let s = a; s < r.end;) {
        const e = Math.min(r.end, startOfDay(s) + DAY)
        const h = (e - s) / 3600000
        if (s >= from) {
          const k = dayKey(s)
          if (perDay.has(k)) perDay.set(k, perDay.get(k) + h)
          perApp.set(r.id, (perApp.get(r.id) || 0) + h)
          hours += h
        } else prevHours += h
        s = e
      }
    }
    // to the minute, so a short run doesn't show as 0
    const round = (h) => Math.round(h * 60) / 60
    const recent = runs.filter((r) => r.script !== "start.js" || r.area === "sandboxes")
      .sort((x, y) => y.end - x.end).slice(0, 8)
      .map((r) => ({ id: r.id, script: r.script, area: r.area, ok: r.ok, at: r.end }))
    const installs = runs.filter((r) => r.area === "apps" && r.script === "install.js" && r.ok && r.end >= from).length
    const first = usageRuns.reduce((m, r) => Math.min(m, r.at), Infinity)
    return {
      days,
      // when Obstat started counting (the first run it has), so the page can say so
      since: Number.isFinite(first) ? first : null,
      hours: round(hours),
      prevHours: round(prevHours),
      installs,
      perDay: [...perDay].map(([day, h]) => ({ day, hours: round(h) })),
      byApp: [...perApp].map(([id, h]) => ({ id, hours: round(h) })).sort((x, y) => y.hours - x.hours).slice(0, 6),
      recent,
    }
  }

  return { record, summary, file }
}

module.exports = { create, KEEP_DAYS }
