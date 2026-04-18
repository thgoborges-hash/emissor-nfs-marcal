// =====================================================
// Serviço de Apuração Tributária Comparativa
// Calcula Simples / Presumido / Real / MEI pra mesma receita
// e mostra qual é o mais vantajoso.
// =====================================================
//
// NOTA: fórmulas simplificadas pra comparação. Casos reais podem ter
// nuances (substituição tributária, regime misto, créditos PIS/COFINS)
// que precisam de refinamento caso a caso.
// Valores válidos pra 2026 — revisar anualmente.

// ==============================
// SIMPLES NACIONAL — anexos
// ==============================
// [faixa_max_RBT12, aliquota_nominal, parcela_deduzir]
const ANEXO_I = [  // Comércio
  [180000, 0.040, 0],
  [360000, 0.073, 5940],
  [720000, 0.095, 13860],
  [1800000, 0.107, 22500],
  [3600000, 0.143, 87300],
  [4800000, 0.190, 378000],
];
const ANEXO_II = [  // Indústria
  [180000, 0.045, 0],
  [360000, 0.078, 5940],
  [720000, 0.100, 13860],
  [1800000, 0.112, 22500],
  [3600000, 0.147, 85500],
  [4800000, 0.300, 720000],
];
const ANEXO_III = [  // Serviços gerais (locações, hotelaria, comunicação, etc)
  [180000, 0.060, 0],
  [360000, 0.112, 9360],
  [720000, 0.135, 17640],
  [1800000, 0.160, 35640],
  [3600000, 0.210, 125640],
  [4800000, 0.330, 648000],
];
const ANEXO_IV = [  // Serviços de vigilância, limpeza, obras/construção
  [180000, 0.045, 0],
  [360000, 0.090, 8100],
  [720000, 0.102, 12420],
  [1800000, 0.140, 39780],
  [3600000, 0.220, 183780],
  [4800000, 0.330, 828000],
];
const ANEXO_V = [  // Serviços intelectuais (consultoria, TI quando não fator R)
  [180000, 0.155, 0],
  [360000, 0.180, 4500],
  [720000, 0.195, 9900],
  [1800000, 0.205, 17100],
  [3600000, 0.230, 62100],
  [4800000, 0.305, 540000],
];

const ANEXOS_POR_SETOR = {
  comercio: ANEXO_I,
  industria: ANEXO_II,
  servicos_gerais: ANEXO_III,
  servicos_construcao: ANEXO_IV,
  servicos_intelectuais: ANEXO_V,
};

const NOMES_ANEXO = {
  comercio: 'Anexo I (comércio)',
  industria: 'Anexo II (indústria)',
  servicos_gerais: 'Anexo III (serviços gerais)',
  servicos_construcao: 'Anexo IV (construção/vigilância)',
  servicos_intelectuais: 'Anexo V (serviços intelectuais)',
};

// ==============================
// Presunção Lucro Presumido (% da receita como base)
// ==============================
const PRESUNCAO_IRPJ = {
  comercio: 0.08,
  industria: 0.08,
  servicos_gerais: 0.32,
  servicos_construcao: 0.32,
  servicos_intelectuais: 0.32,
  transportes: 0.16,
};
const PRESUNCAO_CSLL = {
  comercio: 0.12,
  industria: 0.12,
  servicos_gerais: 0.32,
  servicos_construcao: 0.32,
  servicos_intelectuais: 0.32,
  transportes: 0.12,
};

// MEI — valores 2026 (baseados em salário mínimo R$ 1.518)
const DAS_MEI_2026 = {
  comercio: 72.60,          // 5% SM + R$ 1 ICMS
  industria: 72.60,
  servicos_gerais: 76.60,   // 5% SM + R$ 5 ISS
  servicos_construcao: 76.60,
  servicos_intelectuais: 76.60,
};
const LIMITE_MEI = 81000;

