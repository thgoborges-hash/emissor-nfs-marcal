// =====================================================
// Dashboard Gerencial de Entregas Mensais
// Agregacoes e matriz cliente x tipo de entrega
// Merge com snapshot SERPRO (DCTFWEB + PGDASD automaticos)
// % considera so fontes confiaveis (SERPRO + marcacao manual)
// =====================================================

const { getDb } = require('../database/init');

const TIPOS_ENTREGA = {
  DCTFWEB:   { nome: 'DCTFWeb',     regimes: ['presumido', 'real', 'simples'], dia_vencimento: 15, serpro: true },
  PGDASD:    { nome: 'PGDAS-D',     regimes: ['simples'],                       dia_vencimento: 20, serpro: true },
  DAS:       { nome: 'DAS',         regimes: ['simples', 'mei'],                dia_vencimento: 20 },
  DCTF:      { nome: 'DCTF',        regimes: ['presumido', 'real'],             dia_vencimento: 15 },
  BALANCETE: { nome: 'Balancete',   regimes: ['presumido', 'real'],             dia_vencimento: 30 },
  FOLHA:     { nome: 'Folha',       regimes: ['presumido', 'real', 'simples'], dia_vencimento: 5 },
  ESOCIAL:   { nome: 'eSocial',     regimes: ['presumido', 'real', 'simples'], dia_vencimento: 7 },
  EFDREINF:  { nome: 'EFD-Reinf',   regimes: ['presumido', 'real'],             dia_vencimento: 15 },
};

const ORDEM_TIPOS = ['PGDASD', 'DAS', 'DCTFWEB', 'DCTF', 'FOLHA', 'ESOCIAL', 'EFDREINF', 'BALANCETE'];

const MAP_SNAPSHOT_PARA_TIPO = {
  DCTFWEB: 'DCTFWEB',
  PGDASD: 'PGDASD',
};

const MAP_STATUS = {
  em_dia: 'ok',
  ok: 'ok',
  atrasada: 'atrasado',
  atrasado: 'atrasado',
  pendente: 'pendente',
  // Quando SERPRO responde 'sem_dados', significa que o cliente NAO e obrigado
  // aquela obrigacao — marcamos como nao_aplicavel pra nao poluir com falsos alertas.
  sem_dados: 'nao_aplicavel',
};

// Consideramos "ativa" (entra na conta do %) quando a fonte e confiavel:
// 'serpro' = snapshot retornou dado real
// 'manual' = equipe marcou a mao
// 'mock' = seed inicial, NAO conta (seria falso atraso).
function _isFonteAtiva(fonte) {
  return fonte === 'serpro' || fonte === 'manual';
}

