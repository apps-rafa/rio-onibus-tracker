/**
 * Busca e processa o GTFS estático oficial do Rio (rotas/formas/paradas),
 * usado só para desenhar o itinerário e os pontos de ônibus de uma linha
 * quando o usuário clica em um veículo no mapa.
 *
 * Fonte: https://www.data.rio/documents/b577e4c4c0924888823b630bbdb2c6fd/explore
 * Endpoint do arquivo: https://dados.mobilidade.rio/gtfs/schedule (.zip)
 * Atualização: mensal (segundo a Prefeitura) — por isso o cache local dura
 * várias horas, não precisa rebaixar a cada requisição.
 *
 * Estratégia (de propósito simplificada, pra não depender de stop_times.txt
 * — que é um arquivo enorme numa cidade do tamanho do Rio):
 *   - O itinerário vem direto de shapes.txt, filtrado pelo shape_id que já
 *     vem no próprio registro de GPS do ônibus (campo shape_id da API
 *     Conecta).
 *   - Os pontos de ônibus mostrados são os de stops.txt que caem a até
 *     ~250m de algum ponto do traçado — uma aproximação geográfica, não a
 *     sequência exata de paradas daquela viagem específica.
 */

const GTFS_URL = process.env.GTFS_URL || 'https://dados.mobilidade.rio/gtfs/schedule';
const GTFS_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

let gtfsCache = {
  timestamp: 0,
  shapesById: null,
  stops: null,
  routeBestShape: null,
  routeShapesByDirection: null,
  routeHeadsignsByDirection: null,
  routeIdsByShortName: null,
  knownRouteIds: null,
  linhas: null,
  error: null,
};
let loadingPromise = null;

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].length === 0) start++;
  if (start >= lines.length) return [];
  const headers = splitCsvLine(lines[start]).map((h) => h.trim());
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (cols.length < headers.length) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cols[j];
    rows.push(obj);
  }
  return rows;
}

