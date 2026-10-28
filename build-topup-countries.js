// ============================================================
//  BUILD-TOPUP-COUNTRIES.JS
// ------------------------------------------------------------
//  Recorre los 194 países de countries.js y le pregunta a Zendit,
//  país por país, si existe al menos UNA oferta de Mobile Top-Up
//  de precio FIJO (FIXED) y habilitada (enabled !== false).
//
//  Con eso arma un archivo estático `topup_countries.json` —
//  { "GT": "Guatemala", "PA": "Panamá", ... } — que la página
//  recharge.html carga UNA vez al abrir, y usa para no listar
//  países sin recargas disponibles (ej. Portugal). Mismo patrón
//  que ya usa el catálogo de eSIM (archivos JSON pre-calculados,
//  en vez de consultar a Zendit en cada visita).
//
//  CÓMO CORRERLO (igual que verify-topup-catalog.js):
//
//    cd carpeta-del-proyecto
//    export ZENDIT_API_KEY="tu-api-key-real-de-produccion"
//    node build-topup-countries.js
//
//  Al terminar vas a tener un archivo nuevo: topup_countries.json
//  Súbeme ese archivo (o pégamelo) y yo lo incluyo en el próximo
//  ZIP junto con el cambio de código en recharge.js.
//
//  Nota: usa el MISMO subType ("Mobile Top Up") y el mismo filtro
//  (priceType === "FIXED" && enabled !== false) que ya usa
//  recharge.js en producción, para que el resultado sea 100%
//  consistente con lo que el usuario ve al elegir un país.
// ============================================================

const https = require("https");
const fs = require("fs");
const path = require("path");

const ZENDIT_KEY = process.env.ZENDIT_API_KEY;
const ZENDIT_BASE = process.env.ZENDIT_BASE_URL || "https://api.zendit.io/v1";
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const DELAY_MS = Number(process.env.DELAY_MS || 150); // pequeño respiro entre tandas

if (!ZENDIT_KEY) {
  console.error("❌ Falta ZENDIT_API_KEY. Ejemplo:\n   export ZENDIT_API_KEY=\"tu-api-key\"\n   node build-topup-countries.js");
  process.exit(1);
}

// ── Cargar la lista real de países desde countries.js (misma fuente
//    que usa recharge.js en el navegador — no se inventa una lista nueva) ──
function loadCountryCodes() {
  const countriesPath = path.join(__dirname, "countries.js");
  if (!fs.existsSync(countriesPath)) {
    console.error(`❌ No encontré countries.js en ${countriesPath}. Corre este script desde la carpeta raíz del proyecto (donde está countries.js).`);
    process.exit(1);
  }
  const src = fs.readFileSync(countriesPath, "utf8");
  const m = src.match(/const COUNTRY_CODE = (\{[\s\S]*?\n\});/);
  if (!m) {
    console.error("❌ No pude extraer COUNTRY_CODE de countries.js — el archivo pudo haber cambiado de formato.");
    process.exit(1);
  }
  return JSON.parse(m[1]); // { "AD": "Andorra", ... }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers: { Authorization: "Bearer " + ZENDIT_KEY, "Content-Type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, data: null, raw: buf.slice(0, 200) });
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function hasTopupForCountry(code) {
  const url = `${ZENDIT_BASE}/topups/offers?country=${encodeURIComponent(code)}&_limit=100&_offset=0&subType=${encodeURIComponent("Mobile Top Up")}`;
  try {
    const { status, data } = await httpsGetJson(url);
    if (status !== 200 || !data || !Array.isArray(data.list)) return { code, ok: false, count: 0, error: status !== 200 ? `HTTP ${status}` : null };
    const valid = data.list.filter((o) => o.priceType === "FIXED" && o.enabled !== false);
    return { code, ok: valid.length > 0, count: valid.length, error: null };
  } catch (err) {
    return { code, ok: false, count: 0, error: err.message };
  }
}

async function main() {
  const COUNTRY_CODE = loadCountryCodes();
  const codes = Object.keys(COUNTRY_CODE);
  console.log(`Países a verificar: ${codes.length}`);
  console.log(`Concurrencia: ${CONCURRENCY} · Base: ${ZENDIT_BASE}\n`);

  const results = [];
  let processed = 0;

  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(hasTopupForCountry));
    results.push(...batchResults);
    processed += batch.length;
    process.stdout.write(`\rProcesados: ${processed}/${codes.length}`);
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log("\n");

  const available = {};
  const unavailable = [];
  const errors = [];

  results.forEach((r) => {
    if (r.error) { errors.push(r); return; }
    if (r.ok) available[r.code] = COUNTRY_CODE[r.code];
    else unavailable.push(`${r.code} (${COUNTRY_CODE[r.code]})`);
  });

  const outPath = path.join(__dirname, "topup_countries.json");
  fs.writeFileSync(outPath, JSON.stringify(available, null, 2));

  console.log(`✅ Países CON recarga disponible: ${Object.keys(available).length}`);
  console.log(`⛔ Países SIN recarga disponible: ${unavailable.length}`);
  if (errors.length) console.log(`⚠️  Errores de consulta (tratados como sin recarga, no se listan): ${errors.length}`);
  console.log(`\nArchivo generado: ${outPath}`);
  console.log(`\nPaíses SIN recarga (ejemplos): ${unavailable.slice(0, 15).join(", ")}${unavailable.length > 15 ? "…" : ""}`);
  if (errors.length) {
    console.log(`\nDetalle de errores:`);
    errors.slice(0, 10).forEach((e) => console.log(`  ${e.code}: ${e.error}`));
  }
}

main();
