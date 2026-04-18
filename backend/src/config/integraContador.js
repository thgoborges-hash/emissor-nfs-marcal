// =====================================================
// Configuração da API Integra Contador (SERPRO/RFB)
// OAuth2 + mTLS com e-CNPJ da Marçal
// =====================================================
// Docs oficiais: https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/

const config = {
  // Endpoint de autenticação (gera access_token + jwt_token)
  authEndpoint: 'https://autenticacao.sapi.serpro.gov.br/authenticate',

  // Gateway base das chamadas à API
  gatewayBaseUrl: 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1',

  // Ações disponíveis no Integra Contador (paths relativos ao gateway)
  acoes: {
    Consultar: '/Consultar',
    Monitorar: '/Monitorar',
    Declarar: '/Declarar',
    Apoiar: '/Apoiar',
    Emitir: '/Emitir',
  },

  // Tipos de identificador do contratante/contribuinte
  tipoIdentificador: {
    CPF: 1,
    CNPJ: 2,
  },

  // Credenciais vindas do ambiente (definidas após contratação no SERPRO)
  credenciais: {
    consumerKey: process.env.SERPRO_CONSUMER_KEY || '',
    consumerSecret: process.env.SERPRO_CONSUMER_SECRET || '',
    roleType: 'TERCEIROS', // tipo de acesso pra escritórios contábeis
  },

  // CNPJ do escritório (contratante + autor do pedido)
  // Procuração coletiva: a Marçal opera em nome de toda a carteira com esse CNPJ
  marcal: {
    cnpj: process.env.MARCAL_CNPJ || '',
    // O certificado e-CNPJ A1 da Marçal é carregado pelo certificadoService
    // na chave 'escritorio_marcal' (vide _carregarCertificadoMarcal)
    certSlotId: 'escritorio_marcal',
  },

  // Catálogo de serviços por domínio — referência rápida dos idSistema/idServico
  // Lista completa: https://apicenter.estaleiro.serpro.gov.br/documentacao/api-integra-contador/pt/catalogo_de_servicos/
  servicos: {
    // Simples Nacional (PGDAS-D)
    PGDASD: {
      CONSULTAR_EXTRATO_DAS: { idServico: 'CONSEXTRATO16', versao: '1.0' },
      TRANSMITIR_DECLARACAO: { idServico: 'TRANSDECLARACAO11', versao: '1.0' },
      GERAR_DAS: { idServico: 'GERARDAS12', versao: '1.0' },
      CONSULTAR_DECLARACOES: { idServico: 'CONSDECLARACAO13', versao: '1.0' },
      CONSULTAR_ULTIMA_DECLARACAO: { idServico: 'CONSULTIMADECREC14', versao: '1.0' },
      CONSULTAR_DECLARACAO_NUMERO: { idServico: 'CONSDECREC15', versao: '1.0' },
    },
    // MEI (PGMEI)
    PGMEI: {
      GERAR_DAS_PDF: { idServico: 'GERARDASPDF21', versao: '1.0' },
      GERAR_DAS_COBRANCA: { idServico: 'GERARDASCOBRANCA22', versao: '1.0' },
      ATUALIZAR_BENEFICIO: { idServico: 'ATUBENEFICIO24', versao: '1.0' },
      CONSULTAR_DIVIDA: { idServico: 'DIVIDAATIVA23', versao: '1.0' },
    },
    // DCTFWeb
    DCTFWEB: {
      CONSULTAR_XML_DECLARACAO: { idServico: 'XMLDECLARACAO101', versao: '1.0' },
      CONSULTAR_RECIBO: { idServico: 'CONSRECIBO102', versao: '1.0' },
      CONSULTAR_RELACAO: { idServico: 'CONSRELDEC103', versao: '1.0' },
      TRANSMITIR_DECLARACAO: { idServico: 'TRANSDECLARACAO111', versao: '1.0' },
      GERAR_GUIA: { idServico: 'GERARGUIA112', versao: '1.0' },
    },
    // Procurações Eletrônicas
    PROCURACOES: {
      OBTER_PROCURACAO: { idServico: 'OBTERPROCURACAO41', versao: '1.0' },
    },
    // Sicalc (emissão de DARF)
    SICALC: {
      CONSOLIDAR_GERAR_DARF: { idServico: 'CONSOLIDARGERARDARF51', versao: '1.0' },
      CONSULTAR_APOIO: { idServico: 'CONSULTAAPOIORECEITAS52', versao: '1.0' },
    },
    // Situação Fiscal (Sitfis)
    SITFIS: {
      SOLICITAR_PROTOCOLO: { idServico: 'SOLICITARPROTOCOLO91', versao: '1.0' },
      EMITIR_RELATORIO: { idServico: 'RELATORIOSITFIS92', versao: '1.0' },
    },
    // Caixa Postal e-CAC
    CAIXAPOSTAL: {
      LISTAR_MENSAGENS: { idServico: 'MSGCONTRIBUINTE61', versao: '1.0' },
      OBTER_MENSAGEM: { idServico: 'MSGESPECIFICA62', versao: '1.0' },
      INDICADOR_MENSAGENS: { idServico: 'INDICADORMSG63', versao: '1.0' },
    },
  },
};

// Sanity check — avisa se credenciais não foram configuradas (mas não crasha)
if (!config.credenciais.consumerKey || !config.credenciais.consumerSecret) {
  console.warn('[IntegraContador] SERPRO_CONSUMER_KEY/SECRET não configurados. Chamadas à API vão falhar até contratar na loja SERPRO.');
}

if (!config.marcal.cnpj) {
  console.warn('[IntegraContador] MARCAL_CNPJ não configurado no .env.');
}

module.exports = config;