// O endpoint do GTFS (arquivo .zip grande, servido por um servidor da
// Prefeitura) falha de vez em quando de forma transitória — "fetch failed"
// (conexão recusada/resetada) sem nem chegar a devolver um status HTTP,
// geralmente em menos de 1s, ou seja não é o AbortController de 45s
// estourando. Uma tentativa extra resolve a maioria desses casos sem exigir
// que o usuário recarregue a página. Isso também é o que fazia sugestões de
// linha (que dependem de /api/linhas, que depende do GTFS) sumirem de vez em
// quando.
async function fetchGtfsZip(attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const resp = await fetch(GTFS_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) return resp;
      lastErr = new Error(`GTFS upstream respondeu ${resp.status} ${resp.statusText}`);
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchAndParse() {
  // eslint-disable-next-line global-require
  const JSZip = require('jszip');

  const resp = await fetchGtfsZip();

  const buf = await resp.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const shapesEntry = zip.file('shapes.txt');
  const stopsEntry = zip.file('stops.txt');
  const tripsEntry = zip.file('trips.txt');
  const routesEntry = zip.file('routes.txt');
  if (!shapesEntry || !stopsEntry) {
    throw new Error('shapes.txt ou stops.txt não encontrado dentro do GTFS');
  }

  const [shapesText, stopsText, tripsText, routesText] = await Promise.all([
    shapesEntry.async('string'),
    stopsEntry.async('string'),
    tripsEntry ? tripsEntry.async('string') : Promise.resolve(''),
    routesEntry ? routesEntry.async('string') : Promise.resolve(''),
  ]);

  const shapeRows = parseCsv(shapesText);
  const shapesById = new Map();
  for (const row of shapeRows) {
    const id = row.shape_id;
    if (!id) continue;
    const lat = Number(row.shape_pt_lat);
    const lon = Number(row.shape_pt_lon);
    const seq = Number(row.shape_pt_sequence);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!shapesById.has(id)) shapesById.set(id, []);
    shapesById.get(id).push({ seq: Number.isFinite(seq) ? seq : 0, lat, lon });
  }
  for (const points of shapesById.values()) {
    points.sort((a, b) => a.seq - b.seq);
  }

  const stopRows = parseCsv(stopsText);
  const stops = [];
  for (const row of stopRows) {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.push({ id: row.stop_id || null, name: row.stop_name || row.stop_id || 'Ponto', lat, lon });
  }

  // route_id -> shape_id "típico" da linha, usado como fallback quando o
  // shape_id que vem junto da posição de GPS do ônibus não existe no GTFS
  // (viagens extras/atípicas). Vem de trips.txt, que faz esse vínculo —
  // shape_id sozinho não tem essa informação, e os nomes de shape_id não
  // seguem um padrão único (algumas linhas usam o route_id como prefixo,
  // outras não), então não dá pra adivinhar sem trips.txt.
  //
  // Também construímos a mesma coisa separada por direction_id (0/1 — ida e
  // volta), pra poder desenhar os dois sentidos de uma linha de uma vez só
  // (não só o sentido do ônibus clicado).
  const routeBestShape = new Map();
  const routeShapesByDirection = new Map(); // routeId -> Map(directionId -> shapeId)
  // routeId -> Map(directionId -> headsign "típico") — vem de trip_headsign,
  // usado só pra rotular a direção com o destino real (ex: "Usina", "Leblon")
  // em vez de um "ida"/"volta" genérico, pro front-end conseguir listar
  // "415 Usina" e "415 Leblon" como opções separadas.
  const routeHeadsignsByDirection = new Map();
  const knownRouteIds = new Set();
  if (tripsText) {
    const tripRows = parseCsv(tripsText);
    const routeShapeCounts = new Map(); // routeId -> Map(shapeId -> contagem)
    const routeDirShapeCounts = new Map(); // routeId -> Map(directionId -> Map(shapeId -> contagem))
    const routeDirHeadsignCounts = new Map(); // routeId -> Map(directionId -> Map(headsign -> contagem))
    for (const row of tripRows) {
      const routeId = row.route_id;
      const shapeId = row.shape_id;
      if (!routeId || !shapeId) continue;
      knownRouteIds.add(routeId);

      if (!routeShapeCounts.has(routeId)) routeShapeCounts.set(routeId, new Map());
      const counts = routeShapeCounts.get(routeId);
      counts.set(shapeId, (counts.get(shapeId) || 0) + 1);

      const directionId = row.direction_id !== undefined && row.direction_id !== '' ? row.direction_id : '0';
      if (!routeDirShapeCounts.has(routeId)) routeDirShapeCounts.set(routeId, new Map());
      const dirMap = routeDirShapeCounts.get(routeId);
      if (!dirMap.has(directionId)) dirMap.set(directionId, new Map());
      const dirCounts = dirMap.get(directionId);
      dirCounts.set(shapeId, (dirCounts.get(shapeId) || 0) + 1);

      const headsign = (row.trip_headsign || '').trim();
      if (headsign) {
        if (!routeDirHeadsignCounts.has(routeId)) routeDirHeadsignCounts.set(routeId, new Map());
        const hDirMap = routeDirHeadsignCounts.get(routeId);
        if (!hDirMap.has(directionId)) hDirMap.set(directionId, new Map());
        const hCounts = hDirMap.get(directionId);
        hCounts.set(headsign, (hCounts.get(headsign) || 0) + 1);
      }
    }
    for (const [routeId, counts] of routeShapeCounts.entries()) {
      let bestShapeId = null;
      let bestCount = -1;
      for (const [shapeId, count] of counts.entries()) {
        if (count > bestCount) {
          bestCount = count;
          bestShapeId = shapeId;
        }
      }
      if (bestShapeId) routeBestShape.set(routeId, bestShapeId);
    }
    for (const [routeId, dirMap] of routeDirShapeCounts.entries()) {
      const best = new Map();
      for (const [directionId, dirCounts] of dirMap.entries()) {
        let bestShapeId = null;
        let bestCount = -1;
        for (const [shapeId, count] of dirCounts.entries()) {
          if (count > bestCount) {
            bestCount = count;
            bestShapeId = shapeId;
          }
        }
        if (bestShapeId) best.set(directionId, bestShapeId);
      }
      routeShapesByDirection.set(routeId, best);
    }
    for (const [routeId, hDirMap] of routeDirHeadsignCounts.entries()) {
      const best = new Map();
      for (const [directionId, hCounts] of hDirMap.entries()) {
        let bestHeadsign = null;
        let bestCount = -1;
        for (const [headsign, count] of hCounts.entries()) {
          if (count > bestCount) {
            bestCount = count;
            bestHeadsign = headsign;
          }
        }
        if (bestHeadsign) best.set(directionId, bestHeadsign);
      }
      routeHeadsignsByDirection.set(routeId, best);
    }
  }

  // Lista de códigos de linha conhecidos (route_short_name), usada pro
  // autocomplete do campo de busca no front-end. Números primeiro (é o que
  // a maioria digita), depois códigos alfanuméricos em ordem alfabética.
  // Também guardamos o vínculo linha (route_short_name) -> route_id(s), pra
  // conseguir mostrar o traçado de uma linha assim que o usuário busca ela,
  // sem precisar esperar um ônibus aparecer e ser clicado.
  const linhasSet = new Set();
  const routeIdsByShortName = new Map(); // SHORTNAME (maiúsculo) -> Set(routeId)
  if (routesText) {
    const routeRows = parseCsv(routesText);
    for (const row of routeRows) {
      const shortName = (row.route_short_name || '').trim();
      const routeId = row.route_id;
      if (shortName) linhasSet.add(shortName);
      if (routeId) knownRouteIds.add(routeId);
      if (shortName && routeId) {
        const key = shortName.toUpperCase();
        if (!routeIdsByShortName.has(key)) routeIdsByShortName.set(key, new Set());
        routeIdsByShortName.get(key).add(routeId);
      }
    }
  }
  const linhas = Array.from(linhasSet).sort((a, b) => {
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) return Number(a) - Number(b);
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a.localeCompare(b);
  });

  return { shapesById, stops, routeBestShape, routeShapesByDirection, routeHeadsignsByDirection, routeIdsByShortName, knownRouteIds, linhas };
}

