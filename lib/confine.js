// Walls around sandbox tests on Mac and Linux, the way Windows Sandbox walls them
// off on Windows. The test's worker, and everything it starts, runs inside:
//   Linux  bubblewrap (bwrap), the sandbox Flatpak uses: a private view of the disk
//          where the home folder, other users' runtime folders, removable drives and
//          /tmp are empty, and only the test's own folders can be written.
//   Mac    Apple's own sandbox (sandbox-exec, the Seatbelt that Mac App Store apps
//          run in): the home folder and other drives can't be read, nothing outside
//          the test's folders can be written, and the Keychain and other apps can't
//          be asked for anything.
// Installs need the internet, but nothing on this computer: on Linux the test gets a
// network of its own whose only way out is Obstat's proxy (lib/netproxy.js); on a Mac,
// connections to this computer's localhost are refused except to the app's own port.
// Neither is available
// everywhere, so detect() says which works here; without one, tests run in a plain
// test folder and the window says so.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFile } = require("node:child_process")

// paths as the OS sees them (on a Mac /var is /private/var), so the rules match
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const uniq = (list) => [...new Set(list.filter(Boolean).map(real))]
// bubblewrap's paths are always Linux paths: on Linux with links followed (on Fedora
// Silverblue /home is /var/home), and as they are where the tests run on other systems
const uniqLinux = (list) => [...new Set(list.filter(Boolean).map((p) => (process.platform === "linux" ? real(p) : path.posix.normalize(p))))]

// ---------- Linux: bubblewrap ----------

const BWRAP_DIRS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"]
// folders with other people's or other programs' data, emptied inside the sandbox
const LINUX_HIDE = ["/run/user", "/media", "/mnt", "/run/media", "/srv", "/var/tmp", "/tmp", "/root", "/home"]
const SCRATCH = ["/tmp", "/var/tmp"]
// graphics devices, so GPU apps can still use the GPU
const GPU_DEVICES = ["/dev/dri", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia-modeset", "/dev/nvidia0", "/dev/nvidia1", "/dev/nvidia2", "/dev/nvidia3", "/dev/kfd"]

function bwrapArgs({ writable = [], readable = [], hide = [], ownNetwork = false, exists = fs.existsSync }) {
  const args = [
    "--die-with-parent", // the test ends when Obstat (or its Stop) ends bwrap
    "--new-session", // no typing into the terminal Obstat was started from
    "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    // a network of its own (only its own localhost): no other apps' servers, no X11
    // display socket, nothing on the local network. Obstat's proxy is its way out.
    ...(ownNetwork ? ["--unshare-net"] : []),
    "--ro-bind", "/", "/", // the system's programs and settings, read-only
    "--dev", "/dev", // a fresh /dev with only the basic devices
    "--proc", "/proc", // only the sandbox's own processes
  ]
  // with a network of its own nothing in /run is needed: hide it all, which takes the
  // system D-Bus (admin prompts) and the Docker socket (root, for the docker group) away
  const all = uniqLinux([...LINUX_HIDE, ...(ownNetwork ? ["/run", "/var/run"] : ["/run/dbus", "/var/run/dbus"]), ...hide]).filter((d) => exists(d))
  // a folder inside one that's already emptied is gone with it
  const hidden = all.filter((d) => !all.some((o) => o !== d && d.startsWith(o.endsWith("/") ? o : `${o}/`)))
  for (const d of hidden) args.push("--tmpfs", d)
  for (const d of GPU_DEVICES) args.push("--dev-bind-try", d, d)
  for (const d of uniqLinux(readable)) args.push("--ro-bind-try", d, d)
  for (const d of uniqLinux(writable)) args.push("--bind", d, d)
  // then the emptied folders are made read-only, so nothing can be written beside the
  // test's folders even in memory; /tmp stays writable (and is thrown away after)
  for (const d of hidden) if (!SCRATCH.includes(d)) args.push("--remount-ro", d)
  return args
}

// ---------- Mac: Seatbelt ----------

// Paths go in as parameters (-D), never into the profile's text, so no folder name
// can change the rules. Later rules win over earlier ones.
// `ports`: the only ports on this computer's localhost the test may connect to (its own)
function seatbeltProfile({ writable = [], readable = [], hide = [], ports = [], ancestors = [] }) {
  const lines = [
    "(version 1)",
    "(allow default)",
    // nothing outside the test can be changed...
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ptmx$") (regex #"^/dev/ttys"))',
    // ...the home folder, other drives and other users can't be read...
    '(deny file-read* (subpath "/Volumes") (subpath "/Users") (subpath "/private/var/root"))',
    ...hide.map((_, i) => `(deny file-read* (subpath (param "HIDE${i}")))`),
    // ...it can't use the Keychain, drive other apps or read other apps' memory
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.pasteboard.1"))',
    "(deny appleevent-send)",
    "(deny process-info* (target others))",
    "(deny signal (target others))",
    // no camera or microphone, and nothing else on this computer's localhost: other
    // apps' servers (ComfyUI, Jupyter) or Obstat's. Its own port stays open, since
    // apps like Gradio check their own server. Port numbers only, checked as such.
    "(deny device-camera)",
    "(deny device-microphone)",
    '(deny network-outbound (remote ip "localhost:*"))',
    ...ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536).map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
    // except what the test needs: Obstat's runtimes and program (read), its own folders
    ...readable.map((_, i) => `(allow file-read* (subpath (param "READ${i}")))`),
    ...writable.map((_, i) => `(allow file-read* file-write* (subpath (param "WRITE${i}")))`),
    // the folders above the allowed ones can be looked up (not listed or read), so
    // programs can find their way down to them: macOS resolves an app's own path
    // folder by folder, and Electron stops if it can't
    '(allow file-read-metadata (literal "/Users") (literal "/Volumes"))',
    ...ancestors.map((_, i) => `(allow file-read-metadata (literal (param "UP${i}")))`),
  ]
  return lines.join("\n")
}
// every folder above these paths, up to /
function ancestorsOf(paths) {
  const out = new Set()
  for (const p of paths) for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) out.add(d)
  return [...out]
}
function seatbeltArgs(opts) {
  const writable = uniq(opts.writable), readable = uniq(opts.readable), hide = uniq(opts.hide || [])
  const ancestors = ancestorsOf([...writable, ...readable])
  const defs = [
    ...ancestors.flatMap((d, i) => ["-D", `UP${i}=${d}`]),
    ...readable.flatMap((d, i) => ["-D", `READ${i}=${d}`]),
    ...writable.flatMap((d, i) => ["-D", `WRITE${i}=${d}`]),
    ...hide.flatMap((d, i) => ["-D", `HIDE${i}=${d}`]),
  ]
  return [...defs, "-p", seatbeltProfile({ writable, readable, hide, ancestors, ports: (opts.ports || []).map(Number) })]
}

