// Função serverless da Vercel: GET/POST /api/trail-points
//
// Persiste no Supabase o traçado deduzido ao vivo das linhas sem itinerário
// oficial no GTFS (ex: LECD154) — ver README, seção "Linhas fora do
// cadastro GTFS". Antes disso o traçado só existia em memória do navegador
// de cada aba (Map lineObservedTrails em index.html) e reiniciava do zero a
// cada recarregar. Agora ele é compartilhado entre todos os usuários e
// sobrevive a recarregar a página, guardado na tabela public.line_trails.
//
// Protegido: exige usuário autenticado (Supabase Auth) — ver lib/supabaseAuth.js.
//
// GET  ?linha=LECD154            -> { ok, linha, pontos: [[lat,lon], ...] }
// POST { linha, pontos: [...] }  -> acrescenta pontos novos (merge/dedupe no
//                                    banco via função append_trail_points),
//                                    devolve o traçado já mesclado.
const { requireUser, getUserClient, getBearerToken } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const token = getBearerToken(req);
  const supabase = getUserClient(token);

  if (req.method === 'GET') {
    const linha = (req.query.linha || '').toString().trim().toUpperCase();
    if (!linha) {
      res.status(200).json({ ok: false, erro: 'Parâmetro linha é obrigatório.' });
      return;
    }
    try {
      const { data, error } = await supabase
        .from('line_trails')
        .select('points, updated_at')
        .eq('line_code', linha)
        .maybeSingle();
      if (error) throw error;
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ok: true,
        linha,
        pontos: (data && data.points) || [],
        atualizadoEm: (data && data.updated_at) || null,
      });
    } catch (err) {
      res.status(200).json({ ok: false, erro: `Falha ao buscar traçado deduzido: ${err.message}` });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (err) {
        res.status(400).json({ ok: false, erro: 'JSON inválido no corpo da requisição.' });
        return;
      }
    }
    const linha = ((body && body.linha) || '').toString().trim().toUpperCase();
    const pontos = Array.isArray(body && body.pontos) ? body.pontos : [];
    if (!linha) {
      res.status(200).json({ ok: false, erro: 'Campo linha é obrigatório.' });
      return;
    }
    if (pontos.length === 0) {
      res.status(200).json({ ok: true, linha, ignorado: true });
      return;
    }
    try {
      const { error } = await supabase.rpc('append_trail_points', {
        p_line_code: linha,
        p_points: pontos,
      });
      if (error) throw error;
      res.status(200).json({ ok: true, linha });
    } catch (err) {
      res.status(200).json({ ok: false, erro: `Falha ao salvar traçado deduzido: ${err.message}` });
    }
    return;
  }

  res.status(405).json({ ok: false, erro: 'Método não suportado.' });
};
