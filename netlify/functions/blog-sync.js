// ============================================================
//  BLOG-SYNC.JS — Función programada (cada hora)
//  Compara los artículos publicados en Soro con los que tiene el sitio
//  (/blog/manifest.json, generado por build-blog.js). Si hay diferencias,
//  dispara un build de Netlify (Build Hook) para publicar el HTML nuevo.
//  Requiere la variable BUILD_HOOK_URL (Netlify → Build hooks).
// ============================================================

const https = require("https");

const TOKEN = process.env.SORO_EMBED_TOKEN || "add3845a-f549-4ccb-8c15-cbba2e8207b9";
const SITE = process.env.SITE_URL || "https://infinity-roam.com";

function request(url, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, timeout: 20000,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function () {
  try {
    const hook = process.env.BUILD_HOOK_URL;
    if (!hook || !/^https:\/\/api\.netlify\.com\/build_hooks\//.test(hook)) {
      console.log("[blog-sync] BUILD_HOOK_URL no configurada: no se hace nada.");
      return { statusCode: 200, body: "no-hook" };
    }
    const js = await request(`https://app.trysoro.com/api/embed/${TOKEN}`);
    const m = js.body.match(/var SORO_ARTICLES = (\[[\s\S]*?\]);\s*\n/);
    if (js.status !== 200 || !m) { console.warn("[blog-sync] Soro no respondió bien:", js.status); return { statusCode: 200, body: "soro-unavailable" }; }
    const remote = JSON.parse(m[1]).map((a) => `${a.id}:${a.isoDate}`).sort();
    if (!remote.length) return { statusCode: 200, body: "empty" };

    let local = [];
    try {
      const r = await request(`${SITE}/blog/manifest.json`);
      if (r.status === 200) local = JSON.parse(r.body).items || [];
    } catch {}

    if (JSON.stringify(remote) === JSON.stringify(local)) {
      console.log("[blog-sync] Sin cambios (" + remote.length + " artículos).");
      return { statusCode: 200, body: "unchanged" };
    }
    const r = await request(hook, "POST", "{}");
    console.log(`[blog-sync] Cambios detectados (Soro ${remote.length} vs sitio ${local.length}). Build solicitado: HTTP ${r.status}`);
    return { statusCode: 200, body: "rebuild-triggered" };
  } catch (e) {
    console.error("[blog-sync] Error:", e.message);
    return { statusCode: 200, body: "error" };
  }
};
