// Obstat Desktop window: a sidebar of sections and one view at a time, picked by the URL hash.
// Repo data comes from strangers, so everything is built with textContent.

const $ = (id) => document.getElementById(id)
const view = $("view"), online = $("online")
let repos = null, listError = null, info = {}, poll = null, current = null
const progressSeen = {}
const pasted = new Map() // repos looked up this session, by id

function el(tag, attrs = {}, ...kids) {
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

async function ask(what, ...args) {
  const { data, error } = await window.obstat[what](...args)
  if (error) throw new Error(error)
  return data
}

const go = (hash) => { location.hash = hash }
const appHash = (e) => `#/app/${encodeURIComponent(e.owner)}/${encodeURIComponent(e.name)}`
const runHash = (id) => `#/run/${encodeURIComponent(id)}`
const stars = (n) => `★ ${(n || 0).toLocaleString("en-GB")}`
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
// The app's own logo when it has one (from its folder or its GitHub repo), else its first letter
const icons = new Map()
function mark(name, app) {
  const m = el("div", { class: "mark", "aria-hidden": "true", text: name.slice(0, 1).toUpperCase() })
  if (app?.id) {
    const key = `${app.id}|${app.icon || ""}|${!!app.installed}`
    if (!icons.has(key)) icons.set(key, ask("appIcon", app.id, app.icon || null).catch(() => null))
    icons.get(key).then((src) => { if (src) { m.textContent = ""; m.classList.add("has-img"); m.append(el("img", { src, alt: "" })) } })
  }
  return m
}
const page = (title, sub, ...kids) => [el("h1", { text: title }), sub && el("p", { class: "sub", text: sub }), ...kids]
const soon = (text) => el("p", { class: "soon", text })
const SVG = "http://www.w3.org/2000/svg"
const ICONS = {
  play: "M8 5v14l11-7z", stop: "M7 7h10v10H7z", open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  install: "M12 4v11M7 10l5 5 5-5M5 20h14", update: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4", reset: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4",
  folder: "M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z", code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4", back: "M10 6l-6 6 6 6M4 12h16", prev: "M15 5l-7 7 7 7", next: "M9 5l7 7-7 7", copy: "M8 8h11v11H8zM5 16V5h11", trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1", shield: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z", sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  chat: "M4 5h16v11H9l-5 4z", news: "M4 10v4h3l7 4V6L7 10zM17 9a4 4 0 0 1 0 6", disk: "M4 6h16v12H4zM4 14h16M8 17h.01", logs: "M6 4h9l3 3v13H6zM9 10h6M9 14h6M9 18h4",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5", server: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01", power: "M12 3v8M7 6a7 7 0 1 0 10 0",
  doc: "M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM14 3.5V8h4M9 12h6M9 15.5h6",
  lock: "M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z", key: "M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 12l8-8M16 7l2 2", github: "M12 3a9 9 0 0 0-2.8 17.5v-3c-2.5.5-3-1-3.2-1.6M14.8 20.5v-3.3c0-1 .3-1.6-.6-2.4 2.6-.3 4.8-1.2 4.8-5.3a4 4 0 0 0-1.1-2.8 3.6 3.6 0 0 0-.1-2.8s-.9-.3-3 1.1a10 10 0 0 0-5.4 0C7.4 3.6 6.5 3.9 6.5 3.9a3.6 3.6 0 0 0-.1 2.8 4 4 0 0 0-1.1 2.8c0 4.1 2.2 5 4.8 5.3",
}
function icon(name) {
  const svg = document.createElementNS(SVG, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("aria-hidden", "true")
  const p = document.createElementNS(SVG, "path")
  p.setAttribute("d", ICONS[name])
  svg.append(p)
  return svg
}
const STATUS = { ready: "Downloaded", busy: "Installing", installed: "Installed", running: "Running", opening: "Opening Windows Sandbox", installing: "Installing", starting: "Starting", finished: "Finished", failed: "Failed" }

async function loadList() {
  online.textContent = "Connecting…"
  online.className = "online"
  try {
    repos = await ask("list")
    listError = null
    online.textContent = "Obstat list online"
    online.classList.add("ok")
  } catch (e) {
    repos = repos || []
    listError = e.message
    online.textContent = "Offline"
    online.classList.add("bad")
  }
}

// ---------- views ----------

function row(r) {
  const open = () => go(appHash(r))
  return el("div", { class: "row", role: "link", tabindex: "0", onclick: open, onkeydown: (e) => { if (e.key === "Enter") open() } },
    mark(r.name, r),
    el("h3", { text: r.name }, el("small", { text: r.owner })),
    el("div", { class: "meta" },
      r.reviewedAt ? el("span", { class: "badge ok", text: `${r.testedAt ? "Reviewed and tested" : "Reviewed"} ${day(r.reviewedAt)}` }) : el("span", { class: "badge warn", text: "Not reviewed" }),
      el("span", { text: stars(r.stars) }),
      r.language && el("span", { text: r.language })),
    el("p", { text: r.description || "No description." }))
}

function emptyBox(title, text, ...buttons) {
  return el("div", { class: "empty-box" }, el("h2", { text: title }), el("p", { text }), buttons.length && el("div", { class: "actions" }, ...buttons))
}
const linkBtn = (text, hash, ghost) => el("a", { class: ghost ? "btn ghost" : "btn", href: hash, text })

const views = {
  home: () => homeView(),
  run: (id) => runView(id),
  create: () => createView(),
  tools: () => toolsView(),
  help: () => helpView(),

  apps: async () => {
    const mine = (await ask("apps")).filter((a) => a.installed || a.running || a.local)
    if (!mine.length) return page("My apps", "Apps you install live here, each in its own folder.",
      emptyBox("Nothing installed yet", "Pick a reviewed app, or add any GitHub repo and look at its install steps first.",
        linkBtn("Discover apps", "#/discover"), linkBtn("Add a repo", "#/add", true)))
    return page("My apps", "Apps you install live here, each in its own folder.",
      el("div", { class: "rowlist" }, ...mine.map((a) => {
        const r = row({ ...a, reviewedAt: null })
        const meta = r.querySelector(".meta")
        meta.replaceChildren(
          a.running ? el("span", { class: "badge ok", text: a.running.url ? "Running" : "Busy" }) : el("span", { class: "badge", text: a.installed ? "Installed" : "Not installed yet" }),
          a.local ? el("span", { class: "badge", text: a.copiedFrom ? "Your copy" : "Made by you" }) : a.reviewed ? el("span", { class: "badge ok", text: "Reviewed" }) : el("span", { class: "badge warn", text: "Not reviewed" }))
        return r
      })))
  },

  discover: (term = "") => {
    const q = el("input", { type: "search", placeholder: "Search apps", "aria-label": "Search apps", value: term })
    const sort = el("select", { "aria-label": "Sort" }, el("option", { value: "new", text: "Newest" }), el("option", { value: "stars", text: "Most stars" }))
    const list = el("div", { class: "rowlist" })
    const draw = () => {
      const term = q.value.trim().toLowerCase()
      const shown = repos
        .filter((r) => !term || `${r.owner} ${r.name} ${r.description} ${r.language || ""}`.toLowerCase().includes(term))
        .sort(sort.value === "stars" ? (a, b) => b.stars - a.stars : () => 0)
      list.replaceChildren(...(shown.length ? shown.map(row) : [
        listError ? emptyBox("Couldn't load the list", listError)
          : repos.length ? el("p", { class: "muted", text: "Nothing matches that search." })
          : emptyBox("No reviewed apps yet", "Add any GitHub repo to try it in the sandbox.", linkBtn("Add a repo", "#/add")),
      ]))
    }
    q.addEventListener("input", draw)
    sort.addEventListener("change", draw)
    draw()
    return page("Discover", "Every app here was reviewed at an exact commit. If the repo changes, it comes off the list until it's checked again.",
      el("div", { class: "listbar" }, q, sort), list)
  },

  add: (url = "") => {
    const input = el("input", { type: "text", placeholder: "github.com/owner/repo", autocomplete: "off", spellcheck: "false", "aria-label": "GitHub repo", value: url })
    const status = el("p", { class: "status", role: "status", "aria-live": "polite" })
    const btn = el("button", { class: "btn", text: "Look it up" })
    const run = async () => {
      const url = input.value.trim()
      if (!url) return input.focus()
      btn.disabled = true
      status.className = "status"
      status.textContent = "Looking it up on GitHub…"
      try {
        const r = await ask("check", url)
        pasted.set(r.entry.id, r)
        go(appHash(r.entry))
      } catch (e) {
        status.textContent = e.message
        status.classList.add("err")
        btn.disabled = false
      }
    }
    btn.addEventListener("click", run)
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") run() })
    setTimeout(() => { input.focus(); if (url) run() })
    return page("Add a repo", "Paste any public GitHub repo. It stays private to you, and you can test it in a throwaway sandbox before it touches your files.",
      el("div", { class: "bar" }, input, btn), status)
  },

  app: async (owner, name) => {
    const id = `${owner}/${name}`.toLowerCase()
    let reviewed = repos.find((r) => r.id === id), check = pasted.get(id)
    const local = await ask("app", id)
    const test = local?.installed ? null : (await ask("sandboxes").catch(() => [])).find((t) => t.id === id) || null
    const box = await ask("sandboxInfo").catch(() => ({ mode: "folder" }))
    if (!reviewed && !check && !local && !test) {
      view.replaceChildren(el("p", { class: "muted", text: "Looking it up on GitHub…" }))
      try { check = await ask("check", `github.com/${owner}/${name}`); pasted.set(id, check) } catch (e) { return page("Couldn't open that app", e.message) }
    }
    const e = reviewed || check?.entry || local || test
    const isReviewed = !!reviewed || !!local?.reviewed
    const kind = isReviewed ? null
      : !check ? ""
      : check.ready ? "It has Pinokio install scripts, so Obstat can run them as they are."
      : `It looks like ${{ python: "a Python project", node: "a Node.js project" }[check.stack] || "a project we couldn't identify"} with no install scripts. Obstat writes the install steps and shows them before anything runs.`
    const tools = (await ask("tools").catch(() => [])).filter((t) => t.found && t.kind !== "Tool")
    const runs = local?.installed ? await ask("runs", id).catch(() => []) : []
    const mine = !!local?.local

    const term = el("pre", {})
    const logBody = el("div", { class: "term-body" }, term)
    const note = el("div", { class: "pane-slot" })
    current = { id, term, logBody, note }
    const folder = id.replace(/[^a-z0-9._-]+/gi, "-")
    const lastLog = local?.running ? local.running.script.replace(/\.js$/, "") : local?.installed ? "start" : "install"
    term.textContent = local || test ? "" : `$ ${isReviewed ? "Click Install to start." : "Click Test in sandbox to try it safely first."} Every step shows here.`
    const testLog = test && (test.mode === "windows" ? "windows" : test.running ? test.running.script.replace(/\.js$/, "") : test.scripts.includes("start.js") && test.status !== "ready" ? "start" : "install")
    const logPath = test ? `sandboxes/${folder}/${testLog}.txt` : local ? `apps/${folder}/${lastLog}.txt` : null
    if (local?.local && !local.installed && !local.scripts.includes("install.js")) term.textContent = "$ The AI agent works in its own window. Install steps show here once it's done."
    else if (logPath) ask("readLog", logPath).then((r) => { term.textContent = r.text; logBody.scrollTop = logBody.scrollHeight }).catch(() => { term.textContent = "$ Ready." })

    const busy = (on) => { for (const b of menu.querySelectorAll("button")) b.disabled = on }
    const fail = (err) => { note.replaceChildren(); appendLog(id, `\n${err.message}\n`); busy(false) }

    async function install(_ev, kept = false) {
      if (!isReviewed && !kept && !mine && !confirm("Nobody has reviewed this repo. Its install steps will run on your PC with your permissions. You'll see its commands first; a few details, like ports, are filled in as they run. Continue?")) return
      busy(true)
      term.textContent = ""
      // something in the note holds off the automatic refresh until the plan shows
      note.replaceChildren(el("p", { class: "note", text: kept ? "Deleting the test and downloading a fresh copy…" : "Downloading…" }))
      try {
        appendLog(id, "Getting Obstat's Python, Node and Git ready, then downloading the app…\n")
        await ask(kept ? "keepSandbox" : "fetchApp", id)
        const p = await ask("preview", id, "install.js")
        showPlan(p)
      } catch (err) { fail(err) }
    }

    function showPlan(p, script = "install.js") {
      const risky = p.commands.filter((c) => c.risks.length)
      const what = script === "reset.js" ? "reset" : script === "install.js" ? "install" : "start"
      note.replaceChildren(el("div", { class: "plan" },
        el("h2", { text: `${what[0].toUpperCase()}${what.slice(1)} steps` }),
        el("p", { class: "note", text: `Obstat will run these ${p.commands.length} command${p.commands.length === 1 ? "" : "s"} in the app's own folder.${what === "start" ? " Nobody has reviewed this app, so Obstat shows its steps the first time and whenever they change." : ""}` }),
        p.unsupported.length && el("p", { class: "card-err", text: `This app uses steps Obstat can't run yet (${p.unsupported.join(", ")}), so the install will stop there.` }),
        risky.length && el("p", { class: "card-err", text: `Careful: ${risky.length} command${risky.length === 1 ? "" : "s"} ${[...new Set(risky.flatMap((c) => c.risks))].join(", ")}.` }),
        el("ol", { class: "cmds" }, ...p.commands.map((c) => el("li", { class: c.risks.length ? "risky" : "" },
          el("code", { text: c.command }),
          (c.path !== "." || c.venv) && el("small", { text: [c.path !== "." && `in ${c.path}`, c.venv && `Python env ${c.venv}`].filter(Boolean).join(" · ") })))),
        el("div", { class: "row-btns" },
          el("button", { class: "btn small", text: what === "start" ? "Start it" : `Run ${what}`, onclick: async () => {
            note.replaceChildren()
            try {
              const r = await ask("run", id, script, p.token)
              if (!r.ok) appendLog(id, `\nThe ${what} stopped: ${r.error}\n`)
            } catch (err) { appendLog(id, `\n${err.message}\n`) }
            render()
          } }),
          el("button", { class: "btn small ghost", text: "Cancel", onclick: () => { note.replaceChildren(); busy(false) } }))))
    }

    async function start(script = "start.js") {
      busy(true)
      term.textContent = ""
      try {
        const r = await ask("run", id, script)
        if (r.needsApproval) return showPlan(r.preview, script)
        if (!r.ok) appendLog(id, `\nIt stopped: ${r.error}\n`)
        // it's up: show it inside Obstat, like a browser tab
        else if (r.running && current?.id === id && location.hash.startsWith("#/app/") && (await ask("app", id))?.running?.url) return go(runHash(id))
      } catch (err) { appendLog(id, `\n${err.message}\n`) }
      render()
    }

    async function testIt() {
      const how = box.mode === "windows"
        ? "Obstat will open Windows Sandbox, a throwaway copy of Windows, and install and start the app in there. It can't see your files, and it's wiped when you delete the test."
        : "Obstat will install and start the app in its own test folder, with its home, temp and cache folders pointed inside it. This keeps it from scattering files, but it is weaker than a real sandbox: the app still runs with your permissions."
      if (!confirm(`${how}\n\nContinue?`)) return
      busy(true)
      term.textContent = ""
      try {
        appendLog(id, "Getting Obstat's Python, Node and Git ready, then downloading the app into the sandbox…\n")
        const r = await ask("testInSandbox", id)
        if (r && r.ok === false) appendLog(id, `\nThe test stopped: ${r.error}\n`)
      } catch (err) { appendLog(id, `\n${err.message}\n`) }
      render()
    }

    // menu buttons: an icon, a label and an optional hint underneath
    const act = (text, onclick, cls = "", ic = null, hint = null) => el("button", { class: cls, onclick }, ic && icon(ic), el("span", {}, text, hint && el("small", { text: hint })))
    const head = (text) => el("p", { class: "menu-h", text })
    const r = local?.running
    const tr = test?.running
    const hasInstall = !!local?.scripts.includes("install.js")

    async function update() {
      if (!confirm(isReviewed ? `Update ${e.name} to its newest reviewed version?` : `Update ${e.name} to the newest code on GitHub? Nobody has reviewed the new code.`)) return
      busy(true)
      term.textContent = ""
      note.replaceChildren(el("p", { class: "note", text: "Updating…" }))
      try {
        const u = await ask("update", id)
        if (!u.changed) { note.replaceChildren(el("p", { class: "ok-note", text: "Already up to date." })); busy(false); return }
        appendLog(id, `\nUpdated from ${u.from.slice(0, 7)} to ${u.to.slice(0, 7)}.\n`)
        const p = await ask("preview", id, "install.js")
        showPlan(p)
        note.prepend(el("p", { class: "ok-note", text: "Updated. Run the install steps again so its packages match the new code." }))
      } catch (err) { fail(err) }
    }

    async function reset() {
      busy(true)
      if (local.scripts.includes("reset.js")) {
        try { showPlan(await ask("preview", id, "reset.js"), "reset.js") } catch (err) { fail(err) }
        return
      }
      if (!confirm(`Reset ${e.name}? Obstat deletes the packages it installed (its env and node_modules folders) and keeps everything else, like models and your outputs. Install it again afterwards.`)) return busy(false)
      try {
        const x = await ask("reset", id)
        appendLog(id, x.removed.length ? `\nDeleted ${x.removed.join(", ")}. Click Install to set it up again.\n` : "\nThere were no packages to delete.\n")
      } catch (err) { appendLog(id, `\n${err.message}\n`) }
      render()
    }

    function editLaunchers() {
      busy(true)
      const box = el("div", { class: "editor" })
      note.replaceChildren(box)
      const open = async (file) => {
        const files = await ask("launchers", id)
        const text = el("textarea", { spellcheck: "false", "aria-label": file })
        text.value = await ask("readScript", id, file)
        const status = el("span", { class: "note" })
        box.replaceChildren(
          el("div", { class: "chan-tabs" }, ...files.map((f) => el("button", { "aria-selected": String(f === file), text: f, onclick: () => open(f) }))),
          isReviewed ? el("p", { class: "card-err", text: "Changing a reviewed app's scripts means they're no longer what was reviewed. The app will show as edited." }) : "",
          text,
          el("div", { class: "row-btns" },
            el("button", { class: "btn small", text: "Save", onclick: async () => {
              try { await ask("writeScript", id, file, text.value); status.textContent = "Saved." } catch (err) { status.textContent = err.message }
            } }),
            el("button", { class: "btn small ghost", text: "Close", onclick: () => { note.replaceChildren(); render() } }),
            status))
      }
      ask("launchers", id).then((files) => files.length ? open(files.includes("start.js") ? "start.js" : files[0]) : box.replaceChildren(el("p", { class: "note", text: "This app has no launcher scripts yet." })))
        .catch(fail)
    }

    // Build a UI: for repos that are command-line tools with no screen of their own
    async function buildUiPane() {
      busy(true)
      const box = el("div", { class: "editor" })
      note.replaceChildren(box)
      const close = () => { note.replaceChildren(); render() }
      let d
      try { d = await ask("detectUi", id) } catch (err) { return fail(err) }
      const agents = tools.filter((t) => t.kind === "Terminal")
      const status = el("p", { class: "note", role: "status" })
      box.replaceChildren(...[
        el("h3", { text: "Build a UI" }),
        el("p", { class: "note", text: d.found
          ? `${e.name} looks like a command-line app (it runs ${d.found.command.join(" ")}). Obstat can give it a screen: a form for its options, a Run button, and its output and files on the page. It opens here in Obstat.`
          : "Obstat couldn't tell which command this app runs, so the instant UI isn't available. An AI agent can read the code and build one." }),
        isReviewed ? el("p", { class: "card-err", text: "This adds files to a reviewed app. The app's own code stays as it was reviewed." }) : "",
        el("div", { class: "row-btns" },
          d.found && el("button", { class: "btn small", text: d.has ? "Rebuild the Obstat UI" : "Make the Obstat UI", onclick: async () => {
            status.textContent = "Building…"
            try {
              await ask("buildUi", id, null)
              status.textContent = "Done. Starting it…"
              const r = await ask("run", id, "obstat-ui.js")
              if (r.ok && r.running) return go(runHash(id))
              status.textContent = r.error ? `It stopped: ${r.error}` : "Built. Click Open with Obstat UI to start it."
            } catch (err) { status.textContent = err.message }
          } }),
          ...agents.map((t) => el("button", { class: "btn small ghost", text: `Custom UI with ${t.name}`, onclick: async () => {
            try { await ask("buildUi", id, t.id); status.textContent = `${t.name} is building it in its own window. When it's done, Open with Obstat UI shows up under Run.` } catch (err) { status.textContent = err.message }
          } }))),
        !agents.length && el("p", { class: "note", text: "For a custom-made UI, install Claude Code, Codex or Gemini CLI (see Tools)." }),
        status,
        el("div", { class: "row-btns" }, el("button", { class: "btn small ghost", text: "Close", onclick: close })),
      ].filter(Boolean))
    }

    async function copyApp() {
      if (!confirm(`Make a second copy of ${e.name}? It gets its own folder, so it uses the same disk space again.`)) return
      busy(true)
      appendLog(id, "\nCopying the app folder…\n")
      try { go(appHash(await ask("copy", id))) } catch (err) { fail(err) }
    }

    const menu = el("div", { class: "actions-menu" },
      ...(test ? [
        head("Sandbox test"),
        tr?.url && act("Open the test", () => window.obstat.openExternal(tr.url), "primary", "open"),
        act("Keep it", () => { if (confirm(`Keep ${e.name}? Obstat deletes the test and installs it for real, fresh from GitHub at the commit you tested.`)) install(null, true) }, "primary", "install", "Install it for real"),
        (tr || test.mode === "windows") && act(test.mode === "windows" ? "Close Windows Sandbox" : "Stop", async () => { await ask("stopSandbox", id); setTimeout(render, 1200) }, "", "stop"),
        act("Delete test", async () => { await ask("deleteSandbox", id); render() }, "danger", "trash"),
      ] : !local ? [
        head("Get it"),
        isReviewed ? act("Install", install, "primary", "install") : act("Test in sandbox", testIt, "primary", "shield", "Safe first try"),
        !isReviewed && act("Install without testing", install, "", "install"),
      ] : !local.installed ? [
        head("Get it"),
        mine && !hasInstall ? act("Check again", render, "primary", "update", "Waiting for the agent's install.js") : act("Install", install, "primary", "install"),
      ] : [
        head("Run"),
        ...(r ? [
          r.url && act("Open", () => go(runHash(id)), "primary", "open", "Use it here in Obstat"),
          r.url && act("Open in browser", () => window.obstat.viewExternal(id), "", "link"),
          act("Stop", async () => { await ask("stop", id); setTimeout(render, 1200) }, "", "stop"),
        ] : runs.map((o, i) => act(o.label, () => start(o.script), i === 0 ? "primary" : "", "play"))),
        !r && !runs.length && el("p", { class: "note", text: "This app has no screen yet. Build a UI to use it here." }),
        !r && act("Build a UI", buildUiPane, runs.length ? "" : "primary", "sparkle", runs.some((o) => o.script === "obstat-ui.js") ? "Rebuild or make a custom one" : "For apps with no screen"),
        head("Keep it working"),
        !mine && act("Update", update, "", "update", isReviewed ? "Newest reviewed version" : "Newest code on GitHub"),
        act("Install again", install, "", "install"),
        act("Reset", reset, "", "reset", "Fresh packages, keeps your files"),
      ]),
      local && head("App"),
      local && act("Open folder", () => ask("appFolder", id), "", "folder"),
      ...(local ? tools.map((t) => act(`Open in ${t.name}`, () => ask("openIn", id, t.id), "", t.kind === "Editor" ? "code" : "sparkle")) : []),
      local && act("Edit launcher", editLaunchers, "", "edit", "Its install and start scripts"),
      local?.installed && act("Copy app", copyApp, "", "copy"),
      !mine && e.url && act("See on GitHub", () => window.obstat.openExternal(e.url.replace(/\.git$/, "")), "", "github"),
      local && act("Remove", async () => {
        if (!confirm(`Remove ${e.name}? This deletes its folder and everything it downloaded.`)) return
        await ask("remove", id)
        go("#/apps")
      }, "danger", "trash"))

    return [
      el("button", { class: "back", text: "← Back", onclick: () => history.back() }),
      el("div", { class: "app-head" }, mark(e.name, { ...e, ...(local || {}), icon: e.icon || local?.icon }),
        el("div", {},
          el("h1", { text: e.name }),
          el("div", { class: "by", text: mine ? "on this PC" : e.owner }),
          el("div", { class: "meta" },
            mine ? el("span", { class: "badge", text: local.copiedFrom ? `Your copy of ${local.copiedFrom}` : "Made by you" })
              : isReviewed ? el("span", { class: "badge ok", text: reviewed ? `${reviewed.testedAt ? "Reviewed and tested" : "Reviewed"} ${day(reviewed.reviewedAt)}` : "Reviewed" }) : el("span", { class: "badge warn", text: "Not reviewed" }),
            local?.edited && el("span", { class: "badge warn", text: "Scripts edited" }),
            local?.installed && el("span", { class: "badge", text: r ? (r.url ? "Running" : "Busy") : "Installed" }),
            test && el("span", { class: "badge sandbox", text: `In the sandbox: ${STATUS[test.status] || test.status}` }),
            e.stars != null && el("span", { text: stars(e.stars) }),
            e.language && el("span", { text: e.language }),
            e.license && el("span", { text: e.license })))),
      el("div", { class: "app-body" }, menu,
        el("div", { class: "pane" },
          el("div", { class: "about" },
            el("p", { text: e.description || "No description." }),
            el("p", { class: "note", text: mine ? (local.copiedFrom ? "A copy on this PC, with its own folder. Update isn't available for copies." : hasInstall ? "Made on this PC. Its install steps are ready: click Install, then Start." : "Made on this PC. An AI agent is building it in its own folder. Once it has written install.js, click Install. Use Open in to talk to the agent again.") : isReviewed ? (reviewed ? `Reviewed at commit ${(reviewed.reviewedSha || "").slice(0, 7)}. Obstat installs exactly that commit.` : "Installed at its reviewed commit.") : `Not reviewed yet, and only you can see it. ${kind}` })),
          note,
          el("div", { class: "term" },
            el("div", { class: "term-h" }, el("i"), el("i"), el("i"), el("span", { text: "log" })),
            logBody))),
    ]
  },

  sandbox: async () => {
    const [box, tests] = await Promise.all([ask("sandboxInfo"), ask("sandboxes")])
    const modeNote = box.mode === "windows"
      ? el("p", { class: "note ok-note", text: "This PC has Windows Sandbox, so tests run in a throwaway copy of Windows that can't see your files and is wiped when you delete the test. It has no NVIDIA GPU inside, so GPU apps test with their CPU version." })
      : box.platform === "win32"
        ? el("p", { class: "card-err", text: "Windows Sandbox isn't turned on here, so tests run in a separate test folder instead. That keeps an app from scattering files, but the app still runs with your permissions and can read your files, including Obstat's own. Only test repos you'd be comfortable installing. On Windows Pro you can turn on Windows Sandbox in \"Turn Windows features on or off\". Windows Home doesn't have it." })
        : el("p", { class: "card-err", text: "Tests on this PC run in a separate test folder. That keeps an app from scattering files, but the app still runs with your permissions and can read your files, including Obstat's own. Only test repos you'd be comfortable installing." })
    return page("Sandbox", "Try a repo nobody has reviewed without risking your files.",
      el("ol", { class: "steps-list" },
        el("li", {}, el("b", { text: "Test it" }), el("span", { text: box.mode === "windows" ? "The app installs and runs in Windows Sandbox, which can't see your files." : "The app installs and runs in its own test folder." })),
        el("li", {}, el("b", { text: "Look around" }), el("span", { text: "Open it, try it, and read every command it ran in the log." })),
        el("li", {}, el("b", { text: "Bad? Delete it" }), el("span", { text: "One click deletes the test and everything it downloaded." })),
        el("li", {}, el("b", { text: "Good? Keep it" }), el("span", { text: "Obstat installs it fresh, at the exact commit you tested." }))),
      modeNote,
      el("div", { class: "section-h" }, el("h2", { text: "Your tests" })),
      tests.length
        ? el("div", { class: "rowlist" }, ...tests.map((t) => {
          const r = row({ ...t, reviewedAt: null })
          r.querySelector(".meta").replaceChildren(
            el("span", { class: "badge sandbox", text: STATUS[t.status] || t.status }),
            el("span", { text: t.mode === "windows" ? "Windows Sandbox" : "Test folder" }))
          return r
        }))
        : emptyBox("No tests yet", "Add a repo and choose Test in sandbox.", linkBtn("Add a repo", "#/add")))
  },

  reviews: () => page("How reviews work", "Why apps on the Discover list are safer than a random repo.",
    el("ol", { class: "steps-list" },
      el("li", {}, el("b", { text: "Someone submits a repo" }), el("span", { text: "On obstat.app or from this app." })),
      el("li", {}, el("b", { text: "A person reads the scripts" }), el("span", { text: "Every install and start step, at one exact commit." })),
      el("li", {}, el("b", { text: "That commit is pinned" }), el("span", { text: "Obstat installs only the commit that was reviewed." })),
      el("li", {}, el("b", { text: "Changes take it off the list" }), el("span", { text: "Checked every 15 minutes. New commits mean a new review." })))),

  logs: async () => {
    const files = await ask("logs")
    const out = el("pre", { text: "Pick a log file to read it." })
    const auto = el("input", { type: "checkbox", checked: true, id: "autoscroll" })
    let current = null
    const show = async () => {
      if (!current) return
      try {
        const r = await ask("readLog", current)
        out.textContent = (r.truncated ? "… (older lines not shown)\n" : "") + (r.text || "(empty)")
        if (auto.checked) out.parentElement.scrollTop = out.parentElement.scrollHeight
      } catch (e) {
        out.textContent = e.message
      }
    }
    const tree = el("div", { class: "files" }, ...(files.length ? files.map((f) => {
      const b = el("button", { onclick: () => {
        current = f.path
        for (const x of tree.children) x.removeAttribute("aria-current")
        b.setAttribute("aria-current", "true")
        title.textContent = f.path
        show()
      } }, el("span", { text: f.path }), el("small", { text: bytes(f.size) }))
      return b
    }) : [el("p", { class: "muted", text: "No logs yet." })]))
    const title = el("span", { text: "raw logs" })
    poll = setInterval(show, 2000)
    return page("Logs", `Everything Obstat does is written to ${info.home}${sep()}logs.`,
      el("div", { class: "split" },
        el("div", {}, tree, el("div", { class: "row-btns" },
          el("button", { class: "btn small ghost", text: "Open folder", onclick: () => ask("openFolder", "logs") }),
          el("button", { class: "btn small ghost danger", text: "Clear logs", onclick: async () => { await ask("clearLogs"); render() } }))),
        el("div", { class: "term" },
          el("div", { class: "term-h" }, el("i"), el("i"), el("i"), title,
            el("label", { class: "auto" }, auto, " Auto-scroll")),
          el("div", { class: "term-body" }, out))))
  },

  disk: async () => {
    const d = await ask("disk")
    const total = Object.values(d.used).reduce((a, b) => a + b, 0)
    const label = { apps: "Installed apps", sandboxes: "Sandboxes", bin: "Python, Node, Git and uv", cache: "Downloads cache", logs: "Logs" }
    return page("Disk space", "AI apps and their models can be large. See what each part uses and get space back.",
      el("div", { class: "stats" },
        el("div", {}, el("b", { text: bytes(total) }), el("span", { text: "used by Obstat" })),
        el("div", {}, el("b", { text: d.free == null ? "?" : bytes(d.free) }), el("span", { text: "free on this drive" }))),
      el("dl", { class: "rows" }, ...Object.entries(d.used).map(([k, v]) => el("div", {},
        el("dt", { text: label[k] }),
        el("dd", {}, bytes(v), " ", el("button", { class: "link", text: "View folder", onclick: () => ask("openFolder", k) }))))),
      el("div", { class: "row-btns" },
        el("button", { class: "btn small ghost danger", text: "Empty downloads cache", onclick: async () => { await ask("resetCache"); render() } })))
  },

  plugins: async () => {
    const tools = await ask("tools")
    const group = (kind, title) => {
      const list = tools.filter((t) => t.kind === kind)
      return [el("p", { class: "group-h", text: `${title} · ${list.length}` }),
        el("div", { class: "rowlist" }, ...list.map((t) => el("div", { class: "row plain" },
          mark(t.name),
          el("h3", { text: t.name }),
          el("div", { class: "meta" }, t.found ? el("span", { class: "badge ok", text: "Found" }) : el("button", { class: "btn small ghost", text: "Get it ↗", onclick: () => window.obstat.openExternal(t.url) })),
          el("p", { text: t.found || `Not found on this PC. Install it, then press Reload.` }))))]
    }
    return page("Plugins", "Open an app's folder in your editor, or run a coding tool inside it. Obstat finds the ones already on your PC.",
      ...group("Editor", "Desktop editors"), ...group("Terminal", "Terminal tools"), ...group("Tool", "Other tools"))
  },

  skills: async () => {
    const [list, agents, link] = await Promise.all([ask("skills"), ask("skillAgents"), ask("control")])
    const linkRow = el("dl", { class: "rows" }, el("div", {},
      el("dt", {}, "Let AI agents use Obstat", el("small", { text: link.on
        ? `On. Agents with Obstat skills can list, start and stop your apps through ${link.url}, a private link only this PC can reach.`
        : "Skills need this. It opens a private link on this PC that only agents with the key in control.json can use." })),
      el("dd", {}, toggle(link.on, async (v) => { const r = await ask("setControl", v); render(); return r.on }))))
    const card = (s) => {
      const btns = agents.map((a) => {
        const state = s.installed[a.id]
        return state === "yes"
          ? el("button", { class: "btn small ghost", text: `✓ ${a.name}`, title: `Remove from ${a.name}`, onclick: async () => { await ask("removeSkill", s.name, a.id); render() } })
          : el("button", { class: "btn small", text: state === "changed" ? `Update in ${a.name}` : `Add to ${a.name}`, onclick: async () => { await ask("installSkill", s.name, a.id); render() } })
      })
      const view = el("button", { class: "link small", text: "Read the skill", onclick: async (e) => {
        const box = e.target.closest(".skill").querySelector("pre")
        if (box.hidden) box.textContent = await ask("readSkill", s.name)
        box.hidden = !box.hidden
      } })
      return el("article", { class: "skill" },
        el("div", { class: "skill-h" }, el("h3", { text: s.title }), s.core && el("span", { class: "badge ok", text: "Needed by all" })),
        el("p", { text: s.summary }),
        el("p", { class: "ask" }, el("span", { text: "Try asking: " }), `“${s.ask}”`),
        el("p", { class: "works", text: `Works with ${s.worksWith}` }),
        el("div", { class: "skill-b" }, ...btns, view),
        el("pre", { class: "skill-src", hidden: true }))
    }
    return page("Skills", "Skills teach AI agents like Claude Code and Codex to use your Obstat apps. Add one, then just ask your agent for the result.",
      linkRow,
      el("div", { class: "section-h" }, el("h2", { text: `Library · ${list.length}` })),
      el("div", { class: "skills" }, ...list.map(card)))
  },

  server: async () => {
    const live = (await ask("apps")).filter((a) => a.running?.url)
    return page("Home Server", "Open the apps running on this PC from your phone or another computer on your home network.",
      el("dl", { class: "rows" },
        el("div", {}, el("dt", { text: "Network access" }), el("dd", { text: "Off" })),
        ...live.map((a) => el("div", {}, el("dt", { text: a.name }), el("dd", {}, el("button", { class: "link", text: a.running.url, onclick: () => go(runHash(a.id)) }))))),
      !live.length && el("p", { class: "muted", text: "No apps are running. Start one from My apps and its address shows here." }),
      soon("Sharing to your home network arrives next. It will stay off until you turn it on."))
  },

  autolaunch: async () => {
    const on = await ask("autolaunch")
    return page("Autolaunch", "Choose what starts by itself when you sign in to Windows.",
      el("dl", { class: "rows" },
        el("div", {}, el("dt", { text: "Start Obstat with Windows" }),
          el("dd", {}, toggle(on, async (v) => ask("setAutolaunch", v))))),
      el("div", { class: "section-h" }, el("h2", { text: "Installed apps" })),
      ...(await ask("apps").then((list) => list.filter((a) => a.installed)).then((list) => list.length
        ? [el("dl", { class: "rows" }, ...list.map((a) => el("div", {},
            el("dt", {}, a.name, el("small", { text: a.scripts.includes("start.js") ? "Starts when Obstat opens" : "Has no start script" })),
            el("dd", {}, a.scripts.includes("start.js") ? toggle(a.autostart, (v) => ask("setAutostart", a.id, v)) : "—"))))]
        : [emptyBox("No apps installed", "Once an app is installed, you can set it to start with Obstat here.")])))
  },

  settings: async () => page("Settings", "Storage, startup and troubleshooting.",
    el("h2", { class: "group-h", text: "General" }),
    el("dl", { class: "rows" },
      el("div", {}, el("dt", {}, "Version", el("small", { text: "Obstat updates itself. New versions download in the background." })), el("dd", {}, info.version, " ", updateLine())),
      el("div", {}, el("dt", { text: "Home folder" }), el("dd", {}, info.home, " ", el("button", { class: "link", text: "View folder", onclick: () => ask("openFolder", "home") }))),
      el("div", {}, el("dt", { text: "App list" }), el("dd", { text: "obstat.app" }))),
    el("h2", { class: "group-h", text: "Troubleshoot" }),
    el("dl", { class: "rows" },
      el("div", {}, el("dt", {}, "Downloads cache", el("small", { text: "Files Obstat downloaded while installing. Safe to empty." })),
        el("dd", {}, el("button", { class: "link", text: "View folder", onclick: () => ask("openFolder", "cache") }), " ",
          el("button", { class: "link danger", text: "Reset", onclick: async (e) => { await ask("resetCache"); e.target.textContent = "Done" } }))),
      el("div", {}, el("dt", {}, "Logs", el("small", { text: "What Obstat did, for when something goes wrong." })),
        el("dd", {}, el("button", { class: "link", text: "View folder", onclick: () => ask("openFolder", "logs") }), " ",
          el("button", { class: "link danger", text: "Clear", onclick: async (e) => { await ask("clearLogs"); e.target.textContent = "Done" } }))),
      el("div", {}, el("dt", {}, "Python, Node and Git", el("small", { text: "Obstat's own copies. Reset if installs fail in strange ways; they download again on the next install." })),
        el("dd", {}, el("button", { class: "link", text: "View folder", onclick: () => ask("openFolder", "bin") }), " ",
          el("button", { class: "link danger", text: "Reset", onclick: async (e) => {
            if (!confirm("Stop every running app and delete Obstat's Python, Node and Git? They download again the next time you install something.")) return
            e.target.textContent = "Resetting…"; await ask("resetBin"); e.target.textContent = "Done"
          } })))),
    whichBox(),
    await keysBox(),
    await accountBox(),
    legalBox()),

  updates: () => page("Updates", null,
    rows([["Installed version", info.version || "…"], ["Updates", "Automatic updates arrive with the first public release"]])),

  chat: async (channel = "general") => {
    const channels = await ask("channels")
    if (!Object.hasOwn(channels, channel)) channel = "general"
    let acct = await ask("account")
    const tabs = communityTabs(channels, channel)
    const log = el("div", { class: "chat-log", "aria-live": "polite" })
    const status = el("p", { class: "chat-status" })
    let last = null
    const show = (msgs) => {
      if (!msgs.length) return
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40
      for (const m of msgs) {
        const report = el("button", { class: "link small", text: "Report", onclick: async (e) => {
          try { await ask("reportChat", channel, m.id); e.target.textContent = "Reported" } catch (x) { e.target.textContent = x.message }
        } })
        const row = el("div", { class: "msg" })
        // moderators get Delete and Ban instead of Report
        const mod = (label, action, ask1) => el("button", { class: "link small danger", text: label, onclick: async (e) => {
          if (!confirm(ask1)) return
          try { await ask("modChat", action, channel, m.id); action === "ban" ? log.querySelectorAll(`[data-name="${CSS.escape(m.name)}"]`).forEach((r) => r.remove()) : row.remove() } catch (x) { e.target.textContent = x.message }
        } })
        const tools = acct.badge && m.name !== acct.name
          ? [mod("Delete", "delete", "Delete this message for everyone?"), m.badge ? null : mod("Ban", "ban", `Ban ${m.name}? Everything they posted is removed and they can't come back with the same email.`)]
          : [m.name === acct.name ? null : report]
        row.setAttribute("data-name", m.name)
        row.append(
          el("div", { class: "msg-h" }, el("b", { text: m.name }), badge(m), el("time", { text: new Date(m.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) }), ...tools),
          el("p", { text: m.text }))
        log.append(row)
      }
      last = msgs[msgs.length - 1].id
      if (stick || msgs.length > 20) log.scrollTop = log.scrollHeight
    }
    const refresh = async () => {
      try { show(await ask("readChat", channel, last)); status.textContent = "" } catch (x) { status.textContent = x.message }
    }
    await refresh()
    if (!log.childElementCount) log.append(el("p", { class: "muted", text: "No messages yet. Say hello." }))
    poll = setInterval(refresh, 3000)

    const composer = el("div", { class: "composer" })
    const write = () => {
      const box = el("textarea", { rows: "2", maxlength: "500", placeholder: `Message #${channels[channel]} as ${acct.name}`, "aria-label": "Message" })
      const send = async () => {
        const text = box.value.trim()
        if (!text) return
        send.busy = true
        try {
          await ask("sendChat", channel, text)
          box.value = ""
          if (log.querySelector(".muted")) log.replaceChildren()
          await refresh()
          log.scrollTop = log.scrollHeight
        } catch (x) {
          status.textContent = x.message
          if (/Sign in/.test(x.message)) { acct = { name: null }; composer.replaceChildren(signInBox((a) => { acct = a; status.textContent = ""; write() })) }
        }
        send.busy = false
      }
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!send.busy) send() } })
      composer.replaceChildren(box, el("button", { class: "btn small", text: "Send", onclick: send }))
    }
    acct.name ? write() : composer.replaceChildren(signInBox((a) => { acct = a; write() }))
    setTimeout(() => { log.scrollTop = log.scrollHeight }, 0)
    return page("Community", "Talk with everyone using Obstat: what you're making, what works, what's broken. Messages that three people report are hidden.",
      tabs, el("div", { class: "chat" }, log, composer, status))
  },

  news: async () => {
    const [items, channels] = await Promise.all([ask("news"), ask("channels").catch(() => ({}))])
    markNewsSeen(items)
    const KIND = { update: "Update", "new-app": "New app", outage: "Outage", resolved: "Fixed" }
    return page("Community", "Updates, new apps and service status from the Obstat team.",
      communityTabs(channels, "news"),
      items.length ? el("div", { class: "news" }, ...items.map((n) => {
        const open = n.kind === "outage" && !n.resolvedAt
        return el("article", { class: `news-item${open ? " is-open" : ""}` },
          el("div", { class: "meta" }, el("span", { class: `badge ${open ? "warn" : n.kind === "new-app" ? "ok" : ""}`, text: open ? "Outage" : n.resolvedAt ? "Outage, fixed" : KIND[n.kind] || n.kind }), el("span", { text: day(n.at) })),
          el("h3", { text: n.title }),
          n.body && el("p", { text: n.body }),
          n.url && el("a", { href: n.url, text: n.url }))
      })) : emptyBox("No news yet", "Updates and new apps show up here."))
  },
}

