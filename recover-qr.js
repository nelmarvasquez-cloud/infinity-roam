// ============================================================
//  RECOVER QR — Botón flotante para recuperar eSIM
// ============================================================

function initRecoverQR() {
  // No mostrar en la propia página my-esim.html
  if (window.location.pathname.includes("my-esim")) return;

  const lang = localStorage.getItem("ir_lang") || "es";
  const tooltipText = lang === "es" ? "¿Perdiste tu QR?" : "Lost your QR?";

  const btn = document.createElement("a");
  btn.href = "my-esim.html";
  btn.id = "recover-qr-float";
  btn.setAttribute("aria-label", tooltipText);
  btn.innerHTML = `
    <div class="qr-recover-button">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="3" height="3"/>
        <rect x="18" y="14" width="3" height="3"/>
        <rect x="14" y="18" width="3" height="3"/>
        <rect x="18" y="18" width="3" height="3"/>
      </svg>
      <span class="qr-recover-tooltip">${tooltipText}</span>
    </div>
  `;

  document.body.appendChild(btn);

  // Actualizar tooltip si cambia el idioma
  window.addEventListener("ir_lang_changed", () => {
    const newLang = localStorage.getItem("ir_lang") || "es";
    const tooltip = btn.querySelector(".qr-recover-tooltip");
    if (tooltip) tooltip.textContent = newLang === "es" ? "¿Perdiste tu QR?" : "Lost your QR?";
  });
}

document.addEventListener("DOMContentLoaded", initRecoverQR);
