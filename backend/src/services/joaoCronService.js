/**
 * João Cron Service — agenda jobs recorrentes do João daemon
 *
 * 2 jobs hoje:
 *
 * 1. Sync diário Domínio→Emissor (default: 03:00 BRT, cron '0 3 * * *')
 *    Enfileira UM job `sync_clientes_dominio` na fila joao_jobs. O daemon
 *    pega, invoca skill dominio-sync-clientes, extrai cadastro via
 *    computer-use e POSTa em /api/joao/sync/clientes.
 *    Idempotente: se já existe job pending/running do tipo no momento,
 *    não enfileira outro.
 *
 * 2. Onvio watcher (default: a cada 15 minutos, cron '*\/15 * * * *')
 *    Pra cada cliente em onvio_monitored_clients (ativo=1) enfileira UM
 *    job `monitorar_onvio`. Daemon pega, navega Onvio Documentos via
 *    Chrome MCP, detecta PDFs novos e enfileira classificar_extrato.
 *    Idempotente: dedupa por cliente_id ativo nas últimas 14min.
 *
 * Controle via env:
 *   JOAO_CRONS_ENABLED         — 'false' desabilita TUDO (default: ativado)
 *   JOAO_CRON_SYNC_CLIENTES    — override do schedule (default '0 3 * * *')
 *   JOAO_CRON_ONVIO_WATCHER    — override do schedule (default '*\/15 * * * *')
 *   JOAO_CRON_BOOT_DRY_RUN     — 'true' só loga, não enfileira (smoke test)
 */

const cron = (() => { try { return require('node-cron'); } catch { return null; } })();
const { getDb } = require('../database/init');
const joaoService = require('./joaoService');

const SCHEDULE_SYNC_CLIENTES = process.env.JOAO_CRON_SYNC_CLIENTES || '0 3 * * *';
const SCHEDULE_ONVIO_WATCHER = process.env.JOAO_CRON_ONVIO_WATCHER || '*/15 * * * *';
const DRY_RUN = process.env.JOAO_CRON_BOOT_DRY_RUN === 'true';

// Pra dedup do onvio: SQL que verifica se já tem job pending/running do mesmo
// cliente nas últimas 14min (menor que o intervalo de 15min, evita race).
const JANELA_ONVIO_DEDUP_MIN = 14;

function _existeJobPendente(tipo, cliente_id = null) {
  const db = getDb();
  const sql = cliente_id != null
    ? `SELECT id FROM joao_jobs
       WHERE tipo = ? AND cliente_id = ?
         AND status IN ('pending', 'pending_approval', 'running')
         AND datetime(created_at) > datetime('now', '-${JANELA_ONVIO_DEDUP_MIN} minutes')
       LIMIT 1`
    : `SELECT id FROM joao_jobs
       WHERE tipo = ?
         AND status IN ('pending', 'pending_approval', 'running')
       LIMIT 1`;
  const row = cliente_id != null
    ? db.prepare(sql).get(tipo, cliente_id)
    : db.prepare(sql).get(tipo);
  return !!row;
}

/**
 * Cron de sync — enfileira UM job `sync_clientes_dominio` por dia.
 */
