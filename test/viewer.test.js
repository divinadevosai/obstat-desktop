const { test } = require("node:test")
const assert = require("node:assert/strict")
const { reachable } = require("../lib/viewer")

test("apps that print 0.0.0.0 open at 127.0.0.1; other addresses stay as they are", () => {
  assert.equal(reachable("http://0.0.0.0:7860/"), "http://127.0.0.1:7860/")
  assert.equal(reachable("http://127.0.0.1:5173/"), "http://127.0.0.1:5173/")
  assert.equal(reachable("http://localhost:3000/chat?x=1"), "http://localhost:3000/chat?x=1")
})
