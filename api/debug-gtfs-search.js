// Função serverless da Vercel: GET /api/debug-gtfs-search?q=154
// Diagnóstico: busca uma string livre (case-insensitive) nas linhas cruas
// de routes.txt, trips.txt, shapes.txt e agency.txt do GTFS oficial —
// usado pra investigar por que uma linha (ex: LECD154) não aparece no
// cadastro: descobrir se ela existe sob outro nome/route_id/agência, ou se
// realmente não está em lugar nenhum do GTFS estático atual.
const { GTFS_URL } = require('../lib/gtfs');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    res.status(200).json({ ok: false, erro: 'Parâmetro q é obrigatório.' });
    return;
  }
  try {
    // eslint-disable-next-line global-require
    const JSZip = require('jszip');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let resp;
    try {
      resp = await fetch(GTFS_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) throw new Error(`GTFS upstream respondeu ${resp.status} ${resp.statusText}`);

    const buf = await resp.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const needle = q.toLowerCase();
    const resultados = {};
    for (const filename of ['routes.txt', 'trips.txt', 'shapes.txt', 'agency.txt']) {
      const entry = zip.file(filename);
      if (!entry) {
        resultados[filename] = { existeNoZip: false };
        continue;
      }
      const text = await entry.async('string');
      const lines = text.split(/\r?\n/);
      const cabecalho = lines[0] || '';
      const amostraCorrespondencias = [];
      for (let i = 1; i < lines.length && amostraCorrespondencias.length < 20; i++) {
        if (lines[i].toLowerCase().includes(needle)) amostraCorrespondencias.push(lines[i]);
      }
      resultados[filename] = {
        existeNoZip: true,
        totalLinhas: Math.max(0, lines.length - 1),
        cabecalho,
        amostraCorrespondencias,
      };
    }

    res.status(200).json({ ok: true, q, resultados });
  } catch (err) {
    res.status(200).json({ ok: false, erro: err.message });
  }
};