async function loadGtfs() {
  const now = Date.now();
  if (gtfsCache.shapesById && now - gtfsCache.timestamp < GTFS_CACHE_TTL_MS) {
    return gtfsCache;
  }
  // Evita disparar vários downloads/parsings em paralelo se chegarem
  // requisições concorrentes enquanto o cache está frio.
  if (!loadingPromise) {
    loadingPromise = fetchAndParse()
      .then((data) => {
        gtfsCache = {
          timestamp: Date.now(),
          shapesById: data.shapesById,
          stops: data.stops,
          routeBestShape: data.routeBestShape,
          routeShapesByDirection: data.routeShapesByDirection,
          routeHeadsignsByDirection: data.routeHeadsignsByDirection,
          routeIdsByShortName: data.routeIdsByShortName,
          knownRouteIds: data.knownRouteIds,
          linhas: data.linhas,
          error: null,
        };
        return gtfsCache;
      })
      .catch((err) => {
        gtfsCache = {
          timestamp: gtfsCache.timestamp,
          shapesById: gtfsCache.shapesById,
          stops: gtfsCache.stops,
          routeBestShape: gtfsCache.routeBestShape,
          routeShapesByDirection: gtfsCache.routeShapesByDirection,
          routeHeadsignsByDirection: gtfsCache.routeHeadsignsByDirection,
          routeIdsByShortName: gtfsCache.routeIdsByShortName,
          knownRouteIds: gtfsCache.knownRouteIds,
          linhas: gtfsCache.linhas,
          error: err.message,
        };
        throw err;
      })
      .finally(() => {
        loadingPromise = null;
      });
  }
  return loadingPromise;
}

async function getShape(shapeId) {
  const { shapesById } = await loadGtfs();
  const points = shapesById.get(shapeId);
  if (!points || points.length === 0) return null;
  return points.map((p) => [p.lat, p.lon]);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Pontos de ônibus geograficamente próximos ao traçado (aproximação —
 * veja o comentário no topo do arquivo).
 */
async function getStopsNear(shapePoints, maxDistMeters = 250, maxCount = 80) {
  const { stops } = await loadGtfs();
  if (!shapePoints || shapePoints.length === 0 || !stops) return [];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of shapePoints) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const pad = 0.006; // ~650m de folga na caixa antes do filtro fino por distância
  minLat -= pad;
  maxLat += pad;
  minLon -= pad;
  maxLon += pad;

  const candidates = stops.filter(
    (s) => s.lat >= minLat && s.lat <= maxLat && s.lon >= minLon && s.lon <= maxLon
  );

  const step = Math.max(1, Math.floor(shapePoints.length / 300));
  const near = [];
  for (const stop of candidates) {
    let best = Infinity;
    for (let i = 0; i < shapePoints.length; i += step) {
      const [lat, lon] = shapePoints[i];
      const d = haversineMeters(stop.lat, stop.lon, lat, lon);
      if (d < best) best = d;
      if (best <= maxDistMeters) break;
    }
    if (best <= maxDistMeters) near.push({ ...stop, distancia: Math.round(best) });
  }

  near.sort((a, b) => a.distancia - b.distancia);
  return near.slice(0, maxCount).map(({ id, name, lat, lon }) => ({ id, name, lat, lon }));
}

/**
 * Fallback para quando o shape_id que veio junto com a posição de GPS do
 * ônibus não existe no GTFS estático atual (acontece com viagens
 * extras/atípicas — o veículo às vezes manda um identificador de viagem
 * que não bate com nenhum shape do GTFS do mês). Usa o route_id (que a
 * API Conecta sempre envia) pra achar, via trips.txt, o shape_id mais
 * comum daquela linha — não é necessariamente o traçado exato da viagem
 * daquele veículo específico, por isso o chamador deve marcar o resultado
 * como aproximado.
 */
async function findApproxShapeForRoute(routeId) {
  if (!routeId) return null;
  const { shapesById, routeBestShape } = await loadGtfs();
  const shapeId = routeBestShape.get(routeId);
  if (!shapeId) return null;
  const points = shapesById.get(shapeId);
  if (!points || points.length === 0) return null;
  return { shapeId, shape: points.map((p) => [p.lat, p.lon]) };
}

