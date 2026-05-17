/**
 * Auditor de Cadastro — checa quais campos críticos pra emissão NFS-e estão
 * preenchidos no cadastro do prestador (cliente) ou tomador.
 *
 * Motivação (auditoria 2026-05-17): a Ana costumava INVENTAR lista de campos
 * faltando quando vinha rejeição SEFIN do tipo RNG6110 ("Falha Schema Xml" =
 * campo obrigatório vazio). Cliente Bruno até apontou: "geralmente é falta de
 * preenchimento de algum campo". Agora a Ana tem `CONSULTAR_CADASTRO_CLIENTE`
 * pra ver os dados reais antes de chutar.
 *
 * Reusa regras de validação do preValidacaoNfseService (formato IBGE, CEP,
 * regimes Simples), mas NÃO consulta Receita — é só foto do que está no banco.
 */

const { getDb } = require('../database/init');

// ── Validadores ──────────────────────────────────────────────────────────────

function _isCodigoIBGEValido(cod) {
  if (!cod) return false;
  const c = String(cod).trim();
  return /^\d{7}$/.test(c) && c !== '0000000';
}

function _isCepValido(cep) {
  if (!cep) return false;
  return /^\d{8}$/.test(String(cep).replace(/\D/g, ''));
}

function _isCnpjValido(cnpj) {
  if (!cnpj) return false;
  return String(cnpj).replace(/\D/g, '').length === 14;
}

function _isCpfValido(cpf) {
  if (!cpf) return false;
  return String(cpf).replace(/\D/g, '').length === 11;
}

function _isCTribNacValido(cod) {
  if (!cod) return false;
  return /^\d{6}$/.test(String(cod).trim());
}

function _certificadoStatus(cliente) {
  // Retorna 'sem', 'vencido', 'vence_em_breve', 'ok'
  if (!cliente.certificado_a1_path || !cliente.certificado_a1_senha_encrypted) {
    return { status: 'sem', detalhe: 'não cadastrado' };
  }
  if (!cliente.certificado_validade) {
    return { status: 'sem_validade', detalhe: 'A1 cadastrado mas sem data de validade no banco' };
  }
  const validade = new Date(cliente.certificado_validade);
  const hoje = new Date();
  const dias = Math.floor((validade - hoje) / (1000 * 60 * 60 * 24));
  if (dias < 0) return { status: 'vencido', detalhe: `venceu ${Math.abs(dias)}d atrás` };
  if (dias <= 30) return { status: 'vence_em_breve', detalhe: `vence em ${dias}d` };
  return { status: 'ok', detalhe: `validade em ${cliente.certificado_validade}` };
}

// ── Auditoria do prestador (cliente) ────────────────────────────────────────

/**
 * Audita o cadastro de um cliente prestador.
 * @param {Object} cliente — linha da tabela `clientes`
 * @returns {{problemas:Array, ok:Array, total:number, criticos:number}}
 */
