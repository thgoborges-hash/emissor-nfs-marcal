/**
 * Sync Domínio → Emissor — reconciliação de cadastro de clientes
 *
 * Skill `dominio-sync-clientes` do João extrai cadastro completo dos clientes
 * direto do Domínio Web (via computer-use no GO-Global) e POSTa em lote pro
 * endpoint `POST /api/joao/sync/clientes` (rota em routes/joao.js).
 *
 * Este service faz o lado servidor: pra cada cliente recebido, decide upsert
 * (novo / atualiza campos / não muda nada) e registra tudo em clientes_sync_log
 * + clientes_sync_status. Operação atômica via transação SQLite.
 *
 * Domínio é fonte de verdade fiscal/contábil. Emissor mantém um snapshot
 * operacional pra emissão NF + Ana. Sync é uma via (Domínio → Emissor); pra
 * trás, atualiza-se manual via painel.
 */

const crypto = require('crypto');
const { getDb } = require('../database/init');

// Campos que vêm do Domínio e mapeiam direto pra tabela `clientes`.
// Outros campos (certificado A1, dominio_integration_key, modo_emissao, etc)
// NÃO são sobrescritos — são propriedade do Emissor.
const CAMPOS_SYNC = [
  'razao_social',
  'nome_fantasia',
  'cnpj',
  'inscricao_municipal',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'codigo_municipio',
  'municipio',
  'uf',
  'cep',
  'email',
  'telefone',
  'codigo_servico',
  'descricao_servico_padrao',
  'aliquota_iss',
  'regime_especial',
  'optante_simples',
  'incentivo_fiscal',
  'regime_tributario',
  'regime_simples_nacional',
  'reg_ap_trib_sn',
  'ativo',
];

/**
 * Recebe um lote de clientes do Domínio e reconcilia com a tabela `clientes`.
 *
 * @param {Object} payload
 * @param {Array<Object>} payload.clientes — cada item tem CNPJ + campos do sync
 * @param {string} [payload.fonte='dominio']
 * @param {number|null} [payload.job_id] — FK joao_jobs se veio de job
 * @returns {Object} resumo: { log_id, total, novos, atualizados, inalterados, conflitos, erros, detalhes_por_cliente }
 */
