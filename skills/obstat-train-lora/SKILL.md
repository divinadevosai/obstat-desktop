---
name: obstat-train-lora
description: "Train a custom image style or character LoRA with FluxGym or another training app installed in Obstat: prepare the dataset, caption it, start training and watch progress."
---

# Train a LoRA with Obstat

Teach an image model a new style, product or character from the user's own pictures.

## Steps

1. Dataset: 10 to 30 sharp images of the subject in varied poses and backgrounds, all the user's own or ones they have rights to. Put them in one folder. Square-crop to 1024×1024 if you can.
2. Captions: one `.txt` per image with the same name, starting with a short unique trigger word (like `ohwx_sneaker`) and then a plain description. If the training app has auto-captioning, use it and then fix the captions.
3. Start the training app (FluxGym and similar apps are Gradio apps; `Client(url).view_api()` shows the training endpoint) or walk the user through its page if it has no usable API.
4. Sensible FLUX LoRA defaults: rank 16, about 1,500 steps for 20 images, learning rate 8e-4 or the app's default. Lower the resolution to 512 if the GPU has 12 GB or less.
5. Training takes a long time. Check `/logs/start` every few minutes and tell the user the current step and loss, not every line.
6. When it finishes, tell the user where the `.safetensors` file is and how to use the trigger word in an image app.

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
