// ============================================================
//  QR-IMAGE.JS — Sirve el QR de una compra como una imagen real
//  con URL propia (en vez de base64 incrustado), para poder
//  usarla en <img src="..."> dentro de correos sin que Outlook
//  la corrompa (problema documentado con imágenes base64
//  incrustadas — ver confirmation.js para más contexto).
//
//  Uso: /.netlify/functions/qr-image?id={transactionId}
//
//  Mismo modelo de acceso que ya usa la página de recuperación
//  (my-esim.html?id=...) — conocer el transactionId es lo que da
//  acceso, consistente con el resto del proyecto. No se agrega
//  autenticación nueva porque los clientes de correo no pueden
//  enviar headers personalizados al cargar una imagen.
// ============================================================

const https = require("https");

function httpsRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// PNG 1x1 transparente — se devuelve si algo falla, para que el
// correo no muestre un ícono de "imagen rota" visible.
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

exports.handler = async function (event) {
  const transactionId = event.queryStringParameters?.id;
  const imageHeaders = { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" };

  if (!transactionId) {
    return { statusCode: 200, headers: imageHeaders, body: BLANK_PNG.toString("base64"), isBase64Encoded: true };
  }

  const ZENDIT_KEY = process.env.ZENDIT_API_KEY;
  if (!ZENDIT_KEY) {
    return { statusCode: 200, headers: imageHeaders, body: BLANK_PNG.toString("base64"), isBase64Encoded: true };
  }

  try {
    const result = await httpsRequest(
      `https://api.zendit.io/v1/esim/purchases/${transactionId}/qrcode`,
      { Authorization: ZENDIT_KEY }
    );

    if (result.status !== 200 || !result.buffer || result.buffer.length === 0) {
      return { statusCode: 200, headers: imageHeaders, body: BLANK_PNG.toString("base64"), isBase64Encoded: true };
    }

    // Zendit puede devolver la imagen directa (bytes PNG) o un JSON
    // {"imageBase64": "..."} según el endpoint — se manejan ambos casos.
    let pngBuffer = result.buffer;
    if (result.buffer[0] !== 0x89) {
      try {
        const parsed = JSON.parse(result.buffer.toString("utf8"));
        const b64 = parsed.imageBase64 || parsed.qrCode || parsed.image || parsed.qr || parsed.qrImage || parsed.base64;
        if (b64) pngBuffer = Buffer.from(b64, "base64");
      } catch (e) {
        // no era JSON tampoco — se cae al blank de abajo
      }
    }

    if (!pngBuffer || pngBuffer[0] !== 0x89) {
      return { statusCode: 200, headers: imageHeaders, body: BLANK_PNG.toString("base64"), isBase64Encoded: true };
    }

    return { statusCode: 200, headers: imageHeaders, body: pngBuffer.toString("base64"), isBase64Encoded: true };
  } catch (err) {
    console.error("[qr-image] Error:", err.message);
    return { statusCode: 200, headers: imageHeaders, body: BLANK_PNG.toString("base64"), isBase64Encoded: true };
  }
};
