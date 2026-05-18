/**
 * PGDAS-D Auto-Fill (v2) — preenche automaticamente anexo, RBT12 e receita
 * do mês usando 3 fontes:
 *
 *   1. Anexo:        cadastro do cliente (codigo_servico/cTribNac) → tabela LC 116
 *   2. RBT12:        SERPRO consultarDeclaracoesPorAno + somar 12 PAs anteriores
 *   3. Receita PA:   SERPRO consultarExtratoDAS (NFS-e Nacional + SPED) + Emissor
 *                    notas_fiscais EM PARALELO → reconciliação
 *
 * Política dos campos:
 *   - Tudo é "best effort" — se falhar, devolve null e o caller (calcularDraft)
 *     trata como manual
 *   - Cache de 24h pra evitar bater no SERPRO repetidamente (TTL configurável)
 *   - Sempre devolve um objeto `detalhes` com os passos e fontes consultadas,
 *     que é persistido em pgdasd_fechamentos.detalhes_calculo pra auditoria
 */

const { getDb } = require('../database/init');
const integraContadorService = require('./integraContadorService');
const pgdasdFechamento = require('./pgdasdFechamentoService');  // pra coletarReceitaMes

// ── Mapeamento cTribNac → Anexo Simples Nacional ────────────────────────────
// Baseado na LC 116/2003 + LC 155/2016. cTribNac tem 6 dígitos no formato iissdd.
// Mapeamento simplificado por subitem da Lista de Serviços (iiss):
//   01.xx → Anexo V (tecnologia, intelectual sem Fator R por default; muitos
//                    casos viram Anexo III via Fator R — caller decide)
//   02.xx → Anexo V (pesquisa, desenvolvimento)
//   04.xx → Anexo III (serviços de saúde, fisioterapia, etc)
//   07.xx → Anexo IV (construção civil)
//   08.xx → Anexo III (educação, ensino)
//   09.xx → Anexo III (hospedagem, turismo)
//   10.xx → Anexo III (agenciamento, corretagem)
//   11.xx → Anexo III (guarda, estacionamento, vigilância)
//   12.xx → Anexo III (recreação, lazer, eventos)
//   13.xx → Anexo III (fonografia, artes gráficas, jornalismo, fotografia)
//   14.xx → Anexo III (manutenção, conservação, reparação)
//   15.xx → Anexo III (serviços financeiros — atípicos no Simples)
//   16.xx → Anexo III (transporte municipal)
//   17.xx → Anexo III (serviços de apoio gerais — limpeza, vigilância)
//   17.05/17.06 → Anexo III (limpeza, vigilância, terceirização folha — Fator R sempre)
//   18.xx → Anexo III (serviços jurídicos auxiliares)
//   19.xx → Anexo III (serviços de armazenamento)
//   20.xx → Anexo III (transporte aéreo, etc)
//   21.xx → Anexo IV (advocacia)
//   22.xx → Anexo IV (serviços técnicos engenharia, arquitetura)
//   23.xx → Anexo IV (auditoria, consultoria, contabilidade)
//   24.xx → Anexo III (serviços de saúde — odontologia, medicina)
//   25.xx → Anexo IV (perícia técnica)
//   26-40 → Anexo III (genérico — outros)
//
// COMÉRCIO/VENDA usa Anexo I — não tem cTribNac (cTribNac é só pra serviços).
// Se cliente vende produtos (anexo I), o flag tem que vir do cadastro
// (regime_tributario + uma indicação explícita).
const ANEXO_POR_SUBITEM = {
  // Anexo IV (advocacia, construção civil, perícia técnica, eng/arq, audit)
  '07': 'IV', '21': 'IV', '22': 'IV', '23': 'IV', '25': 'IV',
  // Anexo V (tecnologia, intelectual sem Fator R por default)
  '01': 'V', '02': 'V',
  // Restante: Anexo III (maioria dos serviços)
  // (default cai aqui se não bater nenhum acima)
};

/**
 * Mapeia cTribNac → anexo Simples Nacional.
 *
 * @param {string} cTribNac - 6 dígitos formato iissdd (ex: '130201')
 * @param {Object} [opcoes]
 * @param {boolean} [opcoes.aplicarFatorR=false] - Se true e subitem é Anexo V mas
 *   relação FS12/RBT12 >= 28%, vira Anexo III. Aqui apenas anotamos a possibilidade.
 * @returns {{anexo: string|null, observacao: string|null}}
 */