function aplicarSync({ clientes, fonte = 'dominio', job_id = null } = {}) {
  if (!Array.isArray(clientes)) {
    throw new Error('payload.clientes deve ser array');
  }
  const db = getDb();

  // Cria entrada no log com status running
  const logResult = db.prepare(`
    INSERT INTO clientes_sync_log
      (fonte, total_recebidos, job_id, status)
    VALUES (?, ?, ?, 'running')
  `).run(fonte, clientes.length, job_id);
  const logId = logResult.lastInsertRowid;

  let novos = 0, atualizados = 0, inalterados = 0, conflitos = 0, erros = 0;
  const detalhes = [];

  // Statement helpers
  const findByCnpj = db.prepare(`
    SELECT * FROM clientes
    WHERE REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
    LIMIT 1
  `);
  const updateStatus = db.prepare(`
    INSERT OR REPLACE INTO clientes_sync_status
      (cliente_id, ultima_sync_em, ultimo_log_id, hash_dominio, campos_dessincronizados)
    VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
  `);

  const tx = db.transaction((items) => {
    for (const item of items) {
      try {
        const cnpjLimpo = String(item.cnpj || '').replace(/\D/g, '');
        if (cnpjLimpo.length !== 14) {
          erros += 1;
          detalhes.push({ cnpj: item.cnpj, acao: 'erro', motivo: 'CNPJ inválido' });
          continue;
        }

        const existente = findByCnpj.get(cnpjLimpo);
        const hashDominio = _hashSnapshot(item);

        if (!existente) {
          // INSERT — cria cliente novo
          const colunas = ['razao_social', 'cnpj', 'email', ...CAMPOS_SYNC.filter(c => !['razao_social', 'cnpj', 'email'].includes(c))];
          const valores = colunas.map(c => _valorPraInsert(item, c));
          const placeholders = colunas.map(() => '?').join(', ');
          const ins = db.prepare(`INSERT INTO clientes (${colunas.join(', ')}) VALUES (${placeholders})`).run(...valores);
          updateStatus.run(ins.lastInsertRowid, logId, hashDominio, null);
          novos += 1;
          detalhes.push({ cnpj: item.cnpj, cliente_id: ins.lastInsertRowid, acao: 'novo' });
          continue;
        }

        // UPSERT — compara campos, atualiza só os que mudaram. Conflitos: se o
        // Emissor tem valor preenchido E ele difere do Domínio, registra como
        // conflito mas TROCA pra valor do Domínio (Domínio é fonte de verdade).
        const updates = {};
        const camposDessincronizados = [];
        for (const campo of CAMPOS_SYNC) {
          if (item[campo] === undefined) continue;
          const vNovo = _normalizar(item[campo]);
          const vAtual = _normalizar(existente[campo]);
          if (vNovo !== vAtual) {
            updates[campo] = vNovo;
            if (vAtual != null && vAtual !== '') {
              camposDessincronizados.push({ campo, antigo: vAtual, novo: vNovo });
            }
          }
        }

        if (Object.keys(updates).length === 0) {
          updateStatus.run(existente.id, logId, hashDominio, null);
          inalterados += 1;
          detalhes.push({ cnpj: item.cnpj, cliente_id: existente.id, acao: 'inalterado' });
          continue;
        }

        // Aplica updates
        const sets = Object.keys(updates).map(c => `${c} = ?`).join(', ');
        const valores = [...Object.values(updates), existente.id];
        db.prepare(`UPDATE clientes SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...valores);

        const teveConflito = camposDessincronizados.length > 0;
        updateStatus.run(
          existente.id,
          logId,
          hashDominio,
          teveConflito ? JSON.stringify(camposDessincronizados) : null
        );
        if (teveConflito) conflitos += 1;
        atualizados += 1;
        detalhes.push({
          cnpj: item.cnpj,
          cliente_id: existente.id,
          acao: 'atualizado',
          campos_alterados: Object.keys(updates),
          conflitos: camposDessincronizados,
        });
      } catch (err) {
        erros += 1;
        detalhes.push({ cnpj: item.cnpj, acao: 'erro', motivo: err.message });
      }
    }
  });
  tx(clientes);

  // Fecha log
  db.prepare(`
    UPDATE clientes_sync_log
    SET finalizado_em = CURRENT_TIMESTAMP,
        novos = ?, atualizados = ?, inalterados = ?, conflitos = ?, erros = ?,
        detalhes = ?, status = 'done'
    WHERE id = ?
  `).run(novos, atualizados, inalterados, conflitos, erros, JSON.stringify(detalhes), logId);

  return {
    log_id: logId,
    total: clientes.length,
    novos,
    atualizados,
    inalterados,
    conflitos,
    erros,
    detalhes,
  };
}

/**
 * Retorna histórico recente de syncs.
 */
function historicoSyncs({ limite = 20 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT id, iniciado_em, finalizado_em, fonte, total_recebidos,
           novos, atualizados, inalterados, conflitos, erros, status, job_id
    FROM clientes_sync_log
    ORDER BY iniciado_em DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(200, Number(limite) || 20)));
}

/**
 * Retorna info de sync por cliente_id.
 */
function statusCliente(clienteId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM clientes_sync_status WHERE cliente_id = ?`).get(clienteId) || null;
}

// ── Onvio monitored clients ─────────────────────────────────────────────────

function listarOnvioMonitorados({ apenas_ativos = true } = {}) {
  const db = getDb();
  const where = apenas_ativos ? 'WHERE m.ativo = 1' : '';
  const rows = db.prepare(`
    SELECT m.*, c.razao_social, c.cnpj, c.ativo as cliente_ativo
    FROM onvio_monitored_clients m
    JOIN clientes c ON m.cliente_id = c.id
    ${where}
    ORDER BY m.cliente_id
  `).all();
  return rows.map(r => ({
    ...r,
    arquivos_vistos: _safeParse(r.arquivos_vistos, []),
  }));
}

function setOnvioMonitorado(clienteId, { ativo, pasta_path, ativado_por } = {}) {
  const db = getDb();
  // garante que cliente existe
  const c = db.prepare(`SELECT id FROM clientes WHERE id = ?`).get(clienteId);
  if (!c) throw new Error(`Cliente ${clienteId} não existe`);

  const existente = db.prepare(`SELECT * FROM onvio_monitored_clients WHERE cliente_id = ?`).get(clienteId);
  if (!existente) {
    db.prepare(`
      INSERT INTO onvio_monitored_clients (cliente_id, ativo, pasta_path, ativado_por)
      VALUES (?, ?, ?, ?)
    `).run(clienteId, ativo ? 1 : 0, pasta_path || null, ativado_por || 'desconhecido');
  } else {
    db.prepare(`
      UPDATE onvio_monitored_clients
      SET ativo = COALESCE(?, ativo),
          pasta_path = COALESCE(?, pasta_path),
          ativado_por = COALESCE(?, ativado_por)
      WHERE cliente_id = ?
    `).run(
      ativo == null ? null : (ativo ? 1 : 0),
      pasta_path,
      ativado_por,
      clienteId,
    );
  }
  return db.prepare(`SELECT * FROM onvio_monitored_clients WHERE cliente_id = ?`).get(clienteId);
}

function registrarVerificacaoOnvio(clienteId, { arquivos_vistos, extratos_novos = 0 } = {}) {
  const db = getDb();
  const existente = db.prepare(`SELECT * FROM onvio_monitored_clients WHERE cliente_id = ?`).get(clienteId);
  if (!existente) {
    throw new Error(`Cliente ${clienteId} não está monitorado`);
  }
  const novoTotal = (existente.total_extratos_processados || 0) + Number(extratos_novos || 0);
  const ultExtrato = extratos_novos > 0 ? 'CURRENT_TIMESTAMP' : (existente.ultimo_extrato_em ? "'" + existente.ultimo_extrato_em + "'" : 'NULL');
  // Não consigo interpolar literal SQL com prepared statement; faço 2 caminhos:
  if (extratos_novos > 0) {
    db.prepare(`
      UPDATE onvio_monitored_clients
      SET ultima_verificacao = CURRENT_TIMESTAMP,
          arquivos_vistos = ?,
          total_extratos_processados = ?,
          ultimo_extrato_em = CURRENT_TIMESTAMP
      WHERE cliente_id = ?
    `).run(JSON.stringify(arquivos_vistos || []), novoTotal, clienteId);
  } else {
    db.prepare(`
      UPDATE onvio_monitored_clients
      SET ultima_verificacao = CURRENT_TIMESTAMP,
          arquivos_vistos = ?
      WHERE cliente_id = ?
    `).run(JSON.stringify(arquivos_vistos || []), clienteId);
  }
  return db.prepare(`SELECT * FROM onvio_monitored_clients WHERE cliente_id = ?`).get(clienteId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _valorPraInsert(item, campo) {
  // Defaults pra campos NOT NULL no INSERT
  if (campo === 'razao_social') return item.razao_social || '(sem razão)';
  if (campo === 'email') return item.email || 'sem-email@nao-cadastrado.local';
  if (campo === 'cnpj') return String(item.cnpj || '').replace(/\D/g, '');
  return item[campo] != null ? item[campo] : null;
}

function _normalizar(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim();
  return v;
}

function _hashSnapshot(item) {
  const obj = {};
  for (const c of CAMPOS_SYNC) {
    if (item[c] !== undefined) obj[c] = _normalizar(item[c]);
  }
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function _safeParse(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  aplicarSync,
  historicoSyncs,
  statusCliente,
  listarOnvioMonitorados,
  setOnvioMonitorado,
  registrarVerificacaoOnvio,
  CAMPOS_SYNC,
};
