// Reads an app's scripts for the main process: the install plan, and which
// files are runnable scripts. It runs as its own short-lived process with no
// keys, tokens or Obstat state, so the main process never runs a repo's code.
const { approve, loadScript } = require("./script")

const reply = (r) => process.send(r, () => process.exit(0))

process.on("message", (m) => {
  try {
    if (m.op === "plan") return reply({ data: approve(m.file, m.ctx) })
    if (m.op === "scripts") {
      return reply({ data: m.files.map((f) => {
        try {
          const s = loadScript(f)
          return { ok: true, starts: s.run.filter((st) => st && st.method === "script.start").map((st) => String((st.params && st.params.uri) || "")) }
        } catch { return { ok: false } }
      }) })
    }
    reply({ error: "Unknown request." })
  } catch (err) {
    reply({ error: err.message })
  }
})
