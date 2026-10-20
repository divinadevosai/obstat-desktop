---
name: obstat-app-builder
description: "Write Obstat install.js and start.js scripts for a GitHub repo so it installs and runs in one click. Use when the user wants to package a project for Obstat or submit it to the Obstat list."
---

# Make a repo Obstat-ready

Obstat runs apps from two small scripts in the repo: `install.js` and `start.js`. They use a subset of Pinokio's script format, so Pinokio scripts mostly work as they are.

## The format

Each file exports `{ run: [ steps ] }`. `start.js` adds `daemon: true` so the app keeps running. Steps Obstat supports:
- `shell.run` with `params.message` (one command or a list), optional `path` (folder inside the app), `venv` (a folder name: Obstat creates a Python virtual environment there and runs inside it), `env` (extra variables) and `on` (a list of `{ event: "/regex/", done: true }`: the step finishes when the output matches)
- `local.set` to remember a value, like the app's `url`
- `script.start` to run another script in the repo
- `fs.download`, `fs.copy` (both paths inside the app), `hf.download` (`{ _: ["org/model"], "local-dir": "models" }`), `jump`, `input`, `notify`, `web.open`
- `proxy.start`/`proxy.stop` are skipped: Obstat keeps apps on this PC.
Templates go in `{{ }}`: `{{port}}` (a free port), `{{platform}}` (`win32`, `darwin`, `linux`), `{{gpu}}` (`nvidia` or `none`), `{{kernel.gpu_model}}` (the NVIDIA card's name), `{{cwd}}`, `{{exists('app')}}`, `{{path.resolve(cwd, 'app')}}`, `{{self.…}}` (the script itself) and `{{input.event[1]}}` (the first group of the last `on` match). A step can have `when: "{{platform === 'win32'}}"`.

A script may also be a function of kernel, `module.exports = async (kernel) => ({ run: [...] })`, and may `require` .js or .json files inside the app (like `./config.js`). `kernel` has `platform`, `arch`, `gpu`, `gpu_model`, `gpus`, `port()`, `path()` and `exists()`; nothing else from Node is available.

## A typical Python web app

```js
// install.js
module.exports = { run: [{ method: "shell.run", params: { venv: "env", message: ["uv pip install -r requirements.txt"] } }] }
// start.js
module.exports = { daemon: true, run: [
  { method: "shell.run", params: { venv: "env", message: ["python app.py --port {{port}}"], on: [{ event: "/(http:\\/\\/[0-9.:]+)/", done: true }] } },
  { method: "local.set", params: { url: "{{input.event[1]}}" } },
] }
```

## Rules
- Obstat already provides Python 3.11, Node 22, Git and uv. Use `uv pip install` for speed.
- Pin the PyTorch build per GPU with `when` steps (CUDA for `nvidia`, CPU otherwise).
- Obstat shows every command to the user before running it and flags risky ones, such as `rm -rf`, `curl | sh` and `sudo`. Don't use those.
- To get on the reviewed Obstat list, push the scripts and submit the repo at obstat.app.

## Talking to Obstat

Obstat Desktop runs the apps. You control it through its local control link:

1. Read the control file. On Windows it's `%USERPROFILE%\obstat\control.json`; on macOS and Linux it's `~/obstat/control.json`. It holds `url` and `token`.
   If the file is missing, tell the user to open Obstat, go to **Skills**, and turn on **Let AI agents use Obstat**. Don't try to start Obstat yourself.
2. Send every request with the header `Authorization: Bearer <token>`. Never print the token or write it into files you create.
3. Requests (app ids look like `owner/name`, all lower case):
   - `GET {url}/apps` lists installed apps: `id`, `name`, `installed`, `running`, `url` (the app's own web address once it's running) and `folder`.
   - `POST {url}/apps/<owner>/<name>/start` starts the app and waits until its web page is up, then returns it with its `url`. Starting a big model can take minutes, so allow up to 10 minutes.
   - `POST {url}/apps/<owner>/<name>/stop` stops it and everything it started.
   - `GET {url}/apps/<owner>/<name>/logs/start` (or `/logs/install`) returns the last lines of that log as `text`.
4. Use `curl` or Python's `urllib`. Example:
   `curl -s -X POST -H "Authorization: Bearer $TOKEN" "$URL/apps/cocktailpeanut/fluxgym/start"`

If the app the user needs isn't installed, say which kind of app would do it and ask them to install one from Obstat's Discover page. Don't install apps yourself.
Stop apps you started when the job is done, unless the user wants them left on: big models hold a lot of GPU memory.
