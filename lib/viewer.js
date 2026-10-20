// Running apps open inside Obstat, like Pinokio's "Open Web UI": each app gets its
// own view in the window, with its own sandboxed session, that only shows the app's
// local address. Links to anywhere else open in the person's browser.
const { WebContentsView, session, shell, net } = require("electron")
const crypto = require("crypto")
const api = require("./api")

// Some apps print 0.0.0.0 (listen on everything); a browser can't open that address.
function reachable(url) {
  const u = new URL(url)
  if (u.hostname === "0.0.0.0") u.hostname = "127.0.0.1"
  return u.toString()
}

// The same app, even if it swaps localhost for 127.0.0.1: same scheme and port.
function samePort(url, origin) {
  const a = new URL(url), b = new URL(origin)
  const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80")
  return a.protocol === b.protocol && port(a) === port(b)
}

// What a running app may ask for: its mic and camera (voice and video apps),
// copying to the clipboard, full screen and downloads. Nothing else.
const ALLOWED = new Set(["media", "clipboard-sanitized-write", "fullscreen", "fileSystem"])

function create(getWin, { log = () => {}, emit = () => {} } = {}) {
  const views = new Map() // id -> { view, url, origin, ready }
  let shown = null

  // A hash of the exact id, so two look-alike ids (a/b-c and a-b/c) never share cookies.
  const partition = (id) => `persist:app-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 32)}`
  const send = (id, state, extra = {}) => emit({ type: "view", id, state, ...extra })

  function setup(id) {
    const ses = session.fromPartition(partition(id))
    // Only the app's own page gets them, never a website it shows in a frame.
    const mayAsk = (perm, url, mainFrame) => ALLOWED.has(perm) && mainFrame !== false && !!url && api.isLocalUrl(url)
    ses.setPermissionRequestHandler((_wc, perm, cb, details) => cb(mayAsk(perm, details.requestingUrl, details.isMainFrame)))
    ses.setPermissionCheckHandler((_wc, perm, origin, details) => mayAsk(perm, details.requestingUrl || origin, details.isMainFrame))
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: true },
    })
    view.setBackgroundColor("#ffffff")
    const wc = view.webContents
    const v = { view, url: null, origin: null, ready: false }
    // Stay on the app; everything else goes to the browser.
    const guard = (e, url) => {
      if (api.isLocalUrl(url) && (!v.origin || samePort(url, v.origin))) return
      e.preventDefault()
      if (api.isSafeExternal(url)) shell.openExternal(url)
    }
    wc.on("will-navigate", guard)
    wc.on("will-redirect", guard)
    wc.setWindowOpenHandler(({ url }) => {
      if (api.isLocalUrl(url)) {
        if (new URL(reachable(url)).origin === v.origin) wc.loadURL(reachable(url))
        else shell.openExternal(url)
      } else if (api.isSafeExternal(url)) shell.openExternal(url)
      return { action: "deny" }
    })
    wc.on("page-title-updated", (_e, title) => send(id, "title", { title }))
    wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return // -3: aborted, e.g. a redirect
      v.ready = false
      log(`${id}: page didn't load (${desc})`)
      send(id, "failed", { message: `The app didn't answer at ${url}. It may still be starting, or it stopped. Check the log.` })
      if (shown === id) view.setVisible(false)
    })
    wc.on("did-finish-load", () => {
      v.ready = true
      send(id, "ready", { url: wc.getURL() })
      if (shown === id) view.setVisible(true)
    })
    // Keyboard shortcuts people expect in a browser
    wc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown") return
      const mod = input.control || input.meta
      if (input.key === "F5" || (mod && input.key.toLowerCase() === "r")) { e.preventDefault(); wc.reload() }
      else if (mod && (input.key === "=" || input.key === "+")) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() + 0.5) }
      else if (mod && input.key === "-") { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() - 0.5) }
      else if (mod && input.key === "0") { e.preventDefault(); wc.setZoomLevel(0) }
    })
    views.set(id, v)
    return v
  }

  // Wait until the app answers (any reply counts), so nobody stares at an error page
  // while it is still loading its models.
  async function waitFor(id, url, v) {
    const until = Date.now() + 10 * 60_000
    let first = true
    while (Date.now() < until) {
      if (views.get(id) !== v) return false
      try {
        await net.fetch(url, { method: "GET", bypassCustomProtocolHandlers: true, cache: "no-store", signal: AbortSignal.timeout(5000) })
        return true
      } catch {
        if (first) { send(id, "waiting", { url }); first = false }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    return false
  }

  async function show(id, url, bounds) {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    if (!api.isLocalUrl(url)) throw new Error("Obstat only opens apps running on this PC.")
    url = reachable(url)
    for (const [other, o] of views) if (other !== id) o.view.setVisible(false)
    let v = views.get(id)
    if (!v) v = setup(id)
    if (!win.contentView.children.includes(v.view)) win.contentView.addChildView(v.view)
    shown = id
    if (bounds) place(bounds)
    if (v.url === url && v.ready) { v.view.setVisible(true); send(id, "ready", { url: v.view.webContents.getURL() }); return }
    v.view.setVisible(false)
    v.url = url
    v.origin = new URL(url).origin
    v.ready = false
    send(id, "loading", { url })
    if (!(await waitFor(id, url, v))) {
      if (views.get(id) === v) send(id, "failed", { message: `The app never answered at ${url}. Check the log for errors.` })
      return
    }
    if (views.get(id) !== v || v.url !== url) return
    v.view.webContents.loadURL(url).catch(() => {}) // failures arrive as did-fail-load
  }

  function place(b) {
    const v = shown && views.get(shown)
    if (!v) return
    v.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) })
  }

  function hide() {
    const v = shown && views.get(shown)
    if (v) v.view.setVisible(false)
    shown = null
  }

  function act(id, what) {
    const v = views.get(id)
    if (!v) return
    const wc = v.view.webContents
    if (what === "reload") { if (v.ready) wc.reload(); else if (v.url) { const url = v.url; v.url = null; show(id, url) } }
    else if (what === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (what === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (what === "home" && v.url) wc.loadURL(v.url)
  }

  // The app stopped: drop its page (its session, logins and settings stay on disk).
  function close(id) {
    const v = views.get(id)
    if (!v) return
    views.delete(id)
    if (shown === id) shown = null
    const win = getWin()
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(v.view) } catch {}
    try { v.view.webContents.close() } catch {}
  }

  const current = (id) => views.get(id)?.view.webContents.getURL() || null

  return { show, place, hide, act, close, current, reachable }
}

module.exports = { create, reachable }
