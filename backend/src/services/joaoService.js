/**
 * JOÃO — Fila de jobs assíncronos pra o daemon local
 *
 * O daemon do João vive no Mac do Thiago (GO-Global precisa de sessão real,
 * não dá pra rodar no Render headless). Ele faz long-poll em
 * GET /api/joao/daemon/proximo, executa a skill correspondente via
 * computer-use, e devolve resultado via POST /api/joao/daemon/jobs/:id/...
 *
 * Este service é a camada de DB sobre `joao_jobs` + `joao_daemon_heartbeat`.
 * Lógica de auth do daemon e formatação HTTP fica em routes/joao.js.
 *
 * Convenções de status:
 *   pending           → enfileirado, daemon vai pegar
 *   pending_approval  → ação sensível precisa de aprovação humana antes
 *   running           → daemon pegou e tá executando
 *   done              → terminou com sucesso (resultado JSON populado)
 *   failed            → erro definitivo (erro texto populado)
 *   cancelled         → cancelado pelo usuário antes ou durante
 *
 * Convenção de tipo: namespace de ações que o daemon sabe executar.
 *   importar_txt | classificar_extrato | gerar_obrigacao | monitorar_onvio | generico
 */

const { getDb } = require('../database/init');

// Tipos válidos — espelho do que o daemon sabe executar
const TIPOS_VALIDOS = new Set([
  'importar_txt',
  'classificar_extrato',
  'gerar_obrigacao',
  'monitorar_onvio',
  'generico',
]);

// Ações sensíveis: por padrão entram como pending_approval (precisa humano confirmar)
const TIPOS_SENSIVEIS = new Set([
  'importar_txt',       // escreve lançamentos no Domínio — pode poluir balancete
  'gerar_obrigacao',    // ECD/balancete podem ser irreversíveis dependendo do sub-tipo
]);

const STATUS_FINAIS = new Set(['done', 'failed', 'cancelled']);

/**
 * Enfileira novo job.
 *
 * @param {Object} dados
 * @param {string} dados.tipo
 * @param {number|null} [dados.cliente_id]
 * @param {Object} dados.parametros — schema próprio por tipo (validado pelo daemon)
 * @param {string} [dados.criado_por='painel']
 * @param {number} [dados.prioridade=5]
 * @param {boolean} [dados.requer_aprovacao] — se omitido, usa default por tipo (TIPOS_SENSIVEIS)
 * @param {number|null} [dados.origem_conversa_id]
 * @param {string|null} [dados.origem_telefone]
 * @returns {{ id:number, status:string }}
 */
function enfileirar({
  tipo,
  cliente_id = null,
  parametros,
  criado_por = 'painel',
  prioridade = 5,
  requer_aprovacao,
  origem_conversa_id = null,
  origem_telefone = null,
} = {}) {
  if (!TIPOS_VALIDOS.has(tipo)) {
    throw new Error(`Tipo de job inválido: ${tipo}. Aceitos: ${[...TIPOS_VALIDOS].join(', ')}`);
  }
  if (parametros == null || typeof parametros !== 'object') {
    throw new Error('parametros obrigatório (objeto)');
  }
  const status = (requer_aprovacao === true || (requer_aprovacao !== false && TIPOS_SENSIVEIS.has(tipo)))
    ? 'pending_approval'
    : 'pending';

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO joao_jobs
      (tipo, cliente_id, parametros, status, prioridade,
       criado_por, origem_conversa_id, origem_telefone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tipo,
    cliente_id,
    JSON.stringify(parametros),
    status,
    prioridade,
    criado_por,
    origem_conversa_id,
    origem_telefone,
  );
  return { id: result.lastInsertRowid, status };
}

/**
 * Daemon pega o próximo job da fila. Atomicamente marca como `running`.
 *
 * Critério de seleção:
 *   1. status = 'pending'
 *   2. tipo dentro do filtro `tipos` se passado (daemon pode pedir só certos tipos)
 *   3. ordena por prioridade ASC, depois criado_at ASC (FIFO dentro da mesma prioridade)
 *
 * Atômico via UPDATE ... WHERE id = (SELECT ...) — better-sqlite3 é single-thread
 * dentro do processo Node, mas o daemon faz múltiplos pulls; este SQL é seguro.
 *
 * @param {string[]} [tipos=null] — filtro por tipos; null = todos
 * @returns {Object|null} job hidratado ou null se fila vazia
 */
