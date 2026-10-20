---
name: obstat
description: "Start, stop and check the AI apps installed in Obstat Desktop, and find the right one for a job. Use whenever the user mentions Obstat or wants a local AI app running."
---

# Use Obstat apps

Use this to work with the apps the user installed in Obstat: image, voice, video, chat-model and training apps that run on their own PC.

## How to work

- Start with `GET /apps` to see what's installed and what's already running. Pick the app from its name and description; if two could do the job, ask which.
- Start an app only when the task needs it, and tell the user you're starting it, since it can use a lot of memory.
- Once it's running, its `url` is a normal web address on this PC. Most AI apps there have an API. For Gradio apps (most of them), install `gradio_client` with pip if needed, then `Client(url).view_api()` shows every endpoint and its inputs.
- If a start fails, read `/logs/start` and explain what went wrong in plain words before trying anything else.

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
