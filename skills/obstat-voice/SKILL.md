---
name: obstat-voice
description: "Turn text into speech, clone a voice from a sample, or make a narrated voiceover with a voice app installed in Obstat (OpenVoice, F5-TTS, XTTS, Bark, VibeVoice or any Gradio TTS app)."
---

# Voiceovers and voice cloning with Obstat

Make speech on the user's own PC with an Obstat voice app.

## Steps

1. Find a voice or TTS app with `GET /apps` and start it.
2. Most are Gradio apps: `Client(url).view_api()` shows the text, voice-sample and settings inputs. Pass files with `gradio_client.handle_file(path)`.
3. Split long scripts at sentence ends into chunks of about 200 characters, generate each, then join them with short pauses (ffmpeg's `concat` works if it's installed). Long single requests often fail or drift.
4. Save as WAV first (lossless), and make an MP3 too if the user wants a small file.
5. Voice cloning: only clone a voice the user says they have the right to use, like their own. If they ask to imitate someone else, say you can't.

Report the file paths and the total length.

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
