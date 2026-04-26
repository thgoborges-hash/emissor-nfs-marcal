// =====================================================
// Serviço de Pré-Validação e Enriquecimento de NFS-e
// Roda ANTES da emissão para garantir dados completos
// e compatíveis com o XSD do Portal Nacional
// =====================================================

const cnpjService = require('./cnpjService');
const codigoServicoSugestaoService = require('./codigoServicoSugestaoService');
const { getDb } = require('../database/init');

class PreValidacaoNfseService {

  /**
   * Valida e enriquece os dados antes da emissão.
   * Retorna { valido: true, cliente, tomador, correcoes[] }
   * ou { valido: false, erros[], correcoes[] }
   *
   * Corrige automaticamente o que for possível (ex: busca IBGE via CNPJ).
   * Reporta erros claros para o que não puder corrigir.
   */
  async validarEEnriquecer(nota, cliente, tomador) {
    const erros = [];
    const correcoes = [];
    const avisos = [];

    console.log(`[PreValidacao] Iniciando validação para NF ${nota.id}, cliente ${cliente.razao_social}`);
    console.log(`[PreValidacao] Tomador: ${tomador?.razao_social}, doc=${tomador?.documento}, codigo_municipio="${tomador?.codigo_municipio}", logradouro="${tomador?.logradouro}", cep="${tomador?.cep}"`);

    // =========================================================
    // 1. VALIDAÇÃO E ENRIQUECIMENTO DO PRESTADOR (CLIENTE)
    // =========================================================
    await this._validarPrestador(cliente, erros, correcoes, avisos);

    // =========================================================
    // 2. VALIDAÇÃO E ENRIQUECIMENTO DO TOMADOR
    // =========================================================
    await this._validarTomador(tomador, cliente, erros, correcoes, avisos);

    // =========================================================
    // 3. VALIDAÇÃO DA NOTA FISCAL
    // =========================================================
    this._validarNota(nota, cliente, erros, correcoes, avisos);

    // =========================================================
    // 4. VALIDAÇÃO DE REGIME TRIBUTÁRIO E TRIBUTOS
    // =========================================================
    this._validarRegimeTributario(nota, cliente, erros, avisos);

    // Resumo
    const valido = erros.length === 0;
    if (correcoes.length > 0) {
      console.log(`[PreValidacao] ${correcoes.length} correção(ões) automática(s) aplicada(s):`);
      correcoes.forEach(c => console.log(`  ✅ ${c}`));
    }
    if (avisos.length > 0) {
      console.log(`[PreValidacao] ${avisos.length} aviso(s):`);
      avisos.forEach(a => console.log(`  ⚠️ ${a}`));
    }
    if (!valido) {
      console.log(`[PreValidacao] ❌ ${erros.length} erro(s) impeditivo(s):`);
      erros.forEach(e => console.log(`  ❌ ${e}`));
    } else {
      console.log(`[PreValidacao] ✅ Validação OK - pronto para emissão`);
    }

    return { valido, erros, correcoes, avisos, cliente, tomador };
  }

  // ===========================================================================
  // VALIDAÇÃO DO PRESTADOR
  // ===========================================================================

