/**
 * Autenticação/persistência via Supabase — compartilhado entre server.js
 * (dev local) e as funções serverless em api/.
 *
 * URL e chave "anon" (publishable) NÃO são segredos: são as mesmas usadas
 * no navegador (embutidas em index.html) e são seguras de expor — quem
 * protege os dados é o Row Level Security (RLS) configurado no banco, não
 * o sigilo dessas duas strings. Por isso ficam hardcoded aqui em vez de
 * depender de variável de ambiente na Vercel (evita um passo extra de
 * configuração manual no dashboard da Vercel).
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://uqpcxkcpfldnszrmwsbp.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxcGN4a2NwZmxkbnN6cm13c2JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NjA1MDgsImV4cCI6MjEwNTIzNjUwOH0.vm-1_YYgpyzQqzk9ZK_O_ixrcaH6JCgU49q0W29JcHA';

function getBearerToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Exige um usuário autenticado (via token do Supabase Auth mandado no
 * header Authorization pelo front-end). Em caso de falha, já escreve a
 * resposta 401 e devolve null — quem chamar deve checar `if (!user) return;`.
 */
async function requireUser(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, erro: 'Não autenticado — faça login para acessar este recurso.' });
    return null;
  }
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      res.status(401).json({ ok: false, erro: 'Sessão inválida ou expirada — faça login novamente.' });
      return null;
    }
    return data.user;
  } catch (err) {
    res.status(401).json({ ok: false, erro: `Falha ao validar sessão: ${err.message}` });
    return null;
  }
}

/** Cliente Supabase autenticado como o usuário dono do token (respeita RLS). */
function getUserClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY, getBearerToken, requireUser, getUserClient };
