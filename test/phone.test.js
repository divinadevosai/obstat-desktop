// Phone access (lib/phone.js): a paired phone talks to this computer over the network,
// every message sealed with its own key; it runs a recipe and an Autopilot job on real
// (stand-in) apps and gets the files back; and everything that should be refused is.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const nacl = require("tweetnacl")
const homeLib = require("../lib/home")
const autopilotLib = require("../lib/autopilot")
const recipesLib = require("../lib/recipes")
const phoneLib = require("../lib/phone")
const { fakeApp, TTS, FX } = require("./fake-gradio")

const IFACES = { eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }], tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }], lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }

async function setup({ remote = () => "192.168.1.30", claude = null } = {}) {
  const tts = await fakeApp(TTS, { generate_speech: ([text, voice]) => [{ makeFile: "/tmp/gradio/speech.wav", bytes: `RIFF ${voice} ${text}` }] })
  const fx = await fakeApp(FX, { add_echo: () => [{ makeFile: "/tmp/gradio/echo.wav", bytes: "RIFF echo" }] })
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-phone-"))); h.ensure()
  const url = (s) => `http://127.0.0.1:${s.address().port}`
  const list = [
    { id: "a/kokoro", name: "Kokoro TTS", installed: true, running: { url: url(tts) } },
    { id: "b/fx", name: "Echo FX", installed: true, running: { url: url(fx) } },
  ]
  let phone = null
  const planner = claude ? { MODEL: "m", plan: (o) => require("../lib/planner-claude").plan({ ...o, client: claude }) } : undefined
  const autopilot = autopilotLib.create({ home: h, keys: { envFor: () => (claude ? { AUTOPILOT_ANTHROPIC_KEY: "k" } : {}) }, ...(planner ? { plannerClaude: planner } : { plannerOllama: { models: async () => null } }), emit: (e) => phone?.event(e), apps: { list: () => list, ensureRunning: async (id) => list.find((a) => a.id === id).running.url } })
  const recipes = recipesLib.create(h)
  phone = phoneLib.create({ home: h, autopilot, recipes, version: "9.9.9", listenHost: "127.0.0.1", ifaces: IFACES, remoteOf: remote })
  return { tts, fx, h, recipes, phone, close: () => { phone.stop(); tts.close(); fx.close(); fs.rmSync(h.root, { recursive: true, force: true }) } }
}

// a phone, as app/phone/phone.js talks: { d, n, c } in, { n, c } out
function client(base, link) {
  const [id, k] = link.split("#")[1].split(".")
  const key = new Uint8Array(Buffer.from(k, "base64url"))
  async function raw(env) { return fetch(`${base}/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) }) }
  function envelope(op, args = {}, t = Date.now(), withKey = key) {
    const nonce = nacl.randomBytes(24)
    return { d: id, n: Buffer.from(nonce).toString("base64"), c: Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify({ t, op, args })), nonce, withKey)).toString("base64") }
  }
  async function call(op, args) {
    const res = await raw(envelope(op, args))
    if (res.status !== 200) return { status: res.status }
    const env = await res.json()
    const out = JSON.parse(Buffer.from(nacl.secretbox.open(new Uint8Array(Buffer.from(env.c, "base64")), new Uint8Array(Buffer.from(env.n, "base64")), key)).toString("utf8"))
    return out
  }
  return { id, key, call, raw, envelope }
}
const until = async (fn, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) } throw new Error("timed out") }

test("a paired phone runs a recipe on this computer and gets the file back, with a receipt naming it", async () => {
  const s = await setup()
  try {
    s.recipes.save({ obstatRecipe: 1, name: "Say it", steps: [{ app: "a/kokoro", appName: "Kokoro TTS", action: "/generate_speech", inputs: [{ label: "Text", value: "Hi", edit: true }, { label: "Voice", value: "af_heart" }] }] })
    await assert.rejects(s.phone.pair("x"), /Turn phone access on first/)
    const st = await s.phone.start()
    assert.equal(st.on, true)
    const paired = await s.phone.pair("Sam's phone")
    assert.match(paired.qr, /^data:image\/png;base64,/)
    assert.deepEqual(paired.links.map((l) => [l.kind, l.address]), [["home", "192.168.1.20"], ["tailscale", "100.101.102.103"]])
    assert.match(paired.links[0].url, new RegExp(`^http://192\\.168\\.1\\.20:${st.port}/#[\\w-]+\\.[\\w-]{43}$`))
    const phone = client(`http://127.0.0.1:${st.port}`, paired.links[0].url)

    // the page, and its script, are served; the key never is
    const page = await fetch(`http://127.0.0.1:${st.port}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/)
    assert.equal((await fetch(`http://127.0.0.1:${st.port}/nacl.js`)).status, 200)

    const hello = await phone.call("hello")
    assert.equal(hello.result.device, "Sam's phone")
    assert.equal(hello.result.computer, os.hostname())
    const list = (await phone.call("list")).result
    assert.deepEqual(list.recipes.map((r) => [r.name, r.text]), [["Say it", [{ key: "0.0", label: "Kokoro TTS: Text", value: "Hi" }]]])
    assert.equal(list.autopilot.ready, false)

    const id = s.recipes.list()[0].id
    assert.deepEqual((await phone.call("recipe", { id, text: { "0.0": "From the sofa" } })).result, { started: true })
    const events = []
    await until(async () => { const p = (await phone.call("progress", { since: events.length })).result; events.push(...p.events); return !p.running && events.some((e) => e.type === "done") })
    const made = events.find((e) => e.type === "file")
    assert.equal(made.name, "kokoro_tts-speech.wav")
    const file = (await phone.call("file", { path: made.path })).result
    assert.equal(Buffer.from(file.data, "base64").toString(), "RIFF af_heart From the sofa")
    assert.equal(file.type, "audio/wav")
    assert.match(events.find((e) => e.type === "receipt").summary, /couldn't look|No app connected/)
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(made.path), "receipt.json"), "utf8"))
    assert.deepEqual(receipt.askedBy, { phone: "Sam's phone" })
    assert.ok(s.phone.devices()[0].lastSeen)
    // once the phone's run is over, what's run at the computer isn't shown to it
    const next = events.length
    s.phone.event({ type: "start", dir: "/x", planner: "claude", model: "m", apps: [] })
    s.phone.event({ type: "say", text: "something asked at the computer" })
    assert.deepEqual((await phone.call("progress", { since: next })).result.events, [])
  } finally { s.close() }
})