class EntregasService {
  dashboard(competencia) {
    const db = getDb();
    const comp = competencia || this._competenciaAtual();

    this._seedMockSeNecessario(comp);
    const mergeInfo = this._mergeSnapshotSerpro(comp);

    // Pega entregas + junta resumo do snapshot (pra tooltip rico)
    const entregas = db.prepare(`
      SELECT e.*, c.razao_social as cliente_nome, c.cnpj as cliente_cnpj,
             so.resumo as snapshot_resumo,
             so.competencia as snapshot_competencia
      FROM entregas_mensais e
      INNER JOIN clientes c ON e.cliente_id = c.id
      LEFT JOIN snapshot_obrigacoes so
             ON so.cliente_id = e.cliente_id
            AND so.obrigacao = e.tipo_entrega
            AND (so.status IN ('em_dia','ok','atrasada','pendente'))
      WHERE e.competencia = ? AND c.ativo = 1
      ORDER BY c.razao_social
    `).all(comp);

    const total = entregas.length;
    const aplicaveis = entregas.filter(e => e.status !== 'nao_aplicavel');
    const ativas = aplicaveis.filter(e => _isFonteAtiva(e.fonte));
    const concluidas = ativas.filter(e => e.status === 'ok').length;
    const atrasadas = ativas.filter(e => e.status === 'atrasado').length;
    const pendentes = ativas.filter(e => e.status === 'pendente').length;
    const pctCompleto = ativas.length > 0 ? concluidas / ativas.length : 0;

    const clientesMap = {};
    entregas.forEach(e => {
      if (!clientesMap[e.cliente_id]) {
        clientesMap[e.cliente_id] = {
          id: e.cliente_id, nome: e.cliente_nome, cnpj: e.cliente_cnpj,
          entregas: {}, ok: 0, pendentes: 0, atrasadas: 0,
          total_aplicavel: 0, total_ativas: 0,
        };
      }
      const c = clientesMap[e.cliente_id];
      c.entregas[e.tipo_entrega] = {
        status: e.status,
        data_entrega: e.data_entrega,
        responsavel: e.responsavel_nome,
        fonte: e.fonte || 'mock',
        resumo: e.snapshot_resumo || null,
        competencia_obrigacao: e.snapshot_competencia || null,
      };
      if (e.status !== 'nao_aplicavel') {
        c.total_aplicavel++;
        if (_isFonteAtiva(e.fonte)) {
          c.total_ativas++;
          if (e.status === 'ok') c.ok++;
          if (e.status === 'pendente') c.pendentes++;
          if (e.status === 'atrasado') c.atrasadas++;
        }
      }
    });

    const clientes = Object.values(clientesMap).map(c => ({
      ...c,
      // pct considera so as obrigacoes ATIVAS (SERPRO ou manual)
      // Se o cliente ainda nao tem nada ativo, pct=null (nao ordena pra cima nem pra baixo)
      pct: c.total_ativas > 0 ? c.ok / c.total_ativas : null,
    }));
    // Ordenacao: primeiro com atrasos, depois pct crescente, nulls no fim
    clientes.sort((a, b) => {
      if (a.atrasadas !== b.atrasadas) return b.atrasadas - a.atrasadas;
      if (a.pct === null && b.pct === null) return 0;
      if (a.pct === null) return 1;
      if (b.pct === null) return -1;
      return a.pct - b.pct;
    });

    const clientesOk = clientes.filter(c => c.pct === 1).length;
    const clientesComAtraso = clientes.filter(c => c.atrasadas > 0).length;

    const porTipo = ORDEM_TIPOS.map(tipo => {
      const deste = ativas.filter(e => e.tipo_entrega === tipo);
      const ok = deste.filter(e => e.status === 'ok').length;
      const pend = deste.filter(e => e.status === 'pendente').length;
      const atr = deste.filter(e => e.status === 'atrasado').length;
      return {
        tipo, nome: TIPOS_ENTREGA[tipo]?.nome || tipo,
        total: deste.length, ok, pend, atr,
        pct: deste.length > 0 ? ok / deste.length : 0,
        automatica: !!TIPOS_ENTREGA[tipo]?.serpro,
      };
    }).filter(t => t.total > 0);

    const porResp = {};
    entregas.filter(e => e.status === 'ok' && e.responsavel_nome && _isFonteAtiva(e.fonte)).forEach(e => {
      porResp[e.responsavel_nome] = (porResp[e.responsavel_nome] || 0) + 1;
    });
    const ranking = Object.entries(porResp)
      .map(([nome, qtd]) => ({ nome, qtd }))
      .sort((a, b) => b.qtd - a.qtd);

    const tendencia = this._tendencia6Meses(comp);

    return {
      competencia: comp,
      gerado_em: new Date().toISOString(),
      kpis: {
        pct_completo: pctCompleto,
        total_entregas: total,
        aplicaveis: aplicaveis.length,
        ativas: ativas.length,  // novo: quantas estao sendo acompanhadas de fato
        concluidas, pendentes, atrasadas,
        clientes_total: clientes.length,
        clientes_ok: clientesOk,
        clientes_com_atraso: clientesComAtraso,
      },
      por_tipo: porTipo,
      ordem_tipos: ORDEM_TIPOS,
      nomes_tipos: Object.fromEntries(Object.entries(TIPOS_ENTREGA).map(([k, v]) => [k, v.nome])),
      serpro_tipos: Object.entries(TIPOS_ENTREGA).filter(([_, v]) => v.serpro).map(([k]) => k),
      tendencia,
      ranking_responsaveis: ranking,
      clientes,
      serpro: mergeInfo,
    };
  }