function anexoPorCtribNac(cTribNac, opcoes = {}) {
  if (!cTribNac || !/^\d{6}$/.test(String(cTribNac))) {
    return { anexo: null, observacao: 'cTribNac inválido ou ausente' };
  }
  const subitem = String(cTribNac).slice(0, 2);  // dois primeiros dígitos
  const anexo = ANEXO_POR_SUBITEM[subitem] || 'III';

  let obs = null;
  if (anexo === 'V') {
    obs = 'Anexo V por default. Se relação FS12/RBT12 ≥ 28% (Fator R), reclassificar pra Anexo III.';
  } else if (anexo === 'IV') {
    obs = 'Anexo IV — NÃO aplica Fator R; INSS recolhido em DAS separado.';
  }
  return { anexo, observacao: obs };
}

// ── Cache local de chamadas SERPRO (TTL 24h por default) ─────────────────────

const CACHE_TTL_MS = parseInt(process.env.PGDASD_AUTOFILL_CACHE_TTL_MS, 10) || (24 * 60 * 60 * 1000);
const cacheMem = new Map();  // key → { valor, expira_em }

function _cacheGet(key) {
  const item = cacheMem.get(key);
  if (!item) return undefined;
  if (Date.now() > item.expira_em) { cacheMem.delete(key); return undefined; }
  return item.valor;
}
function _cacheSet(key, valor) {
  cacheMem.set(key, { valor, expira_em: Date.now() + CACHE_TTL_MS });
}

// ── Buscar RBT12 via SERPRO ─────────────────────────────────────────────────

/**
 * Calcula RBT12 do PA alvo somando RPA das 12 declarações imediatamente anteriores.
 *
 * Algoritmo:
 *   1. Identifica os 12 meses anteriores ao PA alvo (range)
 *   2. Busca declarações nesses anos via consultarDeclaracoesPorAno (1 ou 2 anos)
 *   3. Pra cada PA na janela 12m, soma RPA (mercado interno + externo)
 *   4. Cache 24h por (cnpj, PA)
 *
 * @param {string} cnpj - 14 dígitos
 * @param {string} periodoApuracao - YYYYMM do PA alvo
 * @returns {Promise<{rbt12: number|null, origem: string, detalhes: Object}>}
 */
async function buscarRBT12(cnpj, periodoApuracao) {
  const detalhes = { fonte: 'serpro', passos: [], avisos: [] };
  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  if (cnpjLimpo.length !== 14) return { rbt12: null, origem: 'erro', detalhes: { erro: 'CNPJ inválido' } };
  if (!/^\d{6}$/.test(periodoApuracao)) return { rbt12: null, origem: 'erro', detalhes: { erro: 'PA inválido' } };

  const cacheKey = `rbt12:${cnpjLimpo}:${periodoApuracao}`;
  const cached = _cacheGet(cacheKey);
  if (cached) {
    return { ...cached, detalhes: { ...cached.detalhes, cache_hit: true } };
  }

  // Identifica janela 12m anteriores
  const ano = parseInt(periodoApuracao.slice(0, 4), 10);
  const mes = parseInt(periodoApuracao.slice(4, 6), 10);
  const janela = [];
  let mAtual = mes - 1, aAtual = ano;
  if (mAtual === 0) { mAtual = 12; aAtual -= 1; }
  for (let i = 0; i < 12; i++) {
    janela.push(`${aAtual}${String(mAtual).padStart(2, '0')}`);
    mAtual -= 1;
    if (mAtual === 0) { mAtual = 12; aAtual -= 1; }
  }
  detalhes.janela_12m = janela;

  // Determina quais anos buscar (até 2)
  const anosUnicos = [...new Set(janela.map(pa => pa.slice(0, 4)))];
  detalhes.passos.push(`Buscando declarações dos anos: ${anosUnicos.join(', ')}`);

  // Busca declarações por ano
  const declaracoesPorPa = new Map();
  for (const a of anosUnicos) {
    try {
      const resp = await integraContadorService.consultarDeclaracoesPorAno(cnpjLimpo, a);
      const lista = _extrairListaDeclaracoes(resp);
      detalhes.passos.push(`Ano ${a}: ${lista.length} declaração(ões) encontrada(s)`);
      for (const d of lista) {
        if (d.pa) declaracoesPorPa.set(String(d.pa), d);
      }
    } catch (err) {
      detalhes.avisos.push(`Ano ${a}: falhou (${err.message.slice(0, 100)})`);
    }
  }

  // Soma RPA das declarações na janela 12m
  let rbt12 = 0;
  let mesesComDeclaracao = 0;
  for (const pa of janela) {
    const d = declaracoesPorPa.get(pa);
    if (d && typeof d.rpa === 'number') {
      rbt12 += d.rpa;
      mesesComDeclaracao += 1;
    }
  }

  detalhes.passos.push(`Soma de RPA dos 12 meses anteriores: R$ ${rbt12.toFixed(2)} (${mesesComDeclaracao}/12 meses com declaração)`);

  if (mesesComDeclaracao === 0) {
    detalhes.avisos.push('Nenhuma declaração encontrada na janela 12m — cliente novo ou sem histórico SERPRO. RBT12 default = 0 (empresa começou agora).');
    const ret = { rbt12: 0, origem: 'serpro_sem_historico', detalhes };
    _cacheSet(cacheKey, ret);
    return ret;
  }

  if (mesesComDeclaracao < 12) {
    detalhes.avisos.push(`Atenção: só ${mesesComDeclaracao}/12 meses tinham declaração. RBT12 pode estar subestimado se cliente teve atividade nos meses sem declaração.`);
  }

  const ret = { rbt12: Math.round(rbt12 * 100) / 100, origem: 'serpro', detalhes };
  _cacheSet(cacheKey, ret);
  return ret;
}

