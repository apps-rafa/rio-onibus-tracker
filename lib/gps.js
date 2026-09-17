/**
 * Lógica compartilhada de busca + normalização dos dados de GPS dos
 * ônibus do Rio. Usada tanto pelo servidor local (server.js) quanto pelas
 * funções serverless da Vercel (api/buses.js, api/debug-raw.js), para não
 * duplicar a lógica em dois lugares.
 *
 * Fontes consultadas, SEMPRE as duas em paralelo (não é "primária com
 * fallback só se a primeira falhar" — ver o motivo logo abaixo):
 *
 * 1) "API GPS 2.0" unificada da SMTR (its.mobilidade.rio) — agrega vários
 *    provedores de GPS (Conecta, Zirix, Maxtrack) com timeouts curtos e
 *    circuit breakers por trás, então tende a ficar de pé mesmo quando um
 *    provedor individual cai. Endpoint:
 *      GET https://its.mobilidade.rio/v1/geolocalizacao/veiculos
 *        ?datetime_inicio=<ISO 8601>&datetime_fim=<ISO 8601>  (obrigatórios)
 *    Os campos de data/hora dessa API já vêm corretamente em UTC.
 *
 * 2) "API Conecta" (SMTR/Subtt), a fonte histórica. Documentada em:
 *      https://www.data.rio/documents/2a5d133b3e914065b9ece3790f5e5685/about
 *    Endpoint: GET https://dados.mobilidade.rio/sppo/conecta/gps
 *      ?dataInicial=<ISO 8601>&dataFinal=<ISO 8601>  (obrigatórios)
 *    Limites documentados: 5 req/s e 60 req/min — por isso o cache local e a
 *    janela de tempo curta abaixo. Essa fonte rotula os campos de data/hora
 *    como se fossem UTC ("Z") mas na prática já vêm em horário de Brasília —
 *    ver fixUpstreamDatetime() abaixo.
 *
 * Por que consultar as duas sempre, em vez de só usar a Conecta como
 * fallback de erro: descobrimos (setembro/2026) que a API GPS 2.0, apesar
 * de estar no ar, às vezes devolve registros com `servico`/`route_id`/
 * `shape_id` em branco (viagem que o pipeline deles ainda não casou com o
 * itinerário oficial) — um erro "silencioso", sem falha de rede nem status
 * HTTP ruim. Um registro sem `servico` fica sem `linha` depois de
 * normalizado, e por isso desaparece de qualquer busca por linha (ex: "415")
 * mesmo o ônibus estando realmente ali. Como a Conecta rotula `servico` de
 * forma confiável, buscar as duas fontes e mesclar os registros (preferindo,
 * por veículo, o registro que tiver `linha` preenchida — ver
 * dedupeLatestByVehicle) cobre essa lacuna: um veículo "invisível" numa
 * fonte pode aparecer certinho na outra. Isso também mantém a app no ar
 * quando uma das duas fontes cai de vez (erro de rede/HTTP), não só quando
 * os dados vêm incompletos.
 *
 * Veja o README para o histórico de por que essa normalização existe
 * (a API pública já mudou de endereço/formato mais de uma vez — a versão
 * antiga em /gps/sppo foi descontinuada).
 */

const PRIMARY_URL = process.env.PRIMARY_UPSTREAM_URL || 'https://its.mobilidade.rio/v1/geolocalizacao/veiculos';
const FALLBACK_URL = process.env.FALLBACK_UPSTREAM_URL || 'https://dados.mobilidade.rio/sppo/conecta/gps';

// Mantido por compatibilidade: código antigo (mensagens de erro, logs)
// importa UPSTREAM_URL esperando "a" URL da API. Aponta pra fonte primária.
const UPSTREAM_URL = PRIMARY_URL;

// Janela de tempo consultada a cada requisição: GPS de cada ônibus chega
// mais ou menos 1x por minuto, então alguns minutos garantem pegar pelo
// menos uma posição recente de cada veículo ativo.
const WINDOW_MS = Number(process.env.WINDOW_MINUTES || 3) * 60 * 1000;

