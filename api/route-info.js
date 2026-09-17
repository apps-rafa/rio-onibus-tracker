// Função serverless da Vercel: GET /api/route-info?shapeId=...&routeId=...
// Dado o shape_id que já vem no próprio registro de GPS do ônibus, devolve
// o traçado do itinerário (lista de [lat, lon]) e os pontos de ônibus
// próximos a ele. Se o shape_id não existir no GTFS atual (comum em
// viagens extras/atípicas), tenta um traçado aproximado da mesma linha
// usando routeId. Veja lib/gtfs.js para detalhes e limitações.
const { getShape, getStopsNear, findApproxShapeForRoute, findShapeForPosition, routeIdExiste } = require('../lib/gtfs');
const { requireUser } = require('../lib/supabaseAuth');

module.exports = async (req, res) => {
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

    // Prioriza escolher o sentido (ida/volta) mais próximo da posição atual
    // do veículo — o shape_id que vem no GPS às vezes não reflete o sentido
    // real da viagem (ver findShapeForPosition em lib/gtfs.js).
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
        // route_id nem aparece em routes.txt/trips.txt: quase certamente é
        // uma linha extra/provisória que a Prefeitura ainda não publicou no
        // GTFS oficial deste mês, não um bug do app.
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
};
