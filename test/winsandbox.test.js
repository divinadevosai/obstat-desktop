const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const winsandbox = require("../lib/winsandbox")

// a fake Windows: SystemRoot is a temp folder, and every command answers as told
function fake({ edition = "Professional", exit = 3010, stderr = "", sandboxExe = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-win-"))
  fs.mkdirSync(path.join(root, "System32"), { recursive: true })
  if (sandboxExe) fs.writeFileSync(path.join(root, "System32", "WindowsSandbox.exe"), "")
  const calls = []
  const run = (file, args, _opts, cb) => {
    calls.push(args.at(-1))
    const cmd = args.at(-1)
    if (/EditionID/.test(cmd)) return cb(null, `${edition}\r\n`, "")
    if (/Start-Process/.test(cmd)) return exit ? cb(Object.assign(new Error("exit"), { code: exit }), "", stderr) : cb(null, "", "")
    cb(null, "", "")
  }
  return { ws: winsandbox.create({ platform: "win32", run, env: { SystemRoot: root } }), calls }
}

test("Windows Pro can turn Windows Sandbox on; it asks for permission and needs a restart", async () => {
  const { ws, calls } = fake()
  assert.deepEqual(await ws.status(), { windows: true, on: false, canTurnOn: true, home: false, edition: "Professional" })
  assert.deepEqual(await ws.turnOn(), { ok: true, restart: true })
  const cmd = calls.at(-1)
  assert.match(cmd, /-Verb RunAs/, "Windows' permission prompt")
  // the elevated script turns on exactly the Windows Sandbox feature, nothing else
  const b64 = cmd.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1]
  assert.equal(Buffer.from(b64, "base64").toString("utf16le"), winsandbox.ENABLE)
  assert.match(winsandbox.ENABLE, /-FeatureName Containers-DisposableClientVM /)
})

test("Windows Home can't have it, and it's never tried there", async () => {
  const { ws, calls } = fake({ edition: "CoreSingleLanguage" })
  const st = await ws.status()
  assert.equal(st.canTurnOn, false)
  assert.equal(st.home, true)
  await assert.rejects(ws.turnOn(), /Windows Home/)
  assert.ok(!calls.some((c) => /RunAs/.test(c)))
})

test("already on, cancelled, failed, and not Windows", async () => {
  assert.equal((await fake({ sandboxExe: true }).ws.status()).on, true)
  assert.deepEqual(await fake({ sandboxExe: true }).ws.turnOn(), { ok: true, already: true })
  await assert.rejects(fake({ exit: 1, stderr: "The operation was canceled by the user." }).ws.turnOn(), /cancelled/)
  await assert.rejects(fake({ exit: 5 }).ws.turnOn(), /code 5/)
  assert.deepEqual(await winsandbox.create({ platform: "linux" }).status(), { windows: false, on: false, canTurnOn: false })
})
