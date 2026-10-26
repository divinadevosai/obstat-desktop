// The network for a Linux sandbox test. bubblewrap gives the test a network of its
// own with nothing in it but its own localhost, so it can't reach anything on this
// computer: other apps' servers (ComfyUI's custom nodes, Jupyter), the desktop's
// X11 socket, or Obstat. What it gets instead, over two Unix sockets in a folder
// only it and Obstat can see:
//   out.sock  an HTTP proxy (CONNECT for https, plain requests for http) to the
//             internet. Names are looked up here and connections only go to public
//             addresses: never this computer, the local network or cloud metadata.
//   in.sock   the way in (made by the worker inside): Obstat connects with a port
//             number and is piped to that port on the test's own localhost, so the
//             app's page still opens in Obstat (forward()).
const net = require("node:net")
const dns = require("node:dns")
const fs = require("node:fs")

// addresses a test may not reach through the proxy
const blocked = new net.BlockList()
for (const [a, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]]) blocked.addSubnet(a, bits, "ipv4")
for (const [a, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]]) blocked.addSubnet(a, bits, "ipv6")
function isPublic(address) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) // IPv4 written as IPv6
  if (v4) return !blocked.check(v4[1], "ipv4")
  const family = net.isIP(address)
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 ? !blocked.check(address, "ipv6") : false
}

const HEAD_LIMIT = 16 * 1024

// Reads an HTTP request head; resolves with it and whatever came after it.
function readHead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf("\r\n\r\n")
      if (end >= 0) { sock.off("data", onData); sock.pause(); resolve({ head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + 4) }) }
      else if (buf.length > HEAD_LIMIT) { sock.off("data", onData); reject(new Error("head too big")) }
    }
    sock.on("data", onData)
    sock.once("error", reject)
    sock.once("end", () => reject(new Error("closed")))
  })
}

// A public address for a host name, looked up here (so a name can't point at this
// computer later), or why not.
async function resolve(host, lookup) {
  const bare = host.replace(/^\[|\]$/g, "")
  const all = net.isIP(bare) ? [{ address: bare }] : await new Promise((ok, no) => lookup(bare, { all: true }, (e, list) => (e ? no(e) : ok(list))))
  const good = all.find((a) => isPublic(a.address))
  if (!good) throw Object.assign(new Error(`${host} is on this computer or the local network`), { status: 403 })
  return good.address
}

// The proxy this computer itself uses (as at many workplaces), for passing a
// checked request on: host and port, or null to connect directly.
function upstreamFor(env, https) {
  const raw = https ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy
  try { const u = new URL(raw); return u.protocol === "http:" ? { host: u.hostname, port: Number(u.port) || 80 } : null } catch { return null }
}

