// Microsoft's C++ Build Tools, for apps whose Python packages build from source
// on Windows (insightface, Cython extensions and the like). Microsoft doesn't
// allow them to be shipped inside Obstat, and they're several GB, so Obstat
// downloads Microsoft's own installer, checks it's signed by Microsoft, and runs
// it with only the C++ parts ticked. Windows asks for permission once.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const { execFile } = require("node:child_process")

const BOOTSTRAPPER = "https://aka.ms/vs/17/release/vs_BuildTools.exe"
const ARGS = ["--passive", "--wait", "--norestart", "--add", "Microsoft.VisualStudio.Workload.VCTools", "--includeRecommended"]
const VC = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"

// What pip, setuptools, CMake and friends print when there's no C++ compiler.
const NEEDS = /Microsoft Visual C\+\+ 14\.0 or greater is required|Unable to find vcvarsall\.bat|error: command '[^']*cl\.exe' failed|Could not find (a )?C\+?\+? compiler|No CMAKE_C(XX)?_COMPILER could be found|You must use Visual Studio to build|error: Microsoft Visual C\+\+/i
const needsCompiler = (log) => NEEDS.test(String(log || ""))

function create(home, { platform = process.platform, fetchImpl = fetch, run = execFile, env = process.env, log = () => {} } = {}) {
  const exec = (file, args, opts = {}) => new Promise((resolve) => run(file, args, { windowsHide: true, timeout: 60000, ...opts }, (err, out, stderr) => resolve({ err, out: String(out || ""), stderr: String(stderr || ""), code: err ? err.code : 0 })))
  const powershell = (command, extra = {}, timeout) => exec(path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...env, ...extra }, ...(timeout ? { timeout } : {}) })

  // Installed when vswhere (which comes with every Visual Studio install) finds the C++ tools.
  async function installed() {
    if (platform !== "win32") return true
    const vswhere = path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe")
    if (!fs.existsSync(vswhere)) return false
    const r = await exec(vswhere, ["-products", "*", "-requires", VC, "-property", "installationPath"])
    return !r.err && r.out.trim().length > 0
  }

  // Signed by Microsoft, with a signature Windows accepts. The file's path goes in
  // through an environment variable, so it's never part of the command text.
  async function signedByMicrosoft(file) {
    const r = await powershell("$s = Get-AuthenticodeSignature -LiteralPath $env:OBSTAT_FILE; [string]$s.Status + '|' + $s.SignerCertificate.Subject", { OBSTAT_FILE: file })
    const [status, subject = ""] = r.out.trim().split("|")
    return !r.err && status === "Valid" && /(^|,\s*)O=Microsoft Corporation(,|$)/.test(subject)
  }

  async function install() {
    if (platform !== "win32") throw new Error("Microsoft's C++ tools are only for Windows.")
    if (await installed()) return { ok: true, already: true }
    const file = path.join(home.dir("cache"), "vs_BuildTools.exe")
    log("downloading Microsoft's C++ Build Tools installer")
    const res = await fetchImpl(BOOTSTRAPPER)
    if (!res.ok) throw new Error(`Couldn't download Microsoft's installer (${res.status}).`)
    const host = new URL(res.url || BOOTSTRAPPER).hostname
    if (!/(^|\.)(microsoft\.com|visualstudio\.com|aka\.ms)$/i.test(host)) throw new Error(`Microsoft's installer link went somewhere unexpected (${host}), so Obstat stopped.`)
    await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()))
    try {
      if (!(await signedByMicrosoft(file))) throw new Error("The installer isn't signed by Microsoft, so Obstat deleted it.")
      // Start-Process -Verb RunAs shows Windows' permission prompt; -Wait sees it through
      log("running Microsoft's C++ Build Tools installer")
      const r = await powershell("$p = Start-Process -FilePath $env:OBSTAT_FILE -ArgumentList $env:OBSTAT_ARGS -Verb RunAs -Wait -PassThru; exit $p.ExitCode", { OBSTAT_FILE: file, OBSTAT_ARGS: ARGS.join(" ") }, 2 * 60 * 60 * 1000)
      const code = r.err ? r.code : 0
      if (code === 3010) return { ok: true, restart: true }
      if (code !== 0) throw new Error(/canceled|cancelled/i.test(r.stderr) ? "The install was cancelled." : `Microsoft's installer stopped (code ${code}).`)
      return { ok: true }
    } finally {
      await fsp.rm(file, { force: true })
    }
  }

  return { installed, install, signedByMicrosoft }
}

module.exports = { create, needsCompiler, BOOTSTRAPPER, ARGS }
