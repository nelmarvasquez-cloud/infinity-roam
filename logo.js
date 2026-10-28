// ============================================================
//  LOGO — Inyecta el logo SVG real en todos los .nav-logo
// ============================================================
(function () {
  const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 68 52" fill="none" style="width:42px;height:32px;overflow:visible">
    <defs>
      <linearGradient id="irLg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#5AB0F5"/>
        <stop offset="100%" stop-color="#1450C4"/>
      </linearGradient>
    </defs>
    <path d="M32 27C32 27 24 11 15 11C7.5 11 2 18 2 27C2 36 7.5 43 15 43C24 43 32 27 32 27Z" fill="url(#irLg)"/>
    <path d="M32 27C32 27 40 11 49 11C56.5 11 62 18 62 27C62 36 56.5 43 49 43C40 43 32 27 32 27Z" fill="url(#irLg)"/>
    <path d="M38 27Q49 16 60 27Q49 38 38 27Z" stroke="#ffffff" stroke-width="1.3" fill="none" opacity="0.7"/>
    <ellipse cx="49" cy="27" rx="6" ry="16" stroke="#ffffff" stroke-width="1.3" fill="none" opacity="0.7"/>
    <line x1="33" y1="27" x2="65" y2="27" stroke="#ffffff" stroke-width="1.3" opacity="0.7"/>
    <path d="M46 12Q49 6 55 2" stroke="url(#irLg)" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <g transform="translate(50,-3) rotate(45) scale(0.42)">
      <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-5.5l8 2.5z" fill="url(#irLg)"/>
    </g>
  </svg>`;

  // Igual al logo real: "Infinity" Bold Azul + "Roam" Regular Gris plata — siempre sobre negro
  const LOGO_TEXT = `<span style="font-family:'Outfit',Arial,sans-serif;font-size:1.15rem;font-weight:700;color:#2864E6;letter-spacing:-.01em">Infinity <span style="font-weight:400;color:#C8C8C8">Roam</span></span>`;

  function injectLogos() {
    document.querySelectorAll('.nav-logo, .ir-logo').forEach(el => {
      el.innerHTML = LOGO_SVG + LOGO_TEXT;
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.gap = '10px';
      el.style.textDecoration = 'none';
    });
    // Also footer logos
    document.querySelectorAll('.footer-brand .nav-logo, .footer-brand .ir-logo').forEach(el => {
      el.innerHTML = LOGO_SVG + LOGO_TEXT;
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.gap = '10px';
      el.style.textDecoration = 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectLogos);
  } else {
    injectLogos();
  }
})();
