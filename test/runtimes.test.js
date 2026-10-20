const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const home = require("../lib/home")
const runtimes = require("../lib/runtimes")

// A tiny tar.gz standing in for the Python download
function fakeArchive() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "src-"))
  fs.mkdirSync(path.join(src, "python", "bin"), { recursive: true })
  fs.writeFileSync(path.join(src, "python", "bin", "python3"), "#!/bin/sh\necho fake\n")
  const file = path.join(src, "py.tar.gz")
  execFileSync("tar", ["-czf", file, "-C", src, "python"])
  return fs.readFileSync(file)
}

const serve = (buf) => async () => new Response(buf, { headers: { "content-length": String(buf.length) } })

test("a runtime is downloaded, checked, unpacked and put on PATH", async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const buf = fakeArchive()
  const spec = runtimes.RUNTIMES.python.linux
  const saved = { ...spec }
  Object.assign(spec, { sha256: crypto.createHash("sha256").update(buf).digest("hex") })
  try {
    const r = runtimes.create(h, { fetchImpl: serve(buf), platform: "linux" })
    assert.equal(r.status().python.ready, false)
    let progress = 0
    await r.ensure("python", (_n, got) => { progress = got })
    assert.equal(progress, buf.length)
    assert.equal(r.status().python.ready, true)
    assert.ok(r.paths().some((p) => p.endsWith(path.join("python-3.11.10", "python", "bin"))))
    assert.equal(fs.readdirSync(h.dir("cache")).length, 0)
  } finally {
    Object.assign(spec, saved)
  }
})

test("a download with the wrong checksum is thrown away", async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const r = runtimes.create(h, { fetchImpl: serve(Buffer.from("tampered")), platform: "linux" })
  await assert.rejects(r.ensure("python"), /didn't match its checksum/)
  assert.equal(r.status().python.ready, false)
  assert.equal(fs.readdirSync(h.dir("cache")).length, 0)
})

test("git isn't downloaded on Linux", () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-")))
  const r = runtimes.create(h, { platform: "linux" })
  assert.deepEqual(r.status().git, { version: "2.47.0", needed: false, ready: true })
})
