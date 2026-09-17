// Função serverless da Vercel: POST /api/stops-near
//
// Paradas de ônibus (GTFS stops.txt) próximas a um traçado QUALQUER mandado
// pelo cliente (lista de [lat, lon]), não só um shape_id oficial. Usado como
// fallback pra linhas sem itinerário oficial no GTFS (ex: LECD154): nesses
// casos o app desenha o trajeto observado ao vivo em vez do traçado oficial
// (ver drawInferredTrail em index.html), e esse endpoint deixa mostrar os
// pontos de ônibus próximos a esse trajeto observado também — sem isso, uma
// linha sem GTFS nunca mostrava nenhum ponto de ônibus.
//
// POST { pontos: [[lat, lon], ...] } -> { ok, pontos: [{id, name, lat, lon}, ...] }
const { getStopsNear } = require('../lib/gtfs');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, erro: 'Método não suportado.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      res.status(400).json({ ok: false, erro: 'JSON inválido no corpo da requisição.' });
      return;
    }
  }

  const pontosIn = Array.isArray(body && body.pontos) ? body.pontos : [];
  const shapePoints = pontosIn
    .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice(0, 4000);

  if (shapePoints.length < 2) {
    res.status(200).json({ ok: true, pontos: [] });
    return;
  }

  try {
    const pontos = await getStopsNear(shapePoints);
    res.status(200).json({ ok: true, pontos });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao buscar paradas próximas: ${err.message}` });
  }
};
