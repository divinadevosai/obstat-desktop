// API keys some apps need (OpenAI, Hugging Face, …), kept in ~/obstat/keys.json.
// Each value is encrypted with the OS's own protection (Windows DPAPI, the Mac Keychain
// or a Linux keyring, through Electron's safeStorage), so the file is useless on
// another PC or account.
// A key goes to an app as an environment variable, and only to the apps it's
// shared with. Sandbox tests never get keys: they run code nobody has trusted.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

// names an app could use to change how its own shell behaves
const RESERVED = /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|COMSPEC|SYSTEMROOT|WINDIR|PORT|PYTHON\w*|NODE_\w+|UV_\w+|PIP_\w+|VIRTUAL_ENV|ELECTRON_\w+|OBSTAT_\w+|LD_\w+|DYLD_\w+|BASH_ENV|ENV|GIT_\w+|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|PERL5OPT|RUBYOPT|PROMPT_COMMAND|SHELLOPTS|PS4)$/

function create(home, crypt) {
  const file = path.join(home.root, "keys.json")
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return [] } }
  const write = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 })

  // what the window sees: never the value, only its last 4 characters
  const list = () => read().map(({ id, name, hint, apps, at }) => ({ id, name, hint, apps, at }))

  function add({ name, value, apps }) {
    if (!crypt.available()) throw new Error(`This PC can't encrypt keys right now, so Obstat won't save them.${crypt.hint?.() ? ` ${crypt.hint()}` : ""}`)
    name = String(name || "").trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("Use a name like OPENAI_API_KEY: capital letters, numbers and _.")
    if (RESERVED.test(name)) throw new Error(`${name} is used by Obstat itself. Pick another name.`)
    value = String(value || "").trim()
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("Paste the key as one line.")
    if (!Array.isArray(apps) || !apps.length || !apps.every((a) => a === "*" || /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(a))) throw new Error("Pick which apps can use it.")
    const keys = read().filter((k) => k.name !== name)
    const entry = { id: crypto.randomBytes(6).toString("hex"), name, hint: value.slice(-4), apps: apps.includes("*") ? ["*"] : [...new Set(apps.map((a) => a.toLowerCase()))], value: crypt.encrypt(value).toString("base64"), at: new Date().toISOString() }
    write([...keys, entry])
    return list().find((k) => k.id === entry.id)
  }

  function remove(id) {
    const keys = read()
    write(keys.filter((k) => k.id !== id))
  }

  // the env vars an installed app gets; a key that won't decrypt is skipped
  function envFor(appId) {
    const env = {}
    for (const k of read()) {
      if (!k.apps.includes("*") && !k.apps.includes(appId)) continue
      try { env[k.name] = crypt.decrypt(Buffer.from(k.value, "base64")) } catch {}
    }
    return env
  }

  return { list, add, remove, envFor }
}

module.exports = { create }
