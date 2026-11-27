// Obstat on a phone (lib/phone.js serves this): a remote control for the computer at
// home. Every request and answer is sealed with this phone's own key (NaCl secretbox),
// which came in the pairing link after the "#" and never goes over the network.
"use strict"
;(() => {
  const $ = (id) => document.getElementById(id)
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue
      if (k === "text") n.textContent = v
      else if (k === "class") n.className = v
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v)
      else n.setAttribute(k, v === true ? "" : v)
    }
    for (const k of kids) if (k) n.append(k)
    return n
  }
  const app = $("app"), status = $("status")

  // ---------- the key ----------
  const STORE = "obstat-phone"
  const fromB64 = (s) => { const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
  const toB64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }
  let pairing = null
  try { pairing = JSON.parse(localStorage.getItem(STORE) || "null") } catch {}
  const hash = /^#([\w-]{8,40})\.([\w-]{40,50})$/.exec(location.hash)
  if (hash) {
    pairing = { id: hash[1], key: hash[2] }
    try { localStorage.setItem(STORE, JSON.stringify(pairing)) } catch {}
    // the key out of the address bar (and out of anything that might be shared or synced)
    history.replaceState(null, "", location.pathname)
  }
  const key = pairing ? fromB64(pairing.key) : null

  async function call(op, args = {}) {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
    const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify({ t: Date.now(), op, args })), nonce, key)
    let res
    try { res = await fetch("api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ d: pairing.id, n: toB64(nonce), c: toB64(box) }), cache: "no-store" }) } catch { throw new Error("Can't reach your computer. Is it on, with Obstat open, and is this phone on the same Wi-Fi?") }
    if (res.status === 401) throw Object.assign(new Error("This phone isn't paired any more. Pair it again from Obstat on your computer."), { unpaired: true })
    if (res.status === 429) throw new Error("Too many tries. Wait a minute.")
    if (!res.ok) throw new Error(`Your computer said ${res.status}.`)
    const env = await res.json()
    const plain = nacl.secretbox.open(fromB64(env.c), fromB64(env.n), key)
    if (!plain) throw new Error("The answer didn't open with this phone's key.")
    const msg = JSON.parse(new TextDecoder().decode(plain))
    if (msg.error) throw new Error(msg.error)
    return msg.result
  }

  // ---------- files ----------
  const read = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(new Uint8Array(r.result)); r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`)); r.readAsArrayBuffer(file) })
  async function send(file) {
    if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} is over 50 MB.`)
    const { upload } = await call("upload", { name: file.name, data: toB64(await read(file)) })
    return upload
  }

  // ---------- what's running ----------
  let log, results, stopBtn, since = 0, timer = null
  function line(e) {
    if (e.type === "start") return el("li", { text: e.planner === "recipe" ? `Running “${e.model}”` : `Autopilot is working${e.planner === "claude" ? " (planning with Claude)" : e.planner === "ollama" ? ` (planning with ${e.model} on your computer)` : ""}` })
    if (e.type === "say") return el("li", { text: e.text })
    if (e.type === "step") return el("li", { text: `Running ${String(e.tool || "").replace("__", " · ")}` })
    if (e.type === "result") return e.error ? el("li", { class: "err", text: `Didn't work: ${e.text}` }) : null
    if (e.type === "note") return el("li", { class: "dim", text: e.text })
    if (e.type === "file") { showFile(e); return el("li", { text: `Made ${e.name}${e.app ? ` with ${e.app}` : ""}` }) }
    if (e.type === "receipt") return el("li", { class: "dim", text: `Receipt: ${e.summary || ""}` })
    if (e.type === "done") return el("li", { class: "done", text: e.text || "Done." })
    if (e.type === "error") return el("li", { class: "err", text: `Stopped: ${e.text}` })
    return null
  }
  function showFile(e) {
    const box = el("div", { class: "result" })
    const btn = el("button", { class: "ghost", text: `Get ${e.name}`, onclick: async () => {
      btn.disabled = true; btn.textContent = "Getting it…"
      try {
        const f = await call("file", { path: e.path })
        const url = URL.createObjectURL(new Blob([fromB64(f.data)], { type: f.type }))
        const kind = f.type.split("/")[0]
        box.replaceChildren(el("p", { text: f.name }),
          kind === "audio" ? el("audio", { controls: true, src: url }) : kind === "image" ? el("img", { src: url, alt: f.name }) : kind === "video" ? el("video", { controls: true, playsinline: true, src: url }) : null,
          el("p", {}, el("a", { href: url, download: f.name, text: "Save to this phone" })))
      } catch (err) { btn.disabled = false; btn.textContent = `Get ${e.name}`; box.append(el("p", { class: "err", text: err.message })) }
    } })
    box.append(btn)
    results.append(box)
  }
  async function watch() {
    clearTimeout(timer)
    try {
      const p = await call("progress", { since })
      for (const e of p.events) { const li = line(e); if (li) log.append(li) }
      since = p.next
      stopBtn.hidden = !p.running
      if (p.running) timer = setTimeout(watch, 1500)
      else for (const b of document.querySelectorAll("button.go")) b.disabled = b.dataset.off === "1"
    } catch (err) { log.append(el("li", { class: "err", text: err.message })); timer = setTimeout(watch, 4000) }
  }
  async function begin(op, args, files, note) {
    for (const b of document.querySelectorAll("button.go")) b.disabled = true
    note.textContent = ""
    try {
      const sent = []
      for (const f of files) { note.textContent = `Sending ${f.name}…`; sent.push(await send(f)) }
      note.textContent = ""
      log.replaceChildren(); results.replaceChildren(); since = 0
      await call(op, { ...args, files: sent })
      $("now").hidden = false
      $("now").scrollIntoView({ behavior: "smooth", block: "start" })
      watch()
    } catch (err) {
      note.textContent = err.message
      for (const b of document.querySelectorAll("button.go")) b.disabled = b.dataset.off === "1"
    }
  }

  // ---------- the page ----------
  async function show() {
    if (!key) {
      status.textContent = "Not paired"
      app.replaceChildren(el("section", {}, el("h2", { text: "Pair this phone" }), el("p", { text: "On your computer, open Obstat, go to Tools › Home Server, turn on phone access and press “Pair a phone”. Then scan the code with this phone's camera." })))
      return
    }
    let hello, list
    try { hello = await call("hello"); list = await call("list") } catch (err) {
      status.textContent = "Not connected"
      app.replaceChildren(el("section", {}, el("p", { class: "err", text: err.message }), el("div", { class: "row" }, el("button", { text: "Try again", onclick: show }))))
      return
    }
    status.textContent = hello.computer
    status.className = "status ok"
    const parts = []

    if (list.autopilot) {
      const goal = el("textarea", { placeholder: "e.g. Read this out in a calm voice and make it an mp3", "aria-label": "What should Autopilot do?", maxlength: "4000" })
      const files = el("input", { type: "file", multiple: true, "aria-label": "Files for Autopilot" })
      const note = el("p", { class: "dim", role: "status" })
      const go = el("button", { class: "go", text: "Do it", "data-off": list.autopilot.ready ? "0" : "1", disabled: !list.autopilot.ready || list.busy, onclick: () => {
        if (!goal.value.trim()) { note.textContent = "Say what you'd like done."; return }
        begin("autopilot", { goal: goal.value }, [...files.files], note)
      } })
      parts.push(el("section", {}, el("h2", { text: "Ask Autopilot" }),
        !list.autopilot.ready && el("p", { class: "dim", text: `Not set up on your computer yet. ${list.autopilot.reason || ""}`.trim() }),
        goal, el("label", { text: "Files (optional)" }), files, el("div", { class: "row" }, go), note))
    }

    if (list.recipes.length) {
      parts.push(el("section", {}, el("h2", { text: "Recipes" }), ...list.recipes.map((r) => {
        const pickers = r.files.map((label) => el("input", { type: "file", "aria-label": label }))
        const texts = r.text.map((t) => { const i = el(t.value.length > 60 ? "textarea" : "input", { type: "text", "aria-label": t.label }); i.value = t.value; i.dataset.key = t.key; return i })
        const note = el("p", { class: "dim", role: "status" })
        const go = el("button", { class: "go", text: "Run", disabled: list.busy, onclick: () => {
          const missing = r.files.filter((_, k) => !pickers[k].files[0])
          if (missing.length) { note.textContent = `Choose ${missing.join(", ")} first.`; return }
          const text = {}
          for (const i of texts) if (i.value !== r.text.find((t) => t.key === i.dataset.key).value) text[i.dataset.key] = i.value
          begin("recipe", { id: r.id, text }, pickers.map((p) => p.files[0]), note)
        } })
        return el("div", { class: "recipe" }, el("h3", { text: r.name }), r.about && r.about !== r.name && el("p", { class: "dim", text: r.about }),
          ...r.files.flatMap((label, k) => [el("label", { text: label }), pickers[k]]),
          ...r.text.flatMap((t, k) => [el("label", { text: t.label }), texts[k]]),
          el("div", { class: "row" }, go), note)
      })))
    } else if (hello.can.recipes) {
      parts.push(el("section", {}, el("h2", { text: "Recipes" }), el("p", { class: "dim", text: "No recipes yet. When an Autopilot run works on your computer, keep it as a recipe and it shows here." })))
    }

    log = el("ol", { class: "log", "aria-live": "polite" })
    results = el("div", {})
    stopBtn = el("button", { class: "ghost", text: "Stop", hidden: true, onclick: () => call("stop").catch(() => {}) })
    parts.push(el("section", { id: "now", hidden: !list.busy }, el("h2", { text: "Now" }), log, results, el("div", { class: "row" }, stopBtn)))
    if (!parts.length) parts.push(el("section", {}, el("p", { text: "This phone isn't allowed to do anything yet. Change that on your computer, in Tools › Home Server." })))
    app.replaceChildren(...parts)
    if (list.busy) watch()
  }
  show()
})()