// Cache em memória (dura enquanto a instância do processo/função estiver
// "quente" — na Vercel isso é por invocação recente, não é garantido
// entre execuções frias). Mantido >= ao intervalo de polling do front-end
// para respeitar os limites de taxa da API (5 req/s, 60 req/min).
const CACHE_TTL_MS = 20_000;
let cache = { timestamp: 0, buses: null, error: null, source: null, rawPorFonte: [] };

// 'its' (its.mobilidade.rio) usa datetime_inicio/datetime_fim; 'conecta'
// (dados.mobilidade.rio, a fonte antiga) usa dataInicial/dataFinal.
function buildUrl(baseUrl, source) {
  const now = Date.now();
  const fim = new Date(now).toISOString();
  const inicio = new Date(now - WINDOW_MS).toISOString();
  const url = new URL(baseUrl);
  if (source === 'its') {
    url.searchParams.set('datetime_inicio', inicio);
    url.searchParams.set('datetime_fim', fim);
  } else {
    url.searchParams.set('dataInicial', inicio);
    url.searchParams.set('dataFinal', fim);
  }
  return url.toString();
}

async function fetchFrom(baseUrl, source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(buildUrl(baseUrl, source), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`API upstream (${source}) respondeu ${resp.status} ${resp.statusText}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUpstream() {
  const now = Date.now();
  if (cache.buses && now - cache.timestamp < CACHE_TTL_MS) {
    return cache;
  }

  const [primaryResult, fallbackResult] = await Promise.allSettled([
    fetchFrom(PRIMARY_URL, 'its'),
    fetchFrom(FALLBACK_URL, 'conecta'),
  ]);

  const porFonte = [];
  if (primaryResult.status === 'fulfilled') {
    porFonte.push({ source: 'its', records: extractArray(primaryResult.value) });
  }
  if (fallbackResult.status === 'fulfilled') {
    porFonte.push({ source: 'conecta', records: extractArray(fallbackResult.value) });
  }

  if (porFonte.length === 0) {
    // As duas fontes falharam nessa tentativa (rede/HTTP) — mantém o último
    // dado bom em cache (se houver) em vez de derrubar a resposta.
    const combinedMsg =
      `Fonte primária (its): ${primaryResult.status === 'rejected' ? primaryResult.reason.message : 'falhou'} | ` +
      `Fonte alternativa (conecta): ${fallbackResult.status === 'rejected' ? fallbackResult.reason.message : 'falhou'}`;
    if (!cache.buses) throw new Error(combinedMsg); // sem dado nenhum em cache: propaga o erro
    cache = { ...cache, timestamp: now, error: combinedMsg };
    return cache;
  }

  const normalized = [];
  const rawPorFonte = [];
  for (const { source, records } of porFonte) {
    for (const rec of records) {
      const n = normalizeRecord(rec, source);
      if (n) normalized.push(n);
    }
    rawPorFonte.push({ source, total: records.length, amostra: records.slice(0, 3) });
  }

  const buses = dedupeLatestByVehicle(normalized);
  const sourcesUsed = porFonte.map((p) => p.source);
  const failedSources = ['its', 'conecta'].filter((s) => !sourcesUsed.includes(s));

  cache = {
    timestamp: now,
    buses,
    rawPorFonte,
    error: failedSources.length > 0
      ? `Fonte "${failedSources.join(', ')}" falhou nessa tentativa; usando só ${sourcesUsed.join(' + ')}.`
      : null,
    source: sourcesUsed.join('+'),
  };
  return cache;
}

/**
 * Converte um registro em qualquer um dos formatos conhecidos da API em
 * um objeto padronizado:
 *   { ordem, linha, latitude, longitude, velocidade, direcao, datahora }
 * Retorna null se não for possível interpretar o registro.
 *
 * `source` indica de qual fonte veio o registro ('its' | 'conecta' |
 * indefinido) — usado só pra decidir se aplica a correção de fuso horário
 * (ver fixUpstreamDatetime abaixo), já que só a fonte 'conecta' tem esse
 * bug.
 */
function normalizeRecord(rec, source) {
  // Formato antigo (API legada /gps/sppo, descontinuada): array posicional
  // [datahora, ordem, linha, latitude, longitude, velocidade, direcao]
  if (Array.isArray(rec)) {
    const [datahora, ordem, linha, latitude, longitude, velocidade, direcao] = rec;
    return buildRecord({ datahora, ordem, linha, latitude, longitude, velocidade, direcao }, source);
  }

  if (rec && typeof rec === 'object') {
    // Envelope estilo ArcGIS FeatureSet: { attributes: {...}, geometry: {x, y} }
    if (rec.attributes || rec.geometry) {
      const attrs = rec.attributes || {};
      const geom = rec.geometry || {};
      return buildRecord({
        datahora: pick(attrs, ['datahora', 'DATAHORA', 'datetime', 'timestamp']),
        ordem: pick(attrs, ['ordem', 'ORDEM', 'id_veiculo', 'id', 'codigo']),
        linha: pick(attrs, ['linha', 'LINHA', 'servico', 'route']),
        latitude: geom.y ?? pick(attrs, ['latitude', 'LATITUDE', 'lat']),
        longitude: geom.x ?? pick(attrs, ['longitude', 'LONGITUDE', 'lon', 'lng']),
        velocidade: pick(attrs, ['velocidade', 'VELOCIDADE', 'speed']),
        direcao: pick(attrs, ['direcao', 'DIRECAO', 'sentido', 'direction']),
      }, source);
    }

    // Formato "objeto plano" — cobre a API GPS 2.0 (its.mobilidade.rio) e a
    // API Conecta atual (id_veiculo, servico, sentido, direcao, datetime,
    // datetime_envio, datetime_servidor, route_id, trip_id, shape_id) e
    // variações antigas.
    return buildRecord({
      datahora: pick(rec, [
        'datetime', 'datetime_servidor', 'datetime_envio',
        'datahora', 'DATAHORA', 'dataHora', 'timestamp', 'data_hora',
      ]),
      ordem: pick(rec, ['id_veiculo', 'ordem', 'ORDEM', 'idVeiculo', 'codigo', 'id']),
      linha: pick(rec, ['servico', 'linha', 'LINHA', 'servico_informado', 'route', 'line']),
      latitude: pick(rec, ['latitude', 'LATITUDE', 'lat']),
      longitude: pick(rec, ['longitude', 'LONGITUDE', 'lon', 'lng', 'long']),
      velocidade: pick(rec, ['velocidade', 'VELOCIDADE', 'speed']),
      direcao: pick(rec, ['direcao', 'DIRECAO', 'sentido', 'direction']),
      shapeId: pick(rec, ['shape_id', 'shapeId']),
      routeId: pick(rec, ['route_id', 'routeId']),
      tripId: pick(rec, ['trip_id', 'tripId']),
    }, source);
  }

  return null;
}

// A API "Conecta" da Prefeitura rotula os campos de data/hora (datetime,
// datetime_envio, datetime_servidor) com "Z" — como se fossem UTC — mas na
// prática o valor já vem em horário de Brasília (UTC-3), sem qualquer
// conversão. Confirmado comparando o "datetime" de registros reais com o
// horário real da resposta: o valor "UTC" ficava sempre ~3h no passado em
// relação ao agora verdadeiro. Sem corrigir isso, "Última posição" no
// front-end aparecia travado em "3h atrás" pra ônibus que tinham acabado de
// reportar posição. O Brasil não usa mais horário de verão desde 2019, então
// esse deslocamento de -03:00 é fixo o ano inteiro (não precisa lidar com
// DST).
//
// Importante: essa correção só se aplica a registros vindos da fonte
// 'conecta'. A fonte 'its' (API GPS 2.0) rotula datetime corretamente em
// UTC — confirmado comparando amostras reais (defasagem de segundos, não
// horas) — então aplicar essa mesma correção lá deixaria o horário errado
// por +3h.
const UPSTREAM_TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

function fixUpstreamDatetime(raw) {
  if (!raw) return raw;
  const str = String(raw).trim();
  // Só mexe no formato que a API realmente manda: "YYYY-MM-DDTHH:mm:ss"
  // (+ opcionalmente ".sss") seguido de "Z". Qualquer outra coisa (ou um
  // formato que já traga um offset explícito diferente de "Z", tipo
  // "-03:00") é deixada como está, pra não estragar um formato imprevisto.
  const m = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/);
  if (!m) return str;
  const naiveAsUtcMs = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(naiveAsUtcMs)) return str;
  return new Date(naiveAsUtcMs + UPSTREAM_TZ_OFFSET_MS).toISOString();
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function buildRecord({ datahora, ordem, linha, latitude, longitude, velocidade, direcao, shapeId, routeId, tripId }, source) {
  const lat = toNumber(latitude);
  const lon = toNumber(longitude);
  if (lat === null || lon === null) return null;
  // Sanidade: coordenadas fora de uma caixa generosa ao redor do Rio são
  // descartadas (evita lixo/zeros quebrando o mapa).
  if (lat < -24 || lat > -21 || lon < -45 || lon > -42) return null;

  const direcaoNum = toNumber(direcao);

  return {
    ordem: ordem !== undefined ? String(ordem) : null,
    linha: linha !== undefined ? String(linha).trim() : null,
    latitude: lat,
    longitude: lon,
    velocidade: toNumber(velocidade),
    // direcao é o rumo/bearing em graus (0-360); guardamos como número
    // quando possível para poder rotacionar a seta no mapa.
    direcao: direcaoNum !== null ? direcaoNum : (direcao || null),
    datahora: datahora !== undefined
      ? (source === 'conecta' ? fixUpstreamDatetime(datahora) : datahora)
      : null,
    shapeId: shapeId !== undefined && shapeId !== '' ? String(shapeId) : null,
    routeId: routeId !== undefined && routeId !== '' ? String(routeId) : null,
    tripId: tripId !== undefined && tripId !== '' ? String(tripId) : null,
  };
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.features)) return raw.features;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.registros)) return raw.registros;
  return [];
}

/**
 * A API retorna todas as posições dentro da janela de tempo consultada —
 * ou seja, o mesmo veículo pode aparecer várias vezes (um ping por minuto,
 * e agora também porque consultamos duas fontes em paralelo — ver o
 * cabeçalho do arquivo). Mantém só UM registro por veículo, escolhido
 * assim:
 *   1) prefere um registro que tenha `linha` preenchida a um que não tenha
 *      — a API GPS 2.0 às vezes manda `servico` em branco pra uma viagem
 *      ainda não casada com o itinerário oficial; se a Conecta tiver esse
 *      mesmo veículo com a linha certa, usamos essa em vez de "perder" o
 *      ônibus da busca por linha;
 *   2) entre dois registros igualmente completos (ambos com ou ambos sem
 *      linha), fica com o mais recente (`datahora` maior).
 */
function dedupeLatestByVehicle(records) {
  const latest = new Map();
  for (const r of records) {
    if (!r.ordem) continue;
    const existing = latest.get(r.ordem);
    if (!existing) {
      latest.set(r.ordem, r);
      continue;
    }
    const existingScore = existing.linha ? 1 : 0;
    const rScore = r.linha ? 1 : 0;
    if (rScore !== existingScore) {
      if (rScore > existingScore) latest.set(r.ordem, r);
      continue;
    }
    if (r.datahora && (!existing.datahora || r.datahora > existing.datahora)) {
      latest.set(r.ordem, r);
    }
  }
  return Array.from(latest.values());
}

module.exports = {
  fetchUpstream,
  normalizeRecord,
  extractArray,
  dedupeLatestByVehicle,
  UPSTREAM_URL,
  PRIMARY_URL,
  FALLBACK_URL,
};
