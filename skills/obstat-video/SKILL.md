---
name: obstat-video
description: "Generate short video clips from text or images with a video app installed in Obstat (Wan, LTX-Video, HunyuanVideo or any Gradio video app), and stitch clips together."
---

# Make video with Obstat

Make video clips on the user's own GPU.

## Steps

1. Find a video app with `GET /apps` and start it. Check that the GPU has enough memory: most need 12 to 24 GB, and the app's description usually says.
2. Use its Gradio API (`Client(url).view_api()`). Text-to-video takes a prompt; image-to-video takes a start image too, which usually gives more control.
3. Start with a short, low-resolution test clip to check the look, then make the final ones. Clips take minutes each, so tell the user before starting a long batch.
4. Save every clip as MP4 with its prompt in the file name or a `clips.csv`.
5. To join clips, use ffmpeg if it's installed: write `file 'a.mp4'` lines to `list.txt`, then `ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`.

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
