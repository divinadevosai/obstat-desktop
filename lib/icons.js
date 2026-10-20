// App icons, so apps show their own logo instead of a letter. An installed app's
// icon comes from its folder; anything else is downloaded once from GitHub and
// kept in the cache folder. Icons reach the window as data: URLs, so the window
// itself never loads anything from the internet.
const fs = require("fs")
const fsp = require("fs/promises")
const path = require("path")
const { logoDataUrl } = require("./logo")
const crypto = require("crypto")

const HOSTS = new Set(["raw.githubusercontent.com", "avatars.githubusercontent.com"])
const MAX = 512 * 1024
// where repos usually keep their logo, checked in this order
const DIRS = ["", "assets", "icons", "images", "img", "static", "public", "docs", "media", "resources", ".github"]
const NAME = /^(?:app[-_]?)?(icon|logo|favicon)(?:[-_.][\w-]*)?\.(png|webp|jpe?g|gif|svg|ico)$/i
const EXT_ORDER = ["png", "webp", "jpg", "jpeg", "gif", "svg", "ico"]

// The image type from its first bytes; null when it isn't an image we show.
function sniff(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif"
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp"
  if (buf.readUInt32BE(0) === 0x00000100) return "image/x-icon"
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(buf.toString("utf8", 0, 2048))) return "image/svg+xml"
  return null
}
const dataUrl = (buf) => { const type = buf.length <= MAX && sniff(buf); return type ? `data:${type};base64,${buf.toString("base64")}` : null }

const isIconUrl = (url) => {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && HOSTS.has(u.hostname) && !u.username && !u.password && !u.port
  } catch { return false }
}

// The icon file inside an app's folder, or null. Never leaves the folder.
function findInFolder(dir) {
  let real
  try { real = fs.realpathSync(dir) } catch { return null }
  const inside = (f) => { try { const r = fs.realpathSync(f); return r.startsWith(real + path.sep) && fs.statSync(r).isFile() ? r : null } catch { return null } }
  try {
    const m = fs.readFileSync(path.join(real, "pinokio.js"), "utf8").match(/\bicon\s*:\s*["'`]([\w./ -]+\.(?:png|webp|jpe?g|gif|svg|ico))["'`]/i)
    const f = m && inside(path.resolve(real, m[1]))
    if (f) return f
  } catch {}
  for (const sub of DIRS) {
    let names
    try { names = fs.readdirSync(path.join(real, sub)) } catch { continue }
    const hits = names.map((n) => n.match(NAME) && { n, kind: n.match(NAME)[1].toLowerCase(), ext: n.match(NAME)[2].toLowerCase() }).filter(Boolean)
      .sort((a, b) => (a.kind === "favicon") - (b.kind === "favicon") || EXT_ORDER.indexOf(a.ext) - EXT_ORDER.indexOf(b.ext) || a.n.length - b.n.length)
    for (const h of hits) { const f = inside(path.join(real, sub, h.n)); if (f) return f }
  }
  return null
}

function create(cacheDir, fetchImpl) {
  const memo = new Map()
  const dir = path.join(cacheDir, "icons")

  async function fromUrl(url) {
    if (!isIconUrl(url)) return null
    const file = path.join(dir, crypto.createHash("sha256").update(url).digest("hex").slice(0, 32))
    try { return dataUrl(await fsp.readFile(file)) } catch {}
    try {
      const res = await fetchImpl(url, { redirect: "error" })
      if (!res.ok || Number(res.headers.get("content-length") || 0) > MAX) return null
      // read at most MAX bytes, whatever the server says the size is
      const parts = []
      let got = 0
      for await (const chunk of res.body) { got += chunk.length; if (got > MAX) return null; parts.push(Buffer.from(chunk)) }
      const buf = Buffer.concat(parts)
      const out = dataUrl(buf)
      if (out) { await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(file, buf) }
      return out
    } catch { return null }
  }

  // appFolder: the installed app's folder, when there is one. With nothing found,
  // the app gets a made-up logo from its name (when one is given).
  async function get(appFolder, url, name) {
    const key = `${appFolder || ""}|${url || ""}|${name || ""}`
    if (!memo.has(key)) {
      memo.set(key, (async () => {
        const f = appFolder && findInFolder(appFolder)
        if (f) { const out = dataUrl(await fsp.readFile(f).catch(() => Buffer.alloc(0))); if (out) return out }
        const found = url ? await fromUrl(url) : null
        return found || (name ? logoDataUrl(name) : null)
      })())
    }
    return memo.get(key)
  }
  return { get, forget: () => memo.clear() }
}

module.exports = { create, findInFolder, isIconUrl, sniff }
