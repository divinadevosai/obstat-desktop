const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { create: createHome } = require("../lib/home")
const control = require("../lib/control")

// raw requests, so the test can send any Host and Origin
const req = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) }))
  })
  r.on("error", reject); r.end()
})

test("the control link needs its token, refuses web pages, and starts and stops apps", async () => {
  const home = createHome(fs.mkdtempSync(path.join(os.tmpdir(), "obstat-ctl-")))
  home.ensure()
  const state = { running: false }
  const apps = {
    list: () => [{ id: "a/img", name: "img", description: "", installed: true, running: state.running ? { url: "http://127.0.0.1:7860" } : null }],
    run: async () => { state.running = true },
    stop: async () => { state.running = false },
    appDir: (id) => path.join(home.root, "apps", id.replace("/", "-")),
  }
  const ctl = control.create(home, apps)
  const st = await ctl.start()
  const { url, token } = JSON.parse(fs.readFileSync(st.file, "utf8"))
  const port = Number(new URL(url).port)
  const auth = { authorization: `Bearer ${token}` }
  try {
    assert.equal((await req(port, "GET", "/apps")).status, 401)
    assert.equal((await req(port, "GET", "/apps", { authorization: "Bearer nope" })).status, 401)
    assert.equal((await req(port, "GET", "/apps", { ...auth, origin: "https://evil.example" })).status, 403)
    assert.equal((await req(port, "GET", "/apps", { ...auth, host: "evil.example" })).status, 403)
    const list = await req(port, "GET", "/apps", auth)
    assert.deepEqual(list.body.apps.map((a) => [a.id, a.running]), [["a/img", false]])
    const started = await req(port, "POST", "/apps/a/img/start", auth)
    assert.equal(started.body.url, "http://127.0.0.1:7860")
    assert.equal((await req(port, "POST", "/apps/a/img/stop", auth)).status, 200)
    assert.equal(state.running, false)
    assert.equal((await req(port, "POST", "/apps/x/y/start", auth)).status, 404)
  } finally { ctl.stop() }
  assert.equal(fs.existsSync(st.file), false)
})
