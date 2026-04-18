// =====================================================
// Dashboard Gerencial de Entregas Mensais
// Agregações e matriz cliente × tipo de entrega
// =====================================================

const { getDb } = require('../database/init');

// Tipos de entrega e sua relevância por regime
const TIPOS_ENTREGA = {
  DCTFWEB:   { nome: 'DCTFWeb',     regimes: ['presumido', 'real', 'simples'], dia_vencimento: 15 },
  PGDASD:    { nome: 'PGDAS-D',     regimes: ['simples'],                       dia_vencimento: 20 },
  DAS:       { nome: 'DAS',         regimes: ['simples', 'mei'],                dia_vencimento: 20 },
  DCTF:      { nome: 'DCTF',        regimes: ['presumido', 'real'],             dia_vencimento: 15 },
  BALANCETE: { nome: 'Balancete',   regimes: ['presumido', 'real'],             dia_vencimento: 30 },
  FOLHA:     { nome: 'Folha',       regimes: ['presumido', 'real', 'simples'], dia_vencimento: 5 },
  ESOCIAL:   { nome: 'eSocial',     regimes: ['presumido', 'real', 'simples'], dia_vencimento: 7 },
  EFDREINF:  { nome: 'EFD-Reinf',   regimes: ['presumido', 'real'],             dia_vencimento: 15 },
};

// Ordem canônica pra exibição nas colunas da matriz
const ORDEM_TIPOS = ['PGDASD', 'DAS', 'DCTFWEB', 'DCTF', 'FOLHA', 'ESOCIAL', 'EFDREINF', 'BALANCETE'];

class EntregasService {
  /**
   * Retorna dashboard consolidado do mês: KPIs, barras por tipo, tendência,
   * matriz cliente×entrega, ranking por responsável
   */
  dashboard(competencia) {
    const db = getDb();
    const comp = competencia || this._competenciaAtual();

    // Se ainda não tem dados desse mês, gera mock pra demonstração
    this._seedMockSeNecessario(comp);

    const entregas = db.prepare(`
      SELECT e.*, c.razao_social as cliente_nome, c.cnpj as cliente_cnpj
      FROM entregas_mensais e
      INNER JOIN clientes c ON e.cliente_id = c.id
      WHERE e.competencia = ? AND c.ativo = 1
      ORDER BY c.razao_social
    `).all(comp);

    // KPIs
    const total = entregas.length;
    const aplicaveis = entregas.filter(e => e.status !== 'nao_aplicavel');
    const concluidas = aplicaveis.filter(e => e.status === 'ok').length;
    const atrasadas = aplicaveis.filter(e => e.status === 'atrasado').length;
    const pendentes = aplicaveis.filter(e => e.status === 'pendente').length;
    const pctCompleto = aplicaveis.length > 0 ? concluidas / aplicaveis.length : 0;

    // Clientes 100% completos
    const clientesMap = {};
    entregas.forEach(e => {
      if (!clientesMap[e.cliente_id]) {
        clientesMap[e.cliente_id] = {
          id: e.cliente_id, nome: e.cliente_nome, cnpj: e.cliente_cnpj,
          entregas: {}, ok: 0, pendentes: 0, atrasadas: 0, total_aplicavel: 0,
        };
      }
      const c = clientesMap[e.cliente_id];
      c.entregas[e.tipo_entrega] = { status: e.status, data_entrega: e.data_entrega, responsavel: e.responsavel_nome };
      if (e.status !== 'nao_aplicavel') {
        c.total_aplicavel++;
        if (e.status === 'ok') c.ok++;
        if (e.status === 'pendente') c.pendentes++;
        if (e.status === 'atrasado') c.atrasadas++;
      }
    });
    const clientes = Object.values(clientesMap).map(c => ({
      ...c,
      pct: c.total_aplicavel > 0 ? c.ok / c.total_aplicavel : 1,
    }));
    clientes.sort((a, b) => a.pct - b.pct); // menor % primeiro (prioridade)
    const clientesOk = clientes.filter(c => c.pct === 1).length;
    const clientesComAtraso = clientes.filter(c => c.atrasadas > 0).length;

    // Stats por tipo de entrega
    const porTipo = ORDEM_TIPOS.map(tipo => {
      const deste = aplicaveis.filter(e => e.tipo_entrega === tipo);
      const ok = deste.filter(e => e.status === 'ok').length;
      const pend = deste.filter(e => e.status === 'pendente').length;
      const atr = deste.filter(e => e.status === 'atrasado').length;
      return {
        tipo, nome: TIPOS_ENTREGA[tipo]?.nome || tipo,
        total: deste.length, ok, pend, atr,
        pct: deste.length > 0 ? ok / deste.length : 0,
      };
    }).filter(t => t.total > 0);

    // Ranking de responsáveis (quem fechou mais entregas este mês)
    const porResp = {};
    entregas.filter(e => e.status === 'ok' && e.responsavel_nome).forEach(e => {
      porResp[e.responsavel_nome] = (porResp[e.responsavel_nome] || 0) + 1;
    });
    const ranking = Object.entries(porResp)
      .map(([nome, qtd]) => ({ nome, qtd }))
      .sort((a, b) => b.qtd - a.qtd);

    // Tendência dos últimos 6 meses (% concluído mensal)
    const tendencia = this._tendencia6Meses(comp);

    return {
      competencia: comp,
      gerado_em: new Date().toISOString(),
      kpis: {
        pct_completo: pctCompleto,
        total_entregas: total,
        aplicaveis: aplicaveis.length,
        concluidas, pendentes, atrasadas,
        clientes_total: clientes.length,
        clientes_ok: clientesOk,
        clientes_com_atraso: clientesComAtraso,
      },
      por_tipo: porTipo,
      ordem_tipos: ORDEM_TIPOS,
      nomes_tipos: Object.fromEntries(Object.entries(TIPOS_ENTREGA).map(([k, v]) => [k, v.nome])),
      tendencia,
      ranking_responsaveis: ranking,
      clientes, // já ordenados por prioridade (menor % primeiro)
    };
  }

