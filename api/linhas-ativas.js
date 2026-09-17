// Função serverless da Vercel: GET /api/linhas-ativas
// Lista dos códigos de linha que têm pelo menos um ônibus reportando
// posição AGORA na API de GPS ao vivo — diferente de /api/linhas, que
// lista as linhas cadastradas no GTFS oficial (mensal). As duas listas não
// batem necessariamente: existem linhas extras/provisórias circulando de
// verdade que ainda não entraram no cadastro GTFS do mês (por isso o campo
// de busca do front-end consulta as duas antes de dizer que uma linha "não
// existe").
const { fetchUpstream } = require('../lib/gps');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const cache = await fetchUpstream();
    const list = cache.buses || [];
    const linhas = Array.from(new Set(list.map((b) => b.linha).filter(Boolean))).sort((a, b) => {
      const aNum = /^\d+$/.test(a);
      const bNum = /^\d+$/.test(b);
      if (aNum && bNum) return Number(a) - Number(b);
      if (aNum !== bNum) return aNum ? -1 : 1;
      return a.localeCompare(b);
    });
    res.status(200).json({ ok: true, linhas });
  } catch (err) {
    res.status(200).json({
      ok: false,
      erro: `Não foi possível obter dados da API pública: ${err.message}`,
    });
  }
};
