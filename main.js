// Obstat Desktop: the window, and the few things it's allowed to ask for.
const { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell } = require("electron")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const api = require("./lib/api")
const { create, findTools } = require("./lib/home")
const runtimesLib = require("./lib/runtimes")
const appsLib = require("./lib/apps")
const skillsLib = require("./lib/skills")
const controlLib = require("./lib/control")
const sandboxLib = require("./lib/sandbox")
const keysLib = require("./lib/keys")
const accountLib = require("./lib/account")
const iconsLib = require("./lib/icons")
const viewerLib = require("./lib/viewer")
const updatesLib = require("./lib/updates")
const buildUi = require("./lib/buildui")
const cppToolsLib = require("./lib/cpptools")
const winSandboxLib = require("./lib/winsandbox")
const divinaLib = require("./lib/divina")
const usageLib = require("./lib/usage")
const wallsLib = require("./lib/walls")
const { sandboxEnv } = require("./lib/confine")
const deeplink = require("./lib/deeplink")
const platformLib = require("./lib/platform")
const { MacUpdater } = require("./lib/macupdate")
const fs = require("node:fs")
const { which, withPath } = require("./lib/env")
const fsp = require("node:fs/promises")
const { spawn } = require("node:child_process")

const home = create()
const runtimes = runtimesLib.create(home, { fetchImpl: (url) => net.fetch(url), log: (l) => home.log(l) })
const toWindow = (e) => { if (win && !win.isDestroyed()) win.webContents.send("obstat:event", e) }
const lastOpen = new Map() // app id -> the address its start script asked to open
const usage = usageLib.create(home)
// installs (install.js, update.js, reset.js) run inside the OS sandbox on Mac and Linux (lib/walls.js)
const walls = wallsLib.create(home, { appDir: (id) => apps.appDir(id) })
const apps = appsLib.create(home, runtimes, {
  onRun: (r) => { usage.record(r); walls.done(r.id) },
  wrap: (id, file, args, env, script) => walls.wrap(id, file, args, env, script),
  jobExtra: (id, script) => walls.jobExtra(id, script),
  hfEnv: (id, script) => walls.hfEnv(id, script) || path.join(home.dir("cache"), "hf-env"),
  emit: (e) => {
    if (e.type === "open" && api.isLocalUrl(e.url)) lastOpen.set(e.id, e.url)
    // the app stopped: close its page inside Obstat
    if (e.type === "state" && !apps.get(e.id)?.running) { lastOpen.delete(e.id); viewer.close(e.id) }
    toWindow(e)
  },
  // Electron runs the worker as plain Node
  workerEnv: { ELECTRON_RUN_AS_NODE: "1" },
  // each app gets the keys shared with it (sandbox tests get none)
  // installs get no API keys: walled ones their own home and the shared caches instead
  jobEnv: (id, script) => walls.env(id, script) || (wallsLib.WALLED.has(script) ? {} : keys.envFor(id)),
  // and an install that can't be walled (Windows) doesn't see secrets exported in Obstat's own environment
  baseEnv: (script, walled) => (walled ? sandboxEnv(process.env) : wallsLib.WALLED.has(script) ? wallsLib.withoutSecrets(process.env) : process.env),
})
// The OS's own protection: Windows DPAPI, the Mac Keychain, or a Linux keyring. On Linux
// without a keyring, Electron falls back to a built-in key anyone could use, so that counts
// as no encryption (see lib/platform.js).
const crypt = {
  available: () => platformLib.encryptionReal(safeStorage),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (buf) => safeStorage.decryptString(buf),
  hint: () => (process.platform === "linux" ? "Obstat uses your desktop's keyring to encrypt them: install GNOME Keyring or KWallet (most desktops have one), sign out and back in, then try again." : ""),
}
const keys = keysLib.create(home, crypt)
const account = accountLib.create(home, crypt)
const icons = iconsLib.create(home.dir("cache"), (url, opts) => net.fetch(url, opts))

const sandbox = sandboxLib.create(home, runtimes, {
  onRun: (r) => usage.record(r),
  emit: (e) => { if (win && !win.isDestroyed()) win.webContents.send("obstat:event", e) },
  workerEnv: { ELECTRON_RUN_AS_NODE: "1" },
})

