// Função serverless da Vercel: GET /api/route-shapes?linha=838
// Devolve o(s) traçado(s) (ida e volta) de uma linha pelo código dela
// (route_short_name), pra já mostrar o itinerário no mapa assim que o
// usuário busca/fixa uma linha — sem precisar esperar um ônibus aparecer e
// clicar nele. Ver getRouteShapesForLinha em lib/gtfs.js para detalhes.
const { getRouteShapesForLinha } = require('../lib/gtfs');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const linha = (req.query.linha || '').toString().trim();
  if (!linha) {
    res.status(200).json({ ok: false, erro: 'Parâmetro linha é obrigatório.' });
    return;
  }
  try {
    const rotas = await getRouteShapesForLinha(linha);
    res.status(200).json({ ok: true, linha: linha.toUpperCase(), rotas });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao carregar o GTFS: ${err.message}` });
  }
};