function agendarSyncClientesDominio() {
  // Sync é um tipo especial — não está em TIPOS_VALIDOS do joaoService porque
  // não roda no daemon hoje (a skill é dominio-sync-clientes, que tem rota
  // específica). Usamos 'generico' com sub_tipo no parametros, e o subagent
  // João roteia internamente pra skill correta. Isso evita adicionar um tipo
  // novo no joaoService que mudaria a interface.
  const existente = _existeJobPendente('generico');
  // Filtro mais específico — só pulamos se for sync_clientes
  if (existente) {
    const db = getDb();
    const row = db.prepare(`
      SELECT id, parametros FROM joao_jobs
      WHERE tipo = 'generico' AND status IN ('pending', 'pending_approval', 'running')
        AND parametros LIKE '%"sub_tipo":"sync_clientes_dominio"%'
      LIMIT 1
    `).get();
    if (row) {
      console.log(`[JoaoCron] sync-clientes JÁ tem job ${row.id} ativo, pulando`);
      return;
    }
  }

  if (DRY_RUN) {
    console.log('[JoaoCron] DRY_RUN sync-clientes — não enfileirado');
    return;
  }

  const r = joaoService.enfileirar({
    tipo: 'generico',
    parametros: {
      sub_tipo: 'sync_clientes_dominio',
      origem: 'cron',
      schedule: SCHEDULE_SYNC_CLIENTES,
    },
    criado_por: 'cron:sync-clientes-dominio',
    requer_aprovacao: false,  // job recorrente do sistema, não precisa aprovação
    prioridade: 5,
  });
  console.log(`[JoaoCron] sync-clientes enfileirado: job #${r.id} status=${r.status}`);
}

/**
 * Cron do onvio — varre clientes monitorados e enfileira UM job por cliente
 * que não tenha verificação ativa.
 */
function agendarOnvioWatcher() {
  const db = getDb();
  const monitorados = db.prepare(`
    SELECT m.cliente_id, c.razao_social
    FROM onvio_monitored_clients m
    JOIN clientes c ON m.cliente_id = c.id
    WHERE m.ativo = 1 AND c.ativo = 1
  `).all();

  if (monitorados.length === 0) {
    return;  // silencioso — sem clientes monitorados ainda
  }

  let enfileirados = 0;
  let pulados = 0;
  for (const m of monitorados) {
    if (_existeJobPendente('monitorar_onvio', m.cliente_id)) {
      pulados += 1;
      continue;
    }
    if (DRY_RUN) {
      pulados += 1;
      continue;
    }
    try {
      joaoService.enfileirar({
        tipo: 'monitorar_onvio',
        cliente_id: m.cliente_id,
        parametros: { cliente_id: m.cliente_id, estado: 'check', origem: 'cron' },
        criado_por: 'cron:onvio-watcher',
        requer_aprovacao: false,
        prioridade: 7,  // baixa prioridade — não bloqueia jobs interativos
      });
      enfileirados += 1;
    } catch (err) {
      console.warn(`[JoaoCron] erro enfileirando onvio pra cliente ${m.cliente_id}: ${err.message}`);
    }
  }

  if (enfileirados > 0 || pulados > 0) {
    console.log(`[JoaoCron] onvio-watcher: ${enfileirados} enfileirado(s), ${pulados} pulado(s) (de ${monitorados.length} monitorados)`);
  }
}

/**
 * Liga ambos os crons. Chamado uma vez no boot do server.
 */
function iniciarCron() {
  if (!cron) {
    console.warn('[JoaoCron] node-cron nao disponivel, pulando agendamento');
    return;
  }
  if (process.env.JOAO_CRONS_ENABLED === 'false') {
    console.log('[JoaoCron] cron desabilitado via JOAO_CRONS_ENABLED=false');
    return;
  }

  cron.schedule(SCHEDULE_SYNC_CLIENTES, () => {
    try {
      agendarSyncClientesDominio();
    } catch (err) {
      console.error('[JoaoCron] erro no cron sync-clientes:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  cron.schedule(SCHEDULE_ONVIO_WATCHER, () => {
    try {
      agendarOnvioWatcher();
    } catch (err) {
      console.error('[JoaoCron] erro no cron onvio-watcher:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  console.log(`[JoaoCron] crons agendados — sync-clientes: "${SCHEDULE_SYNC_CLIENTES}" | onvio-watcher: "${SCHEDULE_ONVIO_WATCHER}" | TZ: America/Sao_Paulo${DRY_RUN ? ' | DRY_RUN' : ''}`);
}

module.exports = {
  iniciarCron,
  agendarSyncClientesDominio,
  agendarOnvioWatcher,
  // exports privados pra teste:
  _existeJobPendente,
};
