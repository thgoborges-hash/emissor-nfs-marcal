/**
 * Fechamento mensal Simples Nacional (PGDAS-D)
 *
 * Coordena o fechamento de um cliente do Simples Nacional em 4 etapas:
 *   1. Calcular: lê receita do Emissor (notas_fiscais), busca RBA12M via SERPRO
 *      (ou usa cache local), calcula DAS via fórmula da LC 123/2006.
 *   2. Revisar: status='draft' ou 'pending_approval'. Operador confere
 *      pelo painel antes de transmitir. Ações irreversíveis exigem aprovação.
 *   3. Transmitir: chama SERPRO TRANSDECLARACAO11. Marca 'transmitted' com
 *      recibo. Gera DAS pagamento (GERARDAS12).
 *   4. Lançar contábil: enfileira job 'gerar_obrigacao' (sub_tipo='apuracao_simples')
 *      pro daemon João lançar no Domínio Web.
 *
 * Política Domínio-é-pra-contábil: receita bruta NÃO vem do Domínio porque
 * fechamento acontece na 1ª semana do mês — Domínio ainda não tem os
 * lançamentos. Fonte é a tabela `notas_fiscais` do Emissor (status='emitida'
 * + data_competencia no mês).
 *
 * Fora de escopo nesta versão:
 *   - Receitas com substituição tributária ICMS-ST (PIS/COFINS retidos)
 *   - Atividade concomitante (múltiplos anexos no mesmo PA)
 *   - Fator R completo (folha de salários nos últimos 12m)
 *   - Retificação (TRANSDECLARACAO11 com tipoDeclaracao=2)
 *   - Receita externa (exportação)
 *
 * Esses casos ficam pra v2 — hoje skill responde "fora de escopo" e
 * transfere pra equipe.
 */

const { getDb } = require('../database/init');

// ── Anexos do Simples Nacional (LC 123/2006 atualizada pela LC 155/2016) ─────
// Faixas (RBA12M) → alíquota nominal e parcela a deduzir.
// Tabelas oficiais Anexo I (Comércio), III (Serviços Limpeza/Vigilância/Folha),
// IV (Serviços Técnicos/Advocacia/Construção), V (Serviços Tecnológicos).
//
// IMPORTANTE: Anexo II (Indústria) omitido — Marçal não atende indústrias hoje.
//             Anexo III "Fator R" (Serviços Profissionais) cruza com Anexo V
//             dependendo do %folha — calculado em _decidirAnexoIIIvsV.

const FAIXAS = {
  I: [  // Comércio
    { teto: 180_000.00,   aliquota: 0.040,  deducao: 0 },
    { teto: 360_000.00,   aliquota: 0.073,  deducao: 5_940 },
    { teto: 720_000.00,   aliquota: 0.095,  deducao: 13_860 },
    { teto: 1_800_000.00, aliquota: 0.107,  deducao: 22_500 },
    { teto: 3_600_000.00, aliquota: 0.143,  deducao: 87_300 },
    { teto: 4_800_000.00, aliquota: 0.19,   deducao: 378_000 },
  ],
  III: [  // Serviços (limpeza, vigilância, terceirização folha + Fator R)
    { teto: 180_000.00,   aliquota: 0.060,  deducao: 0 },
    { teto: 360_000.00,   aliquota: 0.112,  deducao: 9_360 },
    { teto: 720_000.00,   aliquota: 0.135,  deducao: 17_640 },
    { teto: 1_800_000.00, aliquota: 0.16,   deducao: 35_640 },
    { teto: 3_600_000.00, aliquota: 0.21,   deducao: 125_640 },
    { teto: 4_800_000.00, aliquota: 0.33,   deducao: 648_000 },
  ],
  IV: [  // Serviços (advocacia, construção civil, serviços técnicos)
    { teto: 180_000.00,   aliquota: 0.045,  deducao: 0 },
    { teto: 360_000.00,   aliquota: 0.09,   deducao: 8_100 },
    { teto: 720_000.00,   aliquota: 0.102,  deducao: 12_420 },
    { teto: 1_800_000.00, aliquota: 0.14,   deducao: 39_780 },
    { teto: 3_600_000.00, aliquota: 0.22,   deducao: 183_780 },
    { teto: 4_800_000.00, aliquota: 0.33,   deducao: 828_000 },
  ],
  V: [  // Serviços (tecnologia, intelectual, sem Fator R)
    { teto: 180_000.00,   aliquota: 0.155,  deducao: 0 },
    { teto: 360_000.00,   aliquota: 0.18,   deducao: 4_500 },
    { teto: 720_000.00,   aliquota: 0.195,  deducao: 9_900 },
    { teto: 1_800_000.00, aliquota: 0.205,  deducao: 17_100 },
    { teto: 3_600_000.00, aliquota: 0.23,   deducao: 62_100 },
    { teto: 4_800_000.00, aliquota: 0.305,  deducao: 540_000 },
  ],
};