/**
 * Escolhe, entre os sentidos conhecidos (ida/volta) de uma linha, qual
 * traçado está geograficamente mais perto da posição atual do ônibus.
 *
 * Motivo de existir: o campo shape_id que vem no próprio registro de GPS
 * da API Conecta nem sempre reflete o sentido real da viagem — em algumas
 * linhas observamos TODOS os veículos ativos reportando o mesmo shape_id,
 * mesmo claramente operando em sentidos opostos (uns indo, outros
 * voltando). Nesses casos confiar cegamente no shape_id trava o traçado
 * destacado sempre no mesmo sentido, não importa qual ônibus for clicado.
 * Comparar a posição real do veículo com os dois traçados conhecidos da
 * linha é mais confiável do que o campo shape_id nesses casos.
 */
async function findShapeForPosition(routeId, lat, lon) {
  if (!routeId || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const { shapesById, routeShapesByDirection, routeHeadsignsByDirection } = await loadGtfs();
  const byDirection = routeShapesByDirection ? routeShapesByDirection.get(routeId) : null;
  if (!byDirection || byDirection.size === 0) return null;

  let best = null;
  for (const [directionId, shapeId] of byDirection.entries()) {
    const points = shapesById.get(shapeId);
    if (!points || points.length === 0) continue;
    const dist = minDistanceToShapePoints(points, lat, lon);
    if (!best || dist < best.dist) {
      best = { directionId, shapeId, dist, shape: points.map((p) => [p.lat, p.lon]) };
    }
  }
  if (best) {
    const headsignMap = routeHeadsignsByDirection ? routeHeadsignsByDirection.get(routeId) : null;
    best.headsign = headsignMap ? (headsignMap.get(best.directionId) || null) : null;
  }
  return best;
}

function minDistanceToShapePoints(shapePoints, lat, lon) {
  const step = Math.max(1, Math.floor(shapePoints.length / 500));
  let best = Infinity;
  for (let i = 0; i < shapePoints.length; i += step) {
    const p = shapePoints[i];
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Diz se um route_id aparece em algum lugar do GTFS estático atual
 * (routes.txt e/ou trips.txt). Usado só pra dar uma mensagem de erro mais
 * clara: se o route_id nem existe no GTFS do mês, é bem provável que seja
 * uma linha extra/provisória que a Prefeitura ainda não publicou no
 * cadastro oficial (não é um bug do app).
 */
async function routeIdExiste(routeId) {
  if (!routeId) return false;
  const { knownRouteIds } = await loadGtfs();
  return !!(knownRouteIds && knownRouteIds.has(routeId));
}

/**
 * Traçados (ida e volta) de uma linha pelo código dela (route_short_name),
 * usado pra já mostrar o itinerário no mapa assim que o usuário busca uma
 * linha — sem precisar esperar um ônibus aparecer e clicar nele. Uma linha
 * pode ter mais de um route_id (variações/operadoras diferentes) e cada
 * route_id pode ter até 2 sentidos (direction_id 0 e 1); devolvemos o
 * traçado mais comum de cada combinação encontrada.
 */
async function getRouteShapesForLinha(linha) {
  const code = (linha || '').toString().trim().toUpperCase();
  if (!code) return [];
  const { shapesById, routeIdsByShortName, routeShapesByDirection, routeHeadsignsByDirection } = await loadGtfs();
  const routeIds = routeIdsByShortName ? routeIdsByShortName.get(code) : null;
  if (!routeIds || routeIds.size === 0) return [];

  const out = [];
  for (const routeId of routeIds) {
    const byDirection = routeShapesByDirection ? routeShapesByDirection.get(routeId) : null;
    if (!byDirection) continue;
    const headsignMap = routeHeadsignsByDirection ? routeHeadsignsByDirection.get(routeId) : null;
    for (const [directionId, shapeId] of byDirection.entries()) {
      const points = shapesById.get(shapeId);
      if (!points || points.length === 0) continue;
      out.push({
        routeId,
        directionId,
        shapeId,
        shape: points.map((p) => [p.lat, p.lon]),
        headsign: headsignMap ? (headsignMap.get(directionId) || null) : null,
      });
    }
  }
  return out;
}

/**
 * Lista de códigos de linha conhecidos (vem de routes.txt), pro
 * autocomplete do campo de busca no front-end.
 */
async function getLinhas() {
  const { linhas } = await loadGtfs();
  return linhas || [];
}

module.exports = {
  loadGtfs,
  getShape,
  getStopsNear,
  findApproxShapeForRoute,
  findShapeForPosition,
  routeIdExiste,
  getRouteShapesForLinha,
  getLinhas,
  GTFS_URL,
};