// ---------- home ----------

const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening" }
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000)
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : day(iso)
}

// The latest few messages across every chat channel
async function chatHighlights() {
  const channels = await ask("channels")
  const all = await Promise.all(Object.entries(channels).map(([id, name]) =>
    ask("readChat", id, null).then((msgs) => msgs.slice(-3).map((m) => ({ ...m, channel: id, channelName: name }))).catch(() => [])))
  return all.flat().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5)
}

function appTile(a) {
  const btn = a.running?.url
    ? el("button", { class: "btn small", text: "Open", onclick: (ev) => { ev.stopPropagation(); go(runHash(a.id)) } })
    : a.installed && a.scripts.includes("start.js") && !a.running
      ? el("button", { class: "btn small ghost", text: "Start", onclick: async (ev) => {
        ev.stopPropagation()
        const b = ev.currentTarget
        b.disabled = true; b.textContent = "Starting…"
        const r = await ask("run", a.id, "start.js").catch(() => null)
        if (r?.needsApproval) return go(appHash(a))
        if (location.hash.startsWith("#/home") || location.hash === "") render()
      } })
      : null
  const open = () => go(appHash(a))
  return el("div", { class: "tile", role: "link", tabindex: "0", onclick: open, onkeydown: (e) => { if (e.key === "Enter") open() } },
    mark(a.name, a),
    el("div", {}, el("h3", { text: a.name }), el("p", { text: a.description || (a.local ? "Made by you" : a.owner) })),
    el("div", { class: "tile-b" },
      el("span", { class: `state${a.running ? " on" : ""}`, text: a.running ? (a.running.url ? "Running" : "Busy") : a.installed ? "Ready" : "Not installed yet" }),
      btn))
}

