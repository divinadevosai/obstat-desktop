const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const home = require("../lib/home")
const keysLib = require("../lib/keys")
const { which } = require("../lib/env")

// stands in for safeStorage: reversible, but not plain text
const crypt = { available: () => true, encrypt: (s) => Buffer.from(s).reverse(), decrypt: (b) => Buffer.from(b).reverse().toString() }

test("keys are stored encrypted and only go to the apps they're shared with", () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const keys = keysLib.create(h, crypt)
  keys.add({ name: "openai_api_key", value: "sk-secret-1234", apps: ["*"] })
  keys.add({ name: "HF_TOKEN", value: "hf_abcd", apps: ["someone/flux"] })
  const file = fs.readFileSync(path.join(h.root, "keys.json"), "utf8")
  assert.ok(!file.includes("sk-secret") && !file.includes("hf_abcd"), "no plain text on disk")
  assert.deepEqual(keys.list().map((k) => [k.name, k.hint]), [["OPENAI_API_KEY", "1234"], ["HF_TOKEN", "abcd"]])
  assert.ok(keys.list().every((k) => !("value" in k)), "the window never gets values")
  assert.deepEqual(keys.envFor("someone/flux"), { OPENAI_API_KEY: "sk-secret-1234", HF_TOKEN: "hf_abcd" })
  assert.deepEqual(keys.envFor("other/app"), { OPENAI_API_KEY: "sk-secret-1234" })
  keys.add({ name: "HF_TOKEN", value: "hf_new1", apps: ["*"] })
  assert.equal(keys.list().filter((k) => k.name === "HF_TOKEN").length, 1, "same name replaces")
  keys.remove(keys.list()[0].id)
  assert.deepEqual(Object.keys(keys.envFor("x/y")), ["HF_TOKEN"])
})

test("bad keys are refused", () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const keys = keysLib.create(h, crypt)
  assert.throws(() => keys.add({ name: "PATH", value: "x", apps: ["*"] }), /used by Obstat/)
  assert.throws(() => keys.add({ name: "a b", value: "x", apps: ["*"] }), /OPENAI_API_KEY/)
  assert.throws(() => keys.add({ name: "TOKEN", value: "a\nb", apps: ["*"] }), /one line/)
  assert.throws(() => keys.add({ name: "TOKEN", value: "x", apps: [] }), /which apps/)
  assert.throws(() => keysLib.create(h, { ...crypt, available: () => false }).add({ name: "TOKEN", value: "x", apps: ["*"] }), /can't encrypt/)
})

test("which finds a command the way cmd.exe does", () => {
  const files = new Set(["C:\\obstat\\bin\\python\\python.exe", "C:\\Windows\\git.cmd"])
  const exists = (f) => files.has(f)
  const env = { Path: "C:\\obstat\\bin\\python;C:\\Windows", PATHEXT: ".EXE;.CMD" }
  assert.equal(which("python", env, "win32", exists), "C:\\obstat\\bin\\python\\python.exe")
  assert.equal(which("git", env, "win32", exists), "C:\\Windows\\git.cmd")
  assert.equal(which("node", env, "win32", exists), null)
  assert.equal(which("..\\evil", env, "win32", exists), null)
})
