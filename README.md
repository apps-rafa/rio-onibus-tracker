# Rio Ônibus Tracker

Mapa em tempo real dos ônibus do Rio de Janeiro, usando o dado público de GPS
da Prefeitura (o mesmo referenciado em [data.rio](https://www.data.rio/documents/transporte-rodovi%C3%A1rio-viagens-dos-%C3%B4nibus-identificadas-por-gps/about)).

Você escolhe uma ou mais linhas e o mapa mostra os ônibus daquelas linhas se
movendo, atualizando a cada 20 segundos. Cada ônibus aparece como uma seta
apontando seu sentido de movimento; clicando nele, o app desenha o
itinerário da linha e os pontos de ônibus próximos.

Publicado em: **https://rio-onibus-tracker.vercel.app**

## Por que tem um backend (e não é só uma página HTML)?

A API pública de GPS não libera CORS para chamadas diretas do navegador —
então uma página sozinha não consegue buscar esses dados diretamente. Por
isso o projeto busca os dados no servidor e os repassa pro mapa:

- Rodando localmente: `server.js` (Express) faz esse papel.
- Publicado na Vercel: `api/buses.js`, `api/debug-raw.js` e
  `api/route-info.js` são funções serverless que fazem a mesma coisa. A
  lógica de busca/normalização do GPS é compartilhada entre os dois em
  `lib/gps.js`, e a lógica do itinerário/pontos de ônibus (GTFS) fica em
  `lib/gtfs.js` — para não duplicar código.

## Como rodar localmente

Pré-requisito: [Node.js](https://nodejs.org) 18 ou mais novo (para ter o
`fetch` embutido).

```bash
npm install
npm start
```

Depois abra **http://localhost:3001** no navegador.

## Como usar

1. Digite o número de uma ou mais linhas no campo do painel, separadas por
   vírgula — por exemplo: `838, 918`.
2. Clique em **"Acompanhar"**.
3. Os ônibus daquelas linhas aparecem no mapa como setas coloridas (uma cor
   por linha), apontando o sentido de movimento, e se movem a cada
   atualização. Clique numa seta para ver velocidade e horário da última
   posição, e para desenhar o itinerário da linha e os pontos de ônibus
   próximos (clique em "Fechar itinerário" para tirar do mapa).

Por padrão a página atualiza sozinha a cada 20 segundos (dá pra desligar no
checkbox "Atualizar automaticamente").

> Comece com poucas linhas. Se você deixar o campo de linhas vazio e
> acompanhar a frota toda, são milhares de veículos de uma vez — o servidor
> aceita (endpoint `/api/buses` sem `linhas`), mas o mapa fica pesado e
> difícil de ler.

## Sobre a fonte de dados (leia isso se parar de funcionar)

Essa API pública é **informal e já mudou de endereço/formato mais de uma vez**
— a versão antiga (`dados.mobilidade.rio/gps/sppo`, sem autenticação, sem
janela de tempo) foi descontinuada. O projeto usa hoje a **API Conecta**,
documentada em data.rio:

```
GET https://dados.mobilidade.rio/sppo/conecta/gps?dataInicial=<ISO8601 UTC>&dataFinal=<ISO8601 UTC>
```

Diferente da versão antiga, essa API exige uma **janela de tempo** (não dá
pra só pedir "a posição atual") — o servidor monta essa janela sozinho (os
últimos 3 minutos, por padrão) a cada busca. Como o mesmo veículo pode
aparecer mais de uma vez dentro da janela (um ping a cada ~1 minuto), o
servidor mantém só a posição mais recente de cada ônibus antes de mandar
pro mapa.

Limites documentados pela Prefeitura: 5 requisições/segundo e 60/minuto — por
isso existe um cache de 20 segundos no servidor (evita martelar a API toda
vez que alguém atualiza a página).

Campos esperados em cada registro: `id_veiculo`, `servico` (linha),
`sentido`, `latitude`, `longitude`, `velocidade`, `direcao`, e os horários
`datetime` / `datetime_envio` / `datetime_servidor`. O servidor já sabe
interpretar tanto esse formato quanto o antigo (`ordem`, `linha`, `datahora`
etc.) e um envelope estilo GeoJSON/ArcGIS, então se a Prefeitura trocar de
novo, boa parte dos casos já está coberta.

Hoje o app junta **duas** fontes de GPS em paralelo (`lib/gps.js`): a
Conecta acima e a API "ITS GPS 2.0" (`its.mobilidade.rio/v1/geolocalizacao/veiculos`),
preferindo o registro que trouxer o campo `linha` preenchido quando o mesmo
veículo aparece nas duas. Outras APIs candidatas foram testadas (endpoint
`/api/debug-sources`) e descartadas: a API legada `dadosabertos.rio.rj.gov.br`
(a "primeira" API, de antes da Conecta existir) está fora do ar — as
requisições dão timeout, por isso ela foi removida deste projeto; o endpoint
alternativo `its.mobilidade.rio/v1/geolocalizacao/onibus-urbanos` devolve 404
(não existe); e o proxy `rest.riob.us` não é alcançável a partir da Vercel.
Ou seja, das fontes conhecidas, só as duas já combinadas acima funcionam
hoje.

Se em algum momento o mapa parar de mostrar ônibus:

1. Acesse **`/api/debug-raw`** (local: `http://localhost:3001/api/debug-raw`;
   publicado: `https://rio-onibus-tracker.vercel.app/api/debug-raw`) — esse
   endpoint mostra os 3 primeiros registros exatamente como a API devolveu,
   sem nenhum tratamento. Isso ajuda a ver se o formato ou os nomes dos
   campos mudaram.
2. Se a URL da API tiver mudado, aponte para a nova:
   - Local: `UPSTREAM_URL="https://nova-url-aqui" npm start`
   - Na Vercel: adicione a variável de ambiente `UPSTREAM_URL` em
     Settings → Environment Variables do projeto, e faça um redeploy.
3. Se os *nomes dos campos* mudarem, ajuste a função `normalizeRecord()` em
   `lib/gps.js` — ela já foi escrita para ser fácil de estender (é só
   adicionar o novo nome do campo na lista de alternativas em `pick(...)`).

## Itinerário e pontos de ônibus (GTFS)

Ao clicar num ônibus, o app busca em `/api/route-info?shapeId=...` o
traçado da linha e os pontos de ônibus próximos, usando o `shape_id` que já
vem em cada registro de GPS da API Conecta. Esses dados vêm do **GTFS
estático oficial do Rio** (`https://dados.mobilidade.rio/gtfs/schedule`,
atualizado mensalmente pela Prefeitura), processado em `lib/gtfs.js`:

- O itinerário é o traçado de `shapes.txt` para aquele `shape_id`.
- Os pontos de ônibus mostrados são os de `stops.txt` que ficam a até ~250m
  de algum ponto do traçado — uma **aproximação geográfica**, não
  necessariamente a sequência exata de paradas daquela viagem específica
  (isso exigiria processar `stop_times.txt`, que é grande demais para uma
  cidade do tamanho do Rio processar a cada requisição).
- O GTFS inteiro (zip) é baixado e desempacotado com `jszip` na primeira
  requisição e fica em cache por 12h (por isso a primeira busca de um
  itinerário pode demorar um pouco mais que as seguintes). Se o download
  falhar de forma transitória ("fetch failed", comum nesse servidor), o
  servidor tenta mais uma vez antes de desistir (`fetchGtfsZip` em
  `lib/gtfs.js`) — isso também é o que fazia sugestões de linha (que
  dependem de `/api/linhas`, que depende do GTFS) sumirem de vez em quando.
- Se um veículo não tiver `shape_id` na fonte, ou se o `shape_id` não for
  encontrado no GTFS atual, o app avisa que o itinerário está indisponível
  para aquele ônibus, em vez de travar.

### Linhas fora do cadastro GTFS (ex: LECD154)

Algumas linhas circulam de verdade (têm ônibus reportando GPS) mas ainda não
entraram no cadastro GTFS do mês — o `/api/route-shapes` não retorna nenhum
traçado pra elas. Pra essas linhas o app tem dois fallbacks visuais, sem
depender do GTFS:

- **Traçado deduzido da linha inteira**: assim que você acompanha uma dessas
  linhas, o navegador começa a acumular a posição de cada ônibus dela a cada
  ciclo de atualização (20s) e desenha um traçado tracejado, aproximado, que
  vai ficando mais completo com o tempo — é a mesma ideia do traçado oficial
  (linhas com GTFS), só que "descoberto" ao vivo em vez de vir pronto do
  cadastro. O chip da linha (rodapé) avisa disso no `title` (passe o mouse).
- **Trajeto do ônibus selecionado**: ao clicar numa seta específica, o app
  desenha só o histórico de posições reais daquele veículo (não da linha
  toda) — é o comportamento mais antigo, ainda usado como fallback por
  veículo dentro do popup de itinerário.

O **trajeto do ônibus selecionado** ainda é só em memória do navegador desta
aba (reinicia do zero a cada recarregar). Já o **traçado deduzido da linha
inteira** agora é **persistido no Supabase** (tabela `line_trails`) e
compartilhado entre todos os usuários logados — ver seção "Login e
persistência" abaixo.

## Login e persistência (Supabase)

O site inteiro fica atrás de uma barreira de login: qualquer pessoa pode
entrar, mas precisa digitar um e-mail e o código de 6 dígitos que chega
nele (login sem senha, via [Supabase
Auth](https://supabase.com/docs/guides/auth) — OTP por e-mail). Não existe
lista de e-mails permitidos; qualquer e-mail válido consegue pedir um
código e entrar.

Detalhes técnicos:

- Projeto Supabase dedicado (`rio-onibus-tracker`, região `sa-east-1`) —
  separado dos outros projetos Supabase da conta.
- A URL e a chave `anon`/publishable do projeto ficam **hardcoded** em
  `index.html` (front-end) e `lib/supabaseAuth.js` (backend) — não são
  segredo, são a mesma dupla usada em qualquer app Supabase no navegador; a
  chave `service_role` (essa sim secreta) **não é usada em lugar nenhum**
  do projeto.
- Toda rota de dados em `api/*.js` (e as equivalentes em `server.js`, pro
  dev local) exige um token de sessão válido no header
  `Authorization: Bearer <token>` — `lib/supabaseAuth.js#requireUser`
  valida esse token contra o Supabase Auth antes de responder. Isso garante
  que a barreira de login protege os dados de verdade (backend), não só a
  tela (frontend).
- **Traçado deduzido por linha** (`api/trail-points.js` + tabela
  `line_trails`): ao acompanhar uma linha sem itinerário oficial, o
  front-end busca (`GET`) o traçado já acumulado por qualquer usuário e
  manda (`POST`) os pontos novos observados nesta sessão. O merge/dedupe/
  limite de 4000 pontos acontece de forma atômica dentro do banco, na
  função `append_trail_points()` (migração aplicada via Supabase MCP) —:
  assim, várias pessoas acompanhando a mesma linha ao mesmo tempo não
  perdem pontos umas das outras. Row Level Security (RLS): só usuários
  autenticados podem ler ou (via essa função) escrever na tabela.

### Passo manual único: e-mail com código em vez de link mágico

Por padrão, o Supabase Auth manda um **link mágico** por e-mail (clicar
loga direto), não um código pra digitar. Pra ele mandar o código de 6
dígitos que o app pede, o template de e-mail "Magic Link" do projeto
precisa ser editado **uma vez** no [Dashboard do
Supabase](https://supabase.com/dashboard/project/uqpcxkcpfldnszrmwsbp/auth/templates)
(Authentication → Email Templates → Magic Link), trocando o conteúdo por
algo que inclua a variável `{{ .Token }}`, por exemplo:

```html
<h2>Seu código de acesso — Cadê meu busão?</h2>
<p>Use este código para entrar: <strong>{{ .Token }}</strong></p>
```

Isso não dá pra fazer pelas ferramentas MCP do Supabase (não existe uma
chamada pra editar template de e-mail), só pelo Dashboard mesmo — é um
passo manual único, não precisa repetir depois.

### Alternativa: entrar sem e-mail (acesso anônimo)

Enquanto o passo acima não for feito, a tela de login também tem um botão
**"Entrar sem e-mail"**, que usa o [Anonymous Sign-In do Supabase
Auth](https://supabase.com/docs/guides/auth/auth-anonymous)
(`supabase.auth.signInAnonymously()`). É um usuário real, com ID próprio,
sujeito às mesmas políticas de RLS que um usuário logado por e-mail — por
isso nenhuma rota de `api/*.js`/`server.js` precisa saber a diferença entre
os dois casos (`requireUser` em `lib/supabaseAuth.js` só confere se o token
é válido). A limitação é que essa sessão não tem e-mail vinculado: se sair
ou limpar os dados do navegador, não tem como recuperar a mesma "conta"
depois.

Esse recurso também precisa ser **habilitado uma vez** no Dashboard do
Supabase, em [Authentication → Providers →
Anonymous Sign-Ins](https://supabase.com/dashboard/project/uqpcxkcpfldnszrmwsbp/auth/providers)
(é só um interruptor "Allow anonymous sign-ins", bem mais rápido que editar
o template de e-mail acima). Sem isso habilitado, o botão mostra uma
mensagem explicando o que falta em vez de travar sem explicação.

### Limitação conhecida: limite de envio de e-mail no plano free

O provedor de e-mail embutido do Supabase (usado por padrão, sem configurar
nada) tem um limite de envio baixo, pensado pra teste/desenvolvimento, não
pra produção com tráfego real. Se muita gente pedir código ao mesmo tempo,
alguns envios podem atrasar ou falhar. Pra remover esse limite, configura-se
um provedor de SMTP próprio (ex: Resend, tem plano free) em Authentication
→ Settings → SMTP Settings — não feito ainda neste projeto.

## Estrutura do projeto

```
rio-onibus-tracker/
├── index.html             # mapa (Leaflet + CartoDB Positron), painel e barreira de login
├── server.js               # backend p/ rodar localmente (npm start)
├── lib/
│   ├── gps.js               # busca + normalização dos dados de GPS (compartilhado)
│   ├── gtfs.js               # busca + parsing do GTFS (itinerário/pontos de ônibus)
│   └── supabaseAuth.js       # validação de sessão + cliente Supabase (compartilhado)
├── api/
│   ├── buses.js             # função serverless da Vercel: GET /api/buses
│   ├── debug-raw.js         # função serverless da Vercel: GET /api/debug-raw
│   ├── route-info.js        # função serverless da Vercel: GET /api/route-info
│   └── trail-points.js      # função serverless da Vercel: GET/POST /api/trail-points
└── package.json             # inclui jszip e @supabase/supabase-js, necessários em runtime
```

> Nem todos os arquivos de `api/` estão listados acima (tem também
> `debug-sources.js`, `debug-gtfs-search.js`, `linhas.js`,
> `linhas-ativas.js`, `route-shapes.js`, `ping.js`) — a lista mostra só os
> mais relevantes pra entender a estrutura.

> Nota técnica: as funções da Vercel ficam todas direto em `api/` (sem
> subpastas) — em teste, uma rota aninhada tipo `api/debug/raw.js` não foi
> roteada corretamente nesse projeto (a Vercel devolvia 502 sem nem invocar
> a função). Por segurança, evite criar subpastas dentro de `api/`.
>
> Outra pegadinha: como as funções serverless usam `jszip` em runtime
> (`lib/gtfs.js`), o `package.json` precisa ir junto em todo deploy — sem
> ele a Vercel não instala a dependência e `/api/route-info` quebra.
>
> As funções também têm `maxDuration: 30` em `vercel.json` — o download e
> parsing do GTFS pode passar do limite padrão de execução.

## Ideias para evoluir

- Trocar o polling por WebSocket/SSE para atualização mais suave.
- Persistir também o histórico de posições por VEÍCULO (hoje só o traçado
  agregado por linha é salvo, em `line_trails` — ver "Login e
  persistência") para poder "rebobinar" o trajeto de um ônibus específico.
- Configurar um provedor de SMTP próprio no Supabase (ex: Resend) para
  remover o limite baixo de envio de e-mail do provedor padrão.
- Usar `stop_times.txt`/`trips.txt` do GTFS para mostrar a sequência exata
  de paradas de uma viagem, em vez da aproximação por proximidade geográfica.
- Alertar quando um ônibus específico estiver a X minutos de um ponto salvo.
