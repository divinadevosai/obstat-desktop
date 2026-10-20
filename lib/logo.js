// A logo for apps that don't ship one (apps made in Obstat, repos with no icon),
// so every app in the list has a picture instead of a bare letter. Same name,
// same logo: the colours and shape come from a hash of the name.
const crypto = require("crypto")

const PAIRS = [
  ["#d9b46a", "#8f8cf5"], ["#8f8cf5", "#5be0c8"], ["#ff9d7a", "#d9b46a"], ["#5be0c8", "#3d7bf5"],
  ["#f57fb4", "#8f8cf5"], ["#9ad7b0", "#d9b46a"], ["#3d7bf5", "#f57fb4"], ["#ffcf5c", "#ff7a7a"],
]

function initials(name) {
  const words = String(name || "?").replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/).filter(Boolean)
  const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)
  return s.toUpperCase()
}

function logoSvg(name) {
  const h = crypto.createHash("sha256").update(String(name || "")).digest()
  const [a, b] = PAIRS[h[0] % PAIRS.length]
  const turn = (h[1] % 8) * 45
  const shape = h[2] % 3
  const deco = shape === 0
    ? `<circle cx="96" cy="32" r="38" fill="${b}" opacity=".55"/>`
    : shape === 1
      ? `<path d="M0 96 L64 128 L0 128Z M128 0 L128 48 L80 0Z" fill="${b}" opacity=".6"/>`
      : `<rect x="70" y="-20" width="70" height="70" rx="18" transform="rotate(30 105 15)" fill="${b}" opacity=".55"/>`
  const text = initials(name).replace(/[<&>]/g, "")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" gradientTransform="rotate(${turn} .5 .5)"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><clipPath id="c"><rect width="128" height="128" rx="30"/></clipPath></defs><g clip-path="url(#c)"><rect width="128" height="128" fill="#15131f"/><rect width="128" height="128" fill="url(#g)" opacity=".9"/>${deco}</g><text x="64" y="80" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${text.length > 1 ? 46 : 58}" font-weight="700" fill="#0b0a12">${text}</text></svg>`
}

const logoDataUrl = (name) => `data:image/svg+xml;base64,${Buffer.from(logoSvg(name)).toString("base64")}`

module.exports = { logoSvg, logoDataUrl, initials }
