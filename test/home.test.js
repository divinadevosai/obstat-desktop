const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { create } = require("../lib/home")

const fresh = () => {
  const h = create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-")))
  h.ensure()
  return h
}

test("ensure makes the four folders", () => {
  const h = fresh()
  for (const f of ["apps", "sandboxes", "logs", "cache"]) assert.ok(fs.statSync(h.dir(f)).isDirectory())
  assert.throws(() => h.dir("../etc"), /Unknown folder/)
})

test("logs are listed and read, and nothing outside the logs folder is", async () => {
  const h = fresh()
  h.log("started")
  fs.mkdirSync(path.join(h.dir("logs"), "install"))
  fs.writeFileSync(path.join(h.dir("logs"), "install", "fluxgym.txt"), "step 1\n")
  fs.writeFileSync(path.join(h.root, "secret.txt"), "no")
  assert.deepEqual((await h.listLogs()).map((f) => f.path), ["install/fluxgym.txt", "obstat.log"])
  assert.match((await h.readLog("obstat.log")).text, /started/)
  await assert.rejects(h.readLog("../secret.txt"), /isn't in the logs folder/)
  await assert.rejects(h.readLog(path.join(h.root, "secret.txt")), /isn't in the logs folder/)
})

test("readLog keeps only the tail of a big file", async () => {
  const h = fresh()
  fs.writeFileSync(path.join(h.dir("logs"), "big.txt"), "a".repeat(100) + "END")
  const r = await h.readLog("big.txt", 10)
  assert.equal(r.text, "aaaaaaaEND")
  assert.equal(r.truncated, true)
})

test("disk adds up each folder; reset and clear empty them", async () => {
  const h = fresh()
  fs.writeFileSync(path.join(h.dir("cache"), "x.bin"), Buffer.alloc(1000))
  fs.writeFileSync(path.join(h.dir("logs"), "a.txt"), "hello")
  const d = await h.disk()
  assert.equal(d.used.cache, 1000)
  assert.equal(d.used.logs, 5)
  await h.resetCache()
  await h.clearLogs()
  const after = await h.disk()
  assert.equal(after.used.cache, 0)
  assert.equal(after.used.logs, 0)
})
