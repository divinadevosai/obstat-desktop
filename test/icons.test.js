const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const icons = require("../lib/icons")

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "obstat-icons-"))

test("only real images count, whatever the file is called", () => {
  assert.equal(icons.sniff(PNG), "image/png")
  assert.equal(icons.sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml")
  assert.equal(icons.sniff(Buffer.from("<html><script>alert(1)</script></html>")), null)
  assert.equal(icons.sniff(Buffer.from("MZ\x90\x00 not an image at all")), null)
})

test("finds the icon in an installed app's folder, and never outside it", () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, "public"))
  fs.writeFileSync(path.join(dir, "public", "favicon.png"), PNG)
  assert.equal(icons.findInFolder(dir), fs.realpathSync(path.join(dir, "public", "favicon.png")))
  fs.writeFileSync(path.join(dir, "logo.png"), PNG)
  assert.equal(path.basename(icons.findInFolder(dir)), "logo.png", "a root logo beats a favicon deeper in")
  fs.writeFileSync(path.join(dir, "pinokio.js"), 'module.exports = { icon: "../secret.png" }')
  assert.equal(path.basename(icons.findInFolder(dir)), "logo.png", "pinokio.js can't point outside the folder")
  const outside = tmp()
  fs.writeFileSync(path.join(outside, "x.png"), PNG)
  fs.rmSync(path.join(dir, "logo.png"))
  fs.rmSync(path.join(dir, "public"), { recursive: true })
  try { fs.symlinkSync(path.join(outside, "x.png"), path.join(dir, "icon.png")) } catch { return }
  assert.equal(icons.findInFolder(dir), null, "a link out of the folder is ignored")
})

test("downloads only from GitHub's image hosts, once, and only images", async () => {
  const cache = tmp()
  const asked = []
  const fetch = async (url) => { asked.push(url); return new Response(url.endsWith(".svg") ? "<html>nope</html>" : PNG) }
  const ic = icons.create(cache, fetch)
  assert.equal(await ic.get(null, "https://evil.example/icon.png"), null)
  assert.equal(await ic.get(null, "http://raw.githubusercontent.com/a/b/main/icon.png"), null)
  assert.equal(asked.length, 0)
  const url = "https://raw.githubusercontent.com/a/b/main/icon.png"
  assert.match(await ic.get(null, url), /^data:image\/png;base64,/)
  assert.equal(await ic.get(null, "https://raw.githubusercontent.com/a/b/main/fake.svg"), null, "not really an image")
  const again = icons.create(cache, fetch)
  assert.match(await again.get(null, url), /^data:image\/png;base64,/)
  assert.equal(asked.filter((u) => u === url).length, 1, "kept in the cache folder")
})