// ---------- which one works here ----------

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

// Tries the sandbox for real (a quick `true` inside it), since bwrap can be installed
// but not allowed to run (no user namespaces, or a strict AppArmor).
// Linux tries Obstat's own bubblewrap first (in the .deb and AppImage, with the AppArmor
// profile Ubuntu 24.04 and later need), then the system's.
function detect({ platform = process.platform, run = execFile, exists = fs.existsSync, bundled = process.resourcesPath ? path.join(process.resourcesPath, "bwrap") : null } = {}) {
  const tryRun = (file, args) => new Promise((resolve) => run(file, args, { timeout: 10000 }, (err, _o, stderr) => resolve(err ? String(stderr || err.message).trim().slice(0, 300) || "it didn't start" : null)))
  if (platform === "linux") {
    const found = [bundled, ...BWRAP_DIRS].filter((f) => f && exists(f))
    if (!found.length) return Promise.resolve({ kind: null, reason: "bubblewrap isn't installed", fix: "Install bubblewrap (on Ubuntu or Debian: sudo apt install bubblewrap), then restart Obstat." })
    return found.reduce((prev, bwrap) => prev.then((r) => (r.kind ? r : tryRun(bwrap, [...bwrapArgs({ ownNetwork: true }), "true"]).then((err) => (err ? { ...r, kind: null, reason: `bubblewrap couldn't start a sandbox here (${err})` } : { kind: "bwrap", file: bwrap })))), Promise.resolve({ kind: null }))
      .then((r) => (r.kind ? r : { ...r, fix: "Your system blocks the user namespaces bubblewrap needs. On Ubuntu, install Obstat from the .deb, which allows them for Obstat's own bubblewrap; elsewhere your distribution's documentation says how to allow them." }))
  }
  if (platform === "darwin") {
    if (!exists(SANDBOX_EXEC)) return Promise.resolve({ kind: null, reason: "this Mac has no sandbox-exec", fix: null })
    return tryRun(SANDBOX_EXEC, [...seatbeltArgs({ writable: [], readable: [] }), "/usr/bin/true"]).then((err) => err
      ? { kind: null, reason: `Apple's sandbox didn't start (${err})`, fix: null }
      : { kind: "seatbelt", file: SANDBOX_EXEC })
  }
  return Promise.resolve({ kind: null, reason: "not used on this system", fix: null })
}

// How to start `file args` inside the sandbox.
function wrap(found, opts, file, args) {
  if (found.kind === "bwrap") return { file: found.file, args: [...bwrapArgs(opts), "--", file, ...args] }
  if (found.kind === "seatbelt") return { file: found.file, args: [...seatbeltArgs(opts), file, ...args] }
  throw new Error("No sandbox here.")
}

// What a test may read besides its own folders: Obstat's runtimes, and Obstat's own
// program (the worker runs on it, from inside the app bundle or AppImage).
function programPaths({ execPath = process.execPath, resourcesPath = process.resourcesPath, libDir = __dirname, platform = process.platform } = {}) {
  const out = [path.dirname(execPath), resourcesPath, libDir]
  // on a Mac the whole .app bundle: Electron loads its frameworks from Contents/Frameworks
  if (platform === "darwin") { const m = /^(.*?\.app)(\/|$)/.exec(execPath); if (m) out.push(m[1]) }
  return out.filter(Boolean)
}

// What a test may see of Obstat's own environment: only these. Anything else could
// be a secret someone exported in the terminal Obstat started from (OPENAI_API_KEY,
// GITHUB_TOKEN), or a way out: DISPLAY, WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS
// would let it talk to your desktop. The test's own home, temp and cache folders
// are added by lib/sandbox.js.
const KEEP_ENV = /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|USER|LOGNAME|SHELL|TMPDIR|(https?|no|all)_proxy|(HTTPS?|NO|ALL)_PROXY)$/
const sandboxEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => KEEP_ENV.test(k)))

module.exports = { detect, wrap, sandboxEnv, bwrapArgs, seatbeltProfile, seatbeltArgs, programPaths, LINUX_HIDE, homeDir: os.homedir }