  async _validarPrestador(cliente, erros, correcoes, avisos) {
    // CNPJ obrigatório
    const cnpj = (cliente.cnpj || '').replace(/\D/g, '');
    if (!cnpj || cnpj.length !== 14) {
      erros.push('Prestador: CNPJ inválido ou ausente');
      return;
    }

    // codigo_municipio - obrigatório e deve ser IBGE válido (7 dígitos)
    if (!this._isCodigoIBGEValido(cliente.codigo_municipio)) {
      console.log(`[PreValidacao] Prestador sem codigo_municipio válido (atual: "${cliente.codigo_municipio}"). Buscando via CNPJ...`);
      const dadosReceita = await cnpjService.consultarCNPJ(cnpj);
      if (dadosReceita && this._isCodigoIBGEValido(dadosReceita.codigoMunicipio)) {
        const codigoAnterior = cliente.codigo_municipio;
        cliente.codigo_municipio = dadosReceita.codigoMunicipio;
        correcoes.push(`Prestador: codigo_municipio atualizado de "${codigoAnterior || 'vazio'}" para "${dadosReceita.codigoMunicipio}" (${dadosReceita.municipio}/${dadosReceita.uf})`);
        // Persiste no banco para não precisar buscar novamente
        this._atualizarClienteNoBanco(cliente.id, {
          codigo_municipio: dadosReceita.codigoMunicipio,
          municipio: dadosReceita.municipio || cliente.municipio,
          uf: dadosReceita.uf || cliente.uf,
        }, correcoes);
        // Também enriquecer telefone e email se faltam
        if (!cliente.telefone && dadosReceita.telefone) {
          cliente.telefone = dadosReceita.telefone;
          this._atualizarClienteNoBanco(cliente.id, { telefone: dadosReceita.telefone }, correcoes);
          correcoes.push(`Prestador: telefone preenchido via Receita (${dadosReceita.telefone})`);
        }
        if (!cliente.email && dadosReceita.email) {
          cliente.email = dadosReceita.email;
          this._atualizarClienteNoBanco(cliente.id, { email: dadosReceita.email }, correcoes);
          correcoes.push(`Prestador: email preenchido via Receita (${dadosReceita.email})`);
        }
      } else {
        erros.push(`Prestador: codigo_municipio ausente e não foi possível obter via consulta CNPJ. Cadastre manualmente o código IBGE do município (7 dígitos).`);
      }
    }

    // Certificado digital
    if (!cliente.certificado_a1_path || !cliente.certificado_a1_senha_encrypted) {
      erros.push('Prestador: certificado digital A1 não cadastrado');
    }

    // Regime tributário - avisar se não configurado
    if (!cliente.optante_simples && !cliente.regime_simples_nacional) {
      avisos.push('Prestador: regime do Simples Nacional não configurado (usando padrão: Não Optante)');
    }
  }

  // ===========================================================================
  // VALIDAÇÃO DO TOMADOR
  // ===========================================================================

  async _validarTomador(tomador, cliente, erros, correcoes, avisos) {
    if (!tomador) {
      erros.push('Tomador: não informado (obrigatório para emissão)');
      return;
    }

    // Documento obrigatório
    const documento = (tomador.documento || '').replace(/\D/g, '');
    if (!documento) {
      erros.push('Tomador: documento (CNPJ/CPF) ausente');
      return;
    }

    // Razão social obrigatória
    if (!tomador.razao_social || tomador.razao_social.trim() === '') {
      erros.push('Tomador: razão social ausente');
    }

    // codigo_municipio do tomador - SEMPRE verificar via CNPJ para garantir que é válido
    // (um código de 7 dígitos pode parecer válido mas ser rejeitado pela SEFIN)
    {
      let corrigido = false;

      if (tomador.tipo_documento === 'CNPJ' && documento.length === 14) {
        // Sempre consulta a Receita pra CNPJ — garante dados atualizados
        console.log(`[PreValidacao] Tomador CNPJ ${documento}: verificando codigo_municipio (atual: "${tomador.codigo_municipio}")...`);
        const dadosReceita = await cnpjService.consultarCNPJ(documento);
        if (dadosReceita && this._isCodigoIBGEValido(dadosReceita.codigoMunicipio)) {
          const codigoAnterior = tomador.codigo_municipio;
          // Atualiza se estava vazio OU se mudou (correção de dado errado)
          if (!codigoAnterior || codigoAnterior !== dadosReceita.codigoMunicipio) {
            tomador.codigo_municipio = dadosReceita.codigoMunicipio;
            correcoes.push(`Tomador: codigo_municipio atualizado de "${codigoAnterior || 'vazio'}" para "${dadosReceita.codigoMunicipio}" (${dadosReceita.municipio}/${dadosReceita.uf})`);
          }
          corrigido = true;
          // Persiste no banco — SEMPRE atualiza codigo_municipio pra garantir dado correto
          const updateFields = { codigo_municipio: dadosReceita.codigoMunicipio };
          // Aproveita pra preencher/atualizar dados do tomador
          // Atualiza TODOS os campos do tomador com dados frescos da Receita
          const camposReceita = {
            logradouro: dadosReceita.logradouro,
            numero: dadosReceita.numero,
            bairro: dadosReceita.bairro,
            cep: dadosReceita.cep,
            municipio: dadosReceita.municipio,
            uf: dadosReceita.uf,
            email: dadosReceita.email,
            razao_social: dadosReceita.razaoSocial,
            complemento: dadosReceita.complemento,
          };
          for (const [campo, valor] of Object.entries(camposReceita)) {
            if (valor && (!tomador[campo] || tomador[campo] !== valor)) {
              tomador[campo] = valor;
              updateFields[campo] = valor;
            }
          }
          this._atualizarTomadorNoBanco(tomador.id, updateFields, correcoes);
          if (Object.keys(updateFields).length > 1) {
            correcoes.push(`Tomador: endereço e dados complementares preenchidos via Receita`);
          }
        } else if (dadosReceita && dadosReceita.municipio && dadosReceita.uf) {
          // CNPJ retornou o nome da cidade mas o IBGE lookup falhou no cnpjService
          // Tenta buscar direto pela API do IBGE como fallback
          console.log(`[PreValidacao] CNPJ retornou município ${dadosReceita.municipio}/${dadosReceita.uf} mas sem IBGE. Tentando fallback direto...`);
          try {
            const codigoIBGE = await cnpjService._buscarCodigoIBGE(dadosReceita.municipio, dadosReceita.uf);
            if (codigoIBGE) {
              const codigoAnterior = tomador.codigo_municipio;
              tomador.codigo_municipio = codigoIBGE;
              correcoes.push(`Tomador: codigo_municipio corrigido de "${codigoAnterior || 'vazio'}" para "${codigoIBGE}" (${dadosReceita.municipio}/${dadosReceita.uf}) via fallback IBGE`);
              corrigido = true;
              // Persiste
              const updateFields = { codigo_municipio: codigoIBGE };
              if (!tomador.municipio && dadosReceita.municipio) {
                tomador.municipio = dadosReceita.municipio;
                updateFields.municipio = dadosReceita.municipio;
              }
              if (!tomador.uf && dadosReceita.uf) {
                tomador.uf = dadosReceita.uf;
                updateFields.uf = dadosReceita.uf;
              }
              this._atualizarTomadorNoBanco(tomador.id, updateFields, correcoes);
            }
          } catch (fbErr) {
            console.error(`[PreValidacao] Fallback IBGE falhou:`, fbErr.message);
          }
        }
      }

      // Se não corrigiu E não é CPF sem endereço → BLOQUEIA emissão
      if (!corrigido) {
        if (tomador.tipo_documento === 'CPF') {
          // CPF: limpa o código inválido pra não enviar lixo no XML
          if (tomador.codigo_municipio && !this._isCodigoIBGEValido(tomador.codigo_municipio)) {
            tomador.codigo_municipio = null;
            avisos.push(`Tomador (CPF): codigo_municipio inválido removido. Endereço será omitido do XML.`);
          }
        } else {
          erros.push(`Tomador: codigo_municipio inválido ("${tomador.codigo_municipio || 'vazio'}") e não foi possível corrigir automaticamente. Cadastre o código IBGE (7 dígitos) do tomador.`);
        }
      }
    }
  }