async function homeView() {
  const [mine, news, chats] = await Promise.all([
    ask("apps").then((l) => l.filter((a) => a.installed || a.running || a.local)).catch(() => []),
    ask("news").catch(() => []),
    chatHighlights().catch(() => []),
  ])
  const fresh = [...repos].filter((r) => r.reviewedAt).sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)).slice(0, 4)
  const quick = (href, ic, cls, title, text) => el("a", { href }, el("span", { class: `ico ${cls}` }, icon(ic)), el("div", {}, el("b", { text: title }), el("span", { text })))
  const KIND = { update: "Update", "new-app": "New app", outage: "Outage", resolved: "Fixed" }
  return [
    el("div", { class: "hello" }, el("div", {}, el("h1", { text: greeting() }), el("p", { class: "sub", text: "What would you like to do today?" }))),
    el("div", { class: "quick" },
      quick("#/discover", "compass", "", "Find an app", "Reviewed AI apps that install in one click."),
      quick("#/create", "sparkle", "indigo", "Create an app", "Describe it in your own words and an AI agent builds it."),
      quick("#/add", "shield", "green", "Try any GitHub repo", "Paste a link and test it safely in the sandbox.")),
    el("div", { class: "dash" },
      el("div", {},
        el("section", {},
          el("div", { class: "section-h" }, el("h2", { text: "Your apps" }), mine.length > 6 && el("a", { href: "#/apps", text: `See all ${mine.length}` })),
          mine.length ? el("div", { class: "tiles" }, ...mine.slice(0, 6).map(appTile))
            : el("p", { class: "mini-empty" }, "Nothing installed yet. ", el("a", { href: "#/discover", text: "Find your first app" }), " or ", el("a", { href: "#/create", text: "make one" }), ".")),
        el("section", {},
          el("div", { class: "section-h" }, el("h2", { text: "New on Obstat" }), el("a", { href: "#/discover", text: "Discover all" })),
          fresh.length ? el("div", { class: "tiles" }, ...fresh.map((r) => el("a", { class: "tile", href: appHash(r) },
            mark(r.name, r),
            el("div", {}, el("h3", { text: r.name }), el("p", { text: r.description || r.owner })),
            el("div", { class: "tile-b" }, el("span", { class: "state on", text: r.testedAt ? "Reviewed and tested" : "Reviewed" }), el("span", { class: "state", text: stars(r.stars) })))))
            : el("p", { class: "mini-empty", text: listError ? `Couldn't load the app list: ${listError}` : "New reviewed apps show up here." }))),
      el("div", {},
        el("section", {},
          el("div", { class: "section-h" }, el("h2", { text: "Announcements" }), el("a", { href: "#/news", text: "All news" })),
          el("div", { class: "feed" }, ...(news.length ? news.slice(0, 4).map((n) => {
            const down = n.kind === "outage" && !n.resolvedAt
            return el("a", { href: "#/news", class: down ? "is-open" : "" }, el("small", { text: `${down ? "Outage now" : KIND[n.kind] || n.kind} · ${day(n.at)}` }), el("b", { text: n.title }), n.body && el("p", { text: n.body }))
          }) : [el("p", { class: "muted", text: "No news yet." })]))),
        el("section", {},
          el("div", { class: "section-h" }, el("h2", { text: "Community" }), el("a", { href: "#/chat", text: "Join the chat" })),
          el("div", { class: "feed" }, ...(chats.length ? chats.map((m) => el("a", { href: `#/chat/${m.channel}` },
            el("small", { text: `#${m.channelName} · ${ago(m.at)}` }), el("b", {}, m.name, badge(m)), el("p", { text: m.text })))
            : [el("p", { class: "muted", text: "Quiet right now. Say hello in the chat." })]))))),
  ]
}

