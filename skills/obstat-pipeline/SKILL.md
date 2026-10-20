---
name: obstat-pipeline
description: "Run multi-step jobs across several Obstat apps, like script to voiceover to images to video, or transcribe then summarize then translate. Use when a task needs more than one app."
---

# Chain Obstat apps together

Combine the user's apps into one job, passing each step's output to the next.

## How to work

1. Plan the chain first and show it to the user, for example: chat model writes a 60-second script, voice app narrates it, image app makes 6 scenes, ffmpeg joins them into a video.
2. Check that every app in the chain is installed (`GET /apps`). Say which are missing before starting.
3. GPUs rarely fit several big models at once: start one app, finish its step, stop it, then start the next. Only keep two running together if the user's GPU has room.
4. Keep all files for one job in one folder, numbered by step (`1-script.txt`, `2-voice.wav`, `3-images/`, `4-final.mp4`), so any step can be redone without redoing the rest.
5. Use the matching Obstat skill for each step (obstat-image, obstat-voice, obstat-transcribe, obstat-chat-model, obstat-video) if it's installed.

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
