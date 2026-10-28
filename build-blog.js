// ============================================================
//  BUILD-BLOG.JS — Publica los artículos de Soro como HTML estático
// ------------------------------------------------------------
//  Soro entrega sus artículos solo por JavaScript (embed). Google casi
//  nunca indexa bien contenido cargado así. Este script, que corre en cada
//  deploy de Netlify, descarga los artículos desde Soro (misma fuente pública
//  que usa el embed) y genera:
//
//    /blog/index.html            índice con enlaces <a href> reales
//    /blog/<slug>/index.html     una página HTML completa por artículo
//                                (title, description, canonical, Open Graph,
//                                JSON-LD BlogPosting + BreadcrumbList,
//                                enlaces internos a artículos relacionados)
//    /sitemap.xml                páginas del sitio + todos los artículos
//    /blog/manifest.json         huella de lo publicado (la usa la función
//                                programada para saber si hay que republicar)
//
//  Si Soro no responde, usa la copia guardada en blog_data/articles.json
//  (nunca deja el blog vacío ni rompe el deploy).
//
//  Uso manual:  node build-blog.js
// ============================================================

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SORO_TOKEN = process.env.SORO_EMBED_TOKEN || "add3845a-f549-4ccb-8c15-cbba2e8207b9";
const SORO_BASE = process.env.SORO_BASE_URL || "https://app.trysoro.com";
const SITE = (process.env.SITE_URL || "https://infinity-roam.com").replace(/\/$/, "");
const ROOT = __dirname;
const SNAPSHOT = path.join(ROOT, "blog_data", "articles.json");
const CONCURRENCY = 4;

// ── HTTP ───────────────────────────────────────────────────
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("http://") ? http : https).get(url, { timeout: 20000, headers: { "User-Agent": "InfinityRoam-BlogBuild/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, redirects + 1));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function getRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await get(url);
      if (r.status === 200) return r.body;
      last = new Error("HTTP " + r.status);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw last;
}

// ── Lista de artículos desde el embed de Soro ──────────────
async function fetchArticleList() {
  const js = await getRetry(`${SORO_BASE}/api/embed/${SORO_TOKEN}`);
  const m = js.match(/var SORO_ARTICLES = (\[[\s\S]*?\]);\s*\n/);
  if (!m) throw new Error("No se encontró SORO_ARTICLES en el embed");
  const list = JSON.parse(m[1]);
  if (!Array.isArray(list)) throw new Error("Formato inesperado");
  return list.map((a) => ({
    id: a.id, title: a.title, slug: a.slug, excerpt: a.excerpt || "",
    isoDate: a.isoDate, image: a.image || "", content: a.content || null,
  }));
}

async function fetchContent(id) {
  const body = await getRetry(`${SORO_BASE}/api/embed/${SORO_TOKEN}/article/${encodeURIComponent(id)}`);
  const data = JSON.parse(body);
  if (!data.content) throw new Error("sin contenido");
  return data.content;
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const n = i++; results[n] = await worker(items[n], n); }
  }));
  return results;
}

// ── Sanitizador (el contenido viene de un tercero y se publica en nuestro dominio) ──
const ALLOWED_TAGS = new Set(["p","h2","h3","h4","ul","ol","li","strong","b","em","i","a","img","blockquote","br","hr","code","pre","table","thead","tbody","tr","th","td","figure","figcaption"]);
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function sanitize(html) {
  html = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|form|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<h1\b/gi, "<h2").replace(/<\/h1>/gi, "</h2>"); // la página ya tiene su propio H1
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (full.startsWith("</")) return `</${tag}>`;
    const keep = [];
    const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(attrs))) {
      const name = m[1].toLowerCase(), val = m[3] != null ? m[3] : m[4];
      if (name === "href" && tag === "a") {
        if (/^(https?:\/\/|\/|#|mailto:)/i.test(val)) keep.push(`href="${esc(val.replace(/&amp;/g, "&"))}"`);
      } else if (name === "src" && tag === "img") {
        if (/^https:\/\//i.test(val)) keep.push(`src="${esc(val.replace(/&amp;/g, "&"))}"`);
      } else if ((name === "alt" || name === "title") && (tag === "img" || tag === "a")) {
        keep.push(`${name}="${esc(val.replace(/&amp;/g, "&"))}"`);
      }
    }
    if (tag === "a") {
      const href = (keep.find((k) => k.startsWith("href=")) || "");
      if (/href="https?:\/\//i.test(href) && !href.includes(SITE.replace("https://", ""))) keep.push('rel="noopener nofollow" target="_blank"');
    }
    if (tag === "img") { keep.push('loading="lazy"'); if (!keep.some((k) => k.startsWith("src="))) return ""; }
    return `<${tag}${keep.length ? " " + keep.join(" ") : ""}>`;
  });
}

// ── Utilidades de texto ────────────────────────────────────
function textOf(html) { return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim(); }
function fmtDate(iso) { return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }); }
function readMinutes(html) { return Math.max(1, Math.round(textOf(html).split(" ").length / 220)); }

