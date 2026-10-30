// Windows Sandbox comes with Windows 10 and 11 Pro, Enterprise and Education, but
// it's off until someone turns it on in "Turn Windows features on or off". Obstat
// can turn it on for them: Windows asks for permission once, and the PC needs a
// restart before it works. Windows Home doesn't include it.
const fs = require("node:fs")
const path = require("node:path")
const { execFile } = require("node:child_process")

const FEATURE = "Containers-DisposableClientVM"
// exits 3010 when Windows needs a restart to finish, as Windows installers do
const ENABLE = `$r = Enable-WindowsOptionalFeature -Online -FeatureName ${FEATURE} -All -NoRestart; if ($r.RestartNeeded) { exit 3010 } else { exit 0 }`
// powershell's -EncodedCommand takes UTF-16LE in base64, so nothing needs quoting
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64")

function create({ platform = process.platform, run = execFile, env = process.env, log = () => {} } = {}) {
  const system = (...p) => path.join(env.SystemRoot || "C:\\Windows", "System32", ...p)
  const exec = (file, args, timeout = 60000) => new Promise((resolve) => run(file, args, { windowsHide: true, timeout }, (err, out, stderr) => resolve({ err, out: String(out || ""), stderr: String(stderr || ""), code: err ? (typeof err.code === "number" ? err.code : 1) : 0 })))
  const powershell = (command, timeout) => exec(system("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", command], timeout)

  // on: it's turned on (and the PC has restarted since). home: Windows Home, which can't have it.
  async function status() {
    if (platform !== "win32") return { windows: false, on: false, canTurnOn: false }
    if (fs.existsSync(system("WindowsSandbox.exe"))) return { windows: true, on: true, canTurnOn: false }
    const r = await powershell("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').EditionID")
    const edition = r.out.trim()
    const home = /^Core/i.test(edition) // Core, CoreN, CoreSingleLanguage, CoreCountrySpecific
    return { windows: true, on: false, canTurnOn: !home, home, edition }
  }

  async function turnOn() {
    const st = await status()
    if (!st.windows) throw new Error("Windows Sandbox is only for Windows.")
    if (st.on) return { ok: true, already: true }
    if (st.home) throw new Error("Windows Home doesn't include Windows Sandbox. It comes with Windows Pro, Enterprise and Education.")
    log("turning on Windows Sandbox")
    // Start-Process -Verb RunAs shows Windows' permission prompt; -Wait sees it through
    const r = await powershell(`$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(ENABLE)}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`, 15 * 60 * 1000)
    if (r.code === 3010 || r.code === 0) {
      log("Windows Sandbox turned on; the PC needs a restart")
      // until the restart, WindowsSandbox.exe isn't there yet
      return { ok: true, restart: true }
    }
    if (/cancel/i.test(r.stderr)) throw new Error("Windows Sandbox wasn't turned on: the permission prompt was cancelled.")
    throw new Error(`Windows couldn't turn on Windows Sandbox (code ${r.code}). You can also turn it on in "Turn Windows features on or off".`)
  }

  return { status, turnOn }
}

module.exports = { create, FEATURE, ENABLE, encoded }
