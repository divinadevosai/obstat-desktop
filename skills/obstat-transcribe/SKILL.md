---
name: obstat-transcribe
description: "Transcribe audio or video to text, timestamps or SRT subtitles with a speech-to-text app installed in Obstat (Whisper, WhisperX, faster-whisper or any Gradio transcription app)."
---

# Transcribe and subtitle with Obstat

Turn recordings into text and subtitles locally, so nothing is uploaded anywhere.

## Steps

1. Find a Whisper-style app with `GET /apps` and start it.
2. For video files, pull the audio out first if ffmpeg is installed: `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 audio.wav`.
3. Call the app's API (Gradio: `Client(url).view_api()`; pick the endpoint that returns segments or SRT). Choose the language if the user knows it; auto-detect is slower and can guess wrong on short clips.
4. Save `name.txt` (plain text) and `name.srt` (subtitles) next to the original. If the app only returns segments, build the SRT yourself: `index`, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, then the text.
5. For a folder of files, process them one by one and keep going if one fails; list failures at the end.

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
