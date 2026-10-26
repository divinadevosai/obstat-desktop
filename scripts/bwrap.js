// Before a Linux build: copies this machine's bubblewrap (and its licence) into
// build/linux/, so the .deb and AppImage carry Obstat's own. CI builds on the oldest
// Ubuntu it supports, so the copy runs on that and everything newer.
const fs = require("node:fs")
const path = require("node:path")

const out = path.join(__dirname, "..", "build", "linux")
const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].find((f) => fs.existsSync(f))
if (!bwrap) {
  console.error("bubblewrap isn't installed here. Install it (sudo apt install bubblewrap) and build again.")
  process.exit(1)
}
fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(bwrap, path.join(out, "bwrap"))
fs.chmodSync(path.join(out, "bwrap"), 0o755)
const licence = ["/usr/share/doc/bubblewrap/copyright", "/usr/share/licenses/bubblewrap/COPYING"].find((f) => fs.existsSync(f))
fs.writeFileSync(path.join(out, "bwrap-LICENSE.txt"), `Obstat includes bubblewrap (https://github.com/containers/bubblewrap), copied from ${bwrap}.\nIt is free software under the GNU Lesser General Public License, version 2 or later.\nIts source code is at https://github.com/containers/bubblewrap.\n\n${licence ? fs.readFileSync(licence, "utf8") : ""}`)
console.log(`bundled ${bwrap}`)
