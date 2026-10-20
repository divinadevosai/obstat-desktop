// Turns a command's --help text into form fields (argparse, optparse and Click styles).
"use strict"
const PATHY = /file|path|input|image|img|photo|picture|audio|wav|mp3|video|pdf|doc|csv|json|txt|dir|folder|source|src|in$/i

function parseHelp(text) {
  const fields = []
  const seen = new Set()
  let section = ""
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const head = line.match(/^([A-Za-z][\w ]*):\s*$/)
    if (head) { section = head[1].toLowerCase(); continue }
    // an option: "  -m MODEL, --model MODEL   what it does"
    const opt = line.match(/^\s{1,10}((?:-{1,2}[\w?][\w-]*(?:[ =](?:\{[^}\s]*\}|[A-Z<\[][^\s,]*))?(?:,\s*|\s\/\s)?)+)(?:\s{2,}(.*))?$/)
    if (opt) {
      const names = [...opt[1].matchAll(/(-{1,2}[\w?][\w-]*)(?:[ =](\{[^}\s]*\}|[A-Z<\[][^\s,]*))?/g)]
      const long = names.find((n) => n[1].startsWith("--")) || names[0]
      const flag = long[1]
      if (/^--?(h|help|version|V)$/.test(flag) || seen.has(flag)) continue
      let desc = (opt[2] || "").trim()
      // descriptions often carry on to the next indented lines
      while (i + 1 < lines.length && /^\s{12,}\S/.test(lines[i + 1]) && !/^\s*-/.test(lines[i + 1])) desc += " " + lines[++i].trim()
      const meta = names.map((n) => n[2]).find(Boolean)
      const choices = meta && meta.startsWith("{") ? meta.replace(/[{}]/g, "").split(",") : null
      const def = desc.match(/\(default:?\s*([^)]*)\)|\[default:?\s*([^\]]*)\]/i)
      seen.add(flag)
      fields.push({
        key: flag, label: flag.replace(/^-+/, "").replace(/[-_]+/g, " "), help: desc.replace(/\s+/g, " ").trim().slice(0, 300),
        kind: !meta ? "flag" : choices ? "choice" : "value", choices,
        placeholder: def ? (def[1] || def[2] || "").trim() : (meta && !choices ? meta.replace(/[<>]/g, "") : ""),
        file: !!meta && !choices && PATHY.test(flag + " " + meta),
      })
      continue
    }
    // a positional argument, in argparse's "positional arguments:" section
    const pos = /positional|^arguments/.test(section) && line.match(/^\s{2,6}([\w][\w-]*)(?:\s{2,}(.*))?$/)
    if (pos && !seen.has(pos[1])) {
      seen.add(pos[1])
      fields.push({ key: pos[1], label: pos[1].replace(/[-_]+/g, " "), help: (pos[2] || "").trim(), kind: "positional", file: PATHY.test(pos[1]), placeholder: "" })
    }
  }
  // Click and others name positionals only in the usage line: "Usage: x [OPTIONS] INPUT"
  if (!fields.some((f) => f.kind === "positional")) {
    const usage = ((text.match(/usage:([^\n]*(?:\n\s{6,}[^\n]+)*)/i) || [])[1] || "").split(/\s-\s/)[0]
    for (const m of usage.replace(/\[[^\]]*\]/g, " ").matchAll(/\b([A-Z][A-Z0-9_]{1,30})\b(\.\.\.)?/g)) {
      if (m[1] === "OPTIONS" || m[1] === "COMMAND" || seen.has(m[1])) continue
      seen.add(m[1])
      fields.unshift({ key: m[1], label: m[1].toLowerCase().replace(/_/g, " "), help: "", kind: "positional", file: PATHY.test(m[1]), placeholder: "" })
    }
  }
  // nothing named: still offer one box for the main input, like the text to turn into a QR code
  if (!fields.some((f) => f.kind === "positional")) fields.unshift({ key: "input", label: "input", help: "What the app works on, if it takes one (text, a file, a link). Leave empty if not.", kind: "positional", file: false, placeholder: "" })
  return fields.slice(0, 40)
}

module.exports = { parseHelp }
