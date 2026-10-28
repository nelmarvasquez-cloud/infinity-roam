// ============================================================
//  SEND-REFERRAL-EMAIL.JS — Nodemailer con GoDaddy SMTP
//  From: sales@infinity-roam.com (via alias de nelmar.vasquez@)
//  Usado exclusivamente para emails del programa de referidos
// ============================================================

const nodemailer = require("nodemailer");

const SMTP_USER = process.env.GODADDY_SMTP_USER;   // nelmar.vasquez@infinity-roam.com
const SMTP_PASS = process.env.GODADDY_SMTP_PASS;   // contraseña de tu cuenta
const FROM_EMAIL = "sales@infinity-roam.com";
const FROM_NAME  = "Infinity Roam";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const { to_email, to_name, subject, html_body } = JSON.parse(event.body || "{}");
    if (!to_email || !subject || !html_body)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "to_email, subject y html_body requeridos" }) };

    const transporter = nodemailer.createTransport({
      host: "smtpout.secureserver.net",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      replyTo: FROM_EMAIL,
      to: to_name ? `"${to_name}" <${to_email}>` : to_email,
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff">
          <div style="background:#000;padding:24px 32px;text-align:center">
            <span style="color:#fff;font-size:22px;font-weight:700">Infinity</span>
            <span style="color:#888;font-size:22px;font-weight:300"> Roam</span>
            <p style="color:#888;font-size:11px;margin:6px 0 0;letter-spacing:2px;text-transform:uppercase">ESIM GLOBAL · 190+ PAÍSES</p>
          </div>
          <div style="padding:32px">
            ${html_body}
          </div>
          <div style="border-top:1px solid #eee;padding:20px 32px;text-align:center">
            <p style="color:#aaa;font-size:12px;margin:0">¿Preguntas? Contáctanos por <a href="https://wa.me/50765663686" style="color:#000;font-weight:700;text-decoration:none">WhatsApp</a></p>
            <p style="color:#aaa;font-size:12px;margin:4px 0 0">Infinity Roam — eSIM Global</p>
          </div>
        </div>`,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("[send-referral-email] Error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