class ApuracaoService {
  /**
   * Simula os 4 regimes pro mesmo cenário de receita
   * @param {object} params
   * @param {number} params.receitaMes   — receita do mês a apurar
   * @param {number} [params.rbt12]      — receita bruta últimos 12 meses (default = 12x receitaMes)
   * @param {string} params.setor        — 'comercio' | 'industria' | 'servicos_gerais' | 'servicos_construcao' | 'servicos_intelectuais'
   * @param {number} [params.issMunicipal] — alíquota ISS (default 5%)
   * @param {number} [params.margemLucroReal] — margem estimada pra Lucro Real (default 15%)
   * @returns {object} comparativo
   */
  simular({ receitaMes, rbt12, setor = 'servicos_gerais', issMunicipal = 0.05, margemLucroReal = 0.15 }) {
    if (!receitaMes || receitaMes <= 0) {
      throw new Error('receitaMes obrigatória e > 0');
    }
    if (!ANEXOS_POR_SETOR[setor]) {
      throw new Error(`setor inválido. Válidos: ${Object.keys(ANEXOS_POR_SETOR).join(', ')}`);
    }
    const receitaAnualizada = rbt12 || (receitaMes * 12);

    const regimes = {
      mei: this._calcularMEI(receitaMes, receitaAnualizada, setor),
      simples: this._calcularSimples(receitaMes, receitaAnualizada, setor),
      presumido: this._calcularPresumido(receitaMes, receitaAnualizada, setor, issMunicipal),
      real: this._calcularReal(receitaMes, receitaAnualizada, setor, issMunicipal, margemLucroReal),
    };

    // Identifica o mais vantajoso (menor imposto total mensal, considerando só regimes elegíveis)
    const elegiveis = Object.entries(regimes).filter(([_, r]) => r.elegivel);
    const menor = elegiveis.reduce((min, cur) =>
      !min || cur[1].totalMes < min[1].totalMes ? cur : min, null);

    const melhor = menor ? menor[0] : null;

    // Calcula diferença vs outros
    if (melhor) {
      const totalMelhor = regimes[melhor].totalMes;
      for (const k in regimes) {
        regimes[k].diferencaVsMelhor = regimes[k].elegivel ? regimes[k].totalMes - totalMelhor : null;
        regimes[k].eMelhor = k === melhor;
      }
    }

    return {
      parametros: { receitaMes, rbt12: receitaAnualizada, setor, issMunicipal, margemLucroReal },
      regimes,
      melhor,
      resumo: melhor ? this._montarResumoTexto(regimes, melhor) : 'Nenhum regime elegível (verifique os valores)',
    };
  }

  // -------- MEI --------
  _calcularMEI(receitaMes, rbt12, setor) {
    const elegivel = rbt12 <= LIMITE_MEI;
    const das = DAS_MEI_2026[setor] || 76.60;
    return {
      nome: 'MEI',
      elegivel,
      motivoInelegivel: !elegivel ? `Faturamento anual R$ ${rbt12.toLocaleString('pt-BR')} > limite MEI R$ ${LIMITE_MEI.toLocaleString('pt-BR')}` : null,
      totalMes: elegivel ? das : null,
      aliquotaEfetiva: elegivel ? das / receitaMes : null,
      detalhes: {
        das_fixo: das,
        componentes: 'INSS (5% SM) + ICMS/ISS fixo',
      },
    };
  }

  // -------- Simples Nacional --------
  _calcularSimples(receitaMes, rbt12, setor) {
    const anexo = ANEXOS_POR_SETOR[setor];
    if (!anexo) return { nome: 'Simples Nacional', elegivel: false, motivoInelegivel: 'Setor sem anexo mapeado', totalMes: null };

    if (rbt12 > 4800000) {
      return {
        nome: 'Simples Nacional',
        elegivel: false,
        motivoInelegivel: `RBT12 R$ ${rbt12.toLocaleString('pt-BR')} excede limite Simples (R$ 4.800.000)`,
        totalMes: null,
      };
    }

    // Encontra a faixa
    const faixa = anexo.find(([lim]) => rbt12 <= lim) || anexo[anexo.length - 1];
    const [limiteFaixa, aliquotaNominal, parcelaDeduzir] = faixa;
    const aliquotaEfetiva = (rbt12 * aliquotaNominal - parcelaDeduzir) / rbt12;
    const das = receitaMes * aliquotaEfetiva;

    return {
      nome: 'Simples Nacional',
      elegivel: true,
      totalMes: Math.max(0, das),
      aliquotaEfetiva,
      detalhes: {
        anexo: NOMES_ANEXO[setor],
        rbt12,
        faixa_ate: limiteFaixa,
        aliquota_nominal: aliquotaNominal,
        parcela_deduzir: parcelaDeduzir,
        formula: '(RBT12 × alíquota nominal − parcela a deduzir) / RBT12',
      },
    };
  }