/**
 * Extrai lista normalizada de declarações do retorno do SERPRO.
 * Formato SERPRO varia — tentamos campos comuns.
 *
 * Retorna array de { pa, numeroDeclaracao, rpa, tipoOperacao }
 */
function _extrairListaDeclaracoes(resposta) {
  if (!resposta) return [];
  // Resposta SERPRO típica: { dados: '...', status: ..., mensagem: [...] }
  // Onde `dados` é string JSON contendo `listaDeclaracoes` ou similar.
  let dados = resposta.dados;
  if (typeof dados === 'string') {
    try { dados = JSON.parse(dados); } catch { return []; }
  }
  if (!dados) return [];

  // Tenta múltiplos shapes — SERPRO docs variam por serviço
  const lista = dados.declaracoes || dados.listaDeclaracoes || dados.itens || [];
  if (!Array.isArray(lista)) return [];

  return lista.map(d => ({
    pa: String(d.pa || d.periodoApuracao || ''),
    numeroDeclaracao: d.numeroDeclaracao || d.numero || d.recibo || null,
    rpa: _parseValor(d.rpa || d.receitaPaCompetenciaTotal || d.receitaTotal || d.valorTotal),
    tipoOperacao: d.tipoOperacao || d.tipo || null,
  })).filter(d => d.pa);
}