  // ===========================================================================
  // VALIDAÇÃO DA NOTA FISCAL
  // ===========================================================================

  _validarNota(nota, cliente, erros, correcoes, avisos) {
    // Descrição do serviço — primeiro (vai ser usada pra sugerir cTribNac se faltar)
    if (!nota.descricao_servico || nota.descricao_servico.trim() === '') {
      if (cliente.descricao_servico_padrao) {
        nota.descricao_servico = cliente.descricao_servico_padrao;
        try {
          const db = getDb();
          db.prepare('UPDATE notas_fiscais SET descricao_servico = ? WHERE id = ?').run(cliente.descricao_servico_padrao, nota.id);
          correcoes.push(`Nota: descrição do serviço preenchida do cadastro do cliente`);
        } catch (e) { /* ok */ }
      } else {
        erros.push('Nota: descrição do serviço ausente');
      }
    }

    // Código de serviço (cTribNac)
    if (!nota.codigo_servico) {
      if (cliente.codigo_servico) {
        nota.codigo_servico = cliente.codigo_servico;
        try {
          const db = getDb();
          db.prepare('UPDATE notas_fiscais SET codigo_servico = ? WHERE id = ?').run(cliente.codigo_servico, nota.id);
          correcoes.push(`Nota: código de serviço preenchido do cadastro do cliente (${cliente.codigo_servico})`);
        } catch (e) { /* ok */ }
      } else if (nota.descricao_servico) {
        // Tenta sugerir a partir da descrição (cliente sem cadastro de cTribNac)
        try {
          const escolha = codigoServicoSugestaoService.escolher(nota.descricao_servico, cliente.cnae || '');
          if (escolha.auto && escolha.codigo) {
            // Auto-aplicação: top1 com confiança alta
            nota.codigo_servico = escolha.codigo;
            try {
              const db = getDb();
              db.prepare('UPDATE notas_fiscais SET codigo_servico = ? WHERE id = ?').run(escolha.codigo, nota.id);
              // Auto-cadastra no cliente também (libera próximas NFs sem perguntar)
              db.prepare(`UPDATE clientes SET codigo_servico = ?, updated_at = datetime('now')
                          WHERE id = ? AND (codigo_servico IS NULL OR codigo_servico = '')`).run(escolha.codigo, cliente.id);
            } catch (e) { /* ok */ }
            correcoes.push(`Nota: código de serviço sugerido automaticamente: ${escolha.codigo} - ${escolha.descricao} (confirme depois no cadastro do cliente)`);
            console.log(`[PreValidacao] cTribNac auto-sugerido: ${escolha.codigo} (${escolha.descricao}) - score=${escolha.candidatos[0]?.score}`);
          } else if (escolha.candidatos && escolha.candidatos.length > 0) {
            // Sugestões ambíguas — devolve opções pra equipe escolher
            const opcoes = escolha.candidatos.map((c, i) => `${i + 1}) ${c.codigo} - ${c.descricao}`).join('; ');
            erros.push(`Nota: código de serviço (cTribNac) não cadastrado. Sugestões pra "${nota.descricao_servico}": ${opcoes}. Responda com o código que devo usar.`);
          } else {
            erros.push('Nota: código de serviço (cTribNac) ausente. Configure o código padrão no cadastro do cliente.');
          }
        } catch (sugErr) {
          console.warn('[PreValidacao] sugestão cTribNac falhou:', sugErr.message);
          erros.push('Nota: código de serviço (cTribNac) ausente. Configure o código padrão no cadastro do cliente.');
        }
      } else {
        erros.push('Nota: código de serviço (cTribNac) ausente. Configure o código padrão no cadastro do cliente.');
      }
    }
    if (!nota.valor_servico || nota.valor_servico <= 0) {
      erros.push('Nota: valor do serviço inválido ou zero');
    }

    // Data de competência — aceita YYYY-MM ou YYYY-MM-DD; normaliza pra YYYY-MM-DD
    if (!nota.data_competencia) {
      erros.push('Nota: data de competência ausente');
    } else {
      const dt = String(nota.data_competencia).trim();
      const mYM  = /^(\d{4})-(\d{2})$/.exec(dt);
      const mYMD = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dt);
      let ano, mes, dia;
      if (mYMD) { ano=+mYMD[1]; mes=+mYMD[2]; dia=+mYMD[3]; }
      else if (mYM) { ano=+mYM[1]; mes=+mYM[2]; dia=1; }
      if (!ano || mes < 1 || mes > 12 || dia < 1 || dia > 31 || ano < 2020 || ano > 2099) {
        erros.push(`Nota: data de competência inválida ("${dt}"). Use formato AAAA-MM ou AAAA-MM-DD.`);
      } else if (mYM) {
        // Normaliza pra YYYY-MM-DD pra evitar XML com 'YYYY-MM-01' ambíguo no parser
        const norm = `${ano}-${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
        nota.data_competencia = norm;
        try {
          const db = getDb();
          db.prepare('UPDATE notas_fiscais SET data_competencia = ? WHERE id = ?').run(norm, nota.id);
          correcoes.push(`Nota: data de competência normalizada (${dt} → ${norm})`);
        } catch (e) { /* ok */ }
      }
    }

    // Número DPS
    if (!nota.numero_dps) {
      erros.push('Nota: número DPS não gerado');
    }

    // Serie DPS
    if (!nota.serie_dps) {
      avisos.push('Nota: série DPS não informada (usando padrão "1")');
    }
  }

  // ===========================================================================
  // VALIDAÇÃO DE REGIME TRIBUTÁRIO
  // ===========================================================================

  _validarRegimeTributario(nota, cliente, erros, avisos) {
    const opSimpNac = String(cliente.optante_simples || cliente.regime_simples_nacional || '1');
    const isSimplesNacional = opSimpNac === '2' || opSimpNac === '3';

    if (isSimplesNacional) {
      // Simples Nacional precisa de percentual de tributos
      if (!nota.percentual_total_tributos_sn && !cliente.percentual_tributos_sn) {
        avisos.push(`Simples Nacional: percentual total de tributos não configurado (usando padrão 6.00%). Configure no cadastro do cliente se for diferente.`);
      }

      // [B] regApTribSN obrigatório quando Simples Nacional (1=Receita, 2=Lucro, 3=Presumido, 4=Real, etc).
      // Default '1' (Receita bruta) é o caso mais comum e seguro pra ME/EPP.
      const regApTribSN = String(cliente.reg_ap_trib_sn || '1');
      if (!/^[1-6]$/.test(regApTribSN)) {
        erros.push(`Simples Nacional: reg_ap_trib_sn inválido ("${cliente.reg_ap_trib_sn}"). Cadastre 1-6 no cliente (1=Receita Bruta, mais comum).`);
      }

      // [C] CST PIS/COFINS — valida contra enum oficial pra Simples Nacional (default '00').
      const cst = String(nota.cst_piscofins || '00');
      const CSTS_VALIDOS = ['00','01','04','49','50','51','52','53','54','55','56','60','61','62','63','64','65','66','67','70','71','72','73','74','75','98','99'];
      if (!CSTS_VALIDOS.includes(cst)) {
        erros.push(`Simples Nacional: CST PIS/COFINS inválido ("${cst}"). Valores aceitos: ${CSTS_VALIDOS.slice(0,6).join(', ')}, ...`);
      }
    } else {
      // [A] Regime normal - alíquota ISS é OBRIGATÓRIA. Sem ela o XML manda <pAliq>0.00</pAliq>
      // e a SEFIN rejeita pra serviços que NÃO têm imunidade/isenção.
      if (!nota.aliquota_iss || nota.aliquota_iss <= 0) {
        // Permite override via cliente.aliquota_iss_padrao se cadastrada
        if (cliente.aliquota_iss && cliente.aliquota_iss > 0) {
          nota.aliquota_iss = cliente.aliquota_iss;
          try {
            const db = getDb();
            db.prepare('UPDATE notas_fiscais SET aliquota_iss = ? WHERE id = ?').run(cliente.aliquota_iss, nota.id);
            avisos.push(`Nota: alíquota ISS preenchida do cadastro do cliente (${(cliente.aliquota_iss*100).toFixed(2)}%)`);
          } catch (e) { /* ok */ }
        } else {
          erros.push('Nota: alíquota ISS ausente e cliente é Não Optante do Simples. Cadastre a alíquota padrão no cliente (campo aliquota_iss).');
        }
      }
    }
  }

  // ===========================================================================
  // UTILITÁRIOS
  // ===========================================================================

  /**
   * Valida se um código é um IBGE municipal válido (7 dígitos numéricos)
   */
  _isCodigoIBGEValido(codigo) {
    if (!codigo) return false;
    const cod = String(codigo).trim();
    // Código IBGE: 7 dígitos, não pode ser 0000000
    return /^\d{7}$/.test(cod) && cod !== '0000000';
  }

  /**
   * Atualiza campos do cliente no banco de dados
   */
  _atualizarClienteNoBanco(clienteId, campos, correcoes) {
    try {
      const db = getDb();
      const sets = [];
      const values = [];
      for (const [campo, valor] of Object.entries(campos)) {
        sets.push(`${campo} = ?`);
        values.push(valor);
      }
      if (sets.length === 0) return;
      values.push(clienteId);
      db.prepare(`UPDATE clientes SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
      console.log(`[PreValidacao] Cliente ${clienteId} atualizado no banco: ${sets.join(', ')}`);
    } catch (err) {
      console.error(`[PreValidacao] Erro ao atualizar cliente ${clienteId}:`, err.message);
    }
  }

  /**
   * Atualiza campos do tomador no banco de dados
   */
  _atualizarTomadorNoBanco(tomadorId, campos, correcoes) {
    try {
      const db = getDb();
      const sets = [];
      const values = [];
      for (const [campo, valor] of Object.entries(campos)) {
        sets.push(`${campo} = ?`);
        values.push(valor);
      }
      if (sets.length === 0) return;
      values.push(tomadorId);
      db.prepare(`UPDATE tomadores SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
      console.log(`[PreValidacao] Tomador ${tomadorId} atualizado no banco: ${sets.join(', ')}`);
    } catch (err) {
      console.error(`[PreValidacao] Erro ao atualizar tomador ${tomadorId}:`, err.message);
    }
  }
}

module.exports = new PreValidacaoNfseService();
