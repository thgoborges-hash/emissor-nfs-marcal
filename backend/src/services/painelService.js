// =====================================================
// Serviço Painel Operacional
// Agrega métricas do dia + gerencia a fila de aprovação da ANA
// =====================================================

const { getDb } = require('../database/init');

class PainelService {
  /**
   * Agrega tudo que é relevante pra home "Operações Hoje"
   */
  resumoOperacoesHoje() {
    const db = getDb();
    const hojeInicio = new Date();
    hojeInicio.setHours(0, 0, 0, 0);
    const hojeInicioIso = hojeInicio.toISOString();

    // NFs pendentes de aprovação
    const nfsPendentes = db.prepare(`
      SELECT COUNT(*) as total, COALESCE(SUM(valor_servico), 0) as valor_total
      FROM notas_fiscais WHERE status = 'pendente_aprovacao'
    `).get();

    // NFs emitidas hoje
    const nfsHoje = db.prepare(`
      SELECT COUNT(*) as total, COALESCE(SUM(valor_servico), 0) as valor_total
      FROM notas_fiscais
      WHERE status = 'emitida' AND created_at >= ?
    `).get(hojeInicioIso);

    // Conversas WhatsApp aguardando humano
    const conversasAguardando = db.prepare(`
      SELECT COUNT(*) as total FROM whatsapp_conversas WHERE status = 'aguardando_humano'
    `).get();

    // Fila ANA pendente (ações sensíveis aguardando aprovação)
    const anaFilaPendente = db.prepare(`
      SELECT COUNT(*) as total FROM fila_aprovacao_ana WHERE status = 'pendente'
    `).get();

    // Decisões tomadas hoje (fila ANA)
    const anaFilaHoje = db.prepare(`
      SELECT status, COUNT(*) as total FROM fila_aprovacao_ana
      WHERE decidido_em >= ? GROUP BY status
    `).all(hojeInicioIso);

    // Últimas 5 NFs emitidas (feed de atividade)
    const ultimasNfs = db.prepare(`
      SELECT nf.id, nf.numero_nfse, nf.numero_dps, nf.valor_servico, nf.created_at,
             c.razao_social as cliente_nome
      FROM notas_fiscais nf
      LEFT JOIN clientes c ON nf.cliente_id = c.id
      WHERE nf.status = 'emitida'
      ORDER BY nf.created_at DESC LIMIT 5
    `).all();

    // Obrigações no próximo período (calendário fiscal padrão — sem depender de Integra Contador)
    const obrigacoes = this._calcularObrigacoesProximas();

    return {
      geradoEm: new Date().toISOString(),
      cards: {
        nfs_aprovacao: { total: nfsPendentes.total, valor_total: nfsPendentes.valor_total },
        nfs_hoje: { total: nfsHoje.total, valor_total: nfsHoje.valor_total },
        whatsapp_aguardando: conversasAguardando.total,
        ana_fila_pendente: anaFilaPendente.total,
      },
      ana_decisoes_hoje: anaFilaHoje,
      ultimas_nfs: ultimasNfs,
      obrigacoes_proximas: obrigacoes,
    };
  }

  /**
   * Calcula obrigações mensais padrão com base no calendário fiscal
   * (fonte: prazos legais vigentes). Integra Contador vai enriquecer isso depois.
   */
  _calcularObrigacoesProximas() {
    const hoje = new Date();
    const ano = hoje.getFullYear();
    const mes = hoje.getMonth(); // 0-indexed
    const dia = hoje.getDate();

    const obrigacoes = [
      { nome: 'DAS (Simples Nacional)', dia: 20, cor: '#f39c12', regime: 'Simples' },
      { nome: 'DAS (MEI)', dia: 20, cor: '#3498db', regime: 'MEI' },
      { nome: 'DCTFWeb', dia: 15, cor: '#9b59b6', regime: 'Geral' },
      { nome: 'PGDAS-D', dia: 20, cor: '#1abc9c', regime: 'Simples' },
      { nome: 'ICMS (GIA-SP/DIME-SC/etc)', dia: 10, cor: '#e74c3c', regime: 'Geral' },
      { nome: 'Folha + FGTS', dia: 7, cor: '#2ecc71', regime: 'Geral' },
    ];

    // Retorna obrigações dos próximos 7 dias (deste mês ou do próximo se já passou)
    return obrigacoes.map(o => {
      let dataVenc = new Date(ano, mes, o.dia);
      // Se já passou do dia de venc. este mês, pula pro próximo
      if (dataVenc < hoje) {
        dataVenc = new Date(ano, mes + 1, o.dia);
      }
      const diasPra = Math.ceil((dataVenc - hoje) / (1000 * 60 * 60 * 24));
      return {
        ...o,
        data_vencimento: dataVenc.toISOString().slice(0, 10),
        dias_para_vencimento: diasPra,
        urgente: diasPra <= 3,
      };
    }).sort((a, b) => a.dias_para_vencimento - b.dias_para_vencimento)
      .slice(0, 4); // top 4 mais próximas
  }