  atualizarStatus({ clienteId, competencia, tipoEntrega, status, responsavelId, responsavelNome, observacao }) {
    const db = getDb();
    const existe = db.prepare('SELECT id FROM entregas_mensais WHERE cliente_id = ? AND competencia = ? AND tipo_entrega = ?').get(clienteId, competencia, tipoEntrega);
    const dataEntrega = status === 'ok' ? new Date().toISOString().slice(0, 10) : null;

    if (existe) {
      db.prepare(`
        UPDATE entregas_mensais
        SET status = ?, data_entrega = ?, responsavel_id = ?, responsavel_nome = ?, observacao = ?, fonte = 'manual', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, dataEntrega, responsavelId || null, responsavelNome || null, observacao || null, existe.id);
      return existe.id;
    } else {
      const r = db.prepare(`
        INSERT INTO entregas_mensais (cliente_id, competencia, tipo_entrega, status, data_entrega, responsavel_id, responsavel_nome, observacao, fonte)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')
      `).run(clienteId, competencia, tipoEntrega, status, dataEntrega, responsavelId || null, responsavelNome || null, observacao || null);
      return r.lastInsertRowid;
    }
  }

  _mergeSnapshotSerpro(competencia) {
    const db = getDb();
    const snaps = db.prepare(`
      SELECT so.cliente_id, so.obrigacao, so.status, so.resumo, so.atualizado_em
      FROM snapshot_obrigacoes so
      INNER JOIN clientes c ON c.id = so.cliente_id
      WHERE so.obrigacao IN ('DCTFWEB', 'PGDASD')
        AND c.ativo = 1
        AND datetime(so.atualizado_em) >= datetime('now', '-7 days')
    `).all();

    let atualizadas = 0;
    const clientesComDados = new Set();
    const porTipo = { DCTFWEB: 0, PGDASD: 0 };

    // Nao filtramos por status atual — SERPRO e fonte de verdade, sobrescreve qualquer mock.
    const updateStmt = db.prepare(`
      UPDATE entregas_mensais
      SET status = ?, fonte = 'serpro', updated_at = CURRENT_TIMESTAMP
      WHERE cliente_id = ? AND competencia = ? AND tipo_entrega = ?
    `);

    const tx = db.transaction(() => {
      for (const s of snaps) {
        const tipo = MAP_SNAPSHOT_PARA_TIPO[s.obrigacao];
        const novoStatus = MAP_STATUS[s.status];
        if (!tipo || !novoStatus) continue;
        const r = updateStmt.run(novoStatus, s.cliente_id, competencia, tipo);
        if (r.changes > 0) {
          atualizadas++;
          clientesComDados.add(s.cliente_id);
          porTipo[s.obrigacao] = (porTipo[s.obrigacao] || 0) + 1;
        }
      }
    });
    tx();

    const resumoRow = db.prepare(`
      SELECT MAX(atualizado_em) as ultima, COUNT(DISTINCT cliente_id) as clientes
      FROM snapshot_obrigacoes
      WHERE datetime(atualizado_em) >= datetime('now', '-30 days')
    `).get();

    return {
      ultima_varredura: resumoRow?.ultima || null,
      clientes_com_snapshot: resumoRow?.clientes || 0,
      merged_agora: atualizadas,
      por_tipo: porTipo,
    };
  }

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
          SUM(CASE WHEN status = 'ok' AND (fonte = 'serpro' OR fonte = 'manual') THEN 1 ELSE 0 END) as ok,
          SUM(CASE WHEN status != 'nao_aplicavel' AND (fonte = 'serpro' OR fonte = 'manual') THEN 1 ELSE 0 END) as ativas
        FROM entregas_mensais WHERE competencia = ?
      `).get(c);
      const at = row?.ativas || 0;
      return {
        competencia: c,
        pct: at > 0 ? (row.ok || 0) / at : 0,
      };
    });
  }

  _seedMockSeNecessario(competencia) {
    const db = getDb();
    const existem = db.prepare('SELECT COUNT(*) as c FROM entregas_mensais WHERE competencia = ?').get(competencia).c;
    if (existem > 0) return;

    const clientes = db.prepare('SELECT id, razao_social FROM clientes WHERE ativo = 1 LIMIT 200').all();
    if (clientes.length === 0) return;

    const responsaveis = ['Janaina Alves', 'Lucas Cruz', 'Fernanda Souza', 'Rodrigo Marcal'];

    const hash = (s) => {
      let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
      return Math.abs(h);
    };

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO entregas_mensais
      (cliente_id, competencia, tipo_entrega, status, data_vencimento, data_entrega, responsavel_nome, fonte, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'mock', CURRENT_TIMESTAMP)
    `);

    const hoje = new Date();
    const [anoComp, mesComp] = competencia.split('-').map(Number);
    const dataVencBase = (dia) => `${competencia}-${String(dia).padStart(2, '0')}`;

    const tx = db.transaction(() => {
      for (const cliente of clientes) {
        const regimeHash = hash(`regime-${cliente.id}`) % 100;
        let regime;
        if (regimeHash < 45) regime = 'simples';
        else if (regimeHash < 70) regime = 'presumido';
        else if (regimeHash < 85) regime = 'mei';
        else regime = 'real';

        for (const [tipo, meta] of Object.entries(TIPOS_ENTREGA)) {
          const aplicavel = meta.regimes.includes(regime);
          if (!aplicavel) {
            stmt.run(cliente.id, competencia, tipo, 'nao_aplicavel', null, null, null);
            continue;
          }
          const seed = hash(`${cliente.id}-${competencia}-${tipo}`) % 100;
          let status, dataEntrega = null, responsavel = null;
          const venc = new Date(anoComp, mesComp - 1, meta.dia_vencimento);
          const jaVenceu = venc < hoje;

          if (seed < 70) {
            status = 'ok';
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
  }
}

module.exports = new EntregasService();
module.exports.TIPOS_ENTREGA = TIPOS_ENTREGA;
module.exports.ORDEM_TIPOS = ORDEM_TIPOS;