const viewer = viewerLib.create(() => win, { log: (l) => home.log(l), emit: toWindow })
// net.fetch only for the download; Divina's port checks use Node's own (see lib/divina.js)
const divina = divinaLib.create(home, { fetchImpl: (url, opts) => net.fetch(url, opts), log: (l) => home.log(l) })

// Windows, and Linux installed from the AppImage or the .deb: electron-updater (a .deb
// leaves a package-type file it reads). A Mac: Obstat's own (see lib/macupdate.js).
const updater = !app.isPackaged ? null
  : process.platform === "darwin" ? new MacUpdater({ feed: updatesLib.FEED, app, cacheDir: home.dir("cache"), fetchImpl: (url) => net.fetch(url) })
  : process.platform === "win32" || (process.platform === "linux" && (process.env.APPIMAGE || fs.existsSync(path.join(process.resourcesPath, "package-type")))) ? require("electron-updater").autoUpdater
  : null
const updates = updatesLib.create(updater, {
  enabled: !!updater,
  log: (l) => home.log(l),
  emit: toWindow,
  beforeInstall: () => { apps.stopAll(); sandbox.stopAll(); control.stop(); divina.stop() },
})

const skills = skillsLib.create(path.join(__dirname, "skills"))
const control = controlLib.create(home, apps, { log: (l) => home.log(l) })

const APP_DIR = path.join(__dirname, "app")
const START = "app://obstat/index.html"

// The window's files are served from app://obstat/, so /fonts/… paths work like on the site.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true } }])
// apps that draw with WebGL still show on PCs whose graphics driver Chromium won't use
viewerLib.useSoftwareWebGL(app)

if (!app.requestSingleInstanceLock()) app.quit()
// "Open in Obstat" on obstat.app uses obstat:// links (the installer registers them too)
if (process.defaultApp) app.setAsDefaultProtocolClient("obstat", process.execPath, [path.resolve(process.argv[1] || ".")])
else app.setAsDefaultProtocolClient("obstat")

let win

// A Mac hands over obstat:// links as an event, not as arguments: both when the link
// starts Obstat (before its window exists) and when it's already open.
let pendingLink = null
app.on("open-url", (e, url) => {
  e.preventDefault()
  const id = deeplink.appFromUrl(url)
  if (!id) return
  if (!win || win.isDestroyed()) { pendingLink = id; return }
  if (win.isMinimized()) win.restore()
  win.focus()
  toWindow({ type: "open-app", id })
})

// Errors cross to the window as plain messages, not Electron's wrapped ones.
const answer = (fn) => async (_e, ...args) => {
  try { return { data: await fn(...args) } } catch (err) { return { error: err.message } }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: "Obstat",
    backgroundColor: "#0b0a12",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
    },
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://obstat/")) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (api.isSafeExternal(url)) shell.openExternal(url)
    return { action: "deny" }
  })
  // started by an obstat:// link: open straight on that app's page
  const first = pendingLink || deeplink.fromArgv(process.argv)
  pendingLink = null
  win.loadURL(first ? `${START}#/app/${first.split("/").map(encodeURIComponent).join("/")}` : START)
}

app.on("second-instance", (_e, argv) => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
  const id = deeplink.fromArgv(argv)
  if (id) toWindow({ type: "open-app", id })
})

// on a Mac, find what the person's own shell finds (Homebrew, npm tools) before anything runs
const shellPath = process.platform === "darwin" ? platformLib.loginPath().then((p) => { process.env.PATH = p }).catch(() => {}) : Promise.resolve()

