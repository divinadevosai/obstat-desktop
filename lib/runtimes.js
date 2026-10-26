// Python, Node, Git and the rest that Obstat downloads into its own folder, so apps never
// depend on (or change) what's installed on the PC. Every download is pinned to
// a version and checked against its SHA-256 before it's unpacked.
// Entries are by platform ("win32", "linux") or platform and chip ("darwin-arm64").
const fs = require("node:fs")
const os = require("node:os")
const fsp = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const zlib = require("node:zlib")
const { pipeline } = require("node:stream/promises")
const { execFile } = require("node:child_process")

const PY = "https://github.com/astral-sh/python-build-standalone/releases/download/20241016"
const RUNTIMES = {
  python: {
    version: "3.11.10",
    win32: { url: `${PY}/cpython-3.11.10+20241016-x86_64-pc-windows-msvc-install_only.tar.gz`, sha256: "647b66ff4552e70aec3bf634dd470891b4a2b291e8e8715b3bdb162f577d4c55", bin: ["python"], exe: "python/python.exe" },
    linux: { url: `${PY}/cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz`, sha256: "8b50a442b04724a24c1eebb65a36a0c0e833d35374dbdf9c9470d8a97b164cd9", bin: ["python/bin"], exe: "python/bin/python3" },
    "darwin-arm64": { url: `${PY}/cpython-3.11.10+20241016-aarch64-apple-darwin-install_only.tar.gz`, sha256: "5a69382da99c4620690643517ca1f1f53772331b347e75f536088c42a4cf6620", bin: ["python/bin"], exe: "python/bin/python3" },
    "darwin-x64": { url: `${PY}/cpython-3.11.10+20241016-x86_64-apple-darwin-install_only.tar.gz`, sha256: "1e23ffe5bc473e1323ab8f51464da62d77399afb423babf67f8e13c82b69c674", bin: ["python/bin"], exe: "python/bin/python3" },
  },
  node: {
    version: "22.23.3",
    win32: { url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip", sha256: "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71", bin: ["node-v22.23.3-win-x64"], exe: "node-v22.23.3-win-x64/node.exe" },
    linux: { url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz", sha256: "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de", bin: ["node-v22.23.3-linux-x64/bin"], exe: "node-v22.23.3-linux-x64/bin/node" },
    "darwin-arm64": { url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz", sha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53", bin: ["node-v22.23.3-darwin-arm64/bin"], exe: "node-v22.23.3-darwin-arm64/bin/node" },
    "darwin-x64": { url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-x64.tar.gz", sha256: "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8", bin: ["node-v22.23.3-darwin-x64/bin"], exe: "node-v22.23.3-darwin-x64/bin/node" },
  },
  // the fast pip that Obstat's generated install steps use
  uv: {
    version: "0.5.11",
    win32: { url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-pc-windows-msvc.zip", sha256: "3e8203e6434b45427f20824419f8d8d53f970a76d94ccdcad07f8498fa01a9d0", bin: [""], exe: "uv.exe" },
    linux: { url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "14411de26cdea5f5139fafaf2b675b1c633e744dd49c6d6a9fc8817ec065158b", bin: ["uv-x86_64-unknown-linux-gnu"], exe: "uv-x86_64-unknown-linux-gnu/uv" },
    "darwin-arm64": { url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-aarch64-apple-darwin.tar.gz", sha256: "695f3640d5b1a4e28de7e36e3a2e14072852dcc6c70bf9e4deec6ada00d516b4", bin: ["uv-aarch64-apple-darwin"], exe: "uv-aarch64-apple-darwin/uv" },
    "darwin-x64": { url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-apple-darwin.tar.gz", sha256: "7e23d1d892c23f9e74245c4fd3d3e246438ce9b34460f85eee61f784de137b0b", bin: ["uv-x86_64-apple-darwin"], exe: "uv-x86_64-apple-darwin/uv" },
  },
  git: {
    version: "2.47.0",
    win32: { url: "https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.1/MinGit-2.47.0-64-bit.zip", sha256: "6b175d4675bfa7014ba649e3c0976da2a281d89bd9a096f1f41437f9995497a8", bin: ["cmd"], exe: "cmd/git.exe" },
    // Mac and Linux: GitHub Desktop's portable git (dugite-native 2.56.0), the builds and
    // checksums its dugite package pins. It needs the settings in gitEnv() to run from here.
    linux: { url: "https://github.com/desktop/dugite-native/releases/download/v2.56.0-1/dugite-native-v2.56.0-7ce66f8-ubuntu-x64.tar.gz", sha256: "8d2d7a4449229f97344da4615b22119352f02801c317bed540df5255b335487f", bin: ["bin"], exe: "bin/git", dugite: true, version: "2.56.0" },
    "darwin-arm64": { url: "https://github.com/desktop/dugite-native/releases/download/v2.56.0-1/dugite-native-v2.56.0-7ce66f8-macOS-arm64.tar.gz", sha256: "ab756ab9a15241f14b6c0a0386c704a998bb710a837ab35dc55d4747a90f2ca0", bin: ["bin"], exe: "bin/git", dugite: true, version: "2.56.0" },
    "darwin-x64": { url: "https://github.com/desktop/dugite-native/releases/download/v2.56.0-1/dugite-native-v2.56.0-7ce66f8-macOS-x64.tar.gz", sha256: "f294895790a98405b2900d55160945d4d0ce92492891aac4b95f2c7085220fa3", bin: ["bin"], exe: "bin/git", dugite: true, version: "2.56.0" },
  },
  // Only downloaded for apps that use it (see needsFfmpeg in apps.js). Gyan Doshi's
  // essentials build, the one ffmpeg.org links to for Windows.
  ffmpeg: {
    version: "7.1",
    optional: true,
    win32: { url: "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip", sha256: "fa7d4d7e795db0e2503f49f105f46ed5852386f0cfdd819899be3b65ebde24fc", bin: ["ffmpeg-7.1-essentials_build/bin"], exe: "ffmpeg-7.1-essentials_build/bin/ffmpeg.exe" },
    // Mac and Linux: the static builds the ffmpeg-static package uses (release b6.1.1), one
    // gzipped program each. They publish no checksums, so these are of the files as first
    // downloaded: a file swapped on the release since then is refused.
    linux: { parts: [
      { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz", sha256: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa", file: "ffmpeg" },
      { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-x64.gz", sha256: "25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067", file: "ffprobe" },
    ], bin: [""], exe: "ffmpeg", version: "b6.1.1" },
    "darwin-arm64": { parts: [
      { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz", sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa", file: "ffmpeg" },
      { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64.gz", sha256: "d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be", file: "ffprobe" },
    ], bin: [""], exe: "ffmpeg", version: "b6.1.1" },
    "darwin-x64": { parts: [
      { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64.gz", sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106", file: "ffmpeg" },
      { url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-x64.gz", sha256: "d4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186", file: "ffprobe" },
    ], bin: [""], exe: "ffmpeg", version: "b6.1.1" },
  },
}

// (asking for another platform, as the tests do, means its usual x64 build)
function create(home, { fetchImpl = fetch, platform = process.platform, arch = platform === process.platform ? os.arch() : "x64", log = () => {} } = {}) {
  // a plain platform entry is an x64 build: Windows on ARM runs those, Linux on ARM can't,
  // so it uses the PC's own Python and Node instead
  const spec = (name) => RUNTIMES[name][`${platform}-${arch}`] || (platform === "linux" && arch !== "x64" ? null : RUNTIMES[name][platform] || null)
  // an entry can have its own version (Mac and Linux git and ffmpeg differ from Windows')
  const version = (name) => spec(name)?.version || RUNTIMES[name].version
  const dir = (name) => path.join(home.root, "bin", `${name}-${version(name)}`)
  const ready = (name) => !spec(name) || fs.existsSync(path.join(dir(name), spec(name).exe))

  async function download(url, file, sha256, onProgress) {
    const res = await fetchImpl(url)
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`)
    const total = Number(res.headers.get("content-length")) || 0
    const hash = crypto.createHash("sha256")
    const out = fs.createWriteStream(file)
    let got = 0
    for await (const chunk of res.body) {
      hash.update(chunk)
      got += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
      onProgress?.(got, total)
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())))
    const digest = hash.digest("hex")
    if (digest !== sha256) {
      await fsp.rm(file, { force: true })
      throw new Error(`The download didn't match its checksum, so Obstat threw it away: ${url}`)
    }
  }

  // tar ships with Windows 10 and later, and it unpacks .zip files too
  const untar = (file, dest) => new Promise((resolve, reject) => {
    execFile("tar", ["-xf", file, "-C", dest], { windowsHide: true, maxBuffer: 1 << 24 }, (err, _o, stderr) =>
      err ? reject(new Error(`Couldn't unpack ${path.basename(file)}: ${stderr || err.message}`)) : resolve())
  })

  // Two apps (or two clicks) asking for the same runtime share one download,
  // instead of both writing the same file.
  const pending = new Map() // name -> { promise, listeners }
  function ensure(name, onProgress) {
    const s = spec(name)
    if (!s || ready(name)) return Promise.resolve()
    let p = pending.get(name)
    if (!p) {
      p = { listeners: new Set() }
      p.promise = fetchRuntime(name, s, (...a) => { for (const l of p.listeners) l(...a) }).finally(() => pending.delete(name))
      pending.set(name, p)
    }
    if (onProgress) p.listeners.add(onProgress)
    return p.promise
  }

  // A runtime is one archive, or (ffmpeg on Mac and Linux) several gzipped programs.
  async function fetchRuntime(name, s, onProgress) {
    log(`downloading ${name} ${version(name)}`)
    const tmp = `${dir(name)}.partial`
    await fsp.rm(tmp, { recursive: true, force: true })
    await fsp.mkdir(tmp, { recursive: true })
    for (const part of s.parts || [s]) {
      const file = path.join(home.dir("cache"), path.basename(new URL(part.url).pathname))
      await download(part.url, file, part.sha256, (got, total) => onProgress(name, got, total))
      if (part.file) {
        const dest = path.join(tmp, part.file)
        await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(dest, { mode: 0o755 }))
        await fsp.chmod(dest, 0o755)
      } else {
        await untar(file, tmp)
      }
      await fsp.rm(file, { force: true })
    }
    await fsp.rm(dir(name), { recursive: true, force: true })
    await fsp.rename(tmp, dir(name))
    log(`installed ${name} ${version(name)}`)
  }

  // Everything apps always need; optional ones only when asked for by name
  async function ensureAll(onProgress, extras = []) {
    for (const name of Object.keys(RUNTIMES)) if (!RUNTIMES[name].optional || extras.includes(name)) await ensure(name, onProgress)
  }

  // Folders to put first on PATH so apps find Obstat's own copies.
  const paths = () => Object.keys(RUNTIMES).filter((n) => spec(n) && ready(n)).flatMap((n) => spec(n).bin.map((b) => path.join(dir(n), b)))
  const status = () => Object.fromEntries(Object.keys(RUNTIMES).map((n) => [n, { version: version(n), needed: !!spec(n) && !RUNTIMES[n].optional, ready: ready(n) }]))
  const git = () => (spec("git") ? path.join(dir("git"), spec("git").exe) : "git")
  const python = () => (spec("python") ? path.join(dir("python"), spec("python").exe) : "python3")

  const exe = (name) => (spec(name) ? path.join(dir(name), spec(name).exe) : null)

  // What GitHub Desktop's portable git needs to run from Obstat's folder (as its dugite
  // package sets): where its helpers, own system config and templates are, and on Linux
  // its prefix and certificates. The PC's own certificate store comes first, so networks
  // with their own certificates still work; git's bundled list is the fallback.
  const CA_FILES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"]
  function gitEnv(env = process.env, exists = fs.existsSync) {
    const s = spec("git")
    if (!s || !s.dugite || !ready("git")) return {}
    const d = dir("git")
    const out = {
      GIT_EXEC_PATH: path.join(d, "libexec", "git-core"),
      GIT_CONFIG_SYSTEM: path.join(d, "etc", "gitconfig"),
      GIT_TEMPLATE_DIR: path.join(d, "share", "git-core", "templates"),
    }
    if (platform === "linux") {
      out.PREFIX = d
      if (!env.GIT_SSL_CAINFO) out.GIT_SSL_CAINFO = CA_FILES.find((f) => exists(f)) || path.join(d, "ssl", "cacert.pem")
    }
    return out
  }
  return { ensure, ensureAll, paths, status, python, git, gitEnv, dir, exe }
}

module.exports = { create, RUNTIMES }