const TETO_SIMPLES = 4_800_000.00;

// ── Cálculo do DAS ───────────────────────────────────────────────────────────

/**
 * Calcula alíquota efetiva e valor DAS conforme LC 123/2006.
 *
 *   Aliq. efetiva = ((RBA12M × aliq_nominal) − parcela_a_deduzir) ÷ RBA12M
 *   DAS = receita_pa × aliq_efetiva
 *
 * @param {Object} params
 * @param {string} params.anexo - 'I' | 'III' | 'IV' | 'V'
 * @param {number} params.rba12m - Receita bruta acumulada 12 meses anteriores
 * @param {number} params.receitaPa - Receita do período de apuração
 * @returns {{ aliquota_nominal, parcela_deduzir, aliquota_efetiva, valor_das, faixa, acima_teto }}
 */
function calcularDAS({ anexo, rba12m, receitaPa }) {
  if (!FAIXAS[anexo]) {
    throw new Error(`Anexo inválido: "${anexo}". Aceitos: ${Object.keys(FAIXAS).join(', ')}`);
  }
  if (rba12m == null || rba12m < 0) throw new Error('rba12m obrigatório (>= 0)');
  if (receitaPa == null || receitaPa < 0) throw new Error('receitaPa obrigatório (>= 0)');

  // Acima do teto = excluído do Simples (precisa decisão humana)
  if (rba12m > TETO_SIMPLES) {
    return {
      acima_teto: true,
      aliquota_nominal: null,
      parcela_deduzir: null,
      aliquota_efetiva: null,
      valor_das: null,
      faixa: 7,
      observacao: `RBA12M R$ ${rba12m.toFixed(2)} > teto Simples (R$ ${TETO_SIMPLES.toFixed(2)}). Cliente excluído — requer decisão humana.`,
    };
  }

  const faixas = FAIXAS[anexo];
  let faixaIdx = faixas.length - 1;
  for (let i = 0; i < faixas.length; i++) {
    if (rba12m <= faixas[i].teto) { faixaIdx = i; break; }
  }
  const f = faixas[faixaIdx];

  // Quando rba12m == 0 (empresa começou agora), usa só alíquota nominal sobre receitaPa
  let aliqEfetiva;
  if (rba12m === 0) {
    aliqEfetiva = f.aliquota;  // empresa nova — efetiva == nominal
  } else {
    aliqEfetiva = ((rba12m * f.aliquota) - f.deducao) / rba12m;
    if (aliqEfetiva < 0) aliqEfetiva = 0;  // proteção numérica
  }
  const valorDas = receitaPa * aliqEfetiva;

  return {
    acima_teto: false,
    aliquota_nominal: f.aliquota,
    parcela_deduzir: f.deducao,
    aliquota_efetiva: Math.round(aliqEfetiva * 10000) / 10000,  // 4 casas
    valor_das: Math.round(valorDas * 100) / 100,
    faixa: faixaIdx + 1,
  };
}

// ── Coleta receita do mês do Emissor (notas_fiscais) ─────────────────────────

/**
 * Soma valor_servico das NFs emitidas no período (status='emitida').
 *
 * @param {number} clienteId
 * @param {string} periodoApuracao - YYYYMM
 * @returns {{ receita_bruta: number, total_nfs: number, iss_retido_total: number, nfs: Array }}
 */
