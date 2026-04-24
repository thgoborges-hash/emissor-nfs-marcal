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

  // DCTFWeb — classifica status: em_dia | atrasada | pendente | sem_dados
  try {
    // Competencia alvo = mes anterior (o DCTFWeb do mes passado vence dia 15 deste)
    const hoje = new Date();
    const anoAlvo = hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();
    const mesAlvo = hoje.getMonth() === 0 ? 12 : hoje.getMonth();
    const periodoApuracaoAlvo = `${anoAlvo}${String(mesAlvo).padStart(2, '0')}`;
    const r = await integraContadorService.consultarRelacaoDCTFWeb(cnpj, periodoApuracaoAlvo);
    const dados = (r && r.dados) || r;
    const parsed = typeof dados === 'string' ? tryJson(dados) : dados;
    const declaracoes = Array.isArray(parsed) ? parsed : (parsed && (parsed.declaracoes || parsed.lista)) || [];
    const classif = _classificarDctfweb(declaracoes);
    _gravarSnapshot(cliente.id, 'DCTFWEB', {
      competencia: classif.competenciaAlvo,
      status: classif.status,
      resumo: classif.resumo,
      dadosRaw: { total: declaracoes.length, alvo: classif.competenciaAlvo, amostra: declaracoes.slice(0, 3) },
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

/**
 * Classifica o status da DCTFWeb do cliente segundo a competencia alvo (mes anterior).
 * Regra:
 *   - competencia alvo = mes imediatamente anterior ao mes corrente (YYYYMM)
 *   - prazo legal = dia 15 do mes seguinte a competencia (= dia 15 do mes corrente)
 *   - Se ha declaracao do mes alvo com situacao diferente de CANCELADA => 'em_dia'
 *   - Se nao, e hoje > dia 15 do mes corrente => 'atrasada' (MULTA)
 *   - Se nao, e hoje <= dia 15 => 'pendente' (dentro do prazo)
 *   - Se nao ha historico nenhum => 'sem_dados' (provavelmente nao obrigado)
 */
function _classificarDctfweb(resposta) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1;
  // competencia alvo = mes anterior
  const anoAlvo = mes === 1 ? ano - 1 : ano;
  const mesAlvo = mes === 1 ? 12 : mes - 1;
  const competenciaAlvo = `${anoAlvo}${String(mesAlvo).padStart(2, '0')}`;
  const nomeMes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][mesAlvo - 1];
  const rotuloCompet = `${nomeMes}/${anoAlvo}`;

  // CONSDECCOMPLETA33 retorna a declaracao COMPLETA em um objeto (nao lista).
  // Campos que indicam declaracao transmitida:
  //   - PDFByteArrayBase64 (PDF da declaracao)
  //   - numeroDeclaracao / numero / numeroRecibo
  //   - situacao (TRANSMITIDA, ATIVA, etc.)
  //   - codigoReceita / valorTotal
  // Se qualquer um desses existe com conteudo -> transmitida.
  if (resposta && typeof resposta === 'object' && !Array.isArray(resposta)) {
    const temPDF = resposta.PDFByteArrayBase64 && String(resposta.PDFByteArrayBase64).length > 100;
    const temNumero = resposta.numeroDeclaracao || resposta.numero || resposta.numeroRecibo;
    const temSituacao = resposta.situacao || resposta.status;
    const temValor = typeof resposta.valorTotal !== 'undefined' || typeof resposta.valor !== 'undefined';

    if (temPDF || temNumero || temValor) {
      const situ = temSituacao || 'TRANSMITIDA';
      return {
        status: 'em_dia',
        resumo: `DCTFWeb ${rotuloCompet} ${String(situ).toLowerCase()}`,
        competenciaAlvo,
      };
    }

    // Retorno nao vazio mas sem campos esperados: talvez erro estruturado
    if (Object.keys(resposta).length > 0 && !temSituacao) {
      // Pode ser mensagem de erro tipo "Declaracao nao encontrada" ou "Sem movimento"
      // Trata como nao transmitida e aplica regra de prazo abaixo
    }
  }

  // Compat com endpoint antigo (lista de declaracoes)
  if (Array.isArray(resposta) && resposta.length > 0) {
    const match = resposta.find(d => {
      const comp = String(d.periodoApuracao || d.competencia || d.periodo || '').replace(/\D/g, '');
      return comp.length >= 6 && comp.slice(0, 6) === competenciaAlvo;
    });
    if (match) {
      return {
        status: 'em_dia',
        resumo: `DCTFWeb ${rotuloCompet} ${String(match.situacao || 'transmitida').toLowerCase()}`,
        competenciaAlvo,
      };
    }
  }

  // Nao transmitida ou resposta vazia — aplica regra de prazo
  const dia = hoje.getDate();
  if (dia > 15) {
    return {
      status: 'atrasada',
      resumo: `DCTFWeb ${rotuloCompet} nao transmitida (prazo: dia 15 venceu)`,
      competenciaAlvo,
    };
  }
  return {
    status: 'pendente',
    resumo: `DCTFWeb ${rotuloCompet} ainda nao transmitida (vence dia 15)`,
    competenciaAlvo,
  };
}

/**
 * Agregador: conta quantos clientes estao em cada status de DCTFWeb.
 * Alimenta o card destaque da home. Retorna objeto { em_dia, atrasada, pendente, sem_dados, erro }.
 */
function resumoDctfwebCarteira() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT so.status, COUNT(DISTINCT so.cliente_id) as total
    FROM snapshot_obrigacoes so
    INNER JOIN clientes c ON c.id = so.cliente_id
    WHERE so.obrigacao = 'DCTFWEB' AND c.ativo = 1
    GROUP BY so.status
  `).all();
  const base = { em_dia: 0, atrasada: 0, pendente: 0, sem_dados: 0, erro: 0 };
  for (const r of rows) {
    if (base[r.status] !== undefined) base[r.status] = r.total;
  }
  return base;
}

/**
 * Lista os clientes atrasados na DCTFWeb (pra drill-down no card).
 */
function listarClientesDctfwebAtrasados() {
  const db = getDb();
  return db.prepare(`
    SELECT so.cliente_id, c.razao_social, c.cnpj, so.competencia, so.resumo, so.atualizado_em
    FROM snapshot_obrigacoes so
    INNER JOIN clientes c ON c.id = so.cliente_id
    WHERE so.obrigacao = 'DCTFWEB' AND so.status = 'atrasada' AND c.ativo = 1
    ORDER BY c.razao_social
  `).all();
}

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



/**
 * Diagnostico agregado dos snapshots — util pra ver distribuicao de status
 * por obrigacao, identificar falhas sistemicas (ex: procuracao faltando).
 */
function diagnosticoSnapshot() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT so.obrigacao, so.status, COUNT(*) as total,
           COUNT(DISTINCT so.cliente_id) as clientes,
           MAX(so.atualizado_em) as ultima
    FROM snapshot_obrigacoes so
    INNER JOIN clientes c ON c.id = so.cliente_id
    WHERE c.ativo = 1
    GROUP BY so.obrigacao, so.status
    ORDER BY so.obrigacao, so.status
  `).all();

  // Amostra de erros unicos (pra diagnostico)
  const erros = db.prepare(`
    SELECT erro, COUNT(*) as total
    FROM snapshot_obrigacoes so
    INNER JOIN clientes c ON c.id = so.cliente_id
    WHERE so.status = 'erro' AND c.ativo = 1 AND so.erro IS NOT NULL
    GROUP BY erro
    ORDER BY total DESC
    LIMIT 10
  `).all();

  // Estrutura por obrigacao
  const porObrigacao = {};
  for (const r of rows) {
    if (!porObrigacao[r.obrigacao]) porObrigacao[r.obrigacao] = { total_rows: 0, status: {}, ultima: null };
    porObrigacao[r.obrigacao].status[r.status] = { total: r.total, clientes: r.clientes };
    porObrigacao[r.obrigacao].total_rows += r.total;
    if (!porObrigacao[r.obrigacao].ultima || r.ultima > porObrigacao[r.obrigacao].ultima) {
      porObrigacao[r.obrigacao].ultima = r.ultima;
    }
  }

  return { por_obrigacao: porObrigacao, erros_top: erros };
}

module.exports = {
  rodarSnapshotCompleto,
  iniciarCron,
  lerSnapshot,
  lerSnapshotsTodos,
  resumoDctfwebCarteira,
  listarClientesDctfwebAtrasados,
  diagnosticoSnapshot,
};
