/**
 * Rio Ônibus Tracker — servidor para rodar LOCALMENTE (npm start).
 *
 * A lógica de busca/normalização dos dados de GPS mora em lib/gps.js e é
 * compartilhada com as funções serverless da Vercel em api/ — isso deixa
 * o comportamento idêntico rodando local ou publicado.
 *
 * Veja o README para detalhes sobre a API pública (endereço, campos, e o
 * que fazer se ela mudar de formato de novo).
 */

const express = require('express');
const path = require('path');
const { fetchUpstream, UPSTREAM_URL } = require('./lib/gps');
const { getShape, getStopsNear, findApproxShapeForRoute, findShapeForPosition, routeIdExiste, getRouteShapesForLinha, getLinhas } = require('./lib/gtfs');
const { requireUser, getUserClient, getBearerToken } = require('./lib/supabaseAuth');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Resolve a direção (ida/volta) geograficamente mais próxima de cada ônibus
// — igual ao que /api/route-info já faz pro veículo selecionado — e anexa
// directionId/headsign a cada registro. Usado pro front-end conseguir
// listar/filtrar "415 Usina" e "415 Leblon" como chips separados.
// Best-effort: se a linha não estiver no GTFS (ex: LECD154) ou o GTFS ainda
// não carregou, o ônibus só fica sem direção classificada.
async function withDirection(buses) {
  return Promise.all(
    buses.map(async (b) => {
      if (!b.routeId || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) return b;
      try {
        const dir = await findShapeForPosition(b.routeId, b.latitude, b.longitude);
        if (dir) return { ...b, directionId: dir.directionId, headsign: dir.headsign || null };
      } catch (err) {
        // silencioso
      }
      return b;
    })
  );
}

app.get('/api/buses', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const cache = await fetchUpstream();
    const list = cache.buses || [];

    const linhasParam = (req.query.linhas || '').trim();
    let filtered = list;
    if (linhasParam) {
      const wanted = new Set(
        linhasParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      );
      filtered = list.filter((b) => b.linha && wanted.has(b.linha.toUpperCase()));
    }

    const enriquecido = await withDirection(filtered);

    res.json({
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
      erro: `Não foi possível obter dados da API pública (${UPSTREAM_URL}): ${err.message}`,
    });
  }
});

app.get('/api/debug-raw', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const cache = await fetchUpstream();
    res.json({
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
    res.status(200).json({ ok: false, erro: err.message, upstreamUrl: UPSTREAM_URL });
  }
});

app.get('/api/linhas-ativas', async (req, res) => {
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
});

app.get('/api/route-info', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const shapeId = (req.query.shapeId || '').toString().trim();
  const routeId = (req.query.routeId || '').toString().trim();
  const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
  const lon = req.query.lon !== undefined ? Number(req.query.lon) : null;
  if (!shapeId && !routeId) {
    res.status(200).json({ ok: false, erro: 'Parâmetro shapeId ou routeId é obrigatório.' });
    return;
  }
  try {
    let shape = null;
    let shapeIdUsado = null;
    let aproximado = false;

    if (routeId && Number.isFinite(lat) && Number.isFinite(lon)) {
      const porPosicao = await findShapeForPosition(routeId, lat, lon);
      if (porPosicao) {
        shape = porPosicao.shape;
        shapeIdUsado = porPosicao.shapeId;
      }
    }

    if (!shape && shapeId) {
      shape = await getShape(shapeId);
      shapeIdUsado = shapeId;
    }

    if (!shape && routeId) {
      const approx = await findApproxShapeForRoute(routeId);
      if (approx) {
        shape = approx.shape;
        shapeIdUsado = approx.shapeId;
        aproximado = true;
      }
    }

    if (!shape) {
      let erro;
      if (routeId && !(await routeIdExiste(routeId))) {
        erro = `Essa linha (route_id "${routeId}") ainda não consta no cadastro GTFS oficial deste mês — ` +
          `provavelmente é uma linha extra, provisória ou recém-criada que a Prefeitura ainda não publicou. ` +
          `Sem esse cadastro não dá pra desenhar nem um traçado aproximado.`;
      } else {
        erro = `Itinerário não encontrado para shape_id "${shapeId || '—'}" no GTFS atual` +
          (routeId ? ` (nem um traçado aproximado para a linha/route_id "${routeId}").` : '.');
      }
      res.status(200).json({ ok: false, erro });
      return;
    }

    const pontos = await getStopsNear(shape);
    res.status(200).json({ ok: true, shapeId: shapeIdUsado, shapeIdOriginal: shapeId || null, shape, pontos, aproximado });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao carregar o GTFS: ${err.message}` });
  }
});

app.get('/api/route-shapes', async (req, res) => {
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
});

app.get('/api/linhas', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const linhas = await getLinhas();
    res.status(200).json({ ok: true, linhas });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao carregar linhas do GTFS: ${err.message}` });
  }
});

app.get('/api/trail-points', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const supabase = getUserClient(getBearerToken(req));
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
    res.status(200).json({ ok: true, linha, pontos: (data && data.points) || [], atualizadoEm: (data && data.updated_at) || null });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao buscar traçado deduzido: ${err.message}` });
  }
});

app.post('/api/trail-points', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const supabase = getUserClient(getBearerToken(req));
  const linha = ((req.body && req.body.linha) || '').toString().trim().toUpperCase();
  const pontos = Array.isArray(req.body && req.body.pontos) ? req.body.pontos : [];
  if (!linha) {
    res.status(200).json({ ok: false, erro: 'Campo linha é obrigatório.' });
    return;
  }
  if (pontos.length === 0) {
    res.status(200).json({ ok: true, linha, ignorado: true });
    return;
  }
  try {
    const { error } = await supabase.rpc('append_trail_points', { p_line_code: linha, p_points: pontos });
    if (error) throw error;
    res.status(200).json({ ok: true, linha });
  } catch (err) {
    res.status(200).json({ ok: false, erro: `Falha ao salvar traçado deduzido: ${err.message}` });
  }
});

// POST /api/stops-near — paradas de ônibus (GTFS stops.txt) próximas a um
// traçado QUALQUER mandado pelo cliente (lista de [lat, lon]), não só um
// shape_id oficial. Usado como fallback pra linhas sem itinerário oficial
// no GTFS (ex: LECD154): nesses casos o app desenha o trajeto observado ao
// vivo em vez do traçado oficial (ver drawInferredTrail em index.html), e
// esse endpoint deixa mostrar os pontos de ônibus próximos a esse trajeto
// observado também — sem isso, uma linha sem GTFS nunca mostrava nenhum
// ponto de ônibus.
app.post('/api/stops-near', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const pontosIn = Array.isArray(req.body && req.body.pontos) ? req.body.pontos : [];
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
});

app.listen(PORT, () => {
  console.log(`Rio Ônibus Tracker rodando em http://localhost:${PORT}`);
  console.log(`Buscando dados de: ${UPSTREAM_URL}`);
});