// ---------- create an app ----------

const IDEAS = [
  ["Voice notes to text", "A page where I drop in an audio file or voice memo and get the words back as text I can copy. Use Whisper, and use my NVIDIA GPU if I have one."],
  ["Chat with my files", "A chat page where I upload PDFs or text files and ask questions about them, using a local AI model so nothing leaves my PC."],
  ["Image generator", "A simple page where I type a description and get an image back, with a size picker and a button to save the image."],
  ["Background remover", "Drop in a photo and get it back with the background removed as a PNG I can download."],
  ["Read it aloud", "Paste text and hear it read aloud in a natural voice, with a choice of voices and a button to download the audio."],
]
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().split(/\s+/).slice(0, 3).join("-").slice(0, 41)

async function createView() {
  const builders = (await ask("tools").catch(() => [])).filter((t) => t.kind === "Terminal")
  const found = builders.filter((t) => t.found)
  const task = el("textarea", { id: "task", maxlength: "4000", placeholder: "For example: a page where I drop in a voice memo and get the text back, with a button to copy it." })
  const name = el("input", { id: "appname", maxlength: "41", placeholder: "voice-notes", autocomplete: "off", spellcheck: "false" })
  let named = false
  name.addEventListener("input", () => { named = !!name.value })
  task.addEventListener("input", () => { if (!named) name.value = slug(task.value) })
  const chips = el("div", { class: "chips" }, el("small", { text: "Need an idea?" }), ...IDEAS.map(([t, text]) =>
    el("button", { type: "button", text: t, onclick: () => { task.value = text; if (!named) name.value = slug(t); task.focus() } })))
  const pick = el("div", { class: "pick", role: "radiogroup" },
    ...found.map((t, i) => el("label", {}, el("input", { type: "radio", name: "builder", value: t.id, checked: i === 0 }), el("div", {}, t.name, el("small", { text: "Opens in a terminal and builds it" })))),
    el("label", {}, el("input", { type: "radio", name: "builder", value: "", checked: !found.length }), el("div", {}, "I'll build it myself", el("small", { text: "Just make the folder" }))))
  const status = el("p", { class: "status", role: "status" })
  const btn = el("button", { class: "btn", text: "Create app" })
  btn.addEventListener("click", async () => {
    btn.disabled = true
    status.className = "status"
    status.textContent = "Making its folder…"
    try {
      const builder = pick.querySelector("input:checked")?.value || null
      const a = await ask("createApp", { name: name.value, task: task.value, builder })
      go(appHash(a))
    } catch (e) {
      status.textContent = e.message
      status.classList.add("err")
      btn.disabled = false
    }
  })
  setTimeout(() => task.focus())
  const step = (n, title, text) => el("div", {}, el("span", { class: "ico", text: String(n) }), el("div", {}, el("b", { text: title }), el("span", { text })))
  return page("Create an app", "Describe what you want in your own words. An AI coding agent on your PC builds it, and Obstat installs and runs it like any other app.",
    el("div", { class: "create" },
      el("div", { class: "form-card" },
        el("label", { class: "lbl", for: "task", text: "What should the app do?" }), task, chips,
        el("div", { class: "fld" }, el("label", { class: "lbl", for: "appname" }, "Name", el("small", { text: "lowercase letters, numbers and dashes" })), name),
        el("div", { class: "fld" }, el("p", { class: "lbl", text: "Who builds it?" }), pick,
          !found.length && el("p", { class: "note" }, "No AI coding agent found on this PC. ", el("a", { href: "https://claude.com/claude-code", text: "Get Claude Code" }), ", Codex or Gemini CLI, then come back. You can still make the folder now.")),
        el("div", { class: "form-end" }, btn, status)),
      el("div", { class: "how" },
        step(1, "You describe it", "Plain words are fine. Obstat saves them in the app's folder."),
        step(2, "The agent builds it", "It opens in its own window, writes the app and its install steps, and asks you if it needs anything."),
        step(3, "Install and start", "Come back to the app's page here. You see every install step before it runs."))))
}

