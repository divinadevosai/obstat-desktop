// The chat account's session token, kept in ~/obstat/account.json (only this
// user can read it), encrypted by the OS when it can be. The window never sees it.
const fs = require("node:fs")
const path = require("node:path")

function create(home, crypt) {
  const file = path.join(home.root, "account.json")
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null } }

  function token() {
    const a = read()
    if (!a?.token) return null
    try { return a.encrypted ? crypt.decrypt(Buffer.from(a.token, "base64")) : a.token } catch { return null }
  }
  const name = () => read()?.name || null

  function save(tok, chatName) {
    const enc = crypt.available()
    const body = { name: chatName, encrypted: enc, token: enc ? crypt.encrypt(tok).toString("base64") : tok }
    fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch {}
  }
  const clear = () => fs.rmSync(file, { force: true })

  return { token, name, save, clear }
}

module.exports = { create }