function coletarReceitaMes(clienteId, periodoApuracao) {
  if (!/^\d{6}$/.test(String(periodoApuracao))) {
    throw new Error(`periodoApuracao inválido (esperado YYYYMM): ${periodoApuracao}`);
  }
  const ano = periodoApuracao.slice(0, 4);
  const mes = periodoApuracao.slice(4, 6);
  const inicio = `${ano}-${mes}-01`;
  // Último dia do mês — SQLite calcula com date('end of month')
  const fim = `${ano}-${mes}-31`;

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, numero_nfse, numero_dps, valor_servico, valor_iss,
           data_competencia, status, descricao_servico
    FROM notas_fiscais
    WHERE cliente_id = ?
      AND status = 'emitida'
      AND date(data_competencia) >= date(?)
      AND date(data_competencia) <= date(?)
    ORDER BY data_competencia ASC
  `).all(clienteId, inicio, fim);

  const receita = rows.reduce((s, r) => s + (Number(r.valor_servico) || 0), 0);
  // NOTA: ISS retido na fonte = situação onde o tomador retém o ISS pelo prestador.
  // Hoje o Emissor não diferencia isso na tabela. Assumimos 0 até v2.
  // Pra cliente que tem ISS retido, equipe deve revisar o draft antes de transmitir.
  return {
    receita_bruta: Math.round(receita * 100) / 100,
    total_nfs: rows.length,
    iss_retido_total: 0,  // placeholder — ver nota acima
    nfs: rows,
  };
}

// ── Estado / persistência ────────────────────────────────────────────────────

function _hidratar(row) {
  if (!row) return null;
  return {
    ...row,
    payload_serpro: _safeParse(row.payload_serpro, null),
    resposta_serpro: _safeParse(row.resposta_serpro, null),
    detalhes_calculo: _safeParse(row.detalhes_calculo, null),
    divergencia_receita: row.divergencia_receita === 1,
  };
}

function _safeParse(s, fallback = null) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Cria/atualiza um fechamento em status 'draft' com cálculo do DAS.
 *
 * Modos:
 *   - v1 (manual): caller passa cliente_id + periodo + anexo + rba12m. Receita
 *     do mês vem só do Emissor. Mantido pra compatibilidade.
 *   - v2 (auto-fill): caller passa só cliente_id + periodo_apuracao. Auto-fill
 *     resolve anexo (cTribNac), RBT12 (SERPRO histórico), receita (SERPRO +
 *     Emissor com reconciliação). Overrides opcionais via campos manuais.
 *
 * @param {Object} params
 * @param {number} params.cliente_id
 * @param {string} params.periodo_apuracao - YYYYMM
 * @param {string} [params.anexo] - 'I' | 'III' | 'IV' | 'V'. Se omitido, auto via cTribNac.
 * @param {number} [params.rba12m] - se omitido, auto via SERPRO histórico
 * @param {number} [params.receita_override] - força usar este valor (ignora reconciliação)
 * @param {string} [params.fonte_receita_override] - 'serpro' | 'emissor' (escolhe ao invés de auto-decidir)
 * @param {string} [params.criado_por]
 * @param {string} [params.origem='painel']
 * @param {boolean} [params.autoFill=true] - desabilita auto-fill (modo v1)
 * @returns {Promise<Object>} fechamento criado (com cálculo + reconciliação)
 */
async function calcularDraft(params = {}) {
  const {
    cliente_id, periodo_apuracao,
    anexo: anexoInput, rba12m: rba12mInput,
    receita_override, fonte_receita_override,
    criado_por, origem = 'painel',
    autoFill = true,
  } = params;

  if (!cliente_id) throw new Error('cliente_id obrigatório');
  if (!periodo_apuracao) throw new Error('periodo_apuracao obrigatório');
  if (!/^\d{6}$/.test(String(periodo_apuracao))) {
    throw new Error(`periodo_apuracao deve ser YYYYMM (recebido: "${periodo_apuracao}")`);
  }

  // Busca cliente
  const db = getDb();
  const cliente = db.prepare(`
    SELECT id, razao_social, cnpj, codigo_servico, regime_tributario, optante_simples
    FROM clientes WHERE id = ?
  `).get(cliente_id);
  if (!cliente) throw new Error(`Cliente ${cliente_id} não encontrado`);

  const detalhes = { v2: autoFill, passos: [], avisos: [], origens: {} };

  // ── 1. Resolver ANEXO ────────────────────────────────────────────────
  let anexo = anexoInput;
  let anexoOrigem = 'manual';
  if (!anexo && autoFill) {
    const autoFillSvc = require('./pgdasdAutoFillService');
    const r = autoFillSvc.anexoPorCtribNac(cliente.codigo_servico);
    if (r.anexo) {
      anexo = r.anexo;
      anexoOrigem = 'cadastro';
      detalhes.passos.push(`Anexo = ${anexo} (auto via cTribNac=${cliente.codigo_servico})`);
      if (r.observacao) detalhes.avisos.push(r.observacao);
    }
  }
  if (!anexo) throw new Error('Anexo não informado e não foi possível inferir do cadastro (cTribNac ausente/inválido)');
  detalhes.origens.anexo = anexoOrigem;

  // ── 2. Resolver RECEITA do mês ───────────────────────────────────────
  let receitaPa, receitaSerpro = null, receitaEmissor = null, fonteReceita, divergencia = 0;
  if (receita_override != null) {
    receitaPa = Number(receita_override);
    fonteReceita = 'manual';
    detalhes.passos.push(`Receita = R$ ${receitaPa.toFixed(2)} (override manual)`);
  } else if (autoFill) {
    const autoFillSvc = require('./pgdasdAutoFillService');
    const recon = await autoFillSvc.reconciliarReceita(cliente.cnpj, cliente_id, periodo_apuracao);
    receitaSerpro = recon.serpro.receita;
    receitaEmissor = recon.emissor.receita;
    divergencia = recon.divergencia ? 1 : 0;
    fonteReceita = fonte_receita_override || recon.escolha_sugerida;
    if (fonteReceita === 'serpro') receitaPa = receitaSerpro;
    else if (fonteReceita === 'emissor') receitaPa = receitaEmissor;
    else receitaPa = receitaEmissor != null ? receitaEmissor : receitaSerpro;  // fallback
    detalhes.reconciliacao = {
      serpro: receitaSerpro,
      emissor: receitaEmissor,
      divergencia: recon.divergencia,
      diferenca: recon.diferenca_centavos,
      escolha: fonteReceita,
      aviso: recon.aviso,
    };
    if (recon.aviso) detalhes.avisos.push(recon.aviso);
    detalhes.passos.push(`Receita = R$ ${(receitaPa || 0).toFixed(2)} (fonte: ${fonteReceita || 'indefinida'})`);
  } else {
    // v1 puro — só Emissor
    const r = coletarReceitaMes(cliente_id, periodo_apuracao);
    receitaPa = r.receita_bruta;
    receitaEmissor = r.receita_bruta;
    fonteReceita = 'emissor';
  }
  if (receitaPa == null) throw new Error('Não foi possível determinar receita do mês — nenhuma fonte respondeu. Forneça receita_override.');
  detalhes.origens.receita = fonteReceita;

  // ── 3. Resolver RBT12 ────────────────────────────────────────────────
  let rba12m = rba12mInput;
  let rbt12Origem = 'manual';
  if (rba12m == null && autoFill) {
    const autoFillSvc = require('./pgdasdAutoFillService');
    try {
      const r = await autoFillSvc.buscarRBT12(cliente.cnpj, periodo_apuracao);
      if (r.rbt12 != null) {
        rba12m = r.rbt12;
        rbt12Origem = r.origem;
        detalhes.passos.push(`RBT12 = R$ ${rba12m.toFixed(2)} (auto via ${r.origem})`);
        if (r.detalhes?.avisos) detalhes.avisos.push(...r.detalhes.avisos);
      }
    } catch (err) {
      detalhes.avisos.push(`Falha buscando RBT12: ${err.message}`);
    }
  }
  if (rba12m == null) throw new Error('RBT12 não informado e não foi possível buscar via SERPRO. Forneça rba12m manualmente.');
  detalhes.origens.rbt12 = rbt12Origem;

  // ── 4. Calcular DAS ──────────────────────────────────────────────────
  const calculo = calcularDAS({ anexo, rba12m, receitaPa });
  detalhes.calculo = calculo;

  // Receita por ISS retido (placeholder — v2 não calcula ainda)
  const issRetidoTotal = 0;
  const totalNfs = receitaEmissor != null
    ? coletarReceitaMes(cliente_id, periodo_apuracao).total_nfs
    : 0;

  // ── 5. Persistir ─────────────────────────────────────────────────────
  const existente = db.prepare(`
    SELECT id FROM pgdasd_fechamentos
    WHERE cliente_id = ? AND periodo_apuracao = ?
  `).get(cliente_id, periodo_apuracao);

  if (existente) {
    const atual = db.prepare(`SELECT status FROM pgdasd_fechamentos WHERE id = ?`).get(existente.id);
    if (!['draft', 'pending_approval', 'failed'].includes(atual.status)) {
      throw new Error(`Fechamento já em status "${atual.status}" — não pode ser recalculado`);
    }
    db.prepare(`
      UPDATE pgdasd_fechamentos
      SET receita_bruta_mes = ?, total_nfs = ?, iss_retido_total = ?,
          rba12m = ?, anexo = ?, aliquota_nominal = ?, parcela_deduzir = ?,
          aliquota_efetiva = ?, valor_das = ?, status = 'draft',
          receita_serpro = ?, receita_emissor = ?,
          fonte_receita_escolhida = ?, divergencia_receita = ?,
          anexo_origem = ?, rbt12_origem = ?, detalhes_calculo = ?,
          erro = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      receitaPa, totalNfs, issRetidoTotal,
      rba12m, anexo, calculo.aliquota_nominal, calculo.parcela_deduzir,
      calculo.aliquota_efetiva, calculo.valor_das,
      receitaSerpro, receitaEmissor,
      fonteReceita || 'manual', divergencia,
      anexoOrigem, rbt12Origem, JSON.stringify(detalhes),
      existente.id,
    );
    return obter(existente.id);
  }

  const r = db.prepare(`
    INSERT INTO pgdasd_fechamentos (
      cliente_id, periodo_apuracao, status,
      receita_bruta_mes, total_nfs, iss_retido_total,
      rba12m, anexo, aliquota_nominal, parcela_deduzir,
      aliquota_efetiva, valor_das,
      receita_serpro, receita_emissor,
      fonte_receita_escolhida, divergencia_receita,
      anexo_origem, rbt12_origem, detalhes_calculo,
      criado_por, origem
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cliente_id, periodo_apuracao,
    receitaPa, totalNfs, issRetidoTotal,
    rba12m, anexo, calculo.aliquota_nominal, calculo.parcela_deduzir,
    calculo.aliquota_efetiva, calculo.valor_das,
    receitaSerpro, receitaEmissor,
    fonteReceita || 'manual', divergencia,
    anexoOrigem, rbt12Origem, JSON.stringify(detalhes),
    criado_por || 'sistema', origem,
  );
  return obter(r.lastInsertRowid);
}

/**
 * Marca fechamento como aprovado pra transmissão.
 */
function aprovar(id, aprovadoPor) {
  const db = getDb();
  const atual = db.prepare(`SELECT status FROM pgdasd_fechamentos WHERE id = ?`).get(id);
  if (!atual) throw new Error(`Fechamento ${id} não encontrado`);
  if (!['draft', 'pending_approval'].includes(atual.status)) {
    throw new Error(`Fechamento ${id} já em status "${atual.status}", não pode aprovar`);
  }
  db.prepare(`
    UPDATE pgdasd_fechamentos
    SET status = 'pending_approval',
        aprovado_por = ?, aprovado_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(aprovadoPor || 'desconhecido', id);
  return obter(id);
}

