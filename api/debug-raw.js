// Função serverless da Vercel: GET /api/debug/raw
// Mostra os primeiros registros exatamente como a API pública devolveu,
// sem normalização — útil para diagnosticar se o formato/nome dos campos
// mudou (veja o README).
const { fetchUpstream, UPSTREAM_URL } = require('../lib/gps');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const cache = await fetchUpstream();
    res.status(200).json({
      ok: true,
      upstreamUrl: UPSTREAM_URL,
      fonteAtiva: cache.source || null,
      avisoUltimaTentativa: cache.error || null,
      totalOnibusMesclados: (cache.buses || []).length,
      porFonte: (cache.rawPorFonte || []).map((f) => ({
        fonte: f.source,
        totalRegistrosCrus: f.total,
        amostra: f.amostra,
      })),
      primeirosOnibus: (cache.buses || []).slice(0, 3),
    });
  } catch (err) {
    // Sempre 200 aqui (mesmo em erro) para facilitar diagnóstico via navegador/curl.
    res.status(200).json({ ok: false, erro: err.message, upstreamUrl: UPSTREAM_URL });
  }
};
