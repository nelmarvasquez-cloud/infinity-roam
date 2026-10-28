// ============================================================
//  TOPUP-CONFIRMATION.JS
// ============================================================
// No hace polling ni maneja reintentos — el webhook de Zendit
// (topup-webhook.js) es quien envía el correo de confirmación
// cuando la recarga realmente termina. Esta página solo muestra
// el resumen de lo que se acaba de pagar.

(function () {
  const raw = sessionStorage.getItem("ir_topup_order");
  const card = document.getElementById("tc-card");

  if (!raw) {
    card.innerHTML = `<p style="color:#64748b;text-align:center">No encontramos los datos de tu envío. Si acabas de pagar, revisa tu correo — la confirmación llega directo ahí.</p>`;
    return;
  }

  const order = JSON.parse(raw);
  card.innerHTML = `
    <div class="tc-row"><span>Operadora</span><strong>${order.brand || "—"}</strong></div>
    <div class="tc-row"><span>País</span><strong>${order.country || "—"}</strong></div>
    <div class="tc-row"><span>Número destino</span><strong>${order.recipientPhone || "—"}</strong></div>
    <div class="tc-row"><span>Total pagado</span><strong>$${(order.price || 0).toFixed(2)} USD</strong></div>
    <div class="tc-row" style="border-bottom:none"><span>ID de transacción</span><strong style="font-size:0.78rem">${order.transactionId || "—"}</strong></div>
  `;
})();
