// ============================================================
//  BUILD-GUIDES.JS — Mantiene los precios de /guias/ iguales a los de la tienda
//  Cada tarjeta de precio lleva data-offer="<offerId>". En cada build se lee el
//  precio de venta real (zendit_prices.json, el mismo que muestra el catálogo)
//  y se actualizan las tarjetas y los textos "desde $X" (meta, JSON-LD, hero).
//  Si falta algún precio, esa guía no se toca (no rompe el build).
// ============================================================
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
let P;
try { P = JSON.parse(fs.readFileSync(path.join(ROOT, "zendit_prices.json"), "utf8")); }
catch (e) { console.warn("⚠️  [guides] sin zendit_prices.json:", e.message); process.exit(0); }

let changed = 0;
for (const f of fs.readdirSync(path.join(ROOT, "guias")).filter((x) => /^esim-.*\.html$/.test(x))) {
  const file = path.join(ROOT, "guias", f);
  let html = fs.readFileSync(file, "utf8");
  const ids = [...html.matchAll(/data-offer="([^"]+)"/g)].map((m) => m[1]);
  if (!ids.length) continue;
  const prices = ids.map((id) => P[id]);
  if (prices.some((p) => !(p > 0))) { console.warn(`⚠️  [guides] ${f}: falta precio de algún plan; no se actualiza.`); continue; }
  const before = html;
  // tarjetas
  html = html.replace(/(<div class="price-card[^"]*" data-offer="([^"]+)">[\s\S]*?<div class="pc-price">)\$[\d.]+/g,
    (m, pre, id) => `${pre}$${Number(P[id]).toFixed(2)}`);
  // "desde $X" = el plan más barato de la guía
  const min = Math.min(...prices).toFixed(2);
  html = html.replace(/([Dd]esde )\$[\d.]+/g, `$1$${min}`);
  if (html !== before) { fs.writeFileSync(file, html); changed++; }
}
console.log(`[guides] precios sincronizados (${changed} guías actualizadas).`);
