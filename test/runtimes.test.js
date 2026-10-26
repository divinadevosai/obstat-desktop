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

test("ffmpeg is only downloaded when an app asks for it", async () => {
  const { create: make } = require("../lib/runtimes")
  const fetched = []
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-rt-"))
  const home = { root, dir: (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d } }
  const r = make(home, { platform: "win32", fetchImpl: async (url) => { fetched.push(url); throw new Error("offline") } })
  await assert.rejects(r.ensureAll(() => {}))
  assert.equal(fetched.some((u) => /ffmpeg/.test(u)), false)
  await assert.rejects(r.ensure("ffmpeg"))
  assert.equal(fetched.some((u) => /codexffmpeg\/releases\/download\/7\.1\//.test(u)), true)
  assert.equal(r.status().ffmpeg.needed, false)
})

test("two runs that need the same runtime share one download", async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const buf = fakeArchive()
  const spec = runtimes.RUNTIMES.python.linux
  const saved = { ...spec }
  Object.assign(spec, { sha256: crypto.createHash("sha256").update(buf).digest("hex") })
  try {
    let fetches = 0
    const r = runtimes.create(h, { fetchImpl: async () => { fetches++; return serve(buf)() }, platform: "linux" })
    const seen = [0, 0]
    await Promise.all([r.ensure("python", (_n, got) => { seen[0] = got }), r.ensure("python", (_n, got) => { seen[1] = got })])
    assert.equal(fetches, 1)
    assert.deepEqual(seen, [buf.length, buf.length])
    assert.equal(r.status().python.ready, true)
  } finally {
    Object.assign(spec, saved)
  }
})

test("Macs get the build for their chip, and Linux on ARM uses the PC's own", () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-")))
  const urls = (opts) => { const r = runtimes.create(h, opts); return Object.keys(runtimes.RUNTIMES).map((n) => r.status()[n].needed && n) }
  const pick = (platform, arch, name) => {
    const all = runtimes.RUNTIMES[name]
    return all[`${platform}-${arch}`] || all[platform]
  }
  assert.match(pick("darwin", "arm64", "python").url, /aarch64-apple-darwin/)
  assert.match(pick("darwin", "x64", "python").url, /x86_64-apple-darwin/)
  assert.match(pick("darwin", "arm64", "node").url, /darwin-arm64/)
  assert.match(pick("darwin", "x64", "uv").url, /x86_64-apple-darwin/)
  for (const s of ["darwin-arm64", "darwin-x64"]) for (const n of ["python", "node", "uv"]) assert.match(runtimes.RUNTIMES[n][s].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(urls({ platform: "darwin", arch: "arm64" }), ["python", "node", "uv", false, false])
  // Linux on ARM: no x64 downloads, so apps use the system's python3 and node
  const arm = runtimes.create(h, { platform: "linux", arch: "arm64" })
  assert.deepEqual(urls({ platform: "linux", arch: "arm64" }), [false, false, false, false, false])
  assert.equal(arm.python(), "python3")
  // Windows on ARM runs the x64 builds
  assert.equal(runtimes.create(h, { platform: "win32", arch: "arm64" }).status().python.needed, true)
})
