const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const home = require("../lib/home")
const divina = require("../lib/divina")

const URL_ = "https://raw.githubusercontent.com/divinadevosai/divina-releases/175e7dd6b8b40d8ec0eaa2163c8e9a2adae4908e/obstat/1.0.0/Divina-Obstat-Setup-1.0.0-x64.exe"
const installer = Buffer.from("pretend Divina installer")
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
const pinned = (over = {}) => ({ version: "1.0.0", site: "https://divinaos.site", win32: { url: URL_, sha256: sha(installer), size: installer.length, exe: "Divina.exe", uninstall: "Uninstall Divina.exe", node: "node/node.exe", server: "app/server.js", ...over } })
const serve = (buf, url) => async () => { const r = new Response(buf); if (url) Object.defineProperty(r, "url", { value: url }); return r }

function setup(opts = {}) {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const env = { LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "local-")) }
  const dir = path.join(env.LOCALAPPDATA, "Programs", "Divina")
  const ran = []
  // stands in for the NSIS installer and uninstaller
  const run = (file, args, _o, cb) => {
    ran.push({ file, args, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null })
    if (/Uninstall/.test(file)) fs.rmSync(path.join(dir, "Divina.exe"), { force: true })
    else if (!opts.installerFails) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "Divina.exe"), ""); fs.writeFileSync(path.join(dir, "Uninstall Divina.exe"), "") }
    cb(opts.installerFails ? Object.assign(new Error("x"), { code: 2 }) : null)
  }
  const d = divina.create(h, { platform: "win32", env, run, info: opts.info || pinned(), fetchImpl: opts.fetchImpl || serve(installer), pollMs: 1 })
  return { h, d, dir, ran }
}

test("Divina isn't offered until its checksum and size are pinned", async () => {
  const { d } = setup({ info: pinned({ sha256: null, size: null }) })
  assert.equal(d.status().available, false)
  await assert.rejects(d.install(), /isn't ready/)
})

test("the shipped entry is the official 1.0.0 file, pinned", () => {
  assert.equal(divina.DIVINA.win32.url, URL_)
  assert.ok(divina.okHost(divina.DIVINA.win32.url))
  assert.equal(divina.DIVINA.win32.sha256, "1bb4ebd487eadcdb3153931b0a5f86c863ceeb2510e2243aa317314da470e8f6")
  assert.equal(divina.DIVINA.win32.size, 36131135)
})

test("Divina downloads, passes its check, installs silently and is recorded", async () => {
  const { h, d, ran } = setup()
  assert.deepEqual([d.status().available, d.status().installed], [true, false])
  let seen = 0
  const st = await d.install((got) => { seen = got })
  assert.equal(seen, installer.length)
  assert.deepEqual(ran[0].args, ["/S"])
  assert.deepEqual(ran[0].bytes, installer)
  assert.equal(st.installed, true)
  assert.equal(st.installedVersion, "1.0.0")
  assert.equal(st.update, false)
  assert.equal(st.busy, null)
  assert.equal(fs.readdirSync(h.dir("cache")).length, 0)
})

test("a swapped file is thrown away and never run", async () => {
  const { h, d, ran } = setup({ fetchImpl: serve(Buffer.from("pretend Divina installeR")) })
  await assert.rejects(d.install(), /didn't match/)
  assert.equal(ran.length, 0)
  assert.equal(d.status().installed, false)
  assert.equal(fs.readdirSync(h.dir("cache")).length, 0)
})

test("a bigger file is stopped as soon as it passes the pinned size", async () => {
  const { d, ran } = setup({ fetchImpl: serve(Buffer.concat([installer, Buffer.alloc(1000)])) })
  await assert.rejects(d.install(), /didn't match/)
  assert.equal(ran.length, 0)
})

test("a download that ends up on another host is refused", async () => {
  const { d, ran } = setup({ fetchImpl: serve(installer, "https://evil.example/Divina.exe") })
  await assert.rejects(d.install(), /somewhere unexpected/)
  assert.equal(ran.length, 0)
  assert.equal(divina.okHost("http://github.com/x"), false)
  assert.equal(divina.okHost("https://release-assets.githubusercontent.com/x"), true)
})

test("an installer that fails is reported and not recorded", async () => {
  const { d } = setup({ installerFails: true })
  await assert.rejects(d.install(), /installer stopped/)
  assert.equal(d.status().installed, false)
})

test("a newer pinned version offers an update; Remove runs the uninstaller", async () => {
  const { h, d, dir, ran } = setup()
  await d.install()
  fs.writeFileSync(path.join(h.root, "divina.json"), JSON.stringify({ version: "0.9.0" }))
  assert.equal(d.status().update, true)
  const st = await d.remove()
  assert.equal(ran.at(-1).file, path.join(dir, "Uninstall Divina.exe"))
  assert.deepEqual(ran.at(-1).args, ["/S"])
  assert.equal(st.installed, false)
  assert.equal(fs.existsSync(dir), false)
})

test("Open starts Divina on its own, and needs it installed", async () => {
  const started = []
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const env = { LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "local-")) }
  const d = divina.create(h, { platform: "win32", env, info: pinned(), start: (file, args, o) => { started.push({ file, o }); return { on() {}, unref() {} } } })
  assert.throws(() => d.open(), /Install Divina first/)
  const dir = path.join(env.LOCALAPPDATA, "Programs", "Divina")
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "Divina.exe"), "")
  d.open()
  assert.equal(started[0].file, path.join(dir, "Divina.exe"))
  assert.equal(started[0].o.detached, true)
})