  /**
   * Marca uma entrega como concluída / reabre / atualiza status
   */
  atualizarStatus({ clienteId, competencia, tipoEntrega, status, responsavelId, responsavelNome, observacao }) {
    const db = getDb();
    const existe = db.prepare('SELECT id FROM entregas_mensais WHERE cliente_id = ? AND competencia = ? AND tipo_entrega = ?').get(clienteId, competencia, tipoEntrega);
    const dataEntrega = status === 'ok' ? new Date().toISOString().slice(0, 10) : null;

    if (existe) {
      db.prepare(`
        UPDATE entregas_mensais
        SET status = ?, data_entrega = ?, responsavel_id = ?, responsavel_nome = ?, observacao = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, dataEntrega, responsavelId || null, responsavelNome || null, observacao || null, existe.id);
      return existe.id;
    } else {
      const r = db.prepare(`
        INSERT INTO entregas_mensais (cliente_id, competencia, tipo_entrega, status, data_entrega, responsavel_id, responsavel_nome, observacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clienteId, competencia, tipoEntrega, status, dataEntrega, responsavelId || null, responsavelNome || null, observacao || null);
      return r.lastInsertRowid;
    }
  }

  // -------------------------------------------------
  // Internos
  // -------------------------------------------------

  _competenciaAtual() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  _tendencia6Meses(competenciaAtual) {
    const db = getDb();
    const [ano, mes] = competenciaAtual.split('-').map(Number);
    const comps = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(ano, mes - 1 - i, 1);
      comps.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return comps.map(c => {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok,
          SUM(CASE WHEN status != 'nao_aplicavel' THEN 1 ELSE 0 END) as aplicaveis
        FROM entregas_mensais WHERE competencia = ?
      `).get(c);
      const aplic = row?.aplicaveis || 0;
      return {
        competencia: c,
        pct: aplic > 0 ? (row.ok || 0) / aplic : 0,
      };
    });
  }

  /**
   * Gera mock data realístico se a competência ainda não tiver entregas cadastradas.
   * Isso permite o dashboard funcionar visualmente antes das integrações reais.
   */
  _seedMockSeNecessario(competencia) {
    const db = getDb();
    const existem = db.prepare('SELECT COUNT(*) as c FROM entregas_mensais WHERE competencia = ?').get(competencia).c;
    if (existem > 0) return;

    const clientes = db.prepare('SELECT id, razao_social FROM clientes WHERE ativo = 1 LIMIT 200').all();
    if (clientes.length === 0) return;

    const responsaveis = ['Janaina Alves', 'Lucas Cruz', 'Fernanda Souza', 'Rodrigo Marçal'];

    // Deterministic pseudo-random pra garantir consistência entre reloads
    const hash = (s) => {
      let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
      return Math.abs(h);
    };

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO entregas_mensais
      (cliente_id, competencia, tipo_entrega, status, data_vencimento, data_entrega, responsavel_nome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const hoje = new Date();
    const [anoComp, mesComp] = competencia.split('-').map(Number);
    const dataVencBase = (dia) => `${competencia}-${String(dia).padStart(2, '0')}`;

    const tx = db.transaction(() => {
      for (const cliente of clientes) {
        // Regime "mockado" baseado no id do cliente (determinístico)
        const regimeHash = hash(`regime-${cliente.id}`) % 100;
        let regime;
        if (regimeHash < 45) regime = 'simples';
        else if (regimeHash < 70) regime = 'presumido';
        else if (regimeHash < 85) regime = 'mei';
        else regime = 'real';

        for (const [tipo, meta] of Object.entries(TIPOS_ENTREGA)) {
          // Define se o tipo é aplicável ao regime
          const aplicavel = meta.regimes.includes(regime);
          if (!aplicavel) {
            stmt.run(cliente.id, competencia, tipo, 'nao_aplicavel', null, null, null);
            continue;
          }

          // Distribuição realística do status (seed-based)
          const seed = hash(`${cliente.id}-${competencia}-${tipo}`) % 100;
          let status, dataEntrega = null, responsavel = null;
          const venc = new Date(anoComp, mesComp - 1, meta.dia_vencimento);
          const jaVenceu = venc < hoje;

          if (seed < 70) {
            status = 'ok';
            // Data de entrega: entre venc-5 e venc+1
            const offset = (seed % 7) - 5;
            const d = new Date(venc); d.setDate(d.getDate() + offset);
            dataEntrega = d.toISOString().slice(0, 10);
            responsavel = responsaveis[seed % responsaveis.length];
          } else if (seed < 85) {
            status = jaVenceu ? 'atrasado' : 'pendente';
          } else if (seed < 95) {
            status = 'pendente';
          } else {
            status = jaVenceu ? 'atrasado' : 'pendente';
          }

          stmt.run(cliente.id, competencia, tipo, status, dataVencBase(meta.dia_vencimento), dataEntrega, responsavel);
        }
      }
    });
    tx();

    console.log(`[Entregas] Mock seed criado pra ${competencia}: ${clientes.length} clientes × ${Object.keys(TIPOS_ENTREGA).length} tipos`);
  }
}

module.exports = new EntregasService();
module.exports.TIPOS_ENTREGA = TIPOS_ENTREGA;
module.exports.ORDEM_TIPOS = ORDEM_TIPOS;
