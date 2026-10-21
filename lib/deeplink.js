// obstat:// links from obstat.app: obstat://app/owner/name opens that app's page.
// A link only ever opens a page; installing or running still takes a click in Obstat.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

// "owner/name" from an obstat:// link, or null
function appFromUrl(url) {
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== "obstat:" || u.host !== "app" || u.username || u.password) return null
  const parts = u.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p) } catch { return "" } })
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!OWNER.test(owner) || !REPO.test(name) || name === "." || name === "..") return null
  return `${owner}/${name}`
}

// Windows starts Obstat with the link as one of its arguments
const fromArgv = (argv = []) => {
  for (const a of argv) if (typeof a === "string" && /^obstat:/i.test(a)) return appFromUrl(a)
  return null
}

module.exports = { appFromUrl, fromArgv }