// ---------- tools and help ----------

function toolsView() {
  const t = (href, ic, title, text) => el("a", { href }, el("span", { class: "ico indigo" }, icon(ic)), el("div", {}, el("b", { text: title }), el("span", { text })))
  return page("Tools", "Everything that keeps your apps safe, tidy and connected.",
    el("div", { class: "tool-grid" },
      t("#/sandbox", "shield", "Sandbox", "Test a repo nobody has reviewed without risking your files."),
      t("#/skills", "bolt", "Skills", "Let AI agents like Claude Code use your Obstat apps."),
      t("#/plugins", "plug", "Plugins", "Open apps in VS Code, Cursor, Claude Code and more."),
      t("#/disk", "disk", "Disk space", "See what each app uses and get space back."),
      t("#/logs", "logs", "Logs", "Every command Obstat ran, for when something breaks."),
      t("#/server", "server", "Home Server", "Open your running apps from your phone."),
      t("#/autolaunch", "power", "Autolaunch", "Start Obstat and your apps when Windows starts.")))
}

function helpView() {
  const t = (href, ic, title, text) => el("a", { href }, el("span", { class: "ico" }, icon(ic)), el("div", {}, el("b", { text: title }), el("span", { text })))
  return page("Help", null,
    el("div", { class: "tool-grid" },
      t("#/reviews", "shield", "How reviews work", "Why apps on Discover are safer than a random repo."),
      t("#/chat/help", "chat", "Ask the community", "The Help channel, where people answer questions."),
      t("#/updates", "update", "Updates", `You have version ${info.version || "…"}.`),
      t("https://obstat.app", "link", "Website", "News, the app list and downloads."),
      t(LEGAL.terms, "doc", "Terms of Service", "The rules for using Obstat and its apps."),
      t(LEGAL.privacy, "lock", "Privacy Policy", "What Obstat stores about you, and what it never does.")))
}

