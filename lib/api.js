// Talks to the live Obstat list. Runs in the main process only, so the
// window itself never gets network access.
// OBSTAT_API points a dev build at a local copy of the site
const BASE = process.env.OBSTAT_API || "https://obstat.app"

// Links the window may open in the person's browser.
const EXTERNAL_HOSTS = new Set([
  "github.com", "obstat.app", "obstat.netlify.app", "swe3we.dev", "pinokio.co",
  // where the Plugins page sends people to get a missing tool
  "code.visualstudio.com", "cursor.com", "claude.com", "git-scm.com",
])

function isSafeExternal(url) {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && EXTERNAL_HOSTS.has(u.hostname) && !u.username && !u.password
  } catch {
    return false
  }
}

// An app's own web page running on this PC.
function isLocalUrl(url) {
  try {
    const u = new URL(url)
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(u.hostname)
  } catch {
    return false
  }
}

// `token` is the chat account's session, sent only to Obstat's own API
async function call(path, body, fetchImpl = fetch, area = "repos", method, token) {
  let res
  const headers = { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
  try {
    res = await fetchImpl(`${BASE}/api/${area}${path}`, body || method || token
      ? { method: method || (body ? "POST" : "GET"), headers, body: body ? JSON.stringify(body) : undefined }
      : {})
  } catch {
    throw new Error("Couldn't reach Obstat. Check your internet connection and try again.")
  }
  let data = {}
  try { data = (await res.json()) || {} } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`)
  return data
}

async function list(fetchImpl) {
  const { repos } = await call("", null, fetchImpl)
  return Array.isArray(repos) ? repos : []
}

async function check(url, fetchImpl) {
  if (typeof url !== "string" || !url.trim() || url.length > 300) throw new Error("Paste a GitHub repo, like github.com/owner/repo.")
  return call("/check", { url: url.trim() }, fetchImpl)
}

// The community chat and the news feed. Channel names and ids come back to
// the window as plain data; it renders them as text.
const CHANNEL = /^[a-z]{1,20}$/
const MSG_ID = /^[a-z0-9]{1,16}-[0-9a-f]{8}$/
const chan = (c) => { if (typeof c !== "string" || !CHANNEL.test(c)) throw new Error("No such channel."); return c }

async function channels(fetchImpl) {
  return (await call("", null, fetchImpl, "chat")).channels || {}
}

async function readChat(channel, after, fetchImpl) {
  const q = typeof after === "string" && MSG_ID.test(after) ? `?after=${after}` : ""
  const { messages } = await call(`/${chan(channel)}${q}`, null, fetchImpl, "chat")
  return Array.isArray(messages) ? messages : []
}

async function sendChat(channel, text, token, fetchImpl) {
  if (typeof text !== "string") throw new Error("Write something first.")
  if (!token) throw new Error("Sign in to use the chat.")
  return (await call(`/${chan(channel)}`, { text }, fetchImpl, "chat", "POST", token)).message
}

async function reportChat(channel, id, token, fetchImpl) {
  if (typeof id !== "string" || !MSG_ID.test(id)) throw new Error("That message is gone.")
  if (!token) throw new Error("Sign in to report messages.")
  await call(`/${chan(channel)}/${id}/report`, null, fetchImpl, "chat", "POST", token)
}

// Moderators (accounts with a team badge) can remove a message or ban its poster.
async function modChat(action, channel, id, token, fetchImpl) {
  if (typeof id !== "string" || !MSG_ID.test(id)) throw new Error("That message is gone.")
  if (!token) throw new Error("Sign in to moderate.")
  if (action === "delete") return call(`/${chan(channel)}/${id}`, null, fetchImpl, "chat", "DELETE", token)
  if (action === "ban") return call(`/${chan(channel)}/${id}/ban`, null, fetchImpl, "chat", "POST", token)
  throw new Error("Unknown action.")
}

// Chat accounts: an emailed code, then a session token the main process keeps.
const str = (v, max) => { if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("Fill that in first."); return v.trim() }
const sendCode = (email, fetchImpl) => call("/code", { email: str(email, 254) }, fetchImpl, "account")
const verifyCode = ({ email, code, name, acceptTerms }, fetchImpl) =>
  call("/verify", { email: str(email, 254), code: str(code, 12), ...(name ? { name: str(name, 24) } : {}), acceptTerms: acceptTerms === true }, fetchImpl, "account")
const accountInfo = (token, fetchImpl) => call("", null, fetchImpl, "account", "GET", token)
const signOut = (token, fetchImpl) => call("/signout", null, fetchImpl, "account", "POST", token)
const deleteAccount = (token, fetchImpl) => call("", null, fetchImpl, "account", "DELETE", token)

async function news(fetchImpl) {
  const { news: items } = await call("", null, fetchImpl, "news")
  return Array.isArray(items) ? items : []
}

module.exports = { BASE, isSafeExternal, isLocalUrl, list, check, channels, readChat, sendChat, reportChat, modChat, news, sendCode, verifyCode, accountInfo, signOut, deleteAccount }
