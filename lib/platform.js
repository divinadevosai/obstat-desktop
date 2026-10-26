// What differs between Windows, Mac and Linux outside the app scripts themselves:
// the PATH a Mac app starts with, opening a terminal window, and starting with the
// computer on Linux (Electron's login items only cover Windows and Mac).
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFile } = require("node:child_process")
const { which } = require("./env")

// A Mac app opened from Finder or the Dock gets only /usr/bin:/bin:/usr/sbin:/sbin,
// so nothing installed with Homebrew (ffmpeg) or npm (claude, codex) is found. Ask the
// person's login shell for its PATH, like Terminal would have, plus Homebrew's folders.
const MARK = "__OBSTAT_PATH__"
const MAC_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
function loginPath({ platform = process.platform, env = process.env, run = execFile } = {}) {
  if (platform !== "darwin") return Promise.resolve(env.PATH || "")
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : "/bin/zsh"
  return new Promise((resolve) => {
    run(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], { timeout: 5000, env }, (err, out) => {
      const found = !err && new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(String(out || ""))
      const dirs = [...(found ? found[1].split(":") : []), ...String(env.PATH || "").split(":"), ...MAC_DIRS, path.join(env.HOME || os.homedir(), ".local/bin")]
      resolve([...new Set(dirs.filter((d) => d && path.isAbsolute(d)))].join(":"))
    })
  })
}

// How to open a terminal window in `cwd` that runs `cmd` and then stays open.
// null when no terminal is found (Linux without any of the usual ones).
const LINUX_TERMINALS = [
  ["x-terminal-emulator", (c) => ["-e", "sh", "-c", c]],
  ["gnome-terminal", (c) => ["--", "sh", "-c", c]],
  ["konsole", (c) => ["-e", "sh", "-c", c]],
  ["xfce4-terminal", (c) => ["-x", "sh", "-c", c]],
  ["kitty", (c) => ["sh", "-c", c]],
  ["alacritty", (c) => ["-e", "sh", "-c", c]],
  ["xterm", (c) => ["-e", "sh", "-c", c]],
]
function terminal(cmd, cwd, { platform = process.platform, env = process.env, find = which } = {}) {
  const keepOpen = `${cmd}; exec "\${SHELL:-sh}"`
  if (platform === "darwin") {
    // the folder and command go in as arguments, so nothing in them is read as AppleScript
    return {
      file: "osascript",
      args: [
        "-e", "on run argv",
        "-e", 'tell application "Terminal" to do script ("cd " & quoted form of item 1 of argv & " && " & item 2 of argv)',
        "-e", 'tell application "Terminal" to activate',
        "-e", "end run",
        cwd, keepOpen,
      ],
    }
  }
  for (const [name, args] of LINUX_TERMINALS) {
    const file = find(name, env, platform)
    if (file) return { file, args: args(keepOpen) }
  }
  return null
}

// Linux: a .desktop file in ~/.config/autostart, which GNOME, KDE and the rest read at sign-in.
// An AppImage runs from a temporary mount, so its own path ($APPIMAGE) is the one to start.
function autostart({ env = process.env, execPath = process.execPath } = {}) {
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "autostart")
  const file = path.join(dir, "obstat.desktop")
  const exe = env.APPIMAGE || execPath
  return {
    file,
    enabled: () => fs.existsSync(file),
    set(on) {
      if (!on) { fs.rmSync(file, { force: true }); return false }
      fs.mkdirSync(dir, { recursive: true })
      // desktop-entry quoting: the path in double quotes, with \ " ` $ escaped
      const quoted = `"${exe.replace(/[\\"`$]/g, "\\$&")}"`
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Obstat\nExec=${quoted}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`)
      return true
    },
  }
}

module.exports = { loginPath, terminal, autostart, LINUX_TERMINALS }