// ---------- chat account, Terms and Privacy ----------

const TERMS_VERSION = "2026-10-19"
const LEGAL = { terms: "https://obstat.app/terms.html", privacy: "https://obstat.app/privacy.html" }
const legalLinks = () => [el("a", { href: LEGAL.terms, text: "Terms of Service" }), " and ", el("a", { href: LEGAL.privacy, text: "Privacy Policy" })]

// Email, then the 6-digit code. New addresses also pick a chat name and agree to the Terms.
// The team badge next to a name in chat ("Obstat dev"). Only the Obstat admin can give one.
const badge = (m) => typeof m.badge === "string" && m.badge.length <= 20 ? el("span", { class: "staff", text: m.badge, title: "From the Obstat team" }) : null

function signInBox(done) {
  const box = el("div", { class: "signin" })
  const msg = el("p", { class: "chat-status" })
  const fail = (x) => { msg.textContent = x.message }
  const emailStep = () => {
    const email = el("input", { type: "email", maxlength: "254", placeholder: "you@example.com", "aria-label": "Email address" })
    const go = el("button", { class: "btn small", text: "Email me a code", onclick: async () => {
      go.disabled = true; msg.textContent = ""
      try { await ask("sendCode", email.value.trim()); codeStep(email.value.trim()) } catch (x) { fail(x) }
      go.disabled = false
    } })
    box.replaceChildren(el("p", {}, el("b", { text: "Sign in to chat. " }), "You need a free account to post. We email you a code; no password."), el("div", { class: "row" }, email, go), msg)
  }
  const codeStep = (email) => {
    const code = el("input", { inputmode: "numeric", maxlength: "6", placeholder: "123456", "aria-label": "Code from the email" })
    const extra = el("div", { class: "signin-new", hidden: true })
    const name = el("input", { maxlength: "24", placeholder: "Pick a chat name", "aria-label": "Chat name" })
    const agree = el("input", { type: "checkbox", id: "agree-chat" })
    extra.append(el("p", { text: "New here? Pick the name people see in chat." }), name,
      el("label", { class: "check", for: "agree-chat" }, agree, el("span", {}, "I'm 13 or older and I agree to the ", ...legalLinks(), ".")))
    const go = el("button", { class: "btn small", text: "Sign in", onclick: async () => {
      go.disabled = true; msg.textContent = ""
      try {
        const fields = { email, code: code.value.trim() }
        if (!extra.hidden) Object.assign(fields, { name: name.value.trim(), acceptTerms: agree.checked })
        done(await ask("verifyCode", fields))
      } catch (x) {
        if (/Pick a chat name/.test(x.message) && extra.hidden) { extra.hidden = false; msg.textContent = "" } else fail(x)
      }
      go.disabled = false
    } })
    box.replaceChildren(el("p", { text: `We sent a code to ${email}. It works for 10 minutes.` }), el("div", { class: "row" }, code, go), extra, msg,
      el("button", { class: "link small", text: "Use a different email", onclick: emailStep }))
  }
  emailStep()
  return box
}

