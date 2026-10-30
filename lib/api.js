// Talks to the live Obstat list. Runs in the main process only, so the
// window itself never gets network access.
// OBSTAT_API points a dev build at a local copy of the site
const BASE = process.env.OBSTAT_API || "https://obstat.app"

// Links the window may open in the person's browser.
const EXTERNAL_HOSTS = new Set([
  "github.com", "obstat.app", "obstat.netlify.app", "swe3we.dev", "pinokio.co", "divinaos.site",
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

// The Community Hub: discussions and launches. Reads send the session when
// there is one, so the list shows which posts you voted on.
const HUB_Q = { kind: /^(discussion|launch)$/, tag: /^[a-z]{1,20}$/, sort: /^(hot|new|top)$/, period: /^(day|week|month|all)$/, before: MSG_ID }
const postId = (id) => { if (typeof id !== "string" || !MSG_ID.test(id)) throw new Error("That post is gone."); return id }
const opt = (v, max) => (typeof v === "string" && v.trim() ? str(v, max) : "")
const commentPath = (id, cid) => `/${postId(id)}${cid === undefined || cid === null ? "" : `/comments/${postId(cid)}`}`

async function hubList(query, token, fetchImpl) {
  const q = new URLSearchParams()
  for (const [k, re] of Object.entries(HUB_Q)) if (typeof query?.[k] === "string" && re.test(query[k])) q.set(k, query[k])
  const r = await call(`${q.size ? `?${q}` : ""}`, null, fetchImpl, "hub", "GET", token)
  return { posts: Array.isArray(r.posts) ? r.posts : [], featured: r.featured || null, tags: r.tags || {} }
}
const hubPost = async (id, token, fetchImpl) => (await call(`/${postId(id)}`, null, fetchImpl, "hub", "GET", token)).post

async function hubCreate(fields, token, fetchImpl) {
  if (!token) throw new Error("Sign in to post.")
  const f = fields || {}
  const body = f.kind === "launch"
    ? { kind: "launch", repo: str(f.repo, 300), title: str(f.title, 120), tagline: str(f.tagline, 140), body: opt(f.body, 4000) }
    : { kind: "discussion", tag: str(f.tag, 20), title: str(f.title, 120), body: opt(f.body, 4000) }
  return (await call("", body, fetchImpl, "hub", "POST", token)).post
}
async function hubVote(id, value, token, fetchImpl) {
  if (!token) throw new Error("Sign in to vote.")
  if (![1, 0, -1].includes(value)) throw new Error("Vote up or down.")
  return call(`/${postId(id)}/vote`, { value }, fetchImpl, "hub", "POST", token)
}
async function hubComment(id, text, parent, token, fetchImpl) {
  if (!token) throw new Error("Sign in to comment.")
  return (await call(`/${postId(id)}/comments`, { text: str(text, 2000), ...(parent ? { parent: postId(parent) } : {}) }, fetchImpl, "hub", "POST", token)).comment
}
// action: "report", "delete" (your own, or a moderator's) or "ban" (moderators); cid for a comment
async function hubAct(action, id, cid, token, fetchImpl) {
  if (!token) throw new Error("Sign in first.")
  const path = commentPath(id, cid)
  if (action === "report") return call(`${path}/report`, null, fetchImpl, "hub", "POST", token)
  if (action === "delete") return call(path, null, fetchImpl, "hub", "DELETE", token)
  if (action === "ban") return call(`${path}/ban`, null, fetchImpl, "hub", "POST", token)
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

module.exports = { BASE, isSafeExternal, isLocalUrl, list, check, channels, readChat, sendChat, reportChat, modChat, hubList, hubPost, hubCreate, hubVote, hubComment, hubAct, news, sendCode, verifyCode, accountInfo, signOut, deleteAccount }
