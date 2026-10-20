const { test } = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const updates = require("../lib/updates")

test("a downloaded update waits for Restart, which stops the apps first", async () => {
  const up = new EventEmitter()
  const order = []
  up.checkForUpdates = async () => { up.emit("checking-for-update"); up.emit("update-available", { version: "0.1.40" }); up.emit("update-downloaded", { version: "0.1.40" }) }
  up.quitAndInstall = () => order.push("install")
  const seen = []
  const u = updates.create(up, { enabled: true, emit: (e) => seen.push(e.status), beforeInstall: () => order.push("stop apps") })
  assert.equal(u.install(), false)
  await u.check()
  assert.deepEqual(seen, ["checking", "downloading", "ready"])
  assert.equal(u.state().version, "0.1.40")
  assert.equal(u.install(), true)
  assert.deepEqual(order, ["stop apps", "install"])
})

test("running from source never checks for updates", async () => {
  const u = updates.create(null, { enabled: false })
  assert.equal((await u.check()).status, "off")
  assert.equal(u.install(), false)
})
