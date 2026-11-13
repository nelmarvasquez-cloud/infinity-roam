// ============================================================
//  LOGO — Inyecta el logo oficial (imagen) en todos los .nav-logo / .ir-logo
//  Dos variantes: images/logo.png (para fondos oscuros) y
//  images/logo-light.png ("Roam" en gris oscuro, para fondos claros).
//  Se elige según el color de fondo real del contenedor.
// ============================================================
(function () {
  const W = 162, H = 34; // proporción real del logo (837×176)

  function bgIsLight(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || parseFloat(m[3]) > 0.5)) {
        const lum = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
        return lum > 150;
      }
    }
    return false; // sin fondo definido → el sitio es oscuro por defecto
  }

  function logoHTML(light) {
    const base = "/images/" + (light ? "logo-light" : "logo");
    return '<picture><source srcset="' + base + '.webp" type="image/webp">' +
      '<img src="' + base + '.png" alt="Infinity Roam" width="' + W + '" height="' + H +
      '" decoding="async" style="height:34px;width:auto;display:block"></picture>';
  }

  function injectLogos() {
    document.querySelectorAll('.nav-logo, .ir-logo').forEach(el => {
      el.innerHTML = logoHTML(bgIsLight(el));
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.textDecoration = 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectLogos);
  } else {
    injectLogos();
  }
})();