function auditarCliente(cliente) {
  if (!cliente) return null;
  const problemas = [];
  const ok = [];

  // === CRÍTICOS pra emissão ===
  const checks = [
    ['CNPJ', _isCnpjValido(cliente.cnpj), cliente.cnpj, true],
    ['Razão social', !!cliente.razao_social, cliente.razao_social, true],
    ['Email', !!cliente.email, cliente.email, true],
    ['CEP', _isCepValido(cliente.cep), cliente.cep, true],
    ['Logradouro', !!cliente.logradouro, cliente.logradouro, true],
    ['Número', !!cliente.numero, cliente.numero, true],
    ['Bairro', !!cliente.bairro, cliente.bairro, true],
    ['Código IBGE do município', _isCodigoIBGEValido(cliente.codigo_municipio), cliente.codigo_municipio, true],
    ['Município', !!cliente.municipio, cliente.municipio, true],
    ['UF', !!cliente.uf && cliente.uf.length === 2, cliente.uf, true],
    ['Código de serviço (cTribNac)', _isCTribNacValido(cliente.codigo_servico), cliente.codigo_servico, true],
    ['Descrição de serviço padrão', !!cliente.descricao_servico_padrao, cliente.descricao_servico_padrao, false],
    ['Alíquota ISS', cliente.aliquota_iss != null && cliente.aliquota_iss >= 0, cliente.aliquota_iss, true],
    ['Regime tributário (Simples/Presumido/Real/MEI)', !!cliente.regime_tributario, cliente.regime_tributario, true],
    ['Inscrição Municipal', !!cliente.inscricao_municipal, cliente.inscricao_municipal, false],  // opcional
    ['Telefone', !!cliente.telefone, cliente.telefone, false],
  ];

  for (const [campo, valido, valor, critico] of checks) {
    if (valido) {
      ok.push({ campo, valor: _truncar(valor, 50) });
    } else {
      problemas.push({ campo, valor: _truncar(valor, 50), critico });
    }
  }

  // Regime Simples + regApTribSN — coerência
  if (cliente.optante_simples === 1 && !cliente.reg_ap_trib_sn) {
    problemas.push({
      campo: 'reg_ap_trib_sn (regime apuração SN)',
      valor: null,
      critico: true,
      observacao: 'Cliente é optante do Simples mas regime de apuração SN não está cadastrado',
    });
  }

  // Certificado A1
  const cert = _certificadoStatus(cliente);
  if (cert.status === 'ok') {
    ok.push({ campo: 'Certificado A1', valor: cert.detalhe });
  } else if (cert.status === 'vence_em_breve') {
    problemas.push({ campo: 'Certificado A1', valor: cert.detalhe, critico: false, observacao: 'renovar logo' });
  } else {
    problemas.push({ campo: 'Certificado A1', valor: cert.detalhe, critico: true });
  }

  const criticos = problemas.filter(p => p.critico).length;
  return {
    cliente_id: cliente.id,
    razao_social: cliente.razao_social,
    cnpj: cliente.cnpj,
    ativo: cliente.ativo === 1,
    problemas,
    ok,
    total_campos: ok.length + problemas.length,
    criticos,
  };
}

// ── Auditoria do tomador ────────────────────────────────────────────────────

/**
 * Audita o cadastro de um tomador.
 * @param {Object} tomador — linha da tabela `tomadores`
 */
function auditarTomador(tomador) {
  if (!tomador) return null;
  const problemas = [];
  const ok = [];

  const isCnpj = tomador.tipo_documento === 'CNPJ';
  const checks = [
    [isCnpj ? 'CNPJ' : 'CPF', isCnpj ? _isCnpjValido(tomador.documento) : _isCpfValido(tomador.documento), tomador.documento, true],
    ['Razão social', !!tomador.razao_social, tomador.razao_social, true],
    ['CEP', _isCepValido(tomador.cep), tomador.cep, isCnpj], // CPF pode emitir sem endereço
    ['Logradouro', !!tomador.logradouro, tomador.logradouro, isCnpj],
    ['Número', !!tomador.numero, tomador.numero, isCnpj],
    ['Bairro', !!tomador.bairro, tomador.bairro, isCnpj],
    ['Código IBGE do município', _isCodigoIBGEValido(tomador.codigo_municipio), tomador.codigo_municipio, isCnpj],
    ['Município', !!tomador.municipio, tomador.municipio, isCnpj],
    ['UF', !!tomador.uf && tomador.uf.length === 2, tomador.uf, isCnpj],
    ['Email', !!tomador.email, tomador.email, false],
    ['Telefone', !!tomador.telefone, tomador.telefone, false],
  ];

  for (const [campo, valido, valor, critico] of checks) {
    if (valido) {
      ok.push({ campo, valor: _truncar(valor, 50) });
    } else {
      problemas.push({ campo, valor: _truncar(valor, 50), critico });
    }
  }

  const criticos = problemas.filter(p => p.critico).length;
  return {
    tomador_id: tomador.id,
    razao_social: tomador.razao_social,
    documento: tomador.documento,
    tipo_documento: tomador.tipo_documento,
    ativo: tomador.ativo === 1,
    problemas,
    ok,
    total_campos: ok.length + problemas.length,
    criticos,
  };
}

// ── Busca clientes/tomadores ────────────────────────────────────────────────

/**
 * Busca cliente por CNPJ (qualquer formato, com ou sem máscara).
 */
