// Microsoft's C++ tools: spotting the build errors that need them, and installing
// them only from a Microsoft-signed installer, with Windows' permission prompt.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { create, needsCompiler, BOOTSTRAPPER } = require("../lib/cpptools")

test("spots the errors pip and CMake print when there's no C++ compiler", () => {
  for (const line of [
    "error: Microsoft Visual C++ 14.0 or greater is required. Get it with \"Microsoft C++ Build Tools\"",
    "error: Unable to find vcvarsall.bat",
    "error: command 'C:\\Program Files\\cl.exe' failed: None",
    "CMake Error: No CMAKE_CXX_COMPILER could be found.",
  ]) assert.equal(needsCompiler(`Building wheel for insightface\n${line}\n`), true, line)
  assert.equal(needsCompiler("ERROR: No matching distribution found for torch==9"), false)
})

function fake({ signature = "Valid|CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US", finalUrl = "https://download.visualstudio.microsoft.com/download/pr/x/vs_BuildTools.exe", exitCode = 0, vswhere = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obstat-cpp-"))
  const home = { dir: (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d } }
  const pf = path.join(root, "pf86")
  if (vswhere) { fs.mkdirSync(path.join(pf, "Microsoft Visual Studio", "Installer"), { recursive: true }); fs.writeFileSync(path.join(pf, "Microsoft Visual Studio", "Installer", "vswhere.exe"), "") }
  const calls = []
  const run = (file, args, opts, cb) => {
    calls.push({ file, args, env: opts.env })
    const cmd = args.join(" ")
    if (/vswhere/.test(file)) return cb(null, vswhere ? "C:\\BuildTools\n" : "", "")
    if (/Get-AuthenticodeSignature/.test(cmd)) return cb(null, `${signature}\n`, "")
    if (/Start-Process/.test(cmd)) return exitCode ? cb(Object.assign(new Error("exit"), { code: exitCode }), "", "") : cb(null, "", "")
    cb(new Error("unexpected"), "", "")
  }
  const fetchImpl = async (url) => { calls.push({ fetch: url }); return { ok: true, status: 200, url: finalUrl, arrayBuffer: async () => new ArrayBuffer(8) } }
  const tools = create(home, { platform: "win32", run, fetchImpl, env: { SystemRoot: "C:\\Windows", "ProgramFiles(x86)": pf } })
  return { tools, calls, cache: home.dir("cache") }
}

test("installs from Microsoft's own installer, signed by Microsoft, through Windows' permission prompt", async () => {
  const f = fake()
  assert.deepEqual(await f.tools.install(), { ok: true })
  assert.equal(f.calls.find((c) => c.fetch).fetch, BOOTSTRAPPER)
  const start = f.calls.find((c) => c.args && /Start-Process/.test(c.args.join(" ")))
  assert.match(start.args.join(" "), /-Verb RunAs -Wait/)
  // the file and its options go in as variables, never as command text
  assert.match(start.env.OBSTAT_FILE, /vs_BuildTools\.exe$/)
  assert.match(start.env.OBSTAT_ARGS, /--add Microsoft\.VisualStudio\.Workload\.VCTools/)
  assert.equal(fs.existsSync(path.join(f.cache, "vs_BuildTools.exe")), false)
})

test("refuses an installer that isn't validly signed by Microsoft, and deletes it", async () => {
  for (const signature of ["NotSigned|", "HashMismatch|CN=Microsoft Corporation, O=Microsoft Corporation", "Valid|CN=Evil, O=Microsoft Corporation Fake Ltd"]) {
    const f = fake({ signature })
    await assert.rejects(f.tools.install(), /isn't signed by Microsoft/, signature)
    assert.equal(f.calls.some((c) => c.args && /Start-Process/.test(c.args.join(" "))), false)
    assert.equal(fs.existsSync(path.join(f.cache, "vs_BuildTools.exe")), false)
  }
})

test("stops if Microsoft's link leads somewhere else", async () => {
  await assert.rejects(fake({ finalUrl: "https://evil.example/vs_BuildTools.exe" }).tools.install(), /somewhere unexpected/)
})

test("skips the install when the C++ tools are already there, and reports a needed restart", async () => {
  assert.deepEqual(await fake({ vswhere: true }).tools.install(), { ok: true, already: true })
  assert.deepEqual(await fake({ exitCode: 3010 }).tools.install(), { ok: true, restart: true })
  await assert.rejects(fake({ exitCode: 1602 }).tools.install(), /stopped \(code 1602\)/)
})
