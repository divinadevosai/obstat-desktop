// Privacy receipts (lib/receipt.js): reading each system's open connections, keeping
// only the apps' own, and the receipt a run leaves behind.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const { spawn } = require("node:child_process")
const receipt = require("../lib/receipt")

test("addresses on this computer or the local network don't count as leaving it", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "192.168.0.9", "172.20.1.1", "169.254.1.1", "fe80::1%eth0", "0.0.0.0", "[::1]"]) assert.equal(receipt.isLocal(a), true, a)
  for (const a of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "160.79.104.10"]) assert.equal(receipt.isLocal(a), false, a)
  assert.deepEqual(receipt.splitAddr("[2001:db8::1]:443"), { address: "2001:db8::1", port: 443 })
  assert.deepEqual(receipt.procAddr("0100007F:1F90"), { address: "127.0.0.1", port: 8080 })
  assert.deepEqual(receipt.procAddr("0000000000000000FFFF000008080808:01BB"), { address: "8.8.8.8", port: 443 })
})

test("each system's list of connections is read", async () => {
  const win = await receipt.connections("win32", async () => "4242\t142.250.1.1\t443\tC:\\obstat\\apps\\a\\env\\python.exe\tpython app.py\r\nnot a line\r\n")
  assert.deepEqual(win.conns, [{ pid: 4242, address: "142.250.1.1", port: 443 }])
  assert.match(win.who[4242], /apps\\a\\env/)

  const mac = await receipt.connections("darwin", async (file) => (file === "lsof" ? "p77\nf5\nn10.0.0.2:5000->1.1.1.1:443\nn[::1]:1->[2001:db8::1]:80\n" : "   77 /Users/me/obstat/apps/a/env/bin/python app.py\n"))
  assert.deepEqual(mac.conns, [{ pid: 77, address: "1.1.1.1", port: 443 }, { pid: 77, address: "2001:db8::1", port: 80 }])
  assert.match(mac.who[77], /obstat\/apps\/a/)

  // Linux reads /proc: a made-up one here
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-proc-"))
  try {
    fs.mkdirSync(path.join(proc, "net"))
    fs.writeFileSync(path.join(proc, "net", "tcp"), "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0200000A:C350 08080808:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 555 1\n   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 556 1\n")
    fs.mkdirSync(path.join(proc, "900", "fd"), { recursive: true })
    fs.writeFileSync(path.join(proc, "900", "cmdline"), "/home/me/obstat/apps/a/env/bin/python\0app.py\0")
    fs.symlinkSync("socket:[555]", path.join(proc, "900", "fd", "3"))
    fs.symlinkSync("socket:[556]", path.join(proc, "900", "fd", "4"))
    const linux = await receipt.connections("linux", null, { proc })
    assert.deepEqual(linux.conns, [{ pid: 900, address: "8.8.8.8", port: 443 }], "only connections made, not ports listened on")
    assert.match(linux.who[900], /obstat\/apps\/a/)
    const none = await receipt.connections("linux", null, { proc, match: () => false })
    assert.deepEqual(none.conns, [])
  } finally { fs.rmSync(proc, { recursive: true, force: true }) }
})

test("only the apps' own processes count, and each place once", async () => {
  let n = 0
  const look = async () => {
    n++
    return {
      conns: [{ pid: 1, address: "8.8.8.8", port: 443 }, { pid: 1, address: "8.8.8.8", port: 443 }, { pid: 1, address: "127.0.0.1", port: 7860 }, { pid: 2, address: "9.9.9.9", port: 443 }, { pid: 3, address: "1.1.1.1", port: 53 }],
      who: { 1: "C:\\Users\\Me\\obstat\\apps\\kokoro\\env\\python.exe\n", 2: "\nC:\\Program Files\\Browser\\browser.exe", 3: "/home/me/obstat/apps/fx/env/bin/python\n" },
    }
  }
  const w = receipt.watch([{ id: "a/kokoro", name: "Kokoro", dir: "C:/Users/me/obstat/apps/kokoro" }, { id: "b/fx", name: "FX", dir: "/home/me/obstat/apps/fx/" }], { look, every: 5 })
  await new Promise((r) => setTimeout(r, 30))
  const got = await w.stop()
  assert.ok(got.looks >= 2 && got.looks === n)
  assert.deepEqual(got.connections.map((c) => [c.appName, c.address, c.port]), [["Kokoro", "8.8.8.8", 443], ["FX", "1.1.1.1", 53]])
})

test("on this computer, a real app process's connection is seen", async () => {
  // a stand-in app: a script in its own folder that connects and stays connected
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-receipt-app-"))
  const server = net.createServer((s) => s.on("error", () => {})).listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const script = path.join(dir, "app.js")
  fs.writeFileSync(script, `const s = require("node:net").connect(${server.address().port}, "127.0.0.1", () => process.stdout.write("up\\n")); s.on("error", () => {}); setTimeout(() => {}, 60000)\n`)
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })
  try {
    await new Promise((r) => child.stdout.once("data", r))
    // here "away" is anywhere, so the test needs no internet
    const w = receipt.watch([{ id: "t/app", name: "Stand-in", dir }], { every: 500, away: () => true })
    await new Promise((r) => setTimeout(r, 300))
    const got = await w.stop()
    assert.ok(got.looks >= 1, "the system said what's connected")
    assert.ok(got.connections.some((c) => c.port === server.address().port), `saw the stand-in's connection: ${JSON.stringify(got.connections)}`)
  } finally {
    child.kill()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("the receipt lists apps, steps, files with their hashes, the planner and the connections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-receipt-"))
  try {
    fs.mkdirSync(path.join(dir, "inputs"))
    const input = path.join(dir, "inputs", "in.wav"), output = path.join(dir, "out.wav")
    fs.writeFileSync(input, "in"); fs.writeFileSync(output, "out")
    const base = { dir, kind: "autopilot", goal: "x", planner: { kind: "claude", model: "m" }, apps: [{ id: "a/k", name: "K", commit: "abcdef123", reviewed: true }], steps: [{ app: "a/k", action: "/go", ok: true }], inputs: [input], outputs: [output], startedAt: "s", endedAt: "e", ok: true }
    const quiet = receipt.write({ ...base, network: { looks: 4, connections: [] } })
    assert.equal(quiet.summary, "No app connected to anything outside this computer while this ran.")
    assert.deepEqual(quiet.files.out[0], { name: "out.wav", bytes: 3, sha256: require("node:crypto").createHash("sha256").update("out").digest("hex") })
    assert.equal(quiet.planner.sentTo, "api.anthropic.com")
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8")).apps[0], { id: "a/k", name: "K", commit: "abcdef123", reviewed: true })

    const loud = receipt.write({ ...base, planner: { kind: "ollama", model: "qwen3" }, network: { looks: 4, connections: [{ app: "a/k", appName: "K", address: "8.8.8.8", port: 443 }] } })
    assert.match(loud.summary, /connected to 1 address outside/)
    assert.match(loud.planner.sent, /Nothing left this computer/)

    const blind = receipt.write({ ...base, network: { looks: 0, connections: [] } })
    assert.match(blind.summary, /couldn't look/)
    assert.equal(blind.network.couldNotLook, true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