  // -------------------------------------------------
  // Fila de aprovação da ANA
  // -------------------------------------------------

  criarPendencia({ tipoAcao, clienteId, descricao, payload, origem = 'ana', origemOperador = null }) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO fila_aprovacao_ana (tipo_acao, cliente_id, descricao, payload_json, origem, origem_operador)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    const result = stmt.run(tipoAcao, clienteId || null, descricao, payloadStr, origem, origemOperador);
    return this.buscarPendencia(result.lastInsertRowid);
  }

  buscarPendencia(id) {
    const db = getDb();
    return db.prepare(`
      SELECT f.*, c.razao_social as cliente_nome,
             u.nome as decidido_por_nome
      FROM fila_aprovacao_ana f
      LEFT JOIN clientes c ON f.cliente_id = c.id
      LEFT JOIN usuarios_escritorio u ON f.decidido_por = u.id
      WHERE f.id = ?
    `).get(id);
  }

  listar({ status = 'pendente', limit = 50 } = {}) {
    const db = getDb();
    return db.prepare(`
      SELECT f.*, c.razao_social as cliente_nome, c.cnpj as cliente_cnpj,
             u.nome as decidido_por_nome
      FROM fila_aprovacao_ana f
      LEFT JOIN clientes c ON f.cliente_id = c.id
      LEFT JOIN usuarios_escritorio u ON f.decidido_por = u.id
      WHERE f.status = ?
      ORDER BY f.criado_em DESC LIMIT ?
    `).all(status, limit);
  }

  aprovar(id, usuarioId, observacao = null) {
    const db = getDb();
    const pendencia = this.buscarPendencia(id);
    if (!pendencia) throw new Error('Pendência não encontrada');
    if (pendencia.status !== 'pendente') {
      throw new Error(`Pendência já está ${pendencia.status}, não pode ser aprovada`);
    }
    db.prepare(`
      UPDATE fila_aprovacao_ana
      SET status = 'aprovado', decidido_por = ?, decidido_em = CURRENT_TIMESTAMP, motivo_decisao = ?
      WHERE id = ?
    `).run(usuarioId, observacao, id);
    return this.buscarPendencia(id);
  }

  rejeitar(id, usuarioId, motivo) {
    if (!motivo || !motivo.trim()) throw new Error('Motivo obrigatório pra rejeitar');
    const db = getDb();
    const pendencia = this.buscarPendencia(id);
    if (!pendencia) throw new Error('Pendência não encontrada');
    if (pendencia.status !== 'pendente') {
      throw new Error(`Pendência já está ${pendencia.status}`);
    }
    db.prepare(`
      UPDATE fila_aprovacao_ana
      SET status = 'rejeitado', decidido_por = ?, decidido_em = CURRENT_TIMESTAMP, motivo_decisao = ?
      WHERE id = ?
    `).run(usuarioId, motivo, id);
    return this.buscarPendencia(id);
  }

  marcarExecutado(id, resultado, sucesso = true) {
    const db = getDb();
    db.prepare(`
      UPDATE fila_aprovacao_ana
      SET status = ?, executado_em = CURRENT_TIMESTAMP, resultado_execucao = ?
      WHERE id = ?
    `).run(sucesso ? 'executado' : 'falhou', JSON.stringify(resultado || {}), id);
    return this.buscarPendencia(id);
  }
}

module.exports = new PainelService();