function pegarProximo(tipos = null) {
  const db = getDb();

  let whereTipos = '';
  let params = [];
  if (Array.isArray(tipos) && tipos.length > 0) {
    whereTipos = `AND tipo IN (${tipos.map(() => '?').join(',')})`;
    params = tipos;
  }

  // Pega o id do próximo job + marca como running, retorna a linha atualizada.
  // RETURNING não funciona com UPDATE compostos no SQLite antigo, então fazemos
  // em 2 passos dentro de uma transação.
  const tx = db.transaction((tipoFilter) => {
    let sel = `
      SELECT id FROM joao_jobs
      WHERE status = 'pending' ${whereTipos}
      ORDER BY prioridade ASC, created_at ASC
      LIMIT 1
    `;
    const row = db.prepare(sel).get(...tipoFilter);
    if (!row) return null;
    db.prepare(`
      UPDATE joao_jobs
      SET status='running',
          iniciado_em = CURRENT_TIMESTAMP,
          ultima_tentativa = CURRENT_TIMESTAMP,
          tentativas = tentativas + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);
    return obter(row.id);
  });
  return tx(params);
}

/**
 * Daemon marcou o job como concluído.
 *
 * @param {number} jobId
 * @param {Object} resultado — JSON livre (logs, paths, status_dominio, etc)
 */
function concluir(jobId, resultado) {
  const db = getDb();
  const r = db.prepare(`
    UPDATE joao_jobs
    SET status='done',
        resultado = ?,
        finalizado_em = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(JSON.stringify(resultado || {}), jobId);
  if (r.changes === 0) {
    throw new Error(`Job ${jobId} não está em 'running' — não dá pra concluir`);
  }
  return obter(jobId);
}

/**
 * Daemon marcou o job como falhado. Pode reintentar dependendo de política
 * (ainda não implementada — Fase 4 talvez).
 *
 * @param {number} jobId
 * @param {string} erro
 */
function falhar(jobId, erro) {
  const db = getDb();
  const r = db.prepare(`
    UPDATE joao_jobs
    SET status='failed',
        erro = ?,
        finalizado_em = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).run(String(erro || 'erro não especificado').slice(0, 4000), jobId);
  if (r.changes === 0) {
    throw new Error(`Job ${jobId} não está em 'running' — não dá pra marcar falha`);
  }
  return obter(jobId);
}

/**
 * Operador aprova um job que estava em pending_approval.
 * Move pra pending pra o daemon pegar.
 */
function aprovar(jobId, aprovado_por) {
  const db = getDb();
  const r = db.prepare(`
    UPDATE joao_jobs
    SET status='pending',
        aprovado_por = ?,
        aprovado_em = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending_approval'
  `).run(aprovado_por || 'desconhecido', jobId);
  if (r.changes === 0) {
    throw new Error(`Job ${jobId} não está em 'pending_approval' — nada a aprovar`);
  }
  return obter(jobId);
}

/**
 * Cancela um job. Permitido em qualquer status não-final.
 */
function cancelar(jobId, motivo) {
  const db = getDb();
  const r = db.prepare(`
    UPDATE joao_jobs
    SET status='cancelled',
        erro = ?,
        finalizado_em = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')
  `).run(motivo || 'cancelado pelo usuário', jobId);
  if (r.changes === 0) {
    const atual = obter(jobId);
    if (!atual) throw new Error(`Job ${jobId} não encontrado`);
    throw new Error(`Job ${jobId} já está em status final ${atual.status}`);
  }
  return obter(jobId);
}

/**
 * Pega job por id (hidrata parametros e resultado JSON).
 */
function obter(jobId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM joao_jobs WHERE id = ?`).get(jobId);
  return row ? _hidratar(row) : null;
}

/**
 * Lista jobs com filtros opcionais.
 *
 * @param {Object} filtros
 * @param {string|string[]} [filtros.status]
 * @param {number} [filtros.cliente_id]
 * @param {string|string[]} [filtros.tipo]
 * @param {number} [filtros.limite=50]
 * @param {number} [filtros.offset=0]
 */
function listar({ status, cliente_id, tipo, limite = 50, offset = 0 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (status) {
    const arr = Array.isArray(status) ? status : [status];
    where.push(`status IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  }
  if (cliente_id != null) {
    where.push('cliente_id = ?');
    params.push(cliente_id);
  }
  if (tipo) {
    const arr = Array.isArray(tipo) ? tipo : [tipo];
    where.push(`tipo IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM joao_jobs
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.max(1, Math.min(500, Number(limite) || 50)), Math.max(0, Number(offset) || 0));
  return rows.map(_hidratar);
}

/**
 * Conta jobs por status (resumo pro painel).
 */
function resumoStatus() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) as total
    FROM joao_jobs
    GROUP BY status
  `).all();
  const out = { pending: 0, pending_approval: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.total;
  return out;
}

// ── Heartbeat do daemon ────────────────────────────────────────────────────

function registrarHeartbeat({ hostname, versao, jobs_ativos, metadata } = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE joao_daemon_heartbeat
    SET ultimo_ping = CURRENT_TIMESTAMP,
        hostname = ?,
        versao = ?,
        jobs_ativos = ?,
        metadata = ?
    WHERE id = 1
  `).run(
    hostname || null,
    versao || null,
    jobs_ativos != null ? Number(jobs_ativos) : 0,
    metadata ? JSON.stringify(metadata) : null,
  );
}

function statusDaemon() {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM joao_daemon_heartbeat WHERE id = 1`).get();
  if (!row || !row.ultimo_ping) {
    return { online: false, ultimo_ping: null, hostname: null, versao: null, jobs_ativos: 0 };
  }
  const ultimoMs = new Date(row.ultimo_ping + 'Z').getTime();
  const ageSec = Math.floor((Date.now() - ultimoMs) / 1000);
  // Considera "online" se pingou nos últimos 60s
  return {
    online: ageSec < 60,
    ultimo_ping: row.ultimo_ping,
    age_sec: ageSec,
    hostname: row.hostname,
    versao: row.versao,
    jobs_ativos: row.jobs_ativos,
    metadata: row.metadata ? _safeParse(row.metadata) : null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _hidratar(row) {
  return {
    ...row,
    parametros: _safeParse(row.parametros, {}),
    resultado: row.resultado ? _safeParse(row.resultado, null) : null,
  };
}

function _safeParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  enfileirar,
  pegarProximo,
  concluir,
  falhar,
  aprovar,
  cancelar,
  obter,
  listar,
  resumoStatus,
  registrarHeartbeat,
  statusDaemon,
  TIPOS_VALIDOS,
  TIPOS_SENSIVEIS,
  STATUS_FINAIS,
};
