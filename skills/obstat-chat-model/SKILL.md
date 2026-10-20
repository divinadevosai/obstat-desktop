---
name: obstat-chat-model
description: "Send prompts to a local language model running in Obstat (text-generation-webui, Ollama-style servers, LM Studio-style servers or any OpenAI-compatible app) for private drafting, summarizing or bulk text jobs."
---

# Use a local chat model with Obstat

Use a language model that runs on the user's own PC, for work that should stay private or that would be expensive in the cloud.

## Steps

1. Find a chat-model app with `GET /apps` and start it.
2. Try the APIs in this order:
   - OpenAI-compatible: `POST {app}/v1/chat/completions` with `{"model": ..., "messages": [...]}`. `GET {app}/v1/models` lists model names. text-generation-webui needs its `--api` flag for this.
   - Ollama-style: `POST {app}/api/chat` with `{"model", "messages", "stream": false}`; `GET {app}/api/tags` lists models.
   - Otherwise it's a Gradio app: `Client(url).view_api()`.
3. Local models are smaller than cloud ones: keep prompts short and specific, and give an example of the output you want.
4. For bulk jobs (summarize 500 files, tag a spreadsheet), run one item at a time, save results as you go, and resume from where you stopped if something fails.

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
