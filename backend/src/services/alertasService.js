// =====================================================
// Alertas Proativos — gera e envia resumo diário pro grupo Staff.
// Lê snapshot_obrigacoes (populado pelo serproSnapshotService) e
// agrupa pendências por tipo. Envia via Z-API pro ANA_STAFF_GROUP_IDS.
// =====================================================

const { getDb } = require('../database/init');
const zapiService = require('./zapiService');

// Pendências que viram alerta (status != 'ok' && != 'sem_dados')
const STATUS_PENDENTE = ['pendente', 'atrasada', 'erro'];

function _formatarCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) return cnpj || '';
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
}

function gerarResumoAlertas() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT so.cliente_id, c.razao_social, c.cnpj, so.obrigacao, so.status, so.resumo, so.competencia, so.atualizado_em
    FROM snapshot_obrigacoes so
    JOIN clientes c ON c.id = so.cliente_id
    WHERE c.ativo = 1
      AND so.status IN ('pendente', 'atrasada', 'erro')
    ORDER BY so.obrigacao, c.razao_social
  `).all();

  const gruposPorTipo = {};
  for (const r of rows) {
    if (!gruposPorTipo[r.obrigacao]) gruposPorTipo[r.obrigacao] = [];
    gruposPorTipo[r.obrigacao].push(r);
  }

  const secoes = [];
  const rotulos = {
    CAIXA_POSTAL: '📮 Caixa postal com mensagens novas',
    PROCURACAO:   '⏰ Procurações com problema',
    PGDASD:       '📋 PGDAS-D pendente',
    DCTFWEB:      '📄 DCTFWeb pendente',
    SITFIS:       '🚨 Situação fiscal com pendências',
  };

  for (const tipo of Object.keys(rotulos)) {
    const itens = gruposPorTipo[tipo];
    if (!itens || itens.length === 0) continue;
    const linhas = itens.slice(0, 30).map(r => {
      const cnpj = _formatarCnpj(r.cnpj);
      const extra = r.resumo ? ` — ${r.resumo.substring(0, 80)}` : '';
      return `• ${r.razao_social} (${cnpj})${extra}`;
    });
    if (itens.length > 30) linhas.push(`  …e mais ${itens.length - 30} clientes`);
    secoes.push(`${rotulos[tipo]}\n${linhas.join('\n')}`);
  }

  const totalClientesUnicos = new Set(rows.map(r => r.cliente_id)).size;
  const totalItens = rows.length;

  const hoje = new Date().toLocaleDateString('pt-BR');
  const cabecalho = totalItens === 0
    ? `✅ *Sem alertas hoje (${hoje})*\n\nTodas as obrigações monitoradas estão OK ou sem dados.`
    : `🔔 *Alertas do dia — ${hoje}*\n\n${totalItens} pendência(s) em ${totalClientesUnicos} cliente(s). Detalhes abaixo:`;

  return {
    totalItens,
    totalClientesUnicos,
    texto: [cabecalho, ...secoes].join('\n\n'),
    temAlerta: totalItens > 0,
  };
}

async function enviarAlertasDiarios({ forcar = false } = {}) {
  const destinos = (process.env.ANA_STAFF_GROUP_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (destinos.length === 0) {
    console.log('[Alertas] ANA_STAFF_GROUP_IDS não configurado — não envio.');
    return { enviado: false, motivo: 'sem destino' };
  }

  const resumo = gerarResumoAlertas();
  if (!resumo.temAlerta && !forcar) {
    console.log('[Alertas] Sem pendências hoje — não envio (use forcar=true pra mandar mesmo assim).');
    return { enviado: false, motivo: 'sem alertas', totalItens: 0 };
  }

  // Envia pro primeiro grupo staff configurado
  const destino = destinos[0];
  try {
    await zapiService.enviarTexto(destino, resumo.texto);
    console.log(`[Alertas] Enviado pro grupo staff ${destino}: ${resumo.totalItens} itens, ${resumo.totalClientesUnicos} clientes`);
    return { enviado: true, destino, totalItens: resumo.totalItens, totalClientes: resumo.totalClientesUnicos };
  } catch (err) {
    console.error('[Alertas] Falha ao enviar:', err.message);
    return { enviado: false, motivo: err.message };
  }
}

module.exports = { gerarResumoAlertas, enviarAlertasDiarios };