const STOP = new Set("the a an and or of to in for on with your you is are how what when do does before after this that from at by it as be can will about into".split(" "));
function words(a) { return new Set((a.title + " " + a.slug.replace(/-/g, " ")).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))); }
function related(article, all, n = 4) {
  const w = words(article);
  return all.filter((o) => o.slug !== article.slug)
    .map((o) => { let s = 0; for (const x of words(o)) if (w.has(x)) s++; return { o, s }; })
    .sort((a, b) => b.s - a.s || new Date(b.o.isoDate) - new Date(a.o.isoDate))
    .slice(0, n).map((x) => x.o);
}

// ── Plantillas ─────────────────────────────────────────────
const GA = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-QWNLSCXJ9P"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-QWNLSCXJ9P');</script>
  <script src="/utm.js"></script>`;

const CSS = `:root{--navy:#16223F;--navy2:#223257;--blue:#2864E6;--gray:#B0B0B0;}
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:"Outfit",sans-serif;background:var(--navy);color:#fff;line-height:1.6;}
    a{color:inherit}
    .nav{position:sticky;top:0;z-index:100;background:rgba(10,10,10,0.97);backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.07);padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;}
    .nav-logo{font-weight:800;font-size:1.05rem;color:#2864E6;text-decoration:none;}
    .nav-logo span{color:#C8C8C8;font-weight:400;}
    .nav-cta{background:var(--blue);color:#fff;padding:8px 18px;border-radius:99px;font-size:.85rem;font-weight:700;text-decoration:none;}
    .breadcrumb{font-size:.78rem;color:var(--gray);padding:12px 20px;max-width:820px;margin:0 auto;display:block;}
    .breadcrumb a{color:var(--gray);text-decoration:none;}
    .wrap{max-width:820px;margin:0 auto;padding:0 20px 56px;}
    .hero{background:linear-gradient(135deg,#16223F 0%,#223257 60%,#16223F 100%);padding:48px 20px 28px;text-align:center;}
    .hero h1{font-size:clamp(1.9rem,5vw,2.8rem);font-weight:800;margin-bottom:12px;}
    .hero p{color:var(--gray);max-width:560px;margin:0 auto;}
    .card{display:flex;gap:16px;background:#fff;color:#16223F;border-radius:16px;padding:14px;margin:0 0 14px;text-decoration:none;}
    .card img{width:160px;height:110px;object-fit:cover;border-radius:10px;flex:none;background:#e6ebf5;}
    .card h2{font-size:1.1rem;line-height:1.3;margin-bottom:6px;}
    .card p{font-size:.88rem;color:#4b5873;}
    .card time{font-size:.75rem;color:#7a869f;display:block;margin-top:6px;}
    article.post{background:#fff;color:#1c2540;border-radius:20px;padding:28px 26px;}
    article.post h1{font-size:clamp(1.6rem,4.5vw,2.3rem);line-height:1.2;margin-bottom:10px;color:#16223F;}
    .meta{font-size:.82rem;color:#6b7691;margin-bottom:18px;}
    .hero-img{width:100%;max-height:380px;object-fit:cover;border-radius:12px;margin-bottom:20px;background:#e6ebf5;}
    .content h2{font-size:1.4rem;margin:28px 0 10px;color:#16223F;}
    .content h3{font-size:1.15rem;margin:22px 0 8px;color:#16223F;}
    .content p,.content li{font-size:1.02rem;margin-bottom:14px;}
    .content ul,.content ol{margin:0 0 14px 22px;}
    .content a{color:#2864E6;}
    .content img{max-width:100%;height:auto;border-radius:10px;}
    .content table{width:100%;border-collapse:collapse;margin:0 0 16px;font-size:.95rem;}
    .content th,.content td{border:1px solid #d9e0ee;padding:8px;text-align:left;}
    .cta{background:var(--navy2);border-radius:16px;padding:24px;margin:26px 0;text-align:center;}
    .cta h2{font-size:1.25rem;margin-bottom:8px;} .cta p{color:var(--gray);margin-bottom:14px;}
    .rel h2{font-size:1.2rem;margin:26px 0 12px;}
    footer{background:#060e1a;padding:28px 20px;text-align:center;}
    footer p{color:rgba(255,255,255,0.3);font-size:.75rem;} footer a{color:var(--gray);text-decoration:none;}
    @media(max-width:600px){.card{flex-direction:column}.card img{width:100%;height:170px}article.post{padding:20px 16px}}`;

function layout({ title, description, canonical, ogImage, ogType, jsonLd, body, lang = "en" }) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png"/>
  ${GA}
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}"/>
  <meta name="robots" content="index, follow, max-image-preview:large"/>
  <link rel="canonical" href="${esc(canonical)}"/>
  <link rel="alternate" hreflang="${lang}" href="${esc(canonical)}"/>
  <link rel="alternate" hreflang="x-default" href="${esc(canonical)}"/>
  <meta property="og:type" content="${ogType}"/>
  <meta property="og:site_name" content="Infinity Roam"/>
  <meta property="og:title" content="${esc(title)}"/>
  <meta property="og:description" content="${esc(description)}"/>
  <meta property="og:url" content="${esc(canonical)}"/>
  <meta property="og:image" content="${esc(ogImage)}"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${esc(title)}"/>
  <meta name="twitter:description" content="${esc(description)}"/>
  <meta name="twitter:image" content="${esc(ogImage)}"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;800&display=swap" rel="stylesheet"/>
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
  <style>${CSS}</style>
</head>
<body>
<nav class="nav"><a href="/" class="nav-logo">Infinity <span>Roam</span></a><a href="/catalog.html" class="nav-cta">View plans →</a></nav>
${body}
<footer><p>© 2026 Infinity Roam · <a href="/">Home</a> · <a href="/catalog.html">Plans</a> · <a href="/guias/">Guías</a> · <a href="/blog/">Blog</a></p></footer>
</body>
</html>
`;
}

function card(a) {
  return `<a class="card" href="/blog/${a.slug}/">${a.image ? `<img src="${esc(a.image)}" alt="${esc(a.title)}" loading="lazy" width="160" height="110"/>` : ""}<div><h2>${esc(a.title)}</h2><p>${esc(a.excerpt)}</p><time datetime="${esc(a.isoDate)}">${fmtDate(a.isoDate)}</time></div></a>`;
}

function renderArticle(a, all) {
  const url = `${SITE}/blog/${a.slug}/`;
  const content = sanitize(a.content);
  const rel = related(a, all);
  const desc = a.excerpt || textOf(content).slice(0, 155);
  const ld = [
    {
      "@context": "https://schema.org", "@type": "BlogPosting",
      headline: a.title, description: desc, mainEntityOfPage: { "@type": "WebPage", "@id": url }, url,
      datePublished: a.isoDate, dateModified: a.isoDate, inLanguage: "en",
      ...(a.image ? { image: [a.image] } : {}),
      author: { "@type": "Organization", name: "Infinity Roam", url: SITE },
      publisher: { "@type": "Organization", name: "Infinity Roam", url: SITE, logo: { "@type": "ImageObject", url: SITE + "/icons/icon-512.png" } },
    },
    {
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "Blog", item: SITE + "/blog/" },
        { "@type": "ListItem", position: 3, name: a.title, item: url },
      ],
    },
  ];
  const body = `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/blog/">Blog</a> › ${esc(a.title)}</nav>
<main class="wrap">
<article class="post">
  <h1>${esc(a.title)}</h1>
  <p class="meta"><time datetime="${esc(a.isoDate)}">${fmtDate(a.isoDate)}</time> · ${readMinutes(content)} min read · By Infinity Roam</p>
  ${a.image ? `<img class="hero-img" src="${esc(a.image)}" alt="${esc(a.title)}" width="800" height="380"/>` : ""}
  <div class="content">${content}</div>
</article>
<aside class="cta"><h2>Stay connected on your next trip</h2><p>Instant eSIM data plans for 190+ countries. No roaming fees, no physical SIM.</p><a class="nav-cta" href="/catalog.html">Browse eSIM plans →</a></aside>
${rel.length ? `<section class="rel"><h2>Related articles</h2>${rel.map(card).join("")}</section>` : ""}
</main>`;
  return layout({ title: `${a.title} | Infinity Roam`, description: desc, canonical: url, ogImage: a.image || SITE + "/icons/icon-512.png", ogType: "article", jsonLd: ld, body });
}

function renderIndex(all) {
  const url = `${SITE}/blog/`;
  const ld = [
    { "@context": "https://schema.org", "@type": "Blog", name: "Infinity Roam Blog", url, inLanguage: "en",
      blogPost: all.slice(0, 20).map((a) => ({ "@type": "BlogPosting", headline: a.title, url: `${SITE}/blog/${a.slug}/`, datePublished: a.isoDate })) },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "Blog", item: url } ] },
  ];
  const body = `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a> › Blog</nav>
<header class="hero"><h1>eSIM &amp; travel connectivity guides</h1><p>Tips, how-tos and comparisons to stay online abroad without roaming fees.</p></header>
<main class="wrap" style="padding-top:24px">${all.map(card).join("")}</main>`;
  return layout({ title: "eSIM & Travel Connectivity Blog | Infinity Roam", description: "Guides and tips about travel eSIMs, activation, compatibility and staying connected abroad without roaming fees.", canonical: url, ogImage: SITE + "/icons/icon-512.png", ogType: "website", jsonLd: ld, body });
}

// ── Sitemap ────────────────────────────────────────────────
const STATIC_PAGES = [
  ["/", "weekly", "1.0"], ["/catalog.html", "daily", "0.9"], ["/recharge.html", "weekly", "0.7"],
  ["/compatibility.html", "monthly", "0.6"], ["/my-esim.html", "monthly", "0.5"],
  // Guías (la de China queda fuera hasta verificar su promesa sobre VPN/Google)
  ["/guias/", "monthly", "0.7"], ["/guias/que-es-esim.html", "monthly", "0.7"],
  ["/guias/esim-espana.html", "monthly", "0.7"], ["/guias/esim-europa.html", "monthly", "0.7"],
  ["/guias/esim-japon.html", "monthly", "0.7"], ["/guias/esim-usa.html", "monthly", "0.7"],
];
function renderSitemap(all) {
  const today = new Date().toISOString().slice(0, 10);
  const u = (loc, last, freq, pr) => `  <url>\n    <loc>${SITE}${loc}</loc>\n    <lastmod>${last}</lastmod>\n    <changefreq>${freq}</changefreq>\n    <priority>${pr}</priority>\n  </url>`;
  const newest = all[0] ? all[0].isoDate.slice(0, 10) : today;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...STATIC_PAGES.map(([p, f, pr]) => u(p, today, f, pr)), u("/blog/", newest, "daily", "0.8"),
     ...all.map((a) => u(`/blog/${a.slug}/`, a.isoDate.slice(0, 10), "monthly", "0.6"))].join("\n") + "\n</urlset>\n";
}

// ── Main ───────────────────────────────────────────────────
function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")); } catch { return []; }
}

async function main() {
  const snapshot = loadSnapshot();
  const byId = new Map(snapshot.map((a) => [a.id, a]));
  let articles;
  try {
    const list = await fetchArticleList();
    if (!list.length) throw new Error("lista vacía");
    let fetched = 0, reused = 0, failed = 0;
    articles = await pool(list, async (a) => {
      const prev = byId.get(a.id);
      if (prev && prev.content && prev.isoDate === a.isoDate && prev.title === a.title) { reused++; return { ...a, content: prev.content }; }
      try { const content = a.content || await fetchContent(a.id); fetched++; return { ...a, content }; }
      catch (e) { failed++; console.warn(`⚠️  [blog] sin contenido para ${a.slug}: ${e.message}`); return prev && prev.content ? { ...a, content: prev.content } : null; }
    });
    articles = articles.filter(Boolean);
    console.log(`[blog] Soro: ${list.length} artículos (descargados ${fetched}, reutilizados ${reused}, fallidos ${failed})`);
  } catch (e) {
    console.warn(`⚠️  [blog] No se pudo consultar Soro (${e.message}). Se usa la copia guardada (${snapshot.length} artículos).`);
    articles = snapshot;
  }

  articles = articles.filter((a) => a.slug && /^[a-z0-9-]+$/.test(a.slug) && a.title && a.content && a.isoDate);
  if (!articles.length) {
    // Falla el build a propósito: Netlify conserva el deploy anterior (con el blog
    // intacto) en vez de publicar un sitio sin blog.
    console.error("❌ [blog] No hay artículos disponibles (Soro no respondió y no hay copia guardada).");
    process.exit(1);
  }
  articles.sort((x, y) => new Date(y.isoDate) - new Date(x.isoDate));

  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(articles, null, 1) + "\n");

  const blogDir = path.join(ROOT, "blog");
  fs.rmSync(blogDir, { recursive: true, force: true });
  fs.mkdirSync(blogDir, { recursive: true });
  fs.writeFileSync(path.join(blogDir, "index.html"), renderIndex(articles));
  for (const a of articles) {
    fs.mkdirSync(path.join(blogDir, a.slug), { recursive: true });
    fs.writeFileSync(path.join(blogDir, a.slug, "index.html"), renderArticle(a, articles));
  }
  const manifest = { count: articles.length, items: articles.map((a) => `${a.id}:${a.isoDate}`).sort() };
  fs.writeFileSync(path.join(blogDir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), renderSitemap(articles));
  console.log(`✅ [blog] ${articles.length} artículos publicados en /blog/ y sitemap.xml actualizado.`);
}

main().catch((e) => {
  console.error("❌ [blog] Error inesperado:", e.message);
  process.exit(1);
});