function buscarClientePorCnpj(cnpj) {
  const limpo = String(cnpj || '').replace(/\D/g, '');
  if (limpo.length !== 14) return null;
  const db = getDb();
  return db.prepare(
    `SELECT * FROM clientes
     WHERE REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
     LIMIT 1`
  ).get(limpo) || null;
}

/**
 * Busca tomador por (cliente_id, documento).
 * Aceita documento com ou sem máscara.
 */
function buscarTomadorDoCliente(clienteId, documento) {
  const limpo = String(documento || '').replace(/\D/g, '');
  if (!limpo) return null;
  const db = getDb();
  return db.prepare(
    `SELECT * FROM tomadores
     WHERE cliente_id = ?
       AND REPLACE(REPLACE(REPLACE(documento, '.', ''), '/', ''), '-', '') = ?
     LIMIT 1`
  ).get(clienteId, limpo) || null;
}

// ── Formatação humana (texto WhatsApp) ──────────────────────────────────────

/**
 * Gera um relatório textual amigável pra WhatsApp.
 * @param {Object} cli auditoria do cliente (resultado de auditarCliente)
 * @param {Object|null} tom auditoria do tomador
 */
function formatarRelatorio(cli, tom = null) {
  if (!cli) return '⚠️ Cliente não encontrado.';
  const linhas = [];
  linhas.push(`📋 *Cadastro do prestador*`);
  linhas.push(`*${cli.razao_social}* (${cli.cnpj})${cli.ativo ? '' : ' [INATIVO]'}`);
  linhas.push(`Campos preenchidos: ${cli.ok.length}/${cli.total_campos} • Problemas: ${cli.problemas.length} (${cli.criticos} críticos)`);
  if (cli.problemas.length > 0) {
    linhas.push('');
    linhas.push('❌ *Faltando ou inválido:*');
    for (const p of cli.problemas) {
      const tag = p.critico ? '🔴' : '🟡';
      const obs = p.observacao ? ` _(${p.observacao})_` : '';
      const v = p.valor != null && p.valor !== '' ? ` — atual: "${p.valor}"` : '';
      linhas.push(`  ${tag} ${p.campo}${v}${obs}`);
    }
  } else {
    linhas.push('✅ Nenhum campo faltando.');
  }

  if (tom) {
    linhas.push('');
    linhas.push(`📋 *Cadastro do tomador*`);
    linhas.push(`*${tom.razao_social}* (${tom.documento} ${tom.tipo_documento})${tom.ativo ? '' : ' [INATIVO]'}`);
    linhas.push(`Campos preenchidos: ${tom.ok.length}/${tom.total_campos} • Problemas: ${tom.problemas.length} (${tom.criticos} críticos)`);
    if (tom.problemas.length > 0) {
      linhas.push('');
      linhas.push('❌ *Faltando ou inválido:*');
      for (const p of tom.problemas) {
        const tag = p.critico ? '🔴' : '🟡';
        const obs = p.observacao ? ` _(${p.observacao})_` : '';
        const v = p.valor != null && p.valor !== '' ? ` — atual: "${p.valor}"` : '';
        linhas.push(`  ${tag} ${p.campo}${v}${obs}`);
      }
    } else {
      linhas.push('✅ Nenhum campo faltando.');
    }
  }

  // Sugestão de ação
  const todosCriticos = cli.criticos + (tom?.criticos || 0);
  if (todosCriticos > 0) {
    linhas.push('');
    linhas.push(`💡 *Próximo passo:* ajusta os ${todosCriticos} campo(s) críticos no painel (ou via [ACAO:ATUALIZAR_CLIENTE:cnpj|campo=valor]) e tenta emitir de novo.`);
  }

  return linhas.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _truncar(v, max) {
  if (v == null) return v;
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

module.exports = {
  auditarCliente,
  auditarTomador,
  buscarClientePorCnpj,
  buscarTomadorDoCliente,
  formatarRelatorio,
  // exports privados pra teste:
  _isCodigoIBGEValido,
  _isCepValido,
  _isCnpjValido,
  _isCpfValido,
  _isCTribNacValido,
  _certificadoStatus,
};