test("a phone sends a file and asks Autopilot, which runs it through an app here", async () => {
  const claude = { seen: [], beta: { messages: { create: async (req) => {
    claude.seen.push(req)
    if (claude.seen.length === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "echo_fx__add_echo", input: { audio: /Files the user gave you: (\S+)/.exec(req.system)[1] } }] }
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Added the echo." }] }
  } } } }
  const s = await setup({ claude })
  try {
    const st = await s.phone.start()
    const phone = client(`http://127.0.0.1:${st.port}`, (await s.phone.pair("Phone")).links[0].url)
    const sent = (await phone.call("upload", { name: "voice memo.m4a", data: Buffer.from("RIFF memo").toString("base64") })).result.upload
    assert.match(sent, /^[0-9a-f]{12}-voice_memo\.m4a$/)
    await phone.call("autopilot", { goal: "Add an echo to my memo", files: [sent] })
    const events = []
    await until(async () => { const p = (await phone.call("progress", { since: events.length })).result; events.push(...p.events); return !p.running && events.some((e) => e.type === "done") })
    assert.match(s.fx.uploads[0], /RIFF memo/)
    assert.equal(events.find((e) => e.type === "done").text, "Added the echo.")
    // another phone's upload, or a made-up one, isn't usable
    assert.match((await phone.call("autopilot", { goal: "x", files: ["../../etc/passwd"] })).error, /isn't a file this phone sent/)
    assert.match((await phone.call("autopilot", { goal: "x", files: ["0123456789ab-nope.wav"] })).error, /is gone/)
  } finally { s.close() }
})