async function accountBox() {
  const a = await ask("account")
  return el("div", {},
    el("h2", { class: "group-h", text: "Chat account" }),
    el("dl", { class: "rows" },
      a.name
        ? el("div", {}, el("dt", {}, `Signed in as ${a.name}`, el("small", { text: "Deleting your account also deletes every chat message you posted." })),
            el("dd", {}, el("button", { class: "link", text: "Sign out", onclick: async () => { await ask("signOut"); render() } }), " ",
              el("button", { class: "link danger", text: "Delete account", onclick: async (e) => {
                if (!confirm("Delete your chat account and every message you posted? This can't be undone.")) return
                try { await ask("deleteAccount"); render() } catch (x) { e.target.textContent = x.message }
              } })))
        : el("div", {}, el("dt", {}, "Not signed in", el("small", { text: "You only need an account to post in Community chat." })),
            el("dd", {}, el("a", { class: "link", href: "#/chat", text: "Sign in" })))))
}

function legalBox() {
  return el("div", {},
    el("h2", { class: "group-h", text: "Legal" }),
    el("dl", { class: "rows" },
      el("div", {}, el("dt", {}, "Terms of Service", el("small", { text: "The rules for using Obstat." })), el("dd", {}, el("a", { class: "link", href: LEGAL.terms, text: "Read" }))),
      el("div", {}, el("dt", {}, "Privacy Policy", el("small", { text: "What we store and why." })), el("dd", {}, el("a", { class: "link", href: LEGAL.privacy, text: "Read" })))))
}

// Shown on first launch, and again whenever the Terms change.
async function termsGate() {
  const prefs = await ask("prefs")
  if (prefs.terms === TERMS_VERSION) return
  const agree = el("input", { type: "checkbox", id: "agree-terms" })
  const go = el("button", { class: "btn", text: "Agree and continue", disabled: true })
  agree.addEventListener("change", () => { go.disabled = !agree.checked })
  const gate = el("div", { class: "gate", role: "dialog", "aria-modal": "true", "aria-labelledby": "gate-h" },
    el("div", { class: "gate-card" },
      el("h2", { id: "gate-h", text: prefs.terms ? "Our Terms have changed" : "Welcome to Obstat" }),
      el("p", { text: "Obstat installs and runs open-source apps made by other people. Reviews lower the risk but can't remove it, so only run apps you trust, and keep backups of anything important." }),
      el("label", { class: "check", for: "agree-terms" }, agree, el("span", {}, "I'm 13 or older and I agree to the ", ...legalLinks(), ".")),
      go))
  go.addEventListener("click", async () => { await ask("setPref", "terms", TERMS_VERSION); gate.remove() })
  document.body.append(gate)
  agree.focus()
}

// Chat channels and News share one Community page
function communityTabs(channels, active) {
  return el("div", { class: "chan-tabs", role: "tablist" },
    ...Object.entries(channels).map(([id, name]) => el("a", { href: `#/chat/${id}`, role: "tab", "aria-selected": String(id === active), text: `# ${name}` })),
    el("span", { class: "sep", "aria-hidden": "true" }),
    el("a", { href: "#/news", role: "tab", "aria-selected": String(active === "news"), text: "News" }))
}

// ---------- news: the dot on News, and a banner while something is down ----------

function newsSeen() { try { return localStorage.getItem("obstat-news-seen") } catch { return null } }
function markNewsSeen(items) {
  try { if (items[0]) localStorage.setItem("obstat-news-seen", items[0].id) } catch {}
  $("newsdot").hidden = true
}
// ---------- updates ----------

const UPDATE_TEXT = {
  off: "Updates work in the installed app.", idle: "", checking: "Checking…", current: "Up to date.",
  downloading: "Downloading the new version…", failed: "Couldn't check. It tries again later.",
}
let update = { status: "off" }
function updateLine() {
  const span = el("span", { class: "update-line" })
  const draw = () => {
    if (span.dataset.drawn && !span.isConnected) return
    span.dataset.drawn = "1"
    span.replaceChildren(update.status === "ready"
      ? el("button", { class: "link", text: `Restart to get ${update.version}`, onclick: () => ask("installUpdate") })
      : el("span", { class: "muted", text: UPDATE_TEXT[update.status] ?? "" }),
      " ", ["idle", "current", "failed"].includes(update.status) ? el("button", { class: "link", text: "Check now", onclick: () => ask("checkUpdate") }) : "")
  }
  draw()
  updateLine.draw = draw
  return span
}
function showUpdate(u) {
  update = u
  const b = $("updatebtn")
  b.hidden = u.status !== "ready"
  b.textContent = `Restart to get ${u.version}`
  updateLine.draw?.()
}
$("updatebtn").addEventListener("click", () => ask("installUpdate"))

async function checkNews() {
  let items
  try { items = await ask("news") } catch { return }
  const seen = newsSeen()
  $("newsdot").hidden = !items.length || items[0].id === seen || location.hash.startsWith("#/news")
  $("newsdot").title = "New announcements"
  const down = items.find((n) => n.kind === "outage" && !n.resolvedAt)
  const bar = $("outage")
  bar.hidden = !down
  if (down) bar.replaceChildren(el("b", { text: "Service notice: " }), down.title, " ", el("a", { href: "#/news", text: "Details" }))
}

const sep = () => (info.platform === "win32" ? "\\" : "/")

const bytes = (n) => {
  const u = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

function toggle(on, change) {
  const b = el("button", { class: "switch", role: "switch", "aria-checked": String(!!on) }, el("span"))
  const label = el("span", { class: "switch-l", text: on ? "On" : "Off" })
  b.addEventListener("click", async () => {
    b.disabled = true
    try {
      const now = await change(b.getAttribute("aria-checked") !== "true")
      b.setAttribute("aria-checked", String(!!now))
      label.textContent = now ? "On" : "Off"
    } finally {
      b.disabled = false
    }
  })
  return el("span", { class: "switch-wrap" }, b, label)
}

function rows(pairs) {
  return el("dl", { class: "rows" }, ...pairs.map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }))))
}

// ---------- settings: command path and keys ----------

