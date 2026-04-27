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
    this._validarRegimeTributario(nota, cliente, erros, correcoes, avisos);

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
    // Helper: valida formato (6 dígitos iissdd) e existência na tabela oficial.
    // Se o valor é inválido (lixo de testes antigos, formato 9 dígitos descontinuado, etc),
    // tratamos como ausente pra cair na auto-sugestão.
    const _ctribValido = (cod) => {
      if (!cod || !/^\d{6}$/.test(String(cod))) return false;
      try {
        const db = getDb();
        const r = db.prepare('SELECT 1 FROM codigos_servico_nacional WHERE codigo = ?').get(String(cod));
        return !!r;
      } catch { return /^\d{6}$/.test(String(cod)); /* tabela ainda não populada — aceita formato */ }
    };

    // Normaliza nota.codigo_servico removendo pontos/espacos/lixo (ex: "02.01.01" -> "020101")
    if (nota.codigo_servico) {
      const codNorm = String(nota.codigo_servico).replace(/\D/g, '');
      if (codNorm !== nota.codigo_servico) {
        console.log(`[PreValidacao] cTribNac normalizado: "${nota.codigo_servico}" -> "${codNorm}"`);
        nota.codigo_servico = codNorm;
        // tambem persiste no banco pra nao precisar normalizar de novo
        try { db.prepare('UPDATE notas_fiscais SET codigo_servico = ? WHERE id = ?').run(codNorm, nota.id); } catch (_) {}
      }
    }
    // Se nota.codigo_servico veio mas é inválido, descarta
    if (nota.codigo_servico && !_ctribValido(nota.codigo_servico)) {
      avisos.push(`Nota: código de serviço "${nota.codigo_servico}" tem formato inválido (esperado 6 dígitos da Lista LC 116/2003) — vou tentar sugerir o correto.`);
      nota.codigo_servico = null;
    }
    // Normaliza cliente.codigo_servico tambem (lixo historico pode ter pontos)
    const codClienteRaw = cliente.codigo_servico ? String(cliente.codigo_servico).replace(/\D/g, '') : '';
    const codClienteValido = _ctribValido(codClienteRaw) ? codClienteRaw : null;

    if (!nota.codigo_servico) {
      if (codClienteValido) {
        nota.codigo_servico = codClienteValido;
        try {
          const db = getDb();
          db.prepare('UPDATE notas_fiscais SET codigo_servico = ? WHERE id = ?').run(codClienteValido, nota.id);
          correcoes.push(`Nota: código de serviço preenchido do cadastro do cliente (${codClienteValido})`);
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
              // Auto-cadastra no cliente também (libera próximas NFs sem perguntar).
              // Sobrescreve qualquer valor inválido que esteja no cadastro (ex: lixo de
              // testes antigos com formato errado).
              const _ehValidoUpsert = /^\d{6}$/.test(String(cliente.codigo_servico || ''));
              if (_ehValidoUpsert) {
                // só seta se está NULL/vazio
                db.prepare(`UPDATE clientes SET codigo_servico = ?, updated_at = datetime('now')
                            WHERE id = ? AND (codigo_servico IS NULL OR codigo_servico = '')`).run(escolha.codigo, cliente.id);
              } else {
                // override: limpa valor inválido e aplica sugestão
                db.prepare(`UPDATE clientes SET codigo_servico = ?, updated_at = datetime('now') WHERE id = ?`).run(escolha.codigo, cliente.id);
              }
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

  _validarRegimeTributario(nota, cliente, erros, correcoes, avisos) {
    const opSimpNac = String(cliente.optante_simples || cliente.regime_simples_nacional || '1');
    const isSimplesNacional = opSimpNac === '2' || opSimpNac === '3';

    if (isSimplesNacional) {
      // Simples Nacional precisa de percentual de tributos
      if (!nota.percentual_total_tributos_sn && !cliente.percentual_tributos_sn) {
        avisos.push(`Simples Nacional: percentual total de tributos não configurado (usando padrão 6.00%). Configure no cadastro do cliente se for diferente.`);
      }

      // [B] regApTribSN: default '1' (Receita Bruta — caso mais comum em ME/EPP).
      // Auto-cadastra no cliente pra próximas NFs nem precisar pensar.
      const regApTribSN = String(cliente.reg_ap_trib_sn || '1');
      if (!/^[1-6]$/.test(regApTribSN)) {
        // Valor cadastrado é inválido — corrige pra '1' e avisa
        try {
          const db = getDb();
          db.prepare(`UPDATE clientes SET reg_ap_trib_sn = '1', updated_at = datetime('now') WHERE id = ?`).run(cliente.id);
          cliente.reg_ap_trib_sn = '1';
          correcoes.push(`Cliente: reg_ap_trib_sn corrigido de "${cliente.reg_ap_trib_sn}" para "1" (Receita Bruta — padrão ME/EPP)`);
        } catch (e) { /* ok */ }
      } else if (!cliente.reg_ap_trib_sn) {
        // Não cadastrado — auto-cadastra com '1'
        try {
          const db = getDb();
          db.prepare(`UPDATE clientes SET reg_ap_trib_sn = '1', updated_at = datetime('now') WHERE id = ? AND (reg_ap_trib_sn IS NULL OR reg_ap_trib_sn = '')`).run(cliente.id);
          cliente.reg_ap_trib_sn = '1';
          correcoes.push(`Cliente: reg_ap_trib_sn cadastrado automaticamente como "1" (Receita Bruta). Ajuste em /escritorio/clientes/${cliente.id} se for outro regime.`);
        } catch (e) { /* ok */ }
      }

      // [C] CST PIS/COFINS — default '00' já é o caso comum pro Simples.
      const cst = String(nota.cst_piscofins || '00');
      const CSTS_VALIDOS = ['00','01','04','49','50','51','52','53','54','55','56','60','61','62','63','64','65','66','67','70','71','72','73','74','75','98','99'];
      if (!CSTS_VALIDOS.includes(cst)) {
        erros.push(`Simples Nacional: CST PIS/COFINS "${cst}" inválido. Valores aceitos: ${CSTS_VALIDOS.slice(0,6).join(', ')}, ...`);
      }
    } else {
      // [A] Regime normal — alíquota ISS é obrigatória. Estratégia em 3 níveis:
      //   1) usa o que veio na nota (passou pela equipe)
      //   2) usa o cadastro do cliente (cliente.aliquota_iss)
      //   3) aplica DEFAULT 5% (caso comum: serviços profissionais — LC 116) + auto-cadastra no cliente
      const ALIQUOTA_PADRAO = 0.05;  // 5% — máximo LC 116, típico pra serviços profissionais
      if (!nota.aliquota_iss || nota.aliquota_iss <= 0) {
        if (cliente.aliquota_iss && cliente.aliquota_iss > 0) {
          // Nível 2: cadastro do cliente
          nota.aliquota_iss = cliente.aliquota_iss;
          try {
            const db = getDb();
            db.prepare('UPDATE notas_fiscais SET aliquota_iss = ? WHERE id = ?').run(cliente.aliquota_iss, nota.id);
            correcoes.push(`Nota: alíquota ISS preenchida do cadastro do cliente (${(cliente.aliquota_iss*100).toFixed(2)}%)`);
          } catch (e) { /* ok */ }
        } else {
          // Nível 3: default 5% + auto-cadastra no cliente
          nota.aliquota_iss = ALIQUOTA_PADRAO;
          try {
            const db = getDb();
            db.prepare('UPDATE notas_fiscais SET aliquota_iss = ? WHERE id = ?').run(ALIQUOTA_PADRAO, nota.id);
            db.prepare(`UPDATE clientes SET aliquota_iss = ?, updated_at = datetime('now')
                        WHERE id = ? AND (aliquota_iss IS NULL OR aliquota_iss <= 0)`).run(ALIQUOTA_PADRAO, cliente.id);
            cliente.aliquota_iss = ALIQUOTA_PADRAO;
            correcoes.push(`Nota: alíquota ISS aplicada por padrão (5%) e cadastrada no cliente. Ajuste em /escritorio/clientes/${cliente.id} se a alíquota do município for diferente.`);
          } catch (e) { /* ok */ }
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
