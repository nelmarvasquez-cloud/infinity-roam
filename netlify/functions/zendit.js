const https = require("https");

function httpsRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ 
          status: res.statusCode, 
          buffer: buffer,
          contentType: res.headers["content-type"] || ""
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function (event) {
  // Modo sandbox — activar con ZENDIT_SANDBOX_MODE=true en Netlify.
  // No asumo la URL exacta del sandbox de Zendit (varía según cuenta) —
  // se configura con ZENDIT_SANDBOX_BASE_URL. Si no se define, se usa el
  // mismo host de producción (algunos proveedores solo cambian de modo
  // según la API key, no el host) — revisa tu panel de Zendit para
  // confirmar cuál aplica a tu cuenta.
  const isSandbox = process.env.ZENDIT_SANDBOX_MODE === "true";
  const ZENDIT_KEY = isSandbox
    ? (process.env.ZENDIT_SANDBOX_API_KEY || process.env.ZENDIT_API_KEY)
    : process.env.ZENDIT_API_KEY;
  const ZENDIT_BASE = isSandbox
    ? (process.env.ZENDIT_SANDBOX_BASE_URL || "https://api.zendit.io/v1")
    : "https://api.zendit.io/v1";

  const path = event.queryStringParameters?.path || "/esim/offers";
  const method = event.httpMethod === "POST" ? "POST" : "GET";
  const body = method === "POST" ? event.body : null;

  if (!ZENDIT_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "ZENDIT_API_KEY not configured" }),
    };
  }

  try {
    const result = await httpsRequest(
      `${ZENDIT_BASE}${path}`,
      method,
      {
        "Authorization": ZENDIT_KEY,
        "Content-Type": "application/json",
        "Content-Length": body ? Buffer.byteLength(body) : 0,
      },
      body
    );

    const contentType = result.contentType;

    // Si la respuesta es una imagen (PNG, JPEG) — convertir a base64 y devolver en JSON
    if (contentType.includes("image/") || contentType.includes("png") || contentType.includes("jpeg")) {
      const base64 = result.buffer.toString("base64");
      return {
        statusCode: result.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ imageBase64: base64 }),
      };
    }

    // Si es JSON normal
    let data;
    try {
      data = JSON.parse(result.buffer.toString("utf8"));
    } catch(e) {
      // Si no es JSON ni imagen, intentar como base64 de todos modos
      // (algunos proveedores devuelven PNG sin Content-Type correcto)
      const str = result.buffer.toString("utf8");
      if (str.startsWith("\x89PNG") || result.buffer[0] === 0x89) {
        const base64 = result.buffer.toString("base64");
        return {
          statusCode: result.status,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: base64 }),
        };
      }
      data = { rawResponse: str.substring(0, 200) };
    }

    return {
      statusCode: result.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
