---
name: obstat-fix-install
description: "Diagnose why an app failed to install or start in Obstat by reading its logs, explain the cause in plain words, and fix it safely."
---

# Fix a failed Obstat install

Help when an app in Obstat won't install or start.

## Steps

1. `GET /apps` for the app's id and folder, then read `/logs/install` or `/logs/start`. The real error is usually the first `Error` or `Traceback` near the end, not the last line.
2. Match it to a known cause:
   - `No module named ...`: a package is missing from the app's environment (`env` folder inside the app folder). Install it into that environment, not system Python.
   - `Microsoft Visual C++ 14.0 or greater is required` / wheel build failed: a package has no ready-made build for this Python. Look for a prebuilt wheel or a pinned older version.
   - `CUDA out of memory`: the model is too big for the GPU. Suggest a smaller model, a lower resolution, or the app's low-VRAM option.
   - `Torch not compiled with CUDA enabled`: the CPU build of PyTorch got installed. Reinstall torch from the CUDA index that matches the GPU driver.
   - Port already in use: another copy is running. Stop it in Obstat.
3. Explain the cause and the fix to the user before changing anything. Change only files inside the app's folder, and never delete the user's models or outputs.
4. After a fix, start the app again through the control link and confirm it comes up.

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