function _parseValor(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const limpo = v.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(limpo);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Buscar receita do PA (2 fontes em paralelo) ─────────────────────────────

/**
 * Busca receita do PA via SERPRO (extrato DAS / NFS-e Nacional cruzada).
 * Best effort — se SERPRO não retornar dado utilizável, devolve null.
 *
 * @param {string} cnpj
 * @param {string} periodoApuracao
 * @returns {Promise<{receita: number|null, origem: string, detalhes: Object}>}
 */
async function buscarReceitaSerpro(cnpj, periodoApuracao) {
  const detalhes = { fonte: 'serpro', passos: [], avisos: [] };
  const cacheKey = `recserpro:${cnpj}:${periodoApuracao}`;
  const cached = _cacheGet(cacheKey);
  if (cached) {
    return { ...cached, detalhes: { ...cached.detalhes, cache_hit: true } };
  }

  // Estratégia: consultar última declaração entregue no PA. Se já foi declarado,
  // retorna RPA dela. Se NÃO foi declarado ainda (caso típico do fechamento),
  // tentamos consultar declarações do ano e ver se tem registro do PA.
  try {
    const resp = await integraContadorService.consultarUltimaDeclaracaoPGDASD(cnpj, periodoApuracao);
    detalhes.passos.push(`consultarUltimaDeclaracaoPGDASD(${periodoApuracao}) retornou`);
    let dados = resp?.dados;
    if (typeof dados === 'string') {
      try { dados = JSON.parse(dados); } catch { dados = null; }
    }
    if (dados) {
      const rpa = _parseValor(dados.rpa || dados.receitaPaCompetenciaTotal || dados.receitaTotal);
      if (rpa != null && rpa > 0) {
        detalhes.passos.push(`RPA extraído da declaração: R$ ${rpa.toFixed(2)}`);
        detalhes.avisos.push('Receita lida da declaração JÁ TRANSMITIDA. Se você está retransmitindo, este valor pode ser o que foi declarado antes.');
        const ret = { receita: rpa, origem: 'serpro_declaracao_existente', detalhes };
        _cacheSet(cacheKey, ret);
        return ret;
      }
    }
    detalhes.avisos.push('Declaração ainda não transmitida pra este PA — SERPRO não tem receita pré-apurada via Integra Contador atualmente.');
  } catch (err) {
    detalhes.avisos.push(`consultarUltimaDeclaracaoPGDASD falhou: ${err.message.slice(0, 120)}`);
  }

  // Fallback: NFS-e Nacional API direta não está disponível no Integra Contador
  // pra leitura de receita. v3 vai integrar diretamente com sefin.nfse.gov.br.
  const ret = { receita: null, origem: 'serpro_indisponivel', detalhes };
  _cacheSet(cacheKey, ret);
  return ret;
}

/**
 * Busca receita do PA pelo Emissor (tabela notas_fiscais).
 * Sempre disponível e síncrono.
 */
function buscarReceitaEmissor(clienteId, periodoApuracao) {
  const resultado = pgdasdFechamento.coletarReceitaMes(clienteId, periodoApuracao);
  return {
    receita: resultado.receita_bruta,
    origem: 'emissor',
    detalhes: {
      fonte: 'emissor',
      total_nfs: resultado.total_nfs,
      passos: [`SQL: SUM(valor_servico) FROM notas_fiscais WHERE cliente_id=${clienteId} AND status='emitida' AND data_competencia IN ${periodoApuracao}`],
    },
  };
}

/**
 * Reconciliação 2 fontes — chama SERPRO e Emissor em paralelo, compara.
 *
 * Política:
 *   - SERPRO disponível + Emissor disponível + valores batem → escolha = 'serpro', divergencia=0
 *   - SERPRO disponível + Emissor disponível + valores diferem → divergencia=1, escolha=null (caller resolve UI)
 *   - SERPRO indisponível → escolha = 'emissor' com aviso
 *   - Ambos null → null (calcular vai falhar e equipe digita manual)
 */
async function reconciliarReceita(cnpj, clienteId, periodoApuracao) {
  const [serproRes, emissorRes] = await Promise.allSettled([
    buscarReceitaSerpro(cnpj, periodoApuracao),
    Promise.resolve(buscarReceitaEmissor(clienteId, periodoApuracao)),
  ]);

  const serpro = serproRes.status === 'fulfilled' ? serproRes.value : { receita: null, origem: 'erro', detalhes: { erro: String(serproRes.reason) } };
  const emissor = emissorRes.status === 'fulfilled' ? emissorRes.value : { receita: null, origem: 'erro', detalhes: { erro: String(emissorRes.reason) } };

  const result = {
    serpro,
    emissor,
    divergencia: false,
    diferenca_centavos: 0,
    escolha_sugerida: null,
    aviso: null,
  };

  if (serpro.receita != null && emissor.receita != null) {
    const dif = Math.round((serpro.receita - emissor.receita) * 100);  // centavos
    result.diferenca_centavos = dif;
    if (Math.abs(dif) >= 1) {
      result.divergencia = true;
      result.escolha_sugerida = null;  // caller decide
      result.aviso = `⚠ Divergência de R$ ${(Math.abs(dif) / 100).toFixed(2)} entre SERPRO (R$ ${serpro.receita.toFixed(2)}) e Emissor (R$ ${emissor.receita.toFixed(2)}). Verifique se cliente emitiu fora do portal Marçal.`;
    } else {
      result.escolha_sugerida = 'serpro';  // ambos batem → SERPRO é canônico
    }
  } else if (serpro.receita != null) {
    result.escolha_sugerida = 'serpro';
    result.aviso = 'Emissor não tem registro de NFs no mês — receita usada vem só do SERPRO.';
  } else if (emissor.receita != null) {
    result.escolha_sugerida = 'emissor';
    result.aviso = 'SERPRO indisponível — usando receita do Emissor (notas_fiscais locais). Confira antes de transmitir.';
  } else {
    result.aviso = 'Nenhuma das duas fontes retornou receita. Equipe precisa informar manualmente.';
  }

  return result;
}

module.exports = {
  anexoPorCtribNac,
  buscarRBT12,
  buscarReceitaSerpro,
  buscarReceitaEmissor,
  reconciliarReceita,
  // exports privados pra teste
  _extrairListaDeclaracoes,
  _parseValor,
  ANEXO_POR_SUBITEM,
};