app.whenReady().then(() => shellPath).then(() => {
  protocol.handle("app", (req) => {
    const { host, pathname } = new URL(req.url)
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)))
    if (host !== "obstat" || !file.startsWith(APP_DIR + path.sep)) return new Response("Not found", { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  home.ensure()
  home.log(`Obstat ${app.getVersion()} started`)

  const handle = (name, fn) => ipcMain.handle(`obstat:${name}`, answer(fn))
  handle("info", () => ({ version: app.getVersion(), home: home.root, platform: process.platform }))
  handle("list", async () => {
    try {
      const list = await api.list(net.fetch)
      // pins for reviewed apps installed before the list carried them (lib/pins.js)
      try { apps.setPins(list) } catch (err) { home.log(`pins: ${err.message}`) }
      return list
    } catch (err) {
      home.log(`list: ${err.message}`)
      throw err
    }
  })
  handle("check", async (url) => {
    const r = await api.check(url, net.fetch)
    home.log(`looked up ${r.entry.id}`)
    return r
  })
  handle("chat-channels", () => api.channels(net.fetch))
  handle("chat-read", (channel, after) => api.readChat(channel, after, net.fetch))
  // a 401 means the session ended (signed out elsewhere, or the account was deleted)
  const withAccount = async (fn) => {
    try { return await fn(account.token()) } catch (err) {
      if (/Sign in/.test(err.message)) account.clear()
      throw err
    }
  }
  handle("chat-send", (channel, text) => withAccount((t) => api.sendChat(channel, text, t, net.fetch)))
  handle("chat-report", (channel, id) => withAccount((t) => api.reportChat(channel, id, t, net.fetch)))
  handle("chat-mod", (action, channel, id) => withAccount((t) => api.modChat(action, channel, id, t, net.fetch)))
  // the Hub reads with the session when there is one, for your votes
  handle("hub-list", (query) => api.hubList(query, account.token(), net.fetch))
  handle("hub-post", (id) => api.hubPost(id, account.token(), net.fetch))
  handle("hub-create", (fields) => withAccount((t) => api.hubCreate(fields, t, net.fetch)))
  handle("hub-vote", (id, value) => withAccount((t) => api.hubVote(id, value, t, net.fetch)))
  handle("hub-comment", (id, text, parent) => withAccount((t) => api.hubComment(id, text, parent, t, net.fetch)))
  handle("hub-act", (action, id, cid) => withAccount((t) => api.hubAct(action, id, cid, t, net.fetch)))
  // the badge comes from the server each time, so taking it away works at once
  handle("account", async () => {
    if (!account.token()) return { name: null }
    const live = await api.accountInfo(account.token(), net.fetch).catch(() => null)
    return { name: account.name(), ...(typeof live?.badge === "string" ? { badge: live.badge } : {}) }
  })
  handle("account-code", (email) => api.sendCode(email, net.fetch))
  handle("account-verify", async (fields) => {
    const r = await api.verifyCode(fields || {}, net.fetch)
    account.save(r.token, r.account.name)
    home.log("signed in to chat")
    return { name: r.account.name }
  })
  handle("account-signout", async () => { await api.signOut(account.token(), net.fetch).catch(() => {}); account.clear() })
  handle("account-delete", async () => { await withAccount((t) => api.deleteAccount(t, net.fetch)); account.clear(); home.log("chat account deleted") })
  handle("news", () => api.news(net.fetch))
  handle("skills", () => skills.list())
  handle("skill-agents", () => skills.agents())
  handle("skill-read", (name) => skills.read(name))
  handle("skill-install", (name, agent) => { home.log(`skill ${name} -> ${agent}`); return skills.install(name, agent) })
  handle("skill-remove", (name, agent) => skills.remove(name, agent))
  handle("control", () => control.status())
  handle("set-control", async (on) => {
    home.setPref("agentLink", !!on)
    return on ? control.start() : control.stop()
  })
  handle("prefs", () => home.prefs())
  handle("set-pref", (key, value) => home.setPref(key, value))
  handle("logs", () => home.listLogs())
  handle("read-log", (rel) => home.readLog(rel))
  handle("clear-logs", () => home.clearLogs())
  handle("reset-cache", async () => { await home.resetCache(); home.log("cache reset") })
  // Reset bin: stop everything, delete Obstat's Python, Node, Git and uv; they download again on the next install
  handle("reset-bin", async () => {
    apps.stopAll(); sandbox.stopAll()
    await new Promise((r) => setTimeout(r, 3500))
    await fsp.rm(home.dir("bin"), { recursive: true, force: true, maxRetries: 3 })
    home.ensure()
    home.log("bin reset")
  })
  // Command path: which file a command name runs inside an app's shell
  handle("which", (cmd) => {
    const found = which(String(cmd || "").trim(), withPath(process.env, runtimes.paths()))
    return { path: found, obstat: !!found && found.startsWith(home.dir("bin")) }
  })
  handle("keys", () => keys.list())
  handle("add-key", (k) => { const r = keys.add(k || {}); home.log(`key ${r.name} saved`); return r })
  handle("remove-key", (id) => keys.remove(String(id)))
  handle("disk", () => home.disk())
  // Insights: worked out from what's on this computer, never sent anywhere (lib/usage.js).
  // Adding up the size of every app's files can take a while with big apps, so the page
  // gets everything else at once and the disk numbers from insights-disk when they're ready.
  handle("insights", async (days) => {
    const list = apps.list()
    const live = list.filter((a) => a.running?.script === "start.js").map((a) => ({ id: a.id, since: a.running.since }))
    const box = await sandbox.info()
    const names = Object.fromEntries(list.map((a) => [a.id, a.name]))
    return {
      usage: usage.summary({ days: [1, 7, 30, 90].includes(days) ? days : 30, live }),
      names,
      installed: list.filter((a) => a.installed).length,
      running: list.filter((a) => a.running).map((a) => a.name),
      runtimes: runtimes.status(),
      sandbox: { mode: box.mode, walls: box.walls, windows: box.windowsSandbox },
    }
  })
  // counted at most every 10 minutes; the page shows the last count while a new one runs
  let diskCount = null, diskAt = 0
  handle("insights-disk", async () => {
    if (!diskCount || Date.now() - diskAt > 10 * 60_000) {
      diskAt = Date.now()
      diskCount = home.disk().then((d) => ({ apps: d.used.apps, free: d.free })).catch(() => { diskAt = 0; return { apps: null, free: null } })
    }
    return diskCount
  })
  // looking for each tool starts a process, so the answer is kept for a minute
  let toolsSeen = null
  handle("tools", () => {
    if (!toolsSeen || Date.now() - toolsSeen.at > 60000) toolsSeen = { at: Date.now(), list: findTools().catch((e) => { toolsSeen = null; throw e }) }
    return toolsSeen.list
  })
  handle("open-folder", async (name) => {
    const err = await shell.openPath(home.dir(name))
    if (err) throw new Error(err)
  })
  // Autolaunch: start Obstat when the person signs in. Electron does this on Windows
  // and Mac; Linux gets an autostart file.
  const linuxStart = process.platform === "linux" ? platformLib.autostart() : null
  handle("autolaunch", () => (linuxStart ? linuxStart.enabled() : app.getLoginItemSettings().openAtLogin))
  handle("set-autolaunch", (on) => {
    if (linuxStart) linuxStart.set(!!on)
    else app.setLoginItemSettings({ openAtLogin: !!on })
    home.log(`start at sign-in ${on ? "on" : "off"}`)
    return linuxStart ? linuxStart.enabled() : app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle("obstat:open-external", (_e, url) => {
    if (api.isSafeExternal(url) || api.isLocalUrl(url)) return shell.openExternal(url)
  })

  // ---------- apps ----------
  // The window only names an app by id; what gets cloned, and at which commit,
  // always comes from the Obstat list or GitHub, never from the window.
  async function source(id) {
    const reviewed = (await api.list(net.fetch)).find((r) => r.id === id)
    if (reviewed) return { ...reviewed, url: `https://github.com/${reviewed.owner}/${reviewed.name}.git`, sha: reviewed.reviewedSha, reviewed: true }
    const r = await api.check(`github.com/${id}`, net.fetch)
    const e = r.entry
    return { ...e, url: `https://github.com/${e.owner}/${e.name}.git`, sha: null, reviewed: false, scripts: r.ready ? {} : r.scripts }
  }
  handle("apps", () => apps.list())
  handle("app", (id) => apps.get(id))
  // What's changed: GitHub's newest commits for the app's repo (kept for an hour
  // so browsing doesn't use up GitHub's allowance), falling back to the app's own
  // folder offline. For an installed app, `newer` counts the commits after the
  // installed one; for a reviewed app, `reviewed` marks the reviewed commit.
  const changesCache = new Map()
  async function githubCommits(repo) {
    const hit = changesCache.get(repo)
    if (hit && Date.now() - hit.at < 3600000) return hit.value
    const res = await net.fetch(`https://api.github.com/repos/${repo}/commits?per_page=30`, { headers: { accept: "application/vnd.github+json" } })
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub is busy right now. Try again in a bit." : "Couldn't get this app's changes from GitHub.")
    const list = await res.json()
    const value = (Array.isArray(list) ? list : []).filter((c) => c && /^[0-9a-f]{40}$/.test(c.sha)).map((c) => ({
      sha: c.sha, author: String(c.commit?.author?.name || "").slice(0, 80), at: String(c.commit?.author?.date || ""), message: String(c.commit?.message || "").split("\n")[0].slice(0, 200),
    }))
    changesCache.set(repo, { at: Date.now(), value })
    return value
  }
  handle("app-changes", async (id) => {
    if (typeof id !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(id)) throw new Error("That isn't an app id.")
    const mine = apps.get(id)
    const reviewed = (await api.list(net.fetch).catch(() => [])).find((r) => r.id.toLowerCase() === id.toLowerCase())
    const reviewedSha = reviewed?.reviewedSha && /^[0-9a-f]{40}$/.test(reviewed.reviewedSha) ? reviewed.reviewedSha : null
    const local = mine && (mine.installed || mine.local) ? await apps.changes(id) : null
    const repo = mine?.local ? null : (/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(String(mine?.url || "")) || [null, id])[1]
    let remote = null
    if (repo) try { remote = await githubCommits(repo) } catch (err) { if (!local) throw err }
    const out = local || { sections: [], current: null, reviewed: null }
    out.reviewed = reviewedSha || out.reviewed
    if (remote && remote.length) {
      out.sections = [{ title: out.sections.length > 1 ? "Launcher" : "Code", link: `https://github.com/${repo}`, commits: remote }, ...out.sections.slice(1)]
    }
    const first = out.sections[0]?.commits || []
    const at = out.current ? first.findIndex((c) => c.sha === out.current) : -1
    out.newer = out.current && first.length ? (at < 0 ? first.length : at) : 0
    return out
  })
  handle("app-icon", (id, url) => {
    const mine = typeof id === "string" && apps.get(id)
    const name = mine?.name || (typeof id === "string" ? id.split("/").pop() : null)
    // An app from the reviewed list shows the logo the list gives (checked by the team);
    // the logo in its folder is often a launcher's placeholder. Apps you made use their folder's.
    const folder = (mine?.installed || mine?.local) && !mine?.reviewed ? apps.appDir(id) : null
    return icons.get(folder, typeof url === "string" ? url : mine?.icon || null, name)
  })
  handle("runtimes", () => runtimes.status())
  // Microsoft's C++ tools, for apps whose packages build from source (see lib/cpptools.js)
  const cppTools = cppToolsLib.create(home, { fetchImpl: (url) => net.fetch(url), log: (line) => home.log(line) })
  handle("cpp-tools", () => cppTools.installed())
  handle("cpp-tools-install", () => cppTools.install())
  // Windows Sandbox: off by default on Windows Pro; Obstat can turn it on (see lib/winsandbox.js)
  const winSandbox = winSandboxLib.create({ log: (line) => home.log(line) })
  handle("win-sandbox", () => winSandbox.status())
  handle("win-sandbox-on", () => winSandbox.turnOn())
  // Divina, included free with Obstat (see lib/divina.js)
  handle("divina", () => divina.status())
  handle("divina-install", () => { viewer.close("divina"); return divina.install((got, total) => toWindow({ type: "divina", got, total })) })
  // starts Divina's own server if it isn't running, then shows its page inside Obstat
  handle("divina-show", async (bounds) => {
    const url = await divina.serve()
    viewer.show("divina", url, bounds).catch((err) => home.log(`divina: ${err.message}`))
    return { url }
  })
  handle("divina-stop", () => { viewer.close("divina"); return divina.stop() })
  handle("divina-window", () => divina.open())
  handle("divina-external", () => {
    const url = viewer.current("divina") || divina.running()
    if (url && api.isLocalUrl(url)) return shell.openExternal(url)
  })
  handle("divina-remove", () => { viewer.close("divina"); return divina.remove() })
  handle("divina-log", () => home.readLog("divina.log").catch(() => ({ text: "", size: 0 })))
  handle("divina-folder", async (which) => {
    const err = await shell.openPath(which === "data" ? divina.data() : divina.dir())
    if (err) throw new Error(err)
  })
  handle("app-fetch", async (id) => {
    const mine = apps.get(id)
    if (mine?.local) { await apps.fetchApp(mine, () => {}); return mine }
    const entry = await source(id)
    home.log(`fetching ${id}${entry.sha ? ` at ${entry.sha.slice(0, 7)}` : " (not reviewed)"}`)
    await apps.fetchApp(entry, (text) => win?.webContents.send("obstat:event", { type: "log", id, text }))
    return apps.get(id)
  })
  // Sandbox: test a repo before it's installed for real
  handle("sandbox-info", () => sandbox.info())
  handle("sandboxes", () => sandbox.listed())
  handle("sandbox-test", async (id) => {
    const entry = await source(id)
    home.log(`testing ${id} in the sandbox (${sandbox.mode()})`)
    return sandbox.test(entry, (text) => win?.webContents.send("obstat:event", { type: "log", id, text, sandbox: true }))
  })
  handle("sandbox-stop", (id) => sandbox.stop(id))
  handle("sandbox-delete", async (id) => { await sandbox.remove(id); home.log(`deleted the test of ${id}`) })
  handle("sandbox-keep", async (id) => {
    const commit = sandbox.testedCommit(id)
    const entry = await source(id)
    if (!entry.reviewed && commit) entry.sha = commit
    home.log(`keeping ${id}${commit ? ` at ${commit.slice(0, 7)}` : ""}`)
    await apps.fetchApp(entry, (text) => win?.webContents.send("obstat:event", { type: "log", id, text }))
    await sandbox.remove(id)
    return apps.get(id)
  })
  handle("app-preview", (id, script) => apps.preview(id, script))
  handle("app-run", async (id, script, token) => {
    home.log(`${id}: ${script}`)
    // install and reset steps only run as the plan people were shown
    if ((script === "install.js" || script === "reset.js") && typeof token !== "string") throw new Error("Look at the steps first, then run them from there.")
    return apps.run(id, script, typeof token === "string" ? token : null)
  })
  handle("app-stop", (id) => apps.stop(id))
  // Open a running app inside Obstat. The window names the app; the address
  // always comes from the app's own process, never from the window.
  handle("view-show", (id, bounds) => {
    const r = apps.get(id)?.running
    const url = r?.url || lastOpen.get(id)
    if (!url) throw new Error("This app isn't running yet.")
    viewer.show(id, url, bounds).catch((err) => home.log(`${id}: ${err.message}`))
    return { url: viewer.reachable(url) }
  })
  // Build a UI for an app that has no screen: Obstat's instant one, or a custom one by an AI agent
  handle("app-ui-detect", (id) => {
    const a = apps.get(id)
    if (!a?.installed) throw new Error("Install the app first.")
    return { found: buildUi.detect(apps.appDir(id)), has: require("node:fs").existsSync(path.join(apps.appDir(id), buildUi.LAUNCHER)) }
  })
  handle("app-build-ui", async (id, agent) => {
    const a = apps.get(id)
    if (!a?.installed) throw new Error("Install the app first.")
    if (a.running) throw new Error("Stop the app first.")
    const dir = apps.appDir(id)
    if (!agent) {
      const found = buildUi.build(dir, a)
      home.log(`${id}: built an Obstat UI around ${found.command.join(" ")}`)
      return { built: true, command: found.command }
    }
    const tool = (await findTools()).find((t) => t.id === agent && t.found && t.kind === "Terminal")
    if (!tool) throw new Error("That AI agent isn't installed.")
    await fsp.writeFile(path.join(dir, "OBSTAT_UI_TASK.md"), buildUi.agentTask(a, buildUi.detect(dir)))
    openIn(tool, dir, "Read OBSTAT_UI_TASK.md in this folder and build the UI it describes.")
    home.log(`${id}: asked ${tool.name} to build a UI`)
    return { agent: tool.name }
  })
  handle("update-state", () => updates.state())
  handle("update-check", () => updates.check())
  handle("update-install", () => updates.install())
  handle("view-place", (bounds) => viewer.place(bounds))
  handle("view-hide", () => viewer.hide())
  handle("view-act", (id, what) => viewer.act(id, what))
  handle("view-external", (id) => {
    const url = viewer.current(id) || apps.get(id)?.running?.url || lastOpen.get(id)
    if (url && api.isLocalUrl(url)) return shell.openExternal(viewer.reachable(url))
  })
  handle("app-remove", async (id) => { await apps.remove(id); home.log(`removed ${id}`) })
  handle("app-autostart", (id, on) => apps.setAutostart(id, on))
  handle("app-folder", async (id) => {
    const err = await shell.openPath(apps.appDir(id))
    if (err) throw new Error(err)
  })
  // Plugins: open an installed app's folder in an editor or a terminal tool
  handle("app-open-in", async (id, toolId) => {
    const tool = (await findTools()).find((t) => t.id === toolId && t.found)
    if (!tool) throw new Error("That tool isn't installed.")
    openIn(tool, apps.appDir(id))
  })
  handle("app-runs", (id) => apps.runOptions(id))
  handle("app-launchers", (id) => apps.launchers(id))
  handle("app-read-script", (id, name) => apps.readScript(id, name))
  handle("app-write-script", (id, name, text) => { apps.writeScript(id, name, text); home.log(`${id}: edited ${name}`) })
  handle("app-update", async (id) => {
    const entry = await source(id)
    home.log(`updating ${id}`)
    return apps.update(entry, (text) => win?.webContents.send("obstat:event", { type: "log", id, text }))
  })
  handle("app-reset", async (id) => { const r = await apps.reset(id); home.log(`reset ${id}`); return r })
  handle("app-copy", async (id) => { const r = await apps.copy(id); home.log(`copied ${id} to ${r.id}`); return r })
  // Create an app: a folder with the person's idea in OBSTAT_TASK.md, and an AI
  // coding agent opened there to build it. Their words stay in the file; the
  // agent is only ever given the fixed prompt below.
  handle("app-create", async ({ name, task, builder } = {}) => {
    task = String(task || "").trim()
    if (task.length < 10) throw new Error("Say a little more about what the app should do.")
    if (task.length > 4000) throw new Error("Keep the description under 4,000 characters.")
    const tools = (await findTools()).filter((t) => t.kind === "Terminal" && t.found)
    const tool = builder ? tools.find((t) => t.id === builder) : null
    if (builder && !tool) throw new Error("That AI agent isn't installed.")
    const a = apps.createLocal({ name, task, files: { "OBSTAT_TASK.md": taskFile(task) } })
    home.log(`created ${a.id}${tool ? ` with ${tool.name}` : ""}`)
    if (tool) openIn(tool, apps.appDir(a.id), BUILD_PROMPT)
    return a
  })

  createWindow()
  updates.start()

  // End apps a previous Obstat left running (so they don't hold their ports), then
  // Autolaunch: start the apps that asked to start with Obstat
  apps.cleanup().then((n) => { if (n) home.log(`ended ${n} app process${n > 1 ? "es" : ""} left from last time`) }).catch(() => {}).then(() => {
    for (const a of apps.list()) if (a.installed && a.autostart && a.scripts.includes("start.js")) apps.run(a.id, "start.js").catch(() => {})
  })
  if (home.prefs().agentLink) control.start().catch((e) => home.log(`control link: ${e.message}`))
})

const BUILD_PROMPT = "Read OBSTAT_TASK.md in this folder and build the app it describes."
// gemini needs -i to start interactive with a prompt
const PROMPT_FLAG = { gemini: "-i " }

// Opens a folder in an editor, or a terminal tool in it. `prompt` is fixed text, never the person's.
function openIn(tool, cwd, prompt) {
  const cmd = prompt && tool.kind === "Terminal" ? `${tool.cmd} ${PROMPT_FLAG[tool.id] || ""}"${prompt}"` : tool.cmd
  let child
  if (tool.kind === "Editor") {
    child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", tool.cmd, cwd], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn(tool.found, [cwd], { detached: true, stdio: "ignore" })
  } else if (process.platform === "win32") {
    child = spawn("cmd.exe", [`/c start "" cmd.exe /k ${cmd}`], { cwd, detached: true, stdio: "ignore", windowsVerbatimArguments: true })
  } else {
    const t = platformLib.terminal(cmd, cwd)
    if (!t) throw new Error("Obstat couldn't find a terminal app to open. Install one (like GNOME Terminal or Konsole) and try again.")
    child = spawn(t.file, t.args, { cwd, detached: true, stdio: "ignore" })
  }
  child.on("error", () => {})
  child.unref()
}

// What the agent reads: the idea, then how Obstat apps are put together
function taskFile(task) {
  const guide = skills.read("obstat-app-builder").replace(/^---[\s\S]*?---\s*/, "").split("## Talking to Obstat")[0]
  return `# Build this app for Obstat

## What it should do (from the person who asked)

${task}

## What to build

- Build it in this folder as a local app with a web page the person opens in their browser (Gradio or a small web server works well).
- Write install.js and start.js as described below, so Obstat can install and start it in one click.
- Keep it simple and working first. Explain any API key it needs; Obstat can hand keys to apps from Settings > Keys.
- When it's done, tell the person to go back to Obstat and click Install, then Start.

${guide.trim()}
`
}

app.on("before-quit", () => { apps.stopAll(); sandbox.stopAll(); control.stop(); divina.stop() })

app.on("window-all-closed", () => app.quit())
