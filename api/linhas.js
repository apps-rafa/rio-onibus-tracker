// Função serverless da Vercel: GET /api/linhas
// Lista de códigos de linha conhecidos (route_short_name do GTFS oficial),
// usada só para alimentar o autocomplete do campo de busca no front-end.
const { getLinhas } = require('../lib/gtfs');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const linhas = await getLinhas();
    res.status(200).json({ ok: true, linhas });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao carregar linhas do GTFS: ${err.message}` });
  }
};
