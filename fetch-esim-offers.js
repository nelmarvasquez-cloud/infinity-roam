// ============================================================
//  FETCH-ESIM-OFFERS.js — paso 1 para actualizar costos de eSIM
//  Descarga el catálogo ACTUAL de eSIMs de Zendit y lo guarda en
//  zendit_esim_offers_raw.json. NO modifica ningún archivo de la tienda.
//
//    cd carpeta-del-proyecto
//    read -s ZENDIT_API_KEY; export ZENDIT_API_KEY
//    node fetch-esim-offers.js
// ============================================================
const https = require("https");
const fs = require("fs");
const path = require("path");

const KEY = process.env.ZENDIT_API_KEY;
const BASE = process.env.ZENDIT_BASE_URL || "https://api.zendit.io/v1";
const PAGE = 1000;
if (!KEY) { console.error("Falta ZENDIT_API_KEY (ver instrucciones arriba)."); process.exit(1); }

function get(url) {
  return new Promise((resolve, reject) => {
    https.request(url, { method: "GET", headers: { Authorization: /^Bearer /i.test(KEY) ? KEY : "Bearer " + KEY, "Content-Type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: raw.slice(0, 200) }); }
      });
    }).on("error", reject).end();
  });
}

(async () => {
  const all = [];
  let offset = 0, total = null;
  while (true) {
    const { status, data, raw } = await get(`${BASE}/esim/offers?_limit=${PAGE}&_offset=${offset}`);
    if (status !== 200 || !data || !Array.isArray(data.list)) {
      console.error(`Error HTTP ${status} en offset ${offset}`, raw || ""); process.exit(1);
    }
    all.push(...data.list);
    total = data.total != null ? data.total : total;
    process.stdout.write(`\rDescargadas: ${all.length}${total != null ? "/" + total : ""}`);
    if (data.list.length < PAGE || (total != null && all.length >= total)) break;
    offset += PAGE;
  }
  console.log("");
  const out = path.join(__dirname, "zendit_esim_offers_raw.json");
  fs.writeFileSync(out, JSON.stringify(all));
  console.log(`Ofertas: ${all.length}`);
  console.log(`Archivo: ${out}`);
  console.log("Campos de la primera oferta:", Object.keys(all[0] || {}).join(", "));
})();
