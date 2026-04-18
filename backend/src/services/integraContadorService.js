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
  async consultarUltimaDeclaracaoPGDASD(cnpjContribuinte) {
    const servico = config.servicos.PGDASD.CONSULTAR_ULTIMA_DECLARACAO;
    return await this.chamar('Consultar', cnpjContribuinte, 'PGDASD', servico.idServico, servico.versao, {});
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
    const servico = config.servicos.CAIXAPOSTAL.LISTAR_MENSAGENS;
    return await this.chamar('Monitorar', cnpjContribuinte, 'CAIXAPOSTAL', servico.idServico, servico.versao, {});
  }

  /**
   * Consulta relação de DCTFWeb entregues
   */
  async consultarRelacaoDCTFWeb(cnpjContribuinte) {
    const servico = config.servicos.DCTFWEB.CONSULTAR_RELACAO;
    return await this.chamar('Consultar', cnpjContribuinte, 'DCTFWEB', servico.idServico, servico.versao, {});
  }

  // -------------------------------------------------
  // Helpers internos
  // -------------------------------------------------

  /**
   * Carrega o e-CNPJ A1 da Marçal (pfx + senha descriptografada)
   * O certificado é salvo em CERTIFICADOS_DIR/escritorio_marcal.pfx
   * e a senha criptografada fica na tabela configuracoes_escritorio.
   */
  _carregarCertificadoMarcal() {
    const certPath = path.join(nfseConfig.certificadosDir, `${config.marcal.certSlotId}.pfx`);

    if (!fs.existsSync(certPath)) {
      throw new Error(`Certificado e-CNPJ da Marçal não encontrado em ${certPath}. Faça o upload via painel do escritório (Configurações → Certificado SERPRO).`);
    }

    const senhaEnc = process.env.MARCAL_CERT_SENHA_ENCRYPTED;
    if (!senhaEnc) {
      throw new Error('MARCAL_CERT_SENHA_ENCRYPTED não configurada. Faça o upload do certificado pelo painel pra gerar.');
    }

    const pfxBuffer = fs.readFileSync(certPath);
    const senha = certificadoService.decryptPassword(senhaEnc);

    return { pfxBuffer, senha };
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
