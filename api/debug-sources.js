// Função serverless da Vercel: GET /api/debug-sources
// Diagnóstico temporário: testa em paralelo várias fontes candidatas de GPS
// de ônibus (a atual "Conecta" que anda instável, mais alternativas
// encontradas em pesquisa — RioBus proxy, API legada dadosabertos.rio, e a
// nova "API GPS 2.0" unificada da SMTR ainda em rollout) e reporta o status
// HTTP + um trecho do corpo de cada uma, pra decidir qual usar como fonte
// (ou fallback) no app. Não é usado pelo app em si, só para investigação.
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const now = Date.now();
  const dataFinalIso = new Date(now).toISOString();
  const dataInicialIso = new Date(now - 3 * 60 * 1000).toISOString();

  const candidatos = [
    {
      nome: 'conecta_atual',
      url: `https://dados.mobilidade.rio/sppo/conecta/gps?dataInicial=${encodeURIComponent(dataInicialIso)}&dataFinal=${encodeURIComponent(dataFinalIso)}`,
    },
    {
      nome: 'its_gps2_veiculos',
      url: `https://its.mobilidade.rio/v1/geolocalizacao/veiculos?datetime_inicio=${encodeURIComponent(dataInicialIso)}&datetime_fim=${encodeURIComponent(dataFinalIso)}`,
    },
    {
      nome: 'its_gps2_onibus_urbanos',
      url: `https://its.mobilidade.rio/v1/geolocalizacao/onibus-urbanos?datetime_inicio=${encodeURIComponent(dataInicialIso)}&datetime_fim=${encodeURIComponent(dataFinalIso)}`,
    },
    {
      nome: 'riobus_proxy_v3',
      url: 'https://rest.riob.us/v3/search/415',
    },
    {
      nome: 'legado_dadosabertos',
      url: 'https://dadosabertos.rio.rj.gov.br/apiTransporte/apresentacao/rest/index.cfm/onibus',
    },
  ];

  const resultados = await Promise.all(
    candidatos.map(async (c) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const resp = await fetch(c.url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timeout);
        const text = await resp.text();
        return {
          nome: c.nome,
          url: c.url,
          ok: resp.ok,
          status: resp.status,
          tamanhoResposta: text.length,
          amostra: text.slice(0, 500),
        };
      } catch (err) {
        clearTimeout(timeout);
        return { nome: c.nome, url: c.url, ok: false, erro: err.message };
      }
    })
  );

  res.status(200).json({ ok: true, testadoEm: new Date(now).toISOString(), resultados });
};
