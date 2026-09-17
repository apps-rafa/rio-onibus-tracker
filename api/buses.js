// Função serverless da Vercel: GET /api/buses?linhas=838,918
// Mesma lógica do endpoint local em server.js, usando a base compartilhada
// em lib/gps.js.
const { fetchUpstream } = require('../lib/gps');
const { findShapeForPosition } = require('../lib/gtfs');
const { requireUser } = require('../lib/supabaseAuth');

// Resolve a direção (ida/volta) geograficamente mais próxima de cada
// ônibus — igual ao que /api/route-info já faz pro veículo selecionado —
// e anexa directionId/headsign a cada registro. Usado pro front-end
// conseguir listar/filtrar "415 Usina" e "415 Leblon" como chips
// separados. Best-effort: se a linha não estiver no GTFS (ex: LECD154) ou o
// GTFS ainda não carregou, o ônibus só fica sem direção classificada.
async function withDirection(buses) {
  return Promise.all(
    buses.map(async (b) => {
      if (!b.routeId || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) return b;
      try {
        const dir = await findShapeForPosition(b.routeId, b.latitude, b.longitude);
        if (dir) return { ...b, directionId: dir.directionId, headsign: dir.headsign || null };
      } catch (err) {
        // silencioso — classificação de direção é só um complemento, não
        // deve derrubar a resposta toda se o GTFS falhar
      }
      return b;
    })
  );
}

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const cache = await fetchUpstream();
    const list = cache.buses || [];

    const linhasParam = (req.query.linhas || '').toString().trim();
    let filtered = list;
    if (linhasParam) {
      const wanted = new Set(
        linhasParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      );
      filtered = list.filter((b) => b.linha && wanted.has(b.linha.toUpperCase()));
    }

    const enriquecido = await withDirection(filtered);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      count: enriquecido.length,
      totalNaFonte: list.length,
      atualizadoEm: new Date(cache.timestamp).toISOString(),
      avisoFonte: cache.error || null,
      fonteAtiva: cache.source || null,
      onibus: enriquecido,
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      erro: `Não foi possível obter dados da API pública: ${err.message}`,
    });
  }
};