/**
 * Marca fechamento como transmitido (chamado depois de SERPRO retornar OK).
 */
function marcarTransmitido(id, { recibo, resposta }) {
  const db = getDb();
  db.prepare(`
    UPDATE pgdasd_fechamentos
    SET status = 'transmitted',
        recibo_serpro = ?, resposta_serpro = ?,
        transmitido_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(recibo || null, JSON.stringify(resposta || {}), id);
  return obter(id);
}

/**
 * Marca DAS gerado.
 */
function marcarDASGerado(id, { numero, pdf_path, vencimento }) {
  const db = getDb();
  db.prepare(`
    UPDATE pgdasd_fechamentos
    SET status = 'das_generated',
        das_numero = ?, das_pdf_path = ?, das_vencimento = ?,
        das_gerado_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(numero || null, pdf_path || null, vencimento || null, id);
  return obter(id);
}

function marcarFalha(id, erro) {
  const db = getDb();
  db.prepare(`
    UPDATE pgdasd_fechamentos
    SET status = 'failed', erro = ?, ultima_tentativa = CURRENT_TIMESTAMP,
        tentativas = tentativas + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(String(erro || 'erro não especificado').slice(0, 4000), id);
  return obter(id);
}

function cancelar(id, motivo, canceladoPor) {
  const db = getDb();
  const atual = db.prepare(`SELECT status FROM pgdasd_fechamentos WHERE id = ?`).get(id);
  if (!atual) throw new Error(`Fechamento ${id} não encontrado`);
  if (['transmitted', 'das_generated', 'done', 'cancelled'].includes(atual.status)) {
    throw new Error(`Fechamento ${id} já em "${atual.status}" — irreversível`);
  }
  db.prepare(`
    UPDATE pgdasd_fechamentos
    SET status = 'cancelled', motivo_cancelamento = ?, cancelado_em = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(`${canceladoPor || '?'}: ${motivo || 'sem motivo'}`, id);
  return obter(id);
}

function obter(id) {
  const db = getDb();
  const row = db.prepare(`
    SELECT f.*, c.razao_social, c.cnpj, c.regime_tributario, c.regime_simples_nacional
    FROM pgdasd_fechamentos f
    JOIN clientes c ON f.cliente_id = c.id
    WHERE f.id = ?
  `).get(id);
  return _hidratar(row);
}

function listar({ status, cliente_id, periodo_apuracao, limite = 50 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (status) {
    const arr = Array.isArray(status) ? status : [status];
    where.push(`f.status IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  }
  if (cliente_id) { where.push('f.cliente_id = ?'); params.push(cliente_id); }
  if (periodo_apuracao) { where.push('f.periodo_apuracao = ?'); params.push(periodo_apuracao); }
  const sql = `
    SELECT f.*, c.razao_social, c.cnpj
    FROM pgdasd_fechamentos f
    JOIN clientes c ON f.cliente_id = c.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY f.created_at DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, Math.max(1, Math.min(500, Number(limite) || 50)));
  return rows.map(_hidratar);
}

// ── Montagem do payload SERPRO ───────────────────────────────────────────────

/**
 * Constrói o objeto `declaracao` no formato esperado por TRANSDECLARACAO11.
 *
 * SCHEMA mínimo de produção (a docs SERPRO oficial detalha campos opcionais
 * adicionais — receita externa, atividades concomitantes, fator R, etc).
 *
 * Caso típico Marçal (anexo III, sem deduções, sem retenções, atividade única):
 *   {
 *     tipoDeclaracao: 1,                        // 1=original, 2=retificadora
 *     receitaPaCompetenciaInterno: 5950.00,     // receita BRUTA do PA, mercado interno
 *     receitaPaCompetenciaExterno: 0,           // exportação
 *     valorFixoIcms: 0,
 *     receitasBrutasAnteriores: [...]           // RBA12M individualizadas (opcional)
 *   }
 *
 * Pra clientes com casos especiais (ISS retido, ICMS-ST, múltiplas atividades),
 * usar v2 da skill ou cair pra revisão humana.
 */
function montarPayloadDeclaracao(fechamento) {
  if (!fechamento) throw new Error('fechamento obrigatório');
  return {
    tipoDeclaracao: 1,  // original (retificação fica fora de escopo v1)
    receitaPaCompetenciaInterno: fechamento.receita_bruta_mes,
    receitaPaCompetenciaExterno: 0,
    valorFixoIcms: 0,
  };
}

module.exports = {
  // Cálculo puro (testável standalone)
  calcularDAS,
  coletarReceitaMes,
  // CRUD do fechamento
  calcularDraft,
  aprovar,
  marcarTransmitido,
  marcarDASGerado,
  marcarFalha,
  cancelar,
  obter,
  listar,
  // Payload SERPRO
  montarPayloadDeclaracao,
  // Constantes (pra teste)
  FAIXAS,
  TETO_SIMPLES,
};
