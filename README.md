<p align="center"><img src="build/icon.png" width="96" alt=""></p>

# Obstat

Obstat lets you install and run AI apps on your own computer in one click, with no terminal. It's coming soon for Windows, Mac and Linux, at [obstat.app](https://obstat.app).

- **Reviewed apps.** Every app on the Obstat list has been checked and tested by the Obstat team. Each one installs the exact version that was reviewed.
- **Any GitHub repo.** Paste a link and Obstat installs it in its own folder. You can try it in a sandbox first.
- **Runs inside Obstat.** Apps open in the Obstat window like a browser tab. They're kept apart from each other and from Obstat itself.
- **Build a UI.** If an app is only a command-line tool, Obstat makes a simple screen for it from its options. You can also ask Claude Code, Codex or Gemini CLI to build a custom one.
- **Skills.** AI agents on your PC can install and run apps through Obstat.
- **Updates itself.** New versions download in the background.

Inspired by [Pinokio](https://pinokio.co), and it runs Pinokio scripts.

## Run it from source

You need [Node.js](https://nodejs.org) 22 or newer.

```
npm ci
npm start             # open the app
npm test              # run the tests
npm run dist          # build the Windows installer into dist/
npm run dist:mac      # build the Mac .dmg files (Apple Silicon and Intel), on a Mac
npm run dist:linux    # build the Linux AppImage and .deb, on Linux
```

## Mac and Linux

The latest builds are on the [desktop-preview release](https://github.com/divinadevosai/obstat-desktop/releases/tag/desktop-preview).

- **Mac** (`Obstat-mac-arm64.dmg` for Apple Silicon, `Obstat-mac-x64.dmg` for Intel): Obstat isn't notarised by Apple yet, so the first time you open it macOS says it can't check it. Open **System Settings → Privacy & Security** and click **Open Anyway**.
- **Linux** (`Obstat-linux-amd64.deb` for Ubuntu and Debian; `Obstat-linux-x86_64.AppImage` for most other distributions): to run the AppImage, make it executable (`chmod +x`) and open it.

How they compare with Windows:

- **Sandbox:** Windows tests unreviewed repos in Windows Sandbox. Linux uses bubblewrap (install it with `sudo apt install bubblewrap` if it's missing) and a Mac uses Apple's own sandbox. The test can't see your files, Obstat's keys or chat sign-in, or anything else Obstat keeps, and can only change its own test folder. It can't reach other apps' servers on this computer either: on Linux it gets a network of its own whose only way out is Obstat's proxy to the internet; on a Mac only its own port on localhost is open (the one Obstat gives it in `PORT`; Gradio apps are told to use it), so an app that insists on another port of its own can't reach its own server in a Mac test. A Mac test also can't signal any other program (not even ones it started: Obstat ends those itself), so an app that restarts its own helper processes may not work in a Mac test. Without bubblewrap, Linux tests fall back to a plain test folder and the Sandbox page says so.
- **Runtimes:** Obstat downloads its own Python, Node, uv, git and (for apps that need it) ffmpeg on every system, each pinned and checked against its checksum.
- **Updates:** all three update themselves. The Mac app replaces itself after checking the download's checksum and Apple's code signature; it has to be in a folder you can change (Applications), not run from the `.dmg`. On Linux the AppImage and the `.deb` update through the same updater as Windows (the `.deb` asks for your password to install).
- **GPU:** NVIDIA cards are used on Linux. On Apple silicon, apps are told about Apple's GPU, as in Pinokio.
- **Keys:** on Linux, keys are encrypted with your desktop's keyring (GNOME Keyring or KWallet). Without one, Obstat won't save keys.
- **Ubuntu 24.04 and later:** use the `.deb`, which sets up the AppArmor profile Electron apps need there; the AppImage can't start without it.

## How it's put together

| Folder | What's in it |
|---|---|
| `main.js`, `preload.js` | Electron's main process, and the small bridge the window uses to talk to it |
| `app/` | The window: plain HTML, CSS and JavaScript, no framework |
| `lib/` | Everything else: installing (`apps.js`, `script.js`, `worker.js`), the in-app viewer (`viewer.js`), Build a UI (`buildui.js`, `ui-template/`), the sandbox, keys, skills, updates |
| `skills/` | The skills Obstat gives AI agents |
| `brand/` | Obstat's styles, logo and fonts, shared with obstat.app |

App scripts never run inside Obstat's own process. They run in a locked-down worker with no access to your keys.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a pull request. To report a security problem, see [SECURITY.md](SECURITY.md).

## Licence

The code is under the [MIT licence](LICENSE). The fonts in `brand/fonts` are under the SIL Open Font License. The Obstat name and logo belong to SWE3WE, so a fork should use its own name and logo.
