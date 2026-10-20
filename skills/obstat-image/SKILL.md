---
name: obstat-image
description: "Generate or batch-generate images with an image app installed in Obstat (AUTOMATIC1111, Forge, ComfyUI, Fooocus or any Gradio image app). Use for product shots, concept art, thumbnails, textures or variations."
---

# Make images with Obstat

Generate images on the user's own GPU through an Obstat image app, one at a time or hundreds in a batch.

## Steps

1. Find an image app with `GET /apps` and start it.
2. Work out which API it has from its id or by probing:
   - **AUTOMATIC1111 / Forge**: `POST {app}/sdapi/v1/txt2img` with JSON `{"prompt", "negative_prompt", "steps", "width", "height", "batch_size", "seed"}`. Images come back as base64 PNGs in `images`. If `/sdapi` returns 404, the app was started without `--api`, so tell the user.
   - **ComfyUI**: `POST {app}/prompt` with `{"prompt": <workflow in API format>}`, poll `GET {app}/history/<prompt_id>`, then download each output from `GET {app}/view?filename=...&subfolder=...&type=output`. Ask the user to export their workflow with "Save (API format)" if you need a specific one.
   - **Fooocus and other Gradio apps**: use `gradio_client` (`Client(url).view_api()`, then `predict`).
3. For a batch, write the prompts to `prompts.csv` first (one row per image: file name, prompt, seed) and show the user the first few before running hundreds.
4. Save images into a folder the user chooses, named after the prompt row, never over existing files. Keep `prompts.csv` next to them so any image can be remade.
5. Report how many images were made, where they are, and any that failed.

## Good defaults
- 1024×1024 for SDXL/FLUX models, 512×512 for SD 1.5; 25–30 steps.
- Fix the seed when the user wants variations of one idea; change only the prompt.

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