function proxy(sockPath, { lookup = dns.lookup, log = () => {}, env = process.env } = {}) {
  fs.rmSync(sockPath, { force: true })
  const server = net.createServer(async (client) => {
    client.on("error", () => {})
    let head, rest
    try { ({ head, rest } = await readHead(client)) } catch { return client.destroy() }
    const [line] = head.split("\r\n")
    const m = /^(\S+) (\S+) HTTP\/1\.[01]$/.exec(line)
    const refuse = (status, why) => { log(`blocked ${line.slice(0, 200)}: ${why}`); client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${why}\n`) }
    if (!m) return refuse(400, "not an HTTP request")
    let host, port, first
    if (m[1] === "CONNECT") {
      const t = /^(\[[0-9a-f:.]+\]|[^:\s]+):(\d{1,5})$/i.exec(m[2])
      if (!t) return refuse(400, "bad CONNECT target")
      host = t[1]; port = Number(t[2])
    } else {
      let u
      try { u = new URL(m[2]) } catch { return refuse(400, "only proxy requests (with a full http:// address) are served") }
      if (u.protocol !== "http:") return refuse(400, "only http:// here; https goes through CONNECT")
      host = u.hostname; port = Number(u.port) || 80
      // the request as the server expects it: its path, and no proxy headers
      const lines = head.split("\r\n").slice(1).filter((l) => !/^proxy-/i.test(l))
      first = Buffer.concat([Buffer.from(`${m[1]} ${u.pathname}${u.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`, "latin1"), rest])
    }
    if (!(port >= 1 && port <= 65535)) return refuse(400, "bad port")
    let address
    try { address = await resolve(host, lookup) } catch (err) { return refuse(err.status || 502, err.message) }
    // through this computer's own proxy when it has one (it gets the name, and is
    // asked for a tunnel even for http), else straight to the checked address
    const via = upstreamFor(env, true) || upstreamFor(env, false)
    const upstream = via ? net.connect(via) : net.connect({ host: address, port })
    upstream.on("error", () => { if (!client.destroyed) refuse(502, `couldn't connect to ${host}:${port}`) })
    const piped = () => {
      if (first) upstream.write(first)
      else { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (rest.length) upstream.write(rest) }
      client.pipe(upstream).pipe(client)
      client.resume()
    }
    upstream.once("connect", () => {
      if (!via) return piped()
      upstream.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      readHead(upstream).then(({ head: h, rest: r }) => {
        if (!/^HTTP\/1\.[01] 2\d\d/.test(h)) { upstream.destroy(); return refuse(502, `this computer's proxy refused ${host}:${port}`) }
        if (r.length) client.write(r)
        upstream.resume()
        piped()
      }, () => refuse(502, `this computer's proxy didn't answer for ${host}:${port}`))
    })
    client.on("close", () => upstream.destroy())
    upstream.on("close", () => client.destroy())
  })
  server.listen(sockPath)
  server.unref() // never what keeps Obstat running
  return server
}

// A port on this computer's localhost that leads to `port` on the test's own
// localhost, through in.sock. Resolves with the port here (the same one when free).
function forward(inSock, port) {
  const make = (listenOn) => new Promise((ok, no) => {
    const server = net.createServer((client) => {
      client.on("error", () => {})
      const inner = net.connect(inSock)
      inner.on("error", () => client.destroy())
      const hdr = Buffer.alloc(2); hdr.writeUInt16BE(port)
      inner.write(hdr)
      client.pipe(inner).pipe(client)
      client.on("close", () => inner.destroy()); inner.on("close", () => client.destroy())
    })
    server.once("error", no)
    server.listen(listenOn, "127.0.0.1", () => ok(server))
    server.unref()
  })
  return make(port).catch(() => make(0))
}

// Inside the sandbox (run by the worker): the proxy address shells use, piped to
// out.sock, and in.sock, which pipes Obstat's connections to the asked-for port.
function inside({ outSock, inSock, proxyPort }) {
  const pipeTo = (a, connect) => { a.on("error", () => {}); const b = connect(); b.on("error", () => a.destroy()); a.pipe(b).pipe(a); a.on("close", () => b.destroy()); b.on("close", () => a.destroy()) }
  const out = net.createServer((c) => pipeTo(c, () => net.connect(outSock))).listen(proxyPort, "127.0.0.1")
  fs.rmSync(inSock, { force: true })
  const inn = net.createServer((c) => {
    c.once("readable", function first() {
      const hdr = c.read(2)
      if (!hdr) return c.once("readable", first)
      pipeTo(c, () => net.connect(hdr.readUInt16BE(0), "127.0.0.1"))
    })
  }).listen(inSock)
  return { out, inn }
}

// the proxy settings every program in the test gets
const PROXY_PORT = 47999
const proxyEnv = (port = PROXY_PORT) => {
  const url = `http://127.0.0.1:${port}`
  const local = "localhost,127.0.0.1,::1"
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: local, no_proxy: local,
    npm_config_proxy: url, npm_config_https_proxy: url,
    // Node's own fetch uses them only when asked (Node 22.21 and later, and Obstat's worker)
    NODE_USE_ENV_PROXY: "1",
  }
}

module.exports = { proxy, forward, inside, proxyEnv, isPublic, PROXY_PORT }
