// Copies the shared look (styles, fonts, logo) from brand/ into app/. brand/ is a
// copy of obstat.app's own files, so the app and the site look the same.
const fs = require("node:fs")
const path = require("node:path")

const site = path.join(__dirname, "..", "brand")
const app = path.join(__dirname, "..", "app")

for (const name of ["obstat.css", "obstat.svg", "fonts"]) {
  fs.cpSync(path.join(site, name), path.join(app, name), { recursive: true })
}
