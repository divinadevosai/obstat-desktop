const { test } = require("node:test")
const assert = require("node:assert/strict")
const { appFromUrl, fromArgv } = require("../lib/deeplink")

test("obstat://app/owner/name opens that app", () => {
  assert.equal(appFromUrl("obstat://app/divinadevosai/plazai"), "divinadevosai/plazai")
  assert.equal(appFromUrl("obstat://app/pinokiofactory/LLaMA-Factory/"), "pinokiofactory/LLaMA-Factory", "Windows may add a slash")
  assert.equal(appFromUrl("obstat://app/a/b.c_d-e"), "a/b.c_d-e")
})

test("anything else is ignored", () => {
  for (const bad of [
    "obstat://app/owner", "obstat://app/a/b/c", "obstat://run/a/b", "obstat://app/a/..", "obstat://app/-a/b",
    "obstat://app/a/b%2F..%2Fc", "obstat://user@app/a/b", "https://app/a/b", "obstat://app/a/b c", "not a link", "",
  ]) assert.equal(appFromUrl(bad), null, bad)
})

test("the link is found among Windows' launch arguments", () => {
  assert.equal(fromArgv(["C:\\Obstat\\Obstat.exe", "--allow-file-access", "obstat://app/a/b"]), "a/b")
  assert.equal(fromArgv(["C:\\Obstat\\Obstat.exe"]), null)
  assert.equal(fromArgv(), null)
})