// Which python, node or git an app's install steps will run
function whichBox() {
  const input = el("input", { placeholder: "python, node, git, uv…", "aria-label": "Command name", maxlength: "64" })
  const out = el("p", { class: "note" })
  const look = async () => {
    const cmd = input.value.trim()
    if (!cmd) return
    try {
      const r = await ask("which", cmd)
      out.textContent = r.path ? `${cmd} → ${r.path}${r.obstat ? "  (Obstat's own copy)" : "  (from your PC, not Obstat's)"}` : `Apps can't find "${cmd}". If an install needs it, install it on your PC or reset Python, Node and Git.`
    } catch (e) { out.textContent = e.message }
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") look() })
  return el("div", {},
    el("h2", { class: "group-h", text: "Command check" }),
    el("p", { class: "sub", text: "See exactly which program an app gets when its install steps run a command." }),
    el("div", { class: "bar" }, input, el("button", { class: "btn small", text: "Check", onclick: look })), out)
}

// API keys, encrypted on this PC and handed only to the apps you pick
async function keysBox() {
  const [keys, mine] = await Promise.all([ask("keys"), ask("apps")])
  const installed = mine.filter((a) => a.installed)
  const nameOf = (id) => installed.find((a) => a.id === id)?.name || id
  const box = el("div", {})
  const name = el("input", { list: "keynames", placeholder: "OPENAI_API_KEY", "aria-label": "Key name", maxlength: "64" })
  const names = el("datalist", { id: "keynames" }, ...["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HF_TOKEN", "GEMINI_API_KEY", "REPLICATE_API_TOKEN", "ELEVENLABS_API_KEY"].map((v) => el("option", { value: v })))
  const value = el("input", { type: "password", placeholder: "Paste the key", "aria-label": "Key value", autocomplete: "off" })
  const who = el("select", { "aria-label": "Which apps can use it" }, el("option", { value: "*", text: "All my apps" }), ...installed.map((a) => el("option", { value: a.id, text: `Only ${a.name}` })))
  const status = el("p", { class: "note" })
  const save = async () => {
    try {
      await ask("addKey", { name: name.value, value: value.value, apps: [who.value] })
      render()
    } catch (e) { status.textContent = e.message }
  }
  box.append(
    el("h2", { class: "group-h", text: "Keys" }),
    el("p", { class: "sub", text: "Some apps need an API key, like OpenAI or Hugging Face. Keys are encrypted on this PC, given to an app as a setting when it runs, and never sent to Obstat. Sandbox tests aren't given them." }),
    keys.length ? el("dl", { class: "rows" }, ...keys.map((k) => el("div", {},
      el("dt", {}, k.name, el("small", { text: `…${k.hint} · ${k.apps.includes("*") ? "all my apps" : k.apps.map(nameOf).join(", ")}` })),
      el("dd", {}, el("button", { class: "link danger", text: "Delete", onclick: async () => { if (confirm(`Delete ${k.name}?`)) { await ask("removeKey", k.id); render() } } }))))) : el("p", { class: "muted", text: "No keys yet." }),
    el("div", { class: "bar key-bar" }, name, names, value, who, el("button", { class: "btn small", text: "Save key", onclick: save })), status)
  return box
}

// ---------- live app events ----------

function appendLog(id, text) {
  if (!current || current.id !== id || !document.body.contains(current.term)) return
  const { term, logBody } = current
  const stick = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 30
  term.textContent = (term.textContent + text).slice(-200000)
  if (stick) logBody.scrollTop = logBody.scrollHeight
}

window.obstat.onEvent((ev) => {
  if (ev.type === "log") appendLog(ev.id, ev.text)
  else if (ev.type === "progress") {
    // one line per 25% so the log doesn't flood
    const pct = ev.total ? Math.floor((ev.got / ev.total) * 4) * 25 : null
    const key = `${ev.id}:${ev.name}`
    if (pct !== null && progressSeen[key] !== pct) { progressSeen[key] = pct; appendLog(ev.id, `Downloading ${ev.name}… ${pct}%\n`) }
  }
  else if (ev.type === "open" && ev.url) {
    // the app asked to open its page: show it inside Obstat if the person is looking at it
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(ev.url)) { if (current?.id === ev.id && location.hash.startsWith("#/app/")) go(runHash(ev.id)) }
    else window.obstat.openExternal(ev.url)
  }
  else if (ev.type === "update") showUpdate(ev)
  else if (ev.type === "view" && current?.run && current.id === ev.id) current.onView(ev)
  else if (ev.type === "state" && current?.run && current.id === ev.id) current.onState()
  else if (ev.type === "state" && current?.id === ev.id && location.hash.startsWith("#/app/") && !current.note.childElementCount) {
    // refresh the buttons (Open web UI appears once the app prints its address)
    clearTimeout(current.refresh)
    const was = current
    current.refresh = setTimeout(() => { if (current === was && !was.note.childElementCount) render() }, 300)
  }
})

// ---------- an app open inside Obstat ----------

async function runView(id) {
  const a = await ask("app", id)
  if (!a) return page("That app isn't installed", "Install it first, then start it.", linkBtn("My apps", "#/apps"))
  const term = el("pre", {})
  const logBody = el("div", { class: "term-body" }, term)
  const msg = el("p", { class: "stage-msg", role: "status" })
  const stageBtns = el("div", { class: "row-btns" })
  const stage = el("div", { class: "stage" }, el("div", { class: "stage-in" }, msg, stageBtns))
  const logPane = el("div", { class: "run-log term", hidden: true }, logBody)
  const where = el("span", { class: "run-url" })
  const tb = (label, path, fn) => el("button", { class: "tb", title: label, "aria-label": label, onclick: fn }, icon(path))
  const logBtn = el("button", { class: "btn small ghost", text: "Log", "aria-pressed": "false", onclick: () => showLog(logPane.hidden) })
  const stopBtn = el("button", { class: "btn small ghost", text: "Stop", onclick: async () => { stopBtn.disabled = true; await ask("stop", id).catch(() => {}) } })
  let opened = false, mounted = false

  const showLog = (on) => {
    logPane.hidden = !on
    logBtn.setAttribute("aria-pressed", String(on))
    if (on) logBody.scrollTop = logBody.scrollHeight
  }
  const say = (text, ...btns) => { msg.textContent = text; stageBtns.replaceChildren(...btns.filter(Boolean)) }
  const bounds = () => { const r = stage.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } }
  const place = () => { if (mounted && document.body.contains(stage)) window.obstat.placeView(bounds()) }

  async function open() {
    opened = true
    try { await ask("showView", id, bounds()) } catch (err) { opened = false; say(err.message) }
  }
  async function startWith(script) {
    say("Starting…")
    showLog(true)
    stopBtn.disabled = false
    term.textContent = ""
    const r = await ask("run", id, script).catch((err) => ({ ok: false, error: err.message }))
    if (!r.ok) say(`It stopped: ${r.error}`, el("button", { class: "btn small", text: "Back to the app", onclick: () => go(appHash(a)) }))
  }
  async function idle() {
    opened = false
    stopBtn.disabled = true
    const runs = await ask("runs", id).catch(() => [])
    say(runs.length ? `${a.name} isn't running.` : `${a.name} has nothing to start.`,
      ...runs.map((o, i) => el("button", { class: i ? "btn small ghost" : "btn small", text: o.label, onclick: () => startWith(o.script) })))
  }
  async function sync() {
    const now = await ask("app", id).catch(() => null)
    if (!now?.running) return idle()
    stopBtn.disabled = false
    if (now.running.url) { if (!opened) open() }
    else { say("Starting… it opens here as soon as it's ready."); showLog(true) }
  }

  current = {
    id, term, logBody, note: el("div"), run: true,
    onState: () => { if (document.body.contains(stage)) sync() },
    onView: (ev) => {
      if (ev.state === "title") return
      if (ev.state === "ready") { where.textContent = ev.url; say(""); return }
      if (ev.url) where.textContent = ev.url
      if (ev.state === "loading") say("Opening…")
      else if (ev.state === "waiting") say("Waiting for the app to answer. Big apps can take a few minutes the first time.")
      else if (ev.state === "failed") say(ev.message, el("button", { class: "btn small", text: "Try again", onclick: () => window.obstat.viewAct(id, "reload") }), el("button", { class: "btn small ghost", text: "Show the log", onclick: () => showLog(true) }))
    },
  }
  ask("readLog", `apps/${id.replace(/[^a-z0-9._-]+/gi, "-")}/${(a.running?.script || "start.js").replace(/\.js$/, "")}.txt`)
    .then((r) => { if (!term.textContent) term.textContent = r.text })
    .catch(() => {})

  // the app's page is a separate layer: keep it lined up with the stage
  const ro = new ResizeObserver(() => {
    if (!document.body.contains(stage)) return ro.disconnect()
    if (!mounted) { mounted = true; sync() }
    place()
  })
  ro.observe(stage)
  window.addEventListener("resize", place)

  return [el("div", { class: "run" },
    el("div", { class: "run-bar" },
      tb("Back to the app page", "back", () => go(appHash(a))),
      mark(a.name, a),
      el("strong", { text: a.name }),
      where,
      el("div", { class: "run-tools" },
        tb("Back", "prev", () => window.obstat.viewAct(id, "back")),
        tb("Forward", "next", () => window.obstat.viewAct(id, "forward")),
        tb("Reload", "update", () => window.obstat.viewAct(id, "reload")),
        tb("Open in your browser", "open", () => window.obstat.viewExternal(id)),
        logBtn, stopBtn)),
    stage, logPane)]
}

// ---------- routing ----------

async function render() {
  const [route = "home", ...args] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent)
  const fn = views[route] || views.home
  // a running app's page sits on top of the window; only the Run screen shows it
  if (route !== "run") window.obstat.hideView()
  view.classList.toggle("full", route === "run")
  const SECTION = { app: "apps", news: "chat", sandbox: "tools", disk: "tools", plugins: "tools", skills: "tools", logs: "tools", server: "tools", autolaunch: "tools", reviews: "help", updates: "help" }
  for (const a of document.querySelectorAll(".menu a[data-route]")) {
    const on = a.dataset.route === (SECTION[route] || route)
    on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")
  }
  clearInterval(poll)
  let nodes
  try {
    nodes = await fn(...args)
  } catch (e) {
    nodes = page("Something went wrong", e.message)
  }
  view.replaceChildren(el("div", { class: "view-in" }, ...nodes.filter(Boolean)))
  view.scrollTop = 0
}

// links in text open in the browser, never inside the app window
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]")
  if (!a || a.getAttribute("href").startsWith("#")) return
  e.preventDefault()
  window.obstat.openExternal(a.href)
})

// one box for both: a GitHub link opens it, anything else searches Discover
$("search").addEventListener("submit", (e) => {
  e.preventDefault()
  const q = $("q").value.trim()
  if (!q) return
  $("q").value = ""
  go(/github\.com\/|^[\w.-]+\/[\w.-]+$/i.test(q) ? `#/add/${encodeURIComponent(q)}` : `#/discover/${encodeURIComponent(q)}`)
})
$("back").addEventListener("click", () => history.back())
$("fwd").addEventListener("click", () => history.forward())
$("reload").addEventListener("click", async () => { await loadList(); render() })
window.addEventListener("hashchange", render)

info = await ask("info")
$("ver").textContent = `v${info.version}`
await loadList()
render()
termsGate()
ask("updateState").then(showUpdate).catch(() => {})
checkNews()
setInterval(checkNews, 60_000)