  // -------- Lucro Presumido --------
  _calcularPresumido(receitaMes, rbt12, setor, issMunicipal) {
    if (rbt12 > 78000000) {
      return {
        nome: 'Lucro Presumido',
        elegivel: false,
        motivoInelegivel: 'RBT12 excede limite Lucro Presumido (R$ 78.000.000)',
        totalMes: null,
      };
    }

    const presuncaoIRPJ = PRESUNCAO_IRPJ[setor] || 0.32;
    const presuncaoCSLL = PRESUNCAO_CSLL[setor] || 0.32;

    // Trimestral pro IRPJ/CSLL (pra adicional 10%)
    const receitaTrim = receitaMes * 3;
    const baseIRPJ = receitaTrim * presuncaoIRPJ;
    const baseCSLL = receitaTrim * presuncaoCSLL;

    let irpjTrim = baseIRPJ * 0.15;
    const adicionalBase = baseIRPJ - 60000;
    if (adicionalBase > 0) irpjTrim += adicionalBase * 0.10;

    const csllTrim = baseCSLL * 0.09;

    // PIS + COFINS cumulativo
    const pisMes = receitaMes * 0.0065;
    const cofinsMes = receitaMes * 0.03;

    // ISS (se for serviço)
    const isServico = setor.startsWith('servicos');
    const issMes = isServico ? receitaMes * issMunicipal : 0;

    // ICMS (se for comércio/indústria) — estimativa simplificada 18%
    // mas com crédito de entradas normalmente alta; aqui ignoramos pra não distorcer
    // Deixamos como 0 e explicamos no detalhe

    const totalTrim = irpjTrim + csllTrim;
    const totalMes = totalTrim / 3 + pisMes + cofinsMes + issMes;

    return {
      nome: 'Lucro Presumido',
      elegivel: true,
      totalMes,
      aliquotaEfetiva: totalMes / receitaMes,
      detalhes: {
        irpj_trimestral: irpjTrim,
        csll_trimestral: csllTrim,
        pis_mensal: pisMes,
        cofins_mensal: cofinsMes,
        iss_mensal: issMes,
        observacao: !isServico ? 'ICMS não incluído (depende de créditos de entrada)' : null,
        presuncao_irpj: presuncaoIRPJ,
        presuncao_csll: presuncaoCSLL,
      },
    };
  }

  // -------- Lucro Real (estimativa) --------
  _calcularReal(receitaMes, rbt12, setor, issMunicipal, margemLucro) {
    // Aproximação: assume lucro = receita × margemLucro
    // Na prática, Lucro Real precisa de toda a DRE. Esta é uma CALCULADORA ASSISTIDA.
    const receitaTrim = receitaMes * 3;
    const lucroTrim = receitaTrim * margemLucro;

    let irpjTrim = lucroTrim * 0.15;
    const adicionalBase = lucroTrim - 60000;
    if (adicionalBase > 0) irpjTrim += adicionalBase * 0.10;

    const csllTrim = lucroTrim * 0.09;

    // PIS + COFINS não-cumulativo (assumindo poucos créditos pra simplicidade)
    // alíquotas: 1,65% + 7,6% = 9,25%
    // Crédito típico ~3% (média), então líquido ~6,25%
    const pisCofinsMes = receitaMes * 0.0625;

    const isServico = setor.startsWith('servicos');
    const issMes = isServico ? receitaMes * issMunicipal : 0;

    const totalMes = (irpjTrim + csllTrim) / 3 + pisCofinsMes + issMes;

    return {
      nome: 'Lucro Real (estimativa)',
      elegivel: true,
      totalMes,
      aliquotaEfetiva: totalMes / receitaMes,
      detalhes: {
        margem_lucro_assumida: margemLucro,
        irpj_trimestral: irpjTrim,
        csll_trimestral: csllTrim,
        pis_cofins_mensal_liquido: pisCofinsMes,
        iss_mensal: issMes,
        observacao: 'ESTIMATIVA — Real preciso exige DRE completa com despesas dedutíveis e créditos PIS/COFINS',
      },
    };
  }

  _montarResumoTexto(regimes, melhor) {
    const r = regimes[melhor];
    const valorBrl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    const pctBr = (v) => (v * 100).toFixed(2) + '%';
    return `${r.nome} é o mais vantajoso: ${valorBrl(r.totalMes)}/mês (alíquota efetiva ${pctBr(r.aliquotaEfetiva)})`;
  }

  /**
   * Metadados pra UI (setores disponíveis, limites)
   */
  metadados() {
    return {
      setores: Object.keys(ANEXOS_POR_SETOR).map(k => ({
        codigo: k,
        nome: NOMES_ANEXO[k] || k,
      })),
      limites: {
        mei_anual: LIMITE_MEI,
        simples_anual: 4800000,
        presumido_anual: 78000000,
      },
      ano_base: 2026,
    };
  }
}

module.exports = new ApuracaoService();
