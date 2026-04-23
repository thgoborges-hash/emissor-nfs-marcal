// =====================================================
// Serviço Integra Contador (SERPRO/RFB)
// Consulta DAS, transmite DCTFWeb, emite DARF, etc.
// Usa e-CNPJ A1 da Marçal + procuração coletiva
// =====================================================
// Docs: https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const config = require('../config/integraContador');
const certificadoService = require('./certificadoService');
const nfseConfig = require('../config/nfse');
const { getDb } = require('../database/init');

class IntegraContadorService {
  constructor() {
    // Cache do par { accessToken, jwtToken, expiresAt } — renova antes de expirar
    this.tokenCache = null;
    // Folga de 60s pra renovar antes de expirar de verdade
    this.expiryBufferMs = 60 * 1000;
  }

  // -------------------------------------------------
  // Autenticação OAuth2 com mTLS
  // -------------------------------------------------

  /**
   * Retorna um access_token válido (do cache ou solicita novo)
   */
  async obterToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + this.expiryBufferMs) {
      return this.tokenCache;
    }
    return await this.autenticar();
  }

  /**
   * Solicita um novo par de tokens ao SERPRO via OAuth2 + mTLS
   */
  async autenticar() {
    const { consumerKey, consumerSecret, roleType } = config.credenciais;

    if (!consumerKey || !consumerSecret) {
      throw new Error('SERPRO_CONSUMER_KEY/SECRET não configurados. Contrate o Integra Contador em loja.serpro.gov.br/integracontador e configure as variáveis de ambiente.');
    }

    const { pfxBuffer, senha } = this._carregarCertificadoMarcal();

    // Authorization: Basic base64(consumerKey:consumerSecret)
    const basicAuth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const body = 'grant_type=client_credentials';

    const url = new URL(config.authEndpoint);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      pfx: pfxBuffer,
      passphrase: senha,
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Role-Type': roleType,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    console.log('[IntegraContador] Solicitando novo token (OAuth2 + mTLS)...');

    const resposta = await this._httpRequest(options, body);

    if (resposta.statusCode !== 200) {
      throw new Error(`Falha na autenticação SERPRO (HTTP ${resposta.statusCode}): ${resposta.body}`);
    }

    let payload;
    try {
      payload = JSON.parse(resposta.body);
    } catch (e) {
      throw new Error(`Resposta inválida do SERPRO: ${resposta.body}`);
    }

    if (!payload.access_token || !payload.jwt_token) {
      throw new Error(`Tokens ausentes na resposta SERPRO: ${JSON.stringify(payload)}`);
    }

    const expiresInMs = (payload.expires_in || 2008) * 1000;
    this.tokenCache = {
      accessToken: payload.access_token,
      jwtToken: payload.jwt_token,
      expiresAt: Date.now() + expiresInMs,
    };

    console.log(`[IntegraContador] Token obtido, expira em ${Math.round(expiresInMs / 1000)}s`);
    return this.tokenCache;
  }

  // -------------------------------------------------
  // Chamada genérica ao gateway
  // -------------------------------------------------

  /**
   * Executa uma chamada à API Integra Contador
   * @param {string} acao - 'Consultar' | 'Monitorar' | 'Declarar' | 'Apoiar' | 'Emitir'
   * @param {string} cnpjContribuinte - CNPJ do cliente (só dígitos, 14 chars)
   * @param {string} idSistema - Ex: 'PGDASD', 'PGMEI', 'DCTFWEB'
   * @param {string} idServico - Ex: 'CONSEXTRATO16'
   * @param {string} versaoSistema - Ex: '1.0'
   * @param {object} dadosPayload - Payload específico do serviço (será stringified)
   */
  async chamar(acao, cnpjContribuinte, idSistema, idServico, versaoSistema, dadosPayload) {
    if (!config.acoes[acao]) {
      throw new Error(`Ação inválida: ${acao}. Válidas: ${Object.keys(config.acoes).join(', ')}`);
    }

    const cnpjLimpo = String(cnpjContribuinte).replace(/\D/g, '');
    if (cnpjLimpo.length !== 14) {
      throw new Error(`CNPJ inválido: ${cnpjContribuinte}`);
    }

    const marcalCnpj = config.marcal.cnpj.replace(/\D/g, '');
    if (marcalCnpj.length !== 14) {
      throw new Error('MARCAL_CNPJ não configurado corretamente no .env (esperado 14 dígitos)');
    }

    const { accessToken, jwtToken } = await this.obterToken();
    const { pfxBuffer, senha } = this._carregarCertificadoMarcal();

    const payload = {
      contratante: { numero: marcalCnpj, tipo: config.tipoIdentificador.CNPJ },
      autorPedidoDados: { numero: marcalCnpj, tipo: config.tipoIdentificador.CNPJ },
      contribuinte: { numero: cnpjLimpo, tipo: config.tipoIdentificador.CNPJ },
      pedidoDados: {
        idSistema,
        idServico,
        versaoSistema,
        dados: typeof dadosPayload === 'string' ? dadosPayload : JSON.stringify(dadosPayload),
      },
    };

    const body = JSON.stringify(payload);
    const url = new URL(`${config.gatewayBaseUrl}${config.acoes[acao]}`);

    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      pfx: pfxBuffer,
      passphrase: senha,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'jwt_token': jwtToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    console.log(`[IntegraContador] ${acao} ${idSistema}/${idServico} para CNPJ ${cnpjLimpo}`);
    const resposta = await this._httpRequest(options, body);

    // 401 = token expirou no meio do caminho → renova e tenta uma vez
    if (resposta.statusCode === 401 && !dadosPayload.__retried) {
      console.log('[IntegraContador] Token expirou, renovando e retentando...');
      this.tokenCache = null;
      dadosPayload.__retried = true;
      return this.chamar(acao, cnpjContribuinte, idSistema, idServico, versaoSistema, dadosPayload);
    }

    let bodyParsed;
    try {
      bodyParsed = JSON.parse(resposta.body);
    } catch (e) {
      bodyParsed = { raw: resposta.body };
    }

    if (resposta.statusCode >= 400) {
      const msg = bodyParsed?.mensagem?.[0]?.texto || bodyParsed?.message || resposta.body;
      throw new Error(`SERPRO retornou HTTP ${resposta.statusCode}: ${msg}`);
    }

    return bodyParsed;
  }

  // -------------------------------------------------
  // Wrappers de alto nível (os mais comuns)
  // -------------------------------------------------

  /**
   * Emite/Gera guia DAS do Simples Nacional
   * @param {string} cnpjContribuinte
   * @param {string} periodoApuracao - Formato YYYYMM (ex: '202604' para abril/2026)
   * @returns {object} Retorno do SERPRO com a guia DAS (geralmente PDF base64)
   */
  async gerarDASSimples(cnpjContribuinte, periodoApuracao) {
    const servico = config.servicos.PGDASD.GERAR_DAS;
    const dados = { periodoApuracao };
    return await this.chamar('Emitir', cnpjContribuinte, 'PGDASD', servico.idServico, servico.versao, dados);
  }

  /**
   * Consulta extrato de um DAS específico
   * @param {string} cnpjContribuinte
   * @param {string} numeroDas - Número do DAS (17 dígitos)
   */
  async consultarExtratoDAS(cnpjContribuinte, numeroDas) {
    const servico = config.servicos.PGDASD.CONSULTAR_EXTRATO_DAS;
    const dados = { numeroDas };
    return await this.chamar('Consultar', cnpjContribuinte, 'PGDASD', servico.idServico, servico.versao, dados);
  }

  /**
   * Consulta última declaração PGDAS-D transmitida
   */
  async consultarUltimaDeclaracaoPGDASD(cnpjContribuinte, anoCalendario) {
    // CONSULTIMADECREC14 exige anoCalendario. Default: ano atual.
    const servico = config.servicos.PGDASD.CONSULTAR_ULTIMA_DECLARACAO;
    const ano = anoCalendario || String(new Date().getFullYear());
    return await this.chamar('Consultar', cnpjContribuinte, 'PGDASD', servico.idServico, servico.versao, { anoCalendario: ano });
  }

  /**
   * Gera DAS do MEI (em PDF)
   * @param {string} periodoApuracao - Formato YYYY (só o ano, MEI é anual por DAS mensal)
   */
  async gerarDASMEI(cnpjContribuinte, periodoApuracao) {
    const servico = config.servicos.PGMEI.GERAR_DAS_PDF;
    const dados = { periodoApuracao };
    return await this.chamar('Emitir', cnpjContribuinte, 'PGMEI', servico.idServico, servico.versao, dados);
  }

  /**
   * Consulta procurações eletrônicas vigentes do contribuinte
   * Útil pra validar se a procuração coletiva da Marçal ainda está ativa
   */
  async consultarProcuracoes(cnpjContribuinte) {
    const servico = config.servicos.PROCURACOES.OBTER_PROCURACAO;
    return await this.chamar('Consultar', cnpjContribuinte, 'PROCURACOES', servico.idServico, servico.versao, {});
  }

  /**
   * Lista mensagens da Caixa Postal do e-CAC (útil pra alertar a equipe)
   */
  async listarMensagensCaixaPostal(cnpjContribuinte) {
    // MSGCONTRIBUINTE61 e acao Consultar (nao Monitorar).
    // Pra monitoracao de novas mensagens existe INNOVAMSG63 (INDICADOR_MENSAGENS).
    const servico = config.servicos.CAIXAPOSTAL && config.servicos.CAIXAPOSTAL.LISTAR_MENSAGENS;
    if (!servico) throw new Error('CAIXAPOSTAL.LISTAR_MENSAGENS nao mapeado no config.');
    return await this.chamar('Consultar', cnpjContribuinte, 'CAIXAPOSTAL', servico.idServico, servico.versao, {});
  }

  /**
   * Consulta relação de DCTFWeb entregues
   */
  async consultarRelacaoDCTFWeb(cnpjContribuinte, periodoApuracao) {
    // CONSDECCOMPLETA33 exige anoPA + mesPA + categoria (nao periodoApuracao).
    // Categoria GERAL_MENSAL (codigo 11) = DCTFWeb mensal normal.
    const servico = config.servicos.DCTFWEB && config.servicos.DCTFWEB.CONSULTAR_DEC_COMPLETA;
    if (!servico) throw new Error('DCTFWEB.CONSULTAR_DEC_COMPLETA nao mapeado no config.');
    if (!periodoApuracao) {
      const d = new Date();
      const anoAlvo = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
      const mesAlvo = d.getMonth() === 0 ? 12 : d.getMonth();
      periodoApuracao = `${anoAlvo}${String(mesAlvo).padStart(2, '0')}`;
    }
    const anoPA = periodoApuracao.slice(0, 4);
    const mesPA = periodoApuracao.slice(4, 6);
    const dados = { anoPA, mesPA, categoria: 'GERAL_MENSAL' };
    return await this.chamar('Consultar', cnpjContribuinte, 'DCTFWEB', servico.idServico, servico.versao, dados);
  }


  /**
   * Gera DAS Simples Nacional em modalidade AVULSA (quando ha declaracao no periodo).
   */
  async gerarDASSimplesAvulso(cnpj, periodoApuracao) {
    const s = config.servicos.PGDASD.GERAR_DAS_AVULSO;
    return await this.chamar('Emitir', cnpj, 'PGDASD', s.idServico, s.versao, { periodoApuracao });
  }

  /**
   * Gera DAS Simples Nacional na modalidade COBRANCA da RFB (para reemissao).
   */
  async gerarDASSimplesCobranca(cnpj, periodoApuracao) {
    const s = config.servicos.PGDASD.GERAR_DAS_COBRANCA;
    return await this.chamar('Emitir', cnpj, 'PGDASD', s.idServico, s.versao, { periodoApuracao });
  }

  /**
   * Gera DARF via Sicalc — consolida os calculos e devolve o PDF.
   * @param {object} dados - { receita, periodoApuracao, vencimento, valorPrincipal, ... }
   *   Campos exatos no manual: https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador
   */
  async gerarDARF(cnpj, dados) {
    const s = config.servicos.SICALC.CONSOLIDAR_GERAR_DARF;
    return await this.chamar('Emitir', cnpj, 'SICALC', s.idServico, s.versao, dados);
  }

  /**
   * Gera Guia DCTFWeb — emite DARF com os debitos declarados em uma DCTFWeb.
   * @param {object} dados - { categoria, numDeclaracao, periodoApuracao, ... }
   */
  async gerarGuiaDCTFWeb(cnpj, dados) {
    const s = config.servicos.DCTFWEB.GERAR_GUIA;
    return await this.chamar('Emitir', cnpj, 'DCTFWEB', s.idServico, s.versao, dados);
  }

  /**
   * Consulta pagamentos feitos pelo contribuinte (util pra bater DARF pago).
   */
  async consultarPagamentos(cnpj, filtros = {}) {
    const s = config.servicos.PAGTOWEB.CONSULTAR_PAGAMENTOS;
    return await this.chamar('Consultar', cnpj, 'PAGTOWEB', s.idServico, s.versao, filtros);
  }

  /**
   * Emite Certificado de Condicao de MEI (CCMEI) em PDF.
   */
  async emitirCCMEI(cnpj) {
    const s = config.servicos.CCMEI.EMITIR_CCMEI;
    return await this.chamar('Emitir', cnpj, 'CCMEI', s.idServico, s.versao, {});
  }

  /**
   * SITFIS — Relatorio de Situacao Fiscal (substituto pro contador da Certidao Negativa).
   *
   * O servico e assincrono em duas etapas:
   *   1) SOLICITAR_PROTOCOLO — devolve um protocolo + tempo estimado em ms (tempoEspera)
   *   2) EMITIR_RELATORIO    — usa o protocolo; pode devolver 'em processamento' se chamado cedo demais
   *
   * Este wrapper orquestra os 2 passos com retry ate X minutos.
   *
   * @returns {{ pdfBase64: string|null, dados: object, protocolo: string, tentativas: number }}
   */
  async obterRelatorioSitfis(cnpj, opts = {}) {
    const maxTentativas = opts.maxTentativas || 6;
    const esperaPadraoMs = opts.esperaPadraoMs || 5000;

    // Passo 1 — solicita protocolo
    const sSol = config.servicos.SITFIS.SOLICITAR_PROTOCOLO;
    const respSol = await this.chamar('Apoiar', cnpj, 'SITFIS', sSol.idServico, sSol.versao, {});
    const dadosSol = this._parseDadosSerpro(respSol);
    const protocolo = dadosSol && (dadosSol.protocoloRelatorio || dadosSol.protocolo);
    if (!protocolo) {
      throw new Error(`SITFIS: resposta nao trouxe protocolo. Body: ${JSON.stringify(respSol).slice(0, 400)}`);
    }
    const tempoEsperaMs = Number(dadosSol.tempoEspera) || esperaPadraoMs;

    // Espera o tempo sugerido pelo SERPRO antes da primeira tentativa
    await new Promise(r => setTimeout(r, tempoEsperaMs));

    // Passo 2 — tenta emitir relatorio com retry
    const sEmit = config.servicos.SITFIS.EMITIR_RELATORIO;
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
      const respEmit = await this.chamar('Emitir', cnpj, 'SITFIS', sEmit.idServico, sEmit.versao, { protocoloRelatorio: protocolo });
    const dadosEmit = this._parseDadosSerpro(respEmit);
      // Se devolveu PDF base64, terminou
      const pdfBase64 = dadosEmit && (dadosEmit.pdf || dadosEmit.relatorio);
      if (pdfBase64 && typeof pdfBase64 === 'string' && pdfBase64.length > 100) {
        return { pdfBase64, dados: dadosEmit, protocolo, tentativas: tentativa };
      }
      // Caso 'em processamento' — aguarda e retenta
      const aguardarMs = Number(dadosEmit && dadosEmit.tempoEspera) || esperaPadraoMs;
      console.log(`[IntegraContador] SITFIS ${cnpj} tentativa ${tentativa}/${maxTentativas} ainda processando, aguardando ${aguardarMs}ms...`);
      await new Promise(r => setTimeout(r, aguardarMs));
    }

    throw new Error(`SITFIS: protocolo ${protocolo} nao ficou pronto em ${maxTentativas} tentativas`);
  }

  /**
   * Helper pra extrair o campo 'dados' da resposta SERPRO (pode vir como objeto ou string JSON).
   */
  _parseDadosSerpro(resposta) {
    if (!resposta) return null;
    let d = resposta.dados;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { /* mantem string */ }
    }
    return d;
  }


  // -------------------------------------------------
  // Helpers internos
  // -------------------------------------------------

  /**
   * Carrega o e-CNPJ A1 da Marçal (pfx + senha descriptografada).
   *
   * Estratégia de lookup (em ordem):
   *   1) Procura cliente na tabela `clientes` cujo CNPJ == MARCAL_CNPJ
   *      — se tiver cert já cadastrado (pela tela de Certificados), reutiliza.
   *   2) Fallback: slot dedicado em CERTIFICADOS_DIR/escritorio_marcal.pfx
   *      com senha em MARCAL_CERT_SENHA_ENCRYPTED (pra quem não quer cadastrar
   *      a Marçal como cliente).
   */
  _carregarCertificadoMarcal() {
    const fontes = this._localizarFontesCertificado();

    // Estratégia 1: cliente Marçal cadastrado no sistema
    if (fontes.clienteMarcal) {
      const c = fontes.clienteMarcal;
      console.log(`[IntegraContador] Carregando cert via cliente Marçal (id=${c.id}): ${c.certificado_a1_path}`);
      const cert = certificadoService.carregarCertificado(c.id, c.certificado_a1_senha_encrypted);
      return { pfxBuffer: cert.pfxBuffer, senha: cert.senha, fonte: 'cliente_marcal' };
    }

    // Estratégia 2: slot dedicado (legado)
    if (fontes.slotDedicado.existe && fontes.slotDedicado.senhaConfig) {
      const pfxBuffer = fs.readFileSync(fontes.slotDedicado.path);
      const senha = certificadoService.decryptPassword(process.env.MARCAL_CERT_SENHA_ENCRYPTED);
      console.log(`[IntegraContador] Carregando cert via slot dedicado: ${fontes.slotDedicado.path}`);
      return { pfxBuffer, senha, fonte: 'slot_dedicado' };
    }

    // Nada encontrado — monta mensagem de erro clara
    const msgs = [];
    if (!fontes.marcalCnpjConfigurado) {
      msgs.push('MARCAL_CNPJ não configurada no .env');
    } else {
      msgs.push(`Nenhum cliente encontrado com CNPJ ${config.marcal.cnpj} (ou o cliente existe mas não tem certificado A1 anexado)`);
    }
    msgs.push('E o slot dedicado (escritorio_marcal.pfx + MARCAL_CERT_SENHA_ENCRYPTED) também não está configurado');
    throw new Error(`Certificado Marçal não localizado. ${msgs.join('. ')}.`);
  }

  /**
   * Diagnóstico: mostra as fontes disponíveis de certificado (pra UI de status)
   */
  _localizarFontesCertificado() {
    const marcalCnpjRaw = (config.marcal.cnpj || '').replace(/\D/g, '');
    const marcalCnpjConfigurado = marcalCnpjRaw.length === 14;

    let clienteMarcal = null;
    if (marcalCnpjConfigurado) {
      try {
        const db = getDb();
        clienteMarcal = db.prepare(`
          SELECT id, razao_social, cnpj, certificado_a1_path, certificado_a1_senha_encrypted,
                 certificado_validade
          FROM clientes
          WHERE REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
            AND certificado_a1_path IS NOT NULL
            AND certificado_a1_senha_encrypted IS NOT NULL
            AND ativo = 1
          LIMIT 1
        `).get(marcalCnpjRaw);
      } catch (e) {
        console.warn('[IntegraContador] Erro buscando cliente Marçal:', e.message);
      }
    }

    const slotPath = path.join(nfseConfig.certificadosDir, `${config.marcal.certSlotId}.pfx`);
    const slotExiste = fs.existsSync(slotPath);

    return {
      marcalCnpjConfigurado,
      clienteMarcal,
      slotDedicado: {
        path: slotPath,
        existe: slotExiste,
        senhaConfig: !!process.env.MARCAL_CERT_SENHA_ENCRYPTED,
      },
    };
  }

  /**
   * Retorna info de diagnóstico das fontes — usado pelo endpoint /status
   */
  diagnosticarFontesCertificado() {
    const f = this._localizarFontesCertificado();
    return {
      marcal_cnpj_configurado: f.marcalCnpjConfigurado,
      via_cliente_marcal: !!f.clienteMarcal,
      cliente_marcal: f.clienteMarcal ? {
        id: f.clienteMarcal.id,
        razao_social: f.clienteMarcal.razao_social,
        cnpj: f.clienteMarcal.cnpj,
        titular: null,
        validade: f.clienteMarcal.certificado_validade,
      } : null,
      via_slot_dedicado: f.slotDedicado.existe && f.slotDedicado.senhaConfig,
      slot_dedicado: f.slotDedicado,
    };
  }

  /**
   * Requisição HTTPS de baixo nível com mTLS
   */
  _httpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = new IntegraContadorService();