test("Divina's server starts on 127.0.0.1 inside Obstat, is reused, and stops", async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const env = { LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "local-")), APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "roam-")) }
  const dir = path.join(env.LOCALAPPDATA, "Programs", "Divina")
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "Divina.exe"), "")
  const { EventEmitter } = require("node:events")
  const started = []
  let up = new Set([47800]) // something that isn't Divina already holds 47800
  const fetchImpl = async (url) => {
    const port = Number(new URL(url).port)
    if (port === 47800) return new Response("{}")
    if (!up.has(port)) throw new TypeError("fetch failed")
    return new Response(JSON.stringify({ studioVoice: null }))
  }
  const start = (file, args, o) => {
    const c = Object.assign(new EventEmitter(), { pid: 4242, kill() { up.delete(Number(o.env.PORT)); this.emit("exit") } })
    started.push({ file, args, o })
    setTimeout(() => up.add(Number(o.env.PORT)), 5)
    return c
  }
  const d = divina.create(h, { platform: "win32", env, info: pinned(), fetchImpl, start, pollMs: 1 })
  const url = await d.serve()
  assert.equal(url, "http://127.0.0.1:47801")
  assert.equal(started[0].file, path.join(dir, "node", "node.exe"))
  assert.deepEqual(started[0].args, [path.join(dir, "app", "server.js")])
  assert.equal(started[0].o.env.HOSTNAME, "127.0.0.1")
  assert.equal(started[0].o.env.DIVINA_DATA_DIR, path.join(env.APPDATA, "Divina"))
  assert.equal(await d.serve(), url)
  assert.equal(started.length, 1)
  assert.equal(d.status().running, url)
  assert.equal(d.stop(), true)
  assert.equal(d.status().running, null)
  // Divina.exe already running its server: Obstat shows that one and starts nothing
  up.add(47802)
  const d2 = divina.create(h, { platform: "win32", env, info: pinned(), fetchImpl, start, pollMs: 1 })
  up.add(47801); assert.equal(await d2.serve(), "http://127.0.0.1:47801")
  assert.equal(started.length, 1)
})

test("a Divina server that dies while starting is reported", async () => {
  const h = home.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-"))); h.ensure()
  const env = { LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "local-")), APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "roam-")) }
  const dir = path.join(env.LOCALAPPDATA, "Programs", "Divina")
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "Divina.exe"), "")
  const { EventEmitter } = require("node:events")
  const start = () => { const c = Object.assign(new EventEmitter(), { kill() {} }); setTimeout(() => c.emit("exit", 1), 5); return c }
  const d = divina.create(h, { platform: "win32", env, info: pinned(), fetchImpl: async () => { throw new TypeError("fetch failed") }, start, pollMs: 1 })
  await assert.rejects(d.serve(), /stopped while starting/)
  assert.equal(d.status().running, null)
})