test("what a phone may not do is refused: replays, wrong keys, old messages, other networks, removed phones, files outside the runs", async () => {
  const s = await setup()
  try {
    const st = await s.phone.start()
    const paired = await s.phone.pair("Phone", { recipes: false, autopilot: true })
    const base = `http://127.0.0.1:${st.port}`
    const phone = client(base, paired.links[0].url)

    // the same sealed request twice: answered once
    const env = phone.envelope("hello")
    assert.equal((await phone.raw(env)).status, 200)
    assert.equal((await phone.raw(env)).status, 401)
    // a key that isn't this phone's
    assert.equal((await phone.raw(phone.envelope("hello", {}, Date.now(), nacl.randomBytes(32)))).status, 401)
    // a message from 10 minutes ago
    const old = await phone.raw(phone.envelope("hello", {}, Date.now() - 10 * 60000))
    const oldBody = await old.json()
    assert.match(JSON.parse(Buffer.from(nacl.secretbox.open(new Uint8Array(Buffer.from(oldBody.c, "base64")), new Uint8Array(Buffer.from(oldBody.n, "base64")), phone.key)).toString()).error, /clock is more than 5 minutes off/)
    // not allowed recipes
    assert.match((await phone.call("recipe", { id: "x" })).error, /isn't allowed to run recipes/)
    s.phone.allow(phone.id, { recipes: true, autopilot: false })
    assert.match((await phone.call("autopilot", { goal: "x" })).error, /isn't allowed to use Autopilot/)
    // files: only ones this phone's own runs made
    const secret = path.join(s.h.root, "keys.json")
    fs.writeFileSync(secret, "{}")
    assert.match((await phone.call("file", { path: secret })).error, /isn't something a run from this phone made/)
    assert.match((await phone.call("file", { path: path.join(s.h.dir("autopilot"), "..", "keys.json") })).error, /isn't something a run from this phone made/)
    const up = (await phone.call("upload", { name: "a.txt", data: Buffer.from("x").toString("base64") })).result.upload
    assert.match((await phone.call("file", { path: path.join(s.h.dir("autopilot"), "phone-inbox", phone.id, up) })).error, /isn't something a run from this phone made/)
    // a run started at the computer: its files aren't the phone's, and its events aren't shown to it
    const desk = path.join(s.h.dir("autopilot"), "2026-desk-run")
    fs.mkdirSync(desk, { recursive: true }); fs.writeFileSync(path.join(desk, "private.wav"), "x")
    s.phone.event({ type: "start", dir: desk, planner: "claude", model: "m", apps: [] })
    s.phone.event({ type: "file", file: path.join(desk, "private.wav"), app: "A" })
    assert.deepEqual((await phone.call("progress", { since: 0 })).result.events, [])
    assert.match((await phone.call("file", { path: path.join(desk, "private.wav") })).error, /isn't something a run from this phone made/)
    // the phone's uploads are cleared after a day
    const inboxFile = path.join(s.h.dir("autopilot"), "phone-inbox", phone.id, up)
    s.phone.tidyInbox(Date.now() + 2 * 86400000)
    assert.equal(fs.existsSync(inboxFile), false)
    assert.match((await phone.call("nope")).error, /doesn't know that request/)
    // removed: no longer opens
    s.phone.remove(phone.id)
    assert.equal((await phone.call("hello")).status, 401)
    // too many that don't open: that address waits
    for (let i = 0; i < 20; i++) await phone.raw(phone.envelope("hello"))
    assert.equal((await phone.raw(phone.envelope("hello"))).status, 429)
    // the key is kept off the page: the phone.json on disk has it, not the page
    assert.ok(!(await (await fetch(`${base}/`)).text()).includes(paired.links[0].url.split("#")[1]))
  } finally { s.close() }
})

test("only devices on a private network are answered, and the port stays the same", async () => {
  const s = await setup({ remote: () => "8.8.8.8" })
  try {
    const st = await s.phone.start()
    assert.equal((await fetch(`http://127.0.0.1:${st.port}/`)).status, 403)
    const port = st.port
    s.phone.stop()
    assert.equal((await s.phone.start()).port, port, "a paired phone's link keeps working after a restart")
  } finally { s.close() }
  // no home network: pairing says so, and keeps nothing
  const h = homeLib.create(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-phone-off-"))); h.ensure()
  try {
    const lonely = phoneLib.create({ home: h, autopilot: {}, recipes: {}, listenHost: "127.0.0.1", ifaces: { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } })
    await lonely.start()
    await assert.rejects(lonely.pair("x"), /isn't on a home network/)
    assert.deepEqual(lonely.devices(), [])
    lonely.stop()
  } finally { fs.rmSync(h.root, { recursive: true, force: true }) }
  for (const a of ["192.168.0.5", "10.0.0.2", "172.20.1.1", "100.64.0.1", "::ffff:192.168.1.2", "::1", "fd00::1"]) assert.equal(phoneLib.privateAddress(a), true, a)
  for (const a of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1", ""]) assert.equal(phoneLib.privateAddress(a), false, a)
  assert.deepEqual(phoneLib.addresses(IFACES).map((a) => a.kind), ["home", "tailscale"])
})

// The phone's page itself, in a real browser: pairs from the link, lists the recipe,
// runs it, and plays back the file. (Where Playwright's browser is installed.)
let playwright = null
try { playwright = require("playwright") } catch {}
test("the phone's page works in a real browser", { skip: !playwright && "no browser here" }, async () => {
  const s = await setup()
  const browser = await playwright.chromium.launch()
  try {
    s.recipes.save({ obstatRecipe: 1, name: "Say it", steps: [{ app: "a/kokoro", appName: "Kokoro TTS", action: "/generate_speech", inputs: [{ label: "Text", value: "Hi", edit: true }] }] })
    const st = await s.phone.start()
    const link = (await s.phone.pair("Test phone")).links[0].url.replace("192.168.1.20", "127.0.0.1")
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true })).newPage()
    const errors = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(link)
    await page.getByText(os.hostname()).waitFor()
    assert.equal(new URL(page.url()).hash, "", "the key is taken out of the address bar")
    await page.getByLabel("Kokoro TTS: Text").fill("Hello from my phone")
    await page.getByRole("button", { name: "Run" }).click()
    await page.getByRole("button", { name: /Get kokoro_tts-speech\.wav/ }).click()
    await page.locator("audio").waitFor()
    if (process.env.OBSTAT_SHOT) await page.screenshot({ path: process.env.OBSTAT_SHOT, fullPage: true })
    assert.match(await page.locator("#now").innerText(), /Made kokoro_tts-speech\.wav[\s\S]*Ran “Say it”/)
    assert.equal(await page.getByRole("button", { name: "Do it" }).isDisabled(), true, "Autopilot stays off when the computer has no planner")
    // reloading keeps the pairing (no key in the address any more)
    await page.reload()
    await page.getByText("Say it").first().waitFor()
    assert.deepEqual(errors, [])
  } finally { await browser.close(); s.close() }
})
