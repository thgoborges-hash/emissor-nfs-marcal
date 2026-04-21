/**
 * Snapshot SERPRO — worker diario que consulta obrigacoes da carteira inteira
 * e armazena o resultado em snapshot_obrigacoes pra alimentar a tela Entregas.
 *
 * Politica:
 * - Desligado por default. Ativa via env ENABLE_SERPRO_SNAPSHOT_CRON=true.
 * - Executa 1x ao dia no horario configurado (HH:MM, default 06:00).
 * - Intervalo entre clientes: 5s (evita rate limit SERPRO).
 * - Consultas feitas: procuracao, ultima PGDAS-D, relacao DCTFWeb. SITFIS e
 *   pesado (assincrono por cliente) — roda semanal se ENABLE_SITFIS_WEEKLY=true.
 */

const cron = (() => { try { return require('node-cron'); } catch (e) { return null; } })();
const { getDb } = require('../database/init');
const integraContadorService = require('./integraContadorService');

const INTERVALO_MS = Number(process.env.SERPRO_SNAPSHOT_INTERVALO_CLIENTE_MS || 5000);
const HORA_CRON = process.env.SERPRO_SNAPSHOT_CRON_HORA || '0 6 * * *';  // 06:00 diario

function _gravarSnapshot(clienteId, obrigacao, { competencia = null, status, resumo, dadosRaw, erro = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO snapshot_obrigacoes (cliente_id, obrigacao, competencia, status, resumo, dados_raw, erro, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cliente_id, obrigacao, competencia) DO UPDATE SET
      status = excluded.status,
      resumo = excluded.resumo,
      dados_raw = excluded.dados_raw,
      erro = excluded.erro,
      atualizado_em = CURRENT_TIMESTAMP
  `).run(clienteId, obrigacao, competencia, status, resumo || null, dadosRaw ? JSON.stringify(dadosRaw).slice(0, 8000) : null, erro);
}

async function _coletarPorCliente(cliente) {
  const cnpj = (cliente.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) {
    console.warn(`[SerproSnap] cliente ${cliente.id} (${cliente.razao_social}) tem CNPJ invalido, pulando`);
    return;
  }

  // Procuracao
  try {
    const r = await integraContadorService.consultarProcuracoes(cnpj);
    const dados = (r && r.dados) || r;
    const parsed = typeof dados === 'string' ? tryJson(dados) : dados;
    const temProc = parsed && (Array.isArray(parsed) ? parsed.length > 0 : Object.keys(parsed || {}).length > 0);
    _gravarSnapshot(cliente.id, 'PROCURACAO', {
      status: temProc ? 'ok' : 'pendente',
      resumo: temProc ? 'Procuracao ativa' : 'Sem procuracao vigente',
      dadosRaw: parsed,
    });
  } catch (err) {
    _gravarSnapshot(cliente.id, 'PROCURACAO', { status: 'erro', erro: err.message });
  }

  // Ultima PGDAS-D
  try {
    const r = await integraContadorService.consultarUltimaDeclaracaoPGDASD(cnpj);
    const dados = (r && r.dados) || r;
    const parsed = typeof dados === 'string' ? tryJson(dados) : dados;
    const competencia = parsed && (parsed.periodoApuracao || parsed.competencia);
    _gravarSnapshot(cliente.id, 'PGDASD', {
      competencia: competencia || null,
      status: parsed ? 'ok' : 'sem_dados',
      resumo: parsed ? `Ultima transmitida: ${competencia || 'N/A'}` : 'Sem declaracao localizada',
      dadosRaw: parsed,
    });
  } catch (err) {
    _gravarSnapshot(cliente.id, 'PGDASD', { status: 'erro', erro: err.message });
  }

  // DCTFWeb — lista
  try {
    const r = await integraContadorService.consultarRelacaoDCTFWeb(cnpj);
    const dados = (r && r.dados) || r;
    const parsed = typeof dados === 'string' ? tryJson(dados) : dados;
    const total = Array.isArray(parsed) ? parsed.length : (parsed && parsed.totalRegistros) || 0;
    _gravarSnapshot(cliente.id, 'DCTFWEB', {
      status: total > 0 ? 'ok' : 'sem_dados',
      resumo: total > 0 ? `${total} declaracoes localizadas` : 'Nenhuma DCTFWeb encontrada',
      dadosRaw: parsed,
    });
  } catch (err) {
    _gravarSnapshot(cliente.id, 'DCTFWEB', { status: 'erro', erro: err.message });
  }

  // Caixa Postal — indicador de mensagens novas
  try {
    const r = await integraContadorService.listarMensagensCaixaPostal(cnpj);
    const dados = (r && r.dados) || r;
    const parsed = typeof dados === 'string' ? tryJson(dados) : dados;
    const qtd = Array.isArray(parsed) ? parsed.length : (parsed && parsed.mensagens ? parsed.mensagens.length : 0);
    _gravarSnapshot(cliente.id, 'CAIXA_POSTAL', {
      status: qtd > 0 ? 'pendente' : 'ok',
      resumo: qtd > 0 ? `${qtd} mensagem(ns) no e-CAC` : 'Sem mensagens novas',
      dadosRaw: parsed,
    });
  } catch (err) {
    _gravarSnapshot(cliente.id, 'CAIXA_POSTAL', { status: 'erro', erro: err.message });
  }
}

function tryJson(s) { try { return JSON.parse(s); } catch (e) { return s; } }

async function rodarSnapshotCompleto() {
  const db = getDb();
  const clientes = db.prepare(`
    SELECT id, razao_social, cnpj FROM clientes
    WHERE ativo = 1 AND cnpj IS NOT NULL AND LENGTH(REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','')) = 14
  `).all();
  console.log(`[SerproSnap] Iniciando varredura de ${clientes.length} clientes ativos...`);
  const inicio = Date.now();
  let sucessos = 0, erros = 0;
  for (const c of clientes) {
    try {
      await _coletarPorCliente(c);
      sucessos++;
    } catch (err) {
      console.error(`[SerproSnap] Falha geral em ${c.razao_social}:`, err.message);
      erros++;
    }
    await new Promise(r => setTimeout(r, INTERVALO_MS));
  }
  const totalMin = ((Date.now() - inicio) / 60000).toFixed(1);
  console.log(`[SerproSnap] Concluido em ${totalMin}min. Sucessos: ${sucessos}, Erros: ${erros}`);
  return { total: clientes.length, sucessos, erros, duracaoMin: totalMin };
}

function iniciarCron() {
  if (process.env.ENABLE_SERPRO_SNAPSHOT_CRON !== 'true') {
    console.log('[SerproSnap] Cron desligado (set ENABLE_SERPRO_SNAPSHOT_CRON=true pra ativar)');
    return;
  }
  if (!cron) {
    console.warn('[SerproSnap] node-cron nao esta instalado; rode `npm i node-cron` ou use worker externo');
    return;
  }
  cron.schedule(HORA_CRON, () => {
    rodarSnapshotCompleto().catch(err => console.error('[SerproSnap] Erro no cron:', err));
  });
  console.log(`[SerproSnap] Cron agendado: ${HORA_CRON}`);
}

function lerSnapshot(clienteId) {
  const db = getDb();
  return db.prepare(`
    SELECT obrigacao, competencia, status, resumo, atualizado_em, erro
    FROM snapshot_obrigacoes
    WHERE cliente_id = ?
    ORDER BY obrigacao
  `).all(clienteId);
}

function lerSnapshotsTodos() {
  const db = getDb();
  return db.prepare(`
    SELECT so.cliente_id, c.razao_social, c.cnpj, so.obrigacao, so.competencia,
           so.status, so.resumo, so.atualizado_em, so.erro
    FROM snapshot_obrigacoes so
    INNER JOIN clientes c ON c.id = so.cliente_id
    WHERE c.ativo = 1
    ORDER BY c.razao_social, so.obrigacao
  `).all();
}

module.exports = { rodarSnapshotCompleto, iniciarCron, lerSnapshot, lerSnapshotsTodos };
