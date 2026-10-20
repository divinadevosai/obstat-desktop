// Obstat updates itself: it checks obstat.app for a newer version, downloads it in the
// background, and installs it when the person clicks Restart (or next time they quit).
// Only the installed Windows app does this; running from source never updates.
const CHECK_EVERY = 4 * 60 * 60 * 1000

function create(updater, { enabled, log = () => {}, emit = () => {}, beforeInstall = () => {} }) {
  let state = { status: enabled ? "idle" : "off", version: null, error: null }
  const set = (patch) => { state = { ...state, ...patch }; emit({ type: "update", ...state }) }

  if (enabled) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.logger = { info: (m) => log(`update: ${m}`), warn: (m) => log(`update: ${m}`), error: (m) => log(`update: ${m}`), debug() {} }
    updater.on("checking-for-update", () => set({ status: "checking", error: null }))
    updater.on("update-not-available", () => set({ status: "current" }))
    updater.on("update-available", (i) => set({ status: "downloading", version: i.version }))
    updater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }))
    updater.on("update-downloaded", (i) => set({ status: "ready", version: i.version }))
    updater.on("error", (err) => {
      log(`update: ${err?.message}`)
      set({ status: "failed", error: "Couldn't check for updates. Obstat tries again later." })
    })
  }

  async function check() {
    if (!enabled || state.status === "downloading" || state.status === "ready") return state
    try { await updater.checkForUpdates() } catch (err) { log(`update: ${err.message}`) }
    return state
  }

  function start() {
    if (!enabled) return
    setTimeout(check, 30_000) // let the app settle first
    setInterval(check, CHECK_EVERY).unref?.()
  }

  function install() {
    if (state.status !== "ready") return false
    beforeInstall()
    updater.quitAndInstall(true, true) // silent install, then open Obstat again
    return true
  }

  return { state: () => state, check, start, install }
}

module.exports = { create }
