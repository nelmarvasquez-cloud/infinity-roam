// ============================================================
//  REFERRAL.JS — Netlify Function unificada para referidos
//  Acciones: validate, register-use, generate-token,
//            get-requests, approve, update-code, disable,
//            get-referrer, get-stats
// ============================================================

const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const REFERRAL_DISCOUNT    = 0.05;  // 5% descuento siempre al comprador
const REFERRAL_CREDIT_PCT  = 0.03;  // 3% crédito al referidor por defecto (solo si precio >= umbral)
const REFERRAL_CREDIT_MIN  = 5.00;  // precio mínimo (con descuento) para generar crédito
const MIN_CREDIT_REDEEM    = 10.00; // mínimo $10 para canjear
const MAX_CUSTOM_CREDIT_PCT = 0.10; // tope de seguridad para % personalizados por referido —
                                     // en el plan más barato que activa comisión, 10% deja ~7%
                                     // de margen para la tienda; nunca se permite superar esto,
                                     // ni siquiera manualmente desde el panel admin.

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── Supabase helper ──────────────────────────────────────────
async function supabase(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SUPABASE_URL.replace("https://", ""),
      path: `/rest/v1/${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer": method === "POST" ? "return=representation" : "return=representation",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "null") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Email helper — llama a send-email Netlify Function ────────
async function sendEmail({ to_email, to_name, subject, html_body, message }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ to_email, to_name, subject, html_body, message });
    const req = https.request({
      hostname: "infinity-roam.com",
      path: "/.netlify/functions/send-email",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", () => resolve({ status: 500 }));
    req.write(payload); req.end();
  });
}

// ── Token helpers ─────────────────────────────────────────────
function randomToken(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < len; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const action = event.queryStringParameters?.action;
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // ── VALIDATE REFERRAL CODE (public) ───────────────────────
  if (action === "validate") {
    const code = (body.code || "").toUpperCase().trim();
    if (!code) return res(400, { error: "Código requerido" });

    const r = await supabase("GET", `referrers?code=eq.${code}&status=eq.active&select=id,name,code,credit_balance`);
    if (!r.data || r.data.length === 0)
      return res(400, { error: "Código de referido inválido o inactivo" });

    return res(200, { valid: true, referrer: r.data[0], discount: REFERRAL_DISCOUNT });
  }

  // ── VALIDATE REGISTRATION TOKEN (public) ──────────────────
  if (action === "validate-token") {
    const token = body.token || "";
    if (!token) return res(400, { error: "Token requerido" });

    const r = await supabase("GET", `invite_tokens?token=eq.${token}&used=eq.false&select=*`);
    if (!r.data || r.data.length === 0)
      return res(400, { error: "Este enlace no es válido o ha expirado" });

    const tk = r.data[0];
    if (new Date(tk.expires_at) < new Date())
      return res(400, { error: "Este enlace ha expirado. Solicita uno nuevo." });

    return res(200, { valid: true });
  }

  // ── SELF-REQUEST TO JOIN (public, no invite token needed) ──
  // Reutiliza exactamente el mismo pipeline que "signup" (referrers en
  // estado "pending" + aprobación manual desde admin-ir.html), pero sin
  // exigir un token de invitación — para gente que llega directo desde
  // el sitio (footer / confirmación de compra) y quiere solicitar unirse,
  // en vez de haber recibido un link personalizado del admin.
  if (action === "request-join") {
    const { name, lastname, email, phone, paypal_email } = body;
    if (!name || !lastname || !email)
      return res(400, { error: "Nombre, apellido y email son requeridos" });

    const er = await supabase("GET", `referrers?email=eq.${encodeURIComponent(email)}&select=id`);
    if (er.data && er.data.length > 0)
      return res(400, { error: "Este email ya está registrado en el programa" });

    const nr = await supabase("POST", "referrers", {
      name, lastname, email, phone: phone || "",
      paypal_email: paypal_email || email,
      status: "pending",
      credit_balance: 0,
      code: null,
    });
    if (nr.status !== 201) return res(500, { error: "Error al registrar. Intenta de nuevo." });

    await sendEmail({
      to_email: "sales@infinity-roam.com",
      to_name: "Nelmar",
      subject: `Nueva solicitud de referido (auto-registro, sin invitación): ${name} ${lastname}`,
      email_body: `<p><strong>Alguien solicitó unirse al programa de referidos directamente desde el sitio</strong> (sin link de invitación).</p>
        <p>Nombre: <strong>${name} ${lastname}</strong><br/>
        Email: ${email}<br/>
        PayPal: ${paypal_email || email}<br/>
        Teléfono: ${phone || "(no proporcionado)"}</p>
        <p><a href="https://infinity-roam.com/admin-ir.html" style="background:#000;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">Ir al panel admin →</a></p>`,
    });

    return res(200, { ok: true, message: "Solicitud enviada. Te notificaremos por email cuando tu código esté listo." });
  }

  // ── REGISTER REFERRAL SIGNUP (public) ─────────────────────
  if (action === "signup") {
    const { token, name, lastname, email, phone, paypal_email } = body;
    if (!token || !name || !lastname || !email || !phone)
      return res(400, { error: "Todos los campos son requeridos" });

    // Validate token
    const tr = await supabase("GET", `invite_tokens?token=eq.${token}&used=eq.false&select=*`);
    if (!tr.data || tr.data.length === 0 || new Date(tr.data[0].expires_at) < new Date())
      return res(400, { error: "Enlace inválido o expirado" });

    // Check email not already registered
    const er = await supabase("GET", `referrers?email=eq.${encodeURIComponent(email)}&select=id`);
    if (er.data && er.data.length > 0)
      return res(400, { error: "Este email ya está registrado en el programa" });

    // Create referrer (pending)
    const nr = await supabase("POST", "referrers", {
      name, lastname, email, phone,
      paypal_email: paypal_email || email, // usa el mismo email si no especifica otro
      status: "pending",
      credit_balance: 0,
      code: null,
    });
    if (nr.status !== 201) return res(500, { error: "Error al registrar. Intenta de nuevo." });

    // Mark token as used
    await supabase("PATCH", `invite_tokens?token=eq.${token}`, { used: true });

    await sendEmail({
      to_email: "sales@infinity-roam.com",
      to_name: "Nelmar",
      subject: `Nueva solicitud de referido: ${name} ${lastname}`,
      email_body: `<p><strong>Nueva solicitud de referido</strong></p>
        <p>Nombre: <strong>${name} ${lastname}</strong><br/>
        Email: ${email}<br/>
        PayPal: ${paypal_email || email}<br/>
        Teléfono: ${phone}</p>
        <p><a href="https://infinity-roam.com/admin-ir.html" style="background:#000;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">Ir al panel admin →</a></p>`,
    });

    return res(200, { ok: true, message: "Solicitud enviada. Te notificaremos por email cuando tu código esté listo." });
  }

  // ── REGISTER REFERRAL USE after purchase (public, called from confirmation) ──
  if (action === "register-use") {
    const { referral_code, buyer_email, order_id, sale_amount } = body;
    if (!referral_code || !buyer_email || !order_id || !sale_amount)
      return res(400, { error: "Datos incompletos" });

    const code = referral_code.toUpperCase().trim();
    const r = await supabase("GET", `referrers?code=eq.${code}&status=eq.active&select=id,name,email,paypal_email,credit_balance,credit_pct`);
    if (!r.data || r.data.length === 0) return res(400, { error: "Código no encontrado" });

    const referrer = r.data[0];

    // % efectivo: usa el personalizado del referido si existe, siempre topado
    // por seguridad — nunca puede superar MAX_CUSTOM_CREDIT_PCT aunque el
    // valor guardado en Supabase sea mayor (protección contra error humano).
    const effectivePct = referrer.credit_pct != null
      ? Math.min(Number(referrer.credit_pct), MAX_CUSTOM_CREDIT_PCT)
      : REFERRAL_CREDIT_PCT;

    // Precio con descuento ya aplicado es sale_amount
    // Solo generar crédito si el monto pagado >= umbral mínimo
    const earnsCredit = sale_amount >= REFERRAL_CREDIT_MIN;
    const credit = earnsCredit
      ? Math.round(sale_amount * effectivePct * 100) / 100
      : 0;
    const newBalance = Math.round((referrer.credit_balance + credit) * 100) / 100;

    // Log the use
    await supabase("POST", "referral_uses", {
      referrer_id:      referrer.id,
      buyer_email,
      order_id,
      sale_amount,
      referrer_credit:  credit,
      earns_credit:     earnsCredit,
      buyer_discount_pct: REFERRAL_DISCOUNT,
      referrer_credit_pct: effectivePct,
    });

    // Update balance only if credit was earned
    if (earnsCredit) {
      await supabase("PATCH", `referrers?id=eq.${referrer.id}`, { credit_balance: newBalance });
    }

    return res(200, {
      ok: true,
      credit_earned: credit,
      new_balance: newBalance,
      earns_credit: earnsCredit,
      threshold: REFERRAL_CREDIT_MIN,
    });
  }

  // ── GET REFERRER PORTAL (public, by code) ─────────────────
  if (action === "get-referrer") {
    const code = (body.code || event.queryStringParameters?.code || "").toUpperCase().trim();
    if (!code) return res(400, { error: "Código requerido" });

    const r = await supabase("GET", `referrers?code=eq.${code}&status=eq.active&select=id,name,lastname,credit_balance,paypal_email`);
    if (!r.data || r.data.length === 0) return res(400, { error: "Código no encontrado" });

    const referrer = r.data[0];

    // Ventas generadas
    const uses = await supabase("GET",
      `referral_uses?referrer_id=eq.${referrer.id}&select=sale_amount,referrer_credit,earns_credit,created_at&order=created_at.desc&limit=20`);

    // Pagos recibidos
    const payouts = await supabase("GET",
      `referral_payouts?referrer_id=eq.${referrer.id}&select=amount,paypal_email,note,paid_at&order=paid_at.desc`);

    // Total pagado históricamente
    const totalPaid = (payouts.data || []).reduce((s, p) => s + parseFloat(p.amount), 0);

    return res(200, {
      name:          referrer.name,
      lastname:      referrer.lastname,
      paypal_email:  referrer.paypal_email,
      code,
      credit_balance: referrer.credit_balance,
      total_paid:    Math.round(totalPaid * 100) / 100,
      can_redeem:    referrer.credit_balance >= MIN_CREDIT_REDEEM,
      min_redeem:    MIN_CREDIT_REDEEM,
      uses:          uses.data    || [],
      payouts:       payouts.data || [],
    });
  }

  // ── REQUEST PAYOUT (public — authenticated by code) ────────
  // Solo envía notificación a admin, no modifica saldo
  if (action === "request-payout") {
    const code = (body.code || "").toUpperCase().trim();
    if (!code) return res(400, { error: "Código requerido" });

    const r = await supabase("GET", `referrers?code=eq.${code}&status=eq.active&select=id,name,lastname,email,paypal_email,credit_balance`);
    if (!r.data || r.data.length === 0) return res(400, { error: "Código no encontrado" });

    const referrer = r.data[0];
    if (referrer.credit_balance < MIN_CREDIT_REDEEM)
      return res(400, { error: `Necesitas al menos $${MIN_CREDIT_REDEEM} para solicitar un pago` });

    // Notificar al admin
    await sendEmail({
      to_email: "sales@infinity-roam.com",
      to_name:  "Nelmar",
      subject:  `💰 Solicitud de pago — ${referrer.name} ${referrer.lastname} ($${referrer.credit_balance.toFixed(2)})`,
      email_body: `
        <h2 style="margin:0 0 16px">Solicitud de liquidación de crédito</h2>
        <table style="width:100%;font-size:0.9rem">
          <tr><td style="color:#888;padding:6px 0">Referidor</td><td style="font-weight:700">${referrer.name} ${referrer.lastname}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Código</td><td style="font-weight:700">${code}</td></tr>
          <tr><td style="color:#888;padding:6px 0">PayPal</td><td style="color:#2864E6">${referrer.paypal_email || referrer.email}</td></tr>
          <tr><td style="color:#888;padding:6px 0">Saldo a pagar</td><td style="font-size:1.4rem;font-weight:800;color:#34d399">$${referrer.credit_balance.toFixed(2)}</td></tr>
        </table>
        <p style="margin-top:20px">
          <a href="https://infinity-roam.com/admin-ir.html"
             style="background:#000;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">
            Ir al panel admin →
          </a>
        </p>`,
    });

    return res(200, { ok: true, message: "Solicitud enviada. Te contactaremos en 24-48h." });
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN ACTIONS — require password
  // ─────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || "";
  const providedPw = authHeader.replace("Bearer ", "").trim();
  if (!ADMIN_PASSWORD || providedPw !== ADMIN_PASSWORD)
    return res(401, { error: "No autorizado" });

  // ── GENERATE INVITE TOKEN ──────────────────────────────────
  if (action === "generate-token") {
    const token = randomToken(28);
    const expires_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const r = await supabase("POST", "invite_tokens", { token, expires_at, used: false });
    if (r.status !== 201) return res(500, { error: "Error generando token" });

    const link = `https://infinity-roam.com/referral-signup.html?token=${token}`;
    return res(200, { token, link, expires_at });
  }

  // ── GET ALL PENDING REQUESTS ───────────────────────────────
  if (action === "get-requests") {
    const status = body.status || "pending";
    const r = await supabase("GET", `referrers?status=eq.${status}&select=*&order=created_at.desc`);
    return res(200, { referrers: r.data || [] });
  }

  // ── GET ALL ACTIVE REFERRERS ───────────────────────────────
  if (action === "get-active") {
    const r = await supabase("GET", `referrers?status=eq.active&select=*&order=created_at.desc`);
    return res(200, { referrers: r.data || [] });
  }

  // ── APPROVE + ASSIGN CODE ──────────────────────────────────
  if (action === "approve") {
    const { referrer_id, code } = body;
    if (!referrer_id || !code) return res(400, { error: "referrer_id y code requeridos" });

    const cleanCode = code.toUpperCase().trim();

    // Check code not taken
    const dup = await supabase("GET", `referrers?code=eq.${cleanCode}&id=neq.${referrer_id}&select=id`);
    if (dup.data && dup.data.length > 0) return res(400, { error: "Ese código ya está en uso" });

    // Get referrer data
    const gr = await supabase("GET", `referrers?id=eq.${referrer_id}&select=*`);
    if (!gr.data || gr.data.length === 0) return res(404, { error: "Referidor no encontrado" });
    const referrer = gr.data[0];

    // Update to active
    await supabase("PATCH", `referrers?id=eq.${referrer_id}`, { code: cleanCode, status: "active" });

    // Send welcome email — email_body contiene HTML completo para el template
    const welcomeBody = `
      <h2 style="font-size:1.4rem;margin-bottom:8px">🎉 ¡Bienvenido al programa de referidos!</h2>
      <p>Hola <strong>${referrer.name}</strong>, tu solicitud fue aprobada. Ya eres parte del programa de referidos de Infinity Roam.</p>
      <div style="background:#f5f5f7;border-radius:12px;padding:24px;margin:24px 0;text-align:center">
        <p style="margin:0 0 8px;color:#888;font-size:0.75rem;text-transform:uppercase;letter-spacing:.08em">Tu código de referido</p>
        <div style="font-size:2.2rem;font-weight:900;letter-spacing:.15em;font-family:monospace">${cleanCode}</div>
      </div>
      <h3 style="margin-bottom:10px">¿Cómo funciona tu programa?</h3>
      <ul style="padding-left:20px;line-height:2;font-size:0.9rem;color:#444">
        <li>Comparte tu código con amigos, familiares o clientes</li>
        <li>La persona que compre con tu código recibe <strong>5% de descuento</strong> en su compra</li>
        <li>Tú, como miembro del programa, ganas <strong>3% de comisión sobre esa compra</strong>, acumulada como saldo</li>
        <li>La comisión aplica en compras superiores a <strong>$5 USD</strong></li>
        <li>Cuando llegues a <strong>$10 de saldo</strong>, te lo enviamos a tu PayPal (o lo canjeas en tu próxima compra)</li>
      </ul>
      <div style="margin:28px 0;text-align:center">
        <a href="https://infinity-roam.com/mi-credito.html?code=${cleanCode}"
           style="display:inline-block;background:#000;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:0.95rem">
          Ver mi saldo y movimientos →
        </a>
      </div>
      <p style="font-size:0.8rem;color:#888;margin-top:24px">¿Dudas sobre el programa? Escríbenos a
        <a href="mailto:sales@infinity-roam.com?subject=INFORMACION%20DE%20PROGRAMA%20DE%20REFERIDOS" style="color:#2864E6">sales@infinity-roam.com</a>
        con el asunto "INFORMACION DE PROGRAMA DE REFERIDOS".</p>`;

    await sendEmail({
      to_email: referrer.email,
      to_name: `${referrer.name} ${referrer.lastname}`,
      subject: "¡Bienvenido al programa de referidos de Infinity Roam!",
      email_body: welcomeBody,
    });

    return res(200, { ok: true, code: cleanCode });
  }

  // ── UPDATE CODE ────────────────────────────────────────────
  if (action === "update-code") {
    const { referrer_id, code } = body;
    if (!referrer_id || !code) return res(400, { error: "Datos requeridos" });

    const cleanCode = code.toUpperCase().trim();
    const dup = await supabase("GET", `referrers?code=eq.${cleanCode}&id=neq.${referrer_id}&select=id`);
    if (dup.data && dup.data.length > 0) return res(400, { error: "Ese código ya está en uso" });

    await supabase("PATCH", `referrers?id=eq.${referrer_id}`, { code: cleanCode });
    return res(200, { ok: true });
  }

  // ── UPDATE CUSTOM CREDIT % (solo este referido, resto sigue con el 3% global) ──
  if (action === "update-credit-pct") {
    const { referrer_id, credit_pct } = body;
    if (!referrer_id) return res(400, { error: "referrer_id requerido" });

    // null/vacío = volver al 3% global por defecto
    if (credit_pct === null || credit_pct === "" || credit_pct === undefined) {
      await supabase("PATCH", `referrers?id=eq.${referrer_id}`, { credit_pct: null });
      return res(200, { ok: true, credit_pct: null, message: "Vuelto al 3% por defecto" });
    }

    const parsed = Number(credit_pct);
    if (!Number.isFinite(parsed) || parsed < 0) return res(400, { error: "Porcentaje inválido" });

    // Tope de seguridad SIEMPRE aplicado en el servidor — nunca confiar en
    // el valor que llegue del panel admin, aunque el propio panel ya limite
    // el input, esta es la validación real.
    const capped = Math.min(parsed, MAX_CUSTOM_CREDIT_PCT);

    await supabase("PATCH", `referrers?id=eq.${referrer_id}`, { credit_pct: capped });
    return res(200, {
      ok: true,
      credit_pct: capped,
      was_capped: capped < parsed,
      message: capped < parsed
        ? `Se ajustó al máximo permitido de ${(MAX_CUSTOM_CREDIT_PCT * 100).toFixed(0)}%`
        : "Actualizado correctamente",
    });
  }

  // ── REJECT REQUEST ─────────────────────────────────────────
  if (action === "reject") {
    const { referrer_id } = body;
    if (!referrer_id) return res(400, { error: "referrer_id requerido" });

    // Get referrer data before deleting
    const gr = await supabase("GET", `referrers?id=eq.${referrer_id}&select=email,name,lastname`);
    if (!gr.data || gr.data.length === 0) return res(404, { error: "No encontrado" });
    const referrer = gr.data[0];

    // Delete from DB
    await supabase("DELETE", `referrers?id=eq.${referrer_id}`);

    // Notify by email that request was rejected
    await sendEmail({
      to_email: referrer.email,
      to_name: `${referrer.name} ${referrer.lastname}`,
      subject: "Actualización sobre tu solicitud — Infinity Roam",
      email_body: `<p>Hola <strong>${referrer.name}</strong>,</p>
        <p>Gracias por tu interés en el programa de referidos de Infinity Roam.</p>
        <p>En este momento no podemos procesar tu solicitud. Si tienes preguntas, contáctanos por WhatsApp o escríbenos a sales@infinity-roam.com.</p>
        <p>El equipo de Infinity Roam</p>`,
    });

    return res(200, { ok: true });
  }

  // ── DELETE REFERRER (admin only) ───────────────────────────
  if (action === "delete") {
    const { referrer_id } = body;
    if (!referrer_id) return res(400, { error: "referrer_id requerido" });

    // Delete referral_uses first (FK constraint)
    await supabase("DELETE", `referral_uses?referrer_id=eq.${referrer_id}`);
    // Then delete referrer
    await supabase("DELETE", `referrers?id=eq.${referrer_id}`);

    return res(200, { ok: true });
  }
  // ── REGISTER PAYOUT (admin) ───────────────────────────────
  if (action === "register-payout") {
    const { referrer_id, amount, note } = body;
    if (!referrer_id || !amount) return res(400, { error: "referrer_id y amount requeridos" });

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res(400, { error: "Monto inválido" });

    // Get referrer
    const gr = await supabase("GET", `referrers?id=eq.${referrer_id}&select=name,lastname,paypal_email,email,credit_balance`);
    if (!gr.data || !gr.data.length) return res(404, { error: "Referidor no encontrado" });
    const referrer = gr.data[0];

    if (amt > referrer.credit_balance)
      return res(400, { error: `El monto ($${amt}) supera el saldo disponible ($${referrer.credit_balance.toFixed(2)})` });

    // Record payout
    const pr = await supabase("POST", "referral_payouts", {
      referrer_id,
      amount: amt,
      paypal_email: referrer.paypal_email || referrer.email,
      note: note || "",
    });
    if (pr.status !== 201) return res(500, { error: "Error registrando pago" });

    // Deduct from balance
    const newBalance = Math.round((referrer.credit_balance - amt) * 100) / 100;
    await supabase("PATCH", `referrers?id=eq.${referrer_id}`, { credit_balance: newBalance });

    return res(200, {
      ok: true,
      paid: amt,
      new_balance: newBalance,
      paypal_email: referrer.paypal_email || referrer.email,
    });
  }

  // ── GET PAYOUTS (admin) ────────────────────────────────────
  if (action === "get-payouts") {
    const r = await supabase("GET", `referral_payouts?select=id,amount,paypal_email,note,paid_at,referrer_id,referrers(name,lastname,code)&order=paid_at.desc&limit=50`);
    return res(200, { payouts: r.data || [] });
  }

  if (action === "set-status") {
    const { referrer_id, status } = body;
    if (!referrer_id || !["active", "disabled"].includes(status))
      return res(400, { error: "Datos inválidos" });

    await supabase("PATCH", `referrers?id=eq.${referrer_id}`, { status });
    return res(200, { ok: true });
  }

  // ── GET STATS ──────────────────────────────────────────────
  if (action === "get-stats") {
    const uses = await supabase("GET", "referral_uses?select=sale_amount,referrer_credit,created_at&order=created_at.desc&limit=50");
    const referrers = await supabase("GET", "referrers?select=status,credit_balance");
    return res(200, { uses: uses.data || [], referrers: referrers.data || [] });
  }

  return res(400, { error: "Acción no reconocida" });
};

function res(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
