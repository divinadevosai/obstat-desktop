// Python, Node and Git that Obstat downloads into its own folder, so apps never
// depend on (or change) what's installed on the PC. Every download is pinned to
// a version and checked against its SHA-256 before it's unpacked.
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const { execFile } = require("node:child_process")

const PY = "https://github.com/astral-sh/python-build-standalone/releases/download/20241016"
const RUNTIMES = {
  python: {
    version: "3.11.10",
    win32: { url: `${PY}/cpython-3.11.10+20241016-x86_64-pc-windows-msvc-install_only.tar.gz`, sha256: "647b66ff4552e70aec3bf634dd470891b4a2b291e8e8715b3bdb162f577d4c55", bin: ["python"], exe: "python/python.exe" },
    linux: { url: `${PY}/cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz`, sha256: "8b50a442b04724a24c1eebb65a36a0c0e833d35374dbdf9c9470d8a97b164cd9", bin: ["python/bin"], exe: "python/bin/python3" },
  },
  node: {
    version: "22.20.0",
    win32: { url: "https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip", sha256: "bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d", bin: ["node-v22.20.0-win-x64"], exe: "node-v22.20.0-win-x64/node.exe" },
    linux: { url: "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz", sha256: "00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc", bin: ["node-v22.20.0-linux-x64/bin"], exe: "node-v22.20.0-linux-x64/bin/node" },
  },
  // the fast pip that Obstat's generated install steps use
  uv: {
    version: "0.5.11",
    win32: { url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-pc-windows-msvc.zip", sha256: "3e8203e6434b45427f20824419f8d8d53f970a76d94ccdcad07f8498fa01a9d0", bin: [""], exe: "uv.exe" },
    linux: { url: "https://github.com/astral-sh/uv/releases/download/0.5.11/uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "14411de26cdea5f5139fafaf2b675b1c633e744dd49c6d6a9fc8817ec065158b", bin: ["uv-x86_64-unknown-linux-gnu"], exe: "uv-x86_64-unknown-linux-gnu/uv" },
  },
  git: {
    version: "2.47.0",
    win32: { url: "https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.1/MinGit-2.47.0-64-bit.zip", sha256: "6b175d4675bfa7014ba649e3c0976da2a281d89bd9a096f1f41437f9995497a8", bin: ["cmd"], exe: "cmd/git.exe" },
    // Linux and Mac use the system git; it's only needed to clone
  },
}

function create(home, { fetchImpl = fetch, platform = process.platform, log = () => {} } = {}) {
  const spec = (name) => RUNTIMES[name][platform] || null
  const dir = (name) => path.join(home.root, "bin", `${name}-${RUNTIMES[name].version}`)
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

  async function ensure(name, onProgress) {
    const s = spec(name)
    if (!s || ready(name)) return
    log(`downloading ${name} ${RUNTIMES[name].version}`)
    const file = path.join(home.dir("cache"), path.basename(new URL(s.url).pathname))
    await download(s.url, file, s.sha256, (got, total) => onProgress?.(name, got, total))
    const tmp = `${dir(name)}.partial`
    await fsp.rm(tmp, { recursive: true, force: true })
    await fsp.mkdir(tmp, { recursive: true })
    await untar(file, tmp)
    await fsp.rm(dir(name), { recursive: true, force: true })
    await fsp.rename(tmp, dir(name))
    await fsp.rm(file, { force: true })
    log(`installed ${name} ${RUNTIMES[name].version}`)
  }

  async function ensureAll(onProgress) {
    for (const name of Object.keys(RUNTIMES)) await ensure(name, onProgress)
  }

  // Folders to put first on PATH so apps find Obstat's own copies.
  const paths = () => Object.keys(RUNTIMES).filter((n) => spec(n) && ready(n)).flatMap((n) => spec(n).bin.map((b) => path.join(dir(n), b)))
  const status = () => Object.fromEntries(Object.keys(RUNTIMES).map((n) => [n, { version: RUNTIMES[n].version, needed: !!spec(n), ready: ready(n) }]))
  const git = () => (spec("git") ? path.join(dir("git"), spec("git").exe) : "git")
  const python = () => (spec("python") ? path.join(dir("python"), spec("python").exe) : "python3")

  const exe = (name) => (spec(name) ? path.join(dir(name), spec(name).exe) : null)
  return { ensure, ensureAll, paths, status, python, git, dir, exe }
}

module.exports = { create, RUNTIMES }
