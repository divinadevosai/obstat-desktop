const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const http = require("node:http")
const netproxy = require("../lib/netproxy")

test("only public addresses: never this computer, the local network or cloud metadata", () => {
  for (const a of ["127.0.0.1", "127.8.9.1", "0.0.0.0", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1", "224.0.0.1", "not an ip"]) {
    assert.equal(netproxy.isPublic(a), false, a)
  }
  for (const a of ["140.82.112.3", "151.101.0.223", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) assert.equal(netproxy.isPublic(a), true, a)
})

// asks the proxy (on its Unix socket) for something, the way curl or pip would
function ask(sock, head) {
  return new Promise((resolve) => {
    const c = net.connect(sock)
    let got = ""
    c.on("data", (d) => { got += d; if (/\r\n\r\n/.test(got)) { c.destroy(); resolve(got) } })
    c.on("close", () => resolve(got))
    c.write(head)
  })
}

test("the proxy refuses anything on this computer or the local network, by address or by name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-net-"))
  const sock = path.join(dir, "out.sock")
  // a server on this computer the test would like to reach (another app's, say)
  const victim = http.createServer((q, r) => r.end("secret")).listen(0, "127.0.0.1")
  await new Promise((r) => victim.once("listening", r))
  const port = victim.address().port
  const logs = []
  // a name that points at this computer (DNS rebinding) is caught too
  const lookup = (name, _o, cb) => cb(null, name === "sneaky.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.5", family: 4 }])
  const server = netproxy.proxy(sock, { lookup, log: (l) => logs.push(l), env: {} })
  try {
    for (const head of [
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`,
      `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`,
      `CONNECT [::1]:${port} HTTP/1.1\r\n\r\n`,
      `CONNECT sneaky.example:${port} HTTP/1.1\r\n\r\n`,
      `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
      `GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n\r\n`,
      `CONNECT router.lan:80 HTTP/1.1\r\n\r\n`,
    ]) {
      const answer = await ask(sock, head)
      assert.match(answer, /^HTTP\/1\.1 403 /, head)
      assert.doesNotMatch(answer, /secret/)
    }
    assert.match(await ask(sock, "GET /relative HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 400 /)
    assert.match(await ask(sock, "GET https://example.com/ HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 400 /)
    assert.ok(logs.length >= 7)
  } finally {
    server.close(); victim.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("Obstat reaches the app's own port inside the test through in.sock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-net-"))
  // stands in for the app's server on the test's own localhost
  const app = http.createServer((q, r) => r.end(`app page ${q.url}`)).listen(0, "127.0.0.1")
  await new Promise((r) => app.once("listening", r))
  const { out, inn } = netproxy.inside({ outSock: path.join(dir, "out.sock"), inSock: path.join(dir, "in.sock"), proxyPort: 0 })
  await new Promise((r) => inn.once("listening", r))
  const fwd = await netproxy.forward(path.join(dir, "in.sock"), app.address().port)
  try {
    const res = await fetch(`http://127.0.0.1:${fwd.address().port}/hello`)
    assert.equal(await res.text(), "app page /hello")
  } finally {
    fwd.close(); out.close(); inn.close(); app.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("every program in a test is pointed at the proxy, except for its own localhost", () => {
  const env = netproxy.proxyEnv(47999)
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "npm_config_https_proxy"]) assert.equal(env[k], "http://127.0.0.1:47999")
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1")
  assert.equal(env.NODE_USE_ENV_PROXY, "1")
})
