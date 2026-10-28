// ============================================================
//  Netlify Function — Catálogo desde datos locales
//  Incluye planes por país Y planes regionales/globales
//  Sin llamadas a Zendit API — respuesta < 1 segundo
// ============================================================

const TIER2              = require('../../zendit_tier2.json');
const OFFER_COUNTRY      = require('./offer_country.json');
const OFFER_REGION       = require('./offer_region_meta.json');
const REGION_COUNTRIES   = require('./region_countries.json');

// Canonical region display names
const REGION_INFO = {
  'AFRICA':       { name_es: 'África',                      name_en: 'Africa',                       emoji: '🌍' },
  'ASIA':         { name_es: 'Asia',                        name_en: 'Asia',                         emoji: '🌏' },
  'CARIBBEAN':    { name_es: 'Caribe',                      name_en: 'Caribbean',                    emoji: '🏝️' },
  'CENAM':        { name_es: 'Centroamérica',               name_en: 'Central America',              emoji: '🌎' },
  'EASTEURO':     { name_es: 'Europa del Este',             name_en: 'Eastern Europe',               emoji: '🇪🇺' },
  'EUROPE':       { name_es: 'Europa',                      name_en: 'Europe',                       emoji: '🇪🇺' },
  'GLOBAL':       { name_es: 'Global',                      name_en: 'Global',                       emoji: '🌐' },
  'LATAM':        { name_es: 'Latinoamérica',               name_en: 'Latin America',                emoji: '🌎' },
  'MIDDLE-EAST':  { name_es: 'Oriente Medio',               name_en: 'Middle East & North Africa',   emoji: '🌍' },
  'NORTH-AMERICA':{ name_es: 'Norteamérica',                name_en: 'North America',                emoji: '🌎' },
  'OCEANIA':      { name_es: 'Oceanía',                     name_en: 'Oceania',                      emoji: '🌏' },
};

// Parse offerId to extract plan metadata
function parseOfferId(offerId) {
  const parts = offerId.toUpperCase().split(/[-_]/);
  let dataGB        = 0;
  let durationDays  = 0;
  let dataUnlimited = false;

  for (const p of parts) {
    if (/^\d+D$/.test(p))              durationDays  = parseInt(p);
    if (/^\d+(\.\d+)?GB$/.test(p))    dataGB        = parseFloat(p);
    // "PUL" y "UL" también son variantes de ilimitado — antes no se
    // reconocían, y esos planes se mostraban como "0 GB" en el catálogo
    // (confirmado: 142 ofertas afectadas en todo el catálogo, verificado
    // porque su precio escala con los días como los demás ilimitados,
    // no con GB).
    if (['UNLIMITED','UNL','ULE','ULP','UNLIM','PUL','UL'].includes(p)) dataUnlimited = true;
  }
  return { dataGB, durationDays, dataUnlimited };
}

exports.handler = async function () {
  try {
    const MARKUP = 1.5;
    const list = [];

    for (const [offerId, rawCost] of Object.entries(TIER2)) {
      const cost = Array.isArray(rawCost) ? rawCost[0] : rawCost;
      const { dataGB, durationDays, dataUnlimited } = parseOfferId(offerId);

      const country    = OFFER_COUNTRY[offerId] || null;
      const regionSlug = OFFER_REGION[offerId]  || null;
      const regionInfo = regionSlug ? REGION_INFO[regionSlug] : null;

      list.push({
        offerId,
        dataGB,
        durationDays,
        dataUnlimited,
        country:            country  || null,
        region:             regionSlug || null,
        regionName:         regionInfo ? regionInfo.name_en : null,
        regionNameEs:       regionInfo ? regionInfo.name_es : null,
        regionEmoji:        regionInfo ? regionInfo.emoji   : null,
        isRegional:         !!regionSlug && !country,
        // Countries covered — only for regional plans, keeps country plan payloads small
        coverageCountries:  (!!regionSlug && !country)
                              ? (REGION_COUNTRIES[regionSlug] || [])
                              : null,
        cost: {
          fixed:           Math.round(cost * 100),
          suggestedRetail: Math.round(cost * MARKUP * 100),
          currencyDivisor: 100,
        },
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=3600',
      },
      body: JSON.stringify({ list, total: list.length }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
