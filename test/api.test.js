const { test } = require("node:test")
const assert = require("node:assert/strict")
const api = require("../lib/api")

const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body })

test("only https links to known sites open in the browser", () => {
  assert.ok(api.isSafeExternal("https://github.com/owner/repo"))
  assert.ok(api.isSafeExternal("https://swe3we.dev"))
  assert.ok(!api.isSafeExternal("http://github.com/owner/repo"))
  assert.ok(!api.isSafeExternal("https://github.com.evil.example/x"))
  assert.ok(!api.isSafeExternal("https://user@github.com/x"))
  assert.ok(!api.isSafeExternal("file:///C:/Windows/system32/calc.exe"))
  assert.ok(!api.isSafeExternal("not a url"))
})

test("list returns the reviewed apps", async () => {
  const repos = [{ id: "a/b", name: "b" }]
  assert.deepEqual(await api.list(reply(200, { repos })), repos)
  assert.deepEqual(await api.list(reply(200, {})), [])
})

test("errors carry the site's message", async () => {
  await assert.rejects(api.check("x/y", reply(404, { error: "Couldn't find that repo. It has to be public." })), /has to be public/)
  await assert.rejects(api.list(reply(500, null)), /Request failed \(500\)/)
  await assert.rejects(api.list(async () => { throw new TypeError("fetch failed") }), /Couldn't reach Obstat/)
})

test("check posts the trimmed url and rejects junk before any request", async () => {
  let sent
  const fetchImpl = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => ({ ready: true }) } }
  await api.check("  github.com/a/b  ", fetchImpl)
  assert.equal(sent.url, `${api.BASE}/api/repos/check`)
  assert.deepEqual(sent.body, { url: "github.com/a/b" })
  await assert.rejects(api.check("", fetchImpl), /Paste a GitHub repo/)
  await assert.rejects(api.check("x".repeat(301), fetchImpl), /Paste a GitHub repo/)
})
