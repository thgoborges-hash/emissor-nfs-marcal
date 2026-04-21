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
      GERAR_DAS_COBRANCA: { idServico: 'GERARDASCOBRANCA17', versao: '1.0' },
      GERAR_DAS_PROCESSO: { idServico: 'GERARDASPROCESSO18', versao: '1.0' },
      GERAR_DAS_AVULSO: { idServico: 'GERARDASAVULSO19', versao: '1.0' },
      CONSULTAR_DECLARACOES: { idServico: 'CONSDECLARACAO13', versao: '1.0' },
      CONSULTAR_ULTIMA_DECLARACAO: { idServico: 'CONSULTIMADECREC14', versao: '1.0' },
      CONSULTAR_DECLARACAO_NUMERO: { idServico: 'CONSDECREC15', versao: '1.0' },
    },
    // Regime de Apuracao (caixa/competencia)
    REGIMEAPURACAO: {
      EFETUAR_OPCAO: { idServico: 'EFETUAROPCAOREGIME101', versao: '1.0' },
      CONSULTAR_ANOS: { idServico: 'CONSULTARANOSCALENDARIOS102', versao: '1.0' },
      CONSULTAR_OPCAO: { idServico: 'CONSULTAROPCAOREGIME103', versao: '1.0' },
      CONSULTAR_RESOLUCAO: { idServico: 'CONSULTARRESOLUCAO104', versao: '1.0' },
    },
    // DEFIS
    DEFIS: {
      TRANSMITIR_DECLARACAO: { idServico: 'TRANSDECLARACAO141', versao: '1.0' },
      CONSULTAR_DECLARACOES: { idServico: 'CONSDECLARACAO142', versao: '1.0' },
      CONSULTAR_ULTIMA_DECLARACAO: { idServico: 'CONSULTIMADECREC143', versao: '1.0' },
      CONSULTAR_DECLARACAO_NUMERO: { idServico: 'CONSDECREC144', versao: '1.0' },
    },
    // MEI (PGMEI)
    PGMEI: {
      GERAR_DAS_PDF: { idServico: 'GERARDASPDF21', versao: '1.0' },
      GERAR_DAS_COBRANCA: { idServico: 'GERARDASCODBARRA22', versao: '1.0' },
      ATUALIZAR_BENEFICIO: { idServico: 'ATUBENEFICIO23', versao: '1.0' },
      CONSULTAR_DIVIDA: { idServico: 'DIVIDAATIVA24', versao: '1.0' },
    },
    // CCMEI (Certificado de Condicao MEI)
    CCMEI: {
      EMITIR_CCMEI: { idServico: 'EMITIRCCMEI121', versao: '1.0' },
      DADOS_CCMEI: { idServico: 'DADOSCCMEI122', versao: '1.0' },
      SIT_CADASTRAL: { idServico: 'CCMEISITCADASTRAL123', versao: '1.0' },
    },
    // DASN-SIMEI (Declaracao Anual MEI)
    DASNSIMEI: {
      TRANSMITIR_DECLARACAO: { idServico: 'TRANSDECLARACAO151', versao: '1.0' },
      CONSULTAR_ULTIMA_DECLARACAO: { idServico: 'CONSULTIMADECREC152', versao: '1.0' },
      GERAR_DAS_EXCESSO: { idServico: 'GERARDASEXCESSO153', versao: '1.0' },
    },
    // DCTFWeb
    DCTFWEB: {
      GERAR_GUIA: { idServico: 'GERARGUIA31', versao: '1.0' },
      GERAR_GUIA_MAED: { idServico: 'GERARGUIAMAED36', versao: '1.0' },
      GERAR_GUIA_ANDAMENTO: { idServico: 'GERARGUIAANDAMENTO313', versao: '1.0' },
      GERAR_GUIA_ABATIMENTO: { idServico: 'GERARGUIACOMABATIMENTO311', versao: '1.0' },
      CONSULTAR_RECIBO: { idServico: 'CONSRECIBO32', versao: '1.0' },
      CONSULTAR_DEC_COMPLETA: { idServico: 'CONSDECCOMPLETA33', versao: '1.0' },
      CONSULTAR_REL_CREDITO: { idServico: 'CONSRELCREDITO34', versao: '1.0' },
      CONSULTAR_REL_DEBITO: { idServico: 'CONSRELDEBITO35', versao: '1.0' },
      CONSULTAR_XML_DECLARACAO: { idServico: 'CONSXMLDECLARACAO38', versao: '1.0' },
      CONSULTAR_NOTIF_MAED: { idServico: 'CONSNOTIFMAED37', versao: '1.0' },
      APLICAR_VINCULACAO: { idServico: 'APLVINCULACAO39', versao: '1.0' },
      TRANSMITIR_DECLARACAO: { idServico: 'TRANSDECLARACAO310', versao: '1.0' },
      EDITAR_VALOR_SUSPENSO: { idServico: 'EDITARVALORSUSPENSO312', versao: '1.0' },
    },
    // MIT (Modulo de Inclusao de Tributos)
    MIT: {
      ENCERRAR_APURACAO: { idServico: 'ENCAPURACAO314', versao: '1.0' },
      SITUACAO_ENCERRAMENTO: { idServico: 'SITUACAOENC315', versao: '1.0' },
      CONSULTAR_APURACAO: { idServico: 'CONSAPURACAO316', versao: '1.0' },
      LISTAR_APURACOES: { idServico: 'LISTAAPURACOES317', versao: '1.0' },
    },
    // Procuracoes Eletronicas
    PROCURACOES: {
      OBTER_PROCURACAO: { idServico: 'OBTERPROCURACAO41', versao: '1.0' },
    },
    // Sicalc (emissao de DARF)
    SICALC: {
      CONSOLIDAR_GERAR_DARF: { idServico: 'CONSOLIDARGERARDARF51', versao: '1.0' },
      CONSULTAR_APOIO: { idServico: 'CONSULTAAPOIORECEITAS52', versao: '1.0' },
      GERAR_DARF_CODBARRA: { idServico: 'GERARDARFCODBARRA53', versao: '1.0' },
      CONSOLIDAR_SEM_EMITIR: { idServico: 'CONSOLIDAR54', versao: '1.0' },
    },
    // Situacao Fiscal (Sitfis) - substituto da Certidao Negativa
    SITFIS: {
      SOLICITAR_PROTOCOLO: { idServico: 'SOLICITARPROTOCOLO91', versao: '1.0' },
      EMITIR_RELATORIO: { idServico: 'RELATORIOSITFIS92', versao: '1.0' },
    },
    // Caixa Postal e-CAC
    CAIXAPOSTAL: {
      LISTAR_MENSAGENS: { idServico: 'MSGCONTRIBUINTE61', versao: '1.0' },
      OBTER_MENSAGEM: { idServico: 'MSGDETALHAMENTO62', versao: '1.0' },
      INDICADOR_MENSAGENS: { idServico: 'INNOVAMSG63', versao: '1.0' },
    },
    // DTE (Domicilio Tributario Eletronico)
    DTE: {
      CONSULTA_SITUACAO: { idServico: 'CONSULTASITUACAODTE111', versao: '1.0' },
    },
    // PAGTOWEB (Consulta de Pagamentos)
    PAGTOWEB: {
      CONSULTAR_PAGAMENTOS: { idServico: 'PAGAMENTOS71', versao: '1.0' },
      EMITIR_COMPROVANTE: { idServico: 'COMPARRECADACAO72', versao: '1.0' },
      CONTAR_PAGAMENTOS: { idServico: 'CONTACONSDOCARRPG73', versao: '1.0' },
    },
    // Parcelamentos (gerador de DAS por modalidade)
    PARCSN: { GERAR_DAS: { idServico: 'GERARDAS161', versao: '1.0' }, LISTAR_PARCELAS: { idServico: 'PARCELASPARAGERAR162', versao: '1.0' }, LISTAR_PEDIDOS: { idServico: 'PEDIDOSPARC163', versao: '1.0' } },
    PARCSN_ESP: { GERAR_DAS: { idServico: 'GERARDAS171', versao: '1.0' } },
    PERTSN:    { GERAR_DAS: { idServico: 'GERARDAS181', versao: '1.0' } },
    RELPSN:    { GERAR_DAS: { idServico: 'GERARDAS191', versao: '1.0' } },
    PARCMEI:   { GERAR_DAS: { idServico: 'GERARDAS201', versao: '1.0' }, LISTAR_PARCELAS: { idServico: 'PARCELASPARAGERAR202', versao: '1.0' } },
    PARCMEI_ESP: { GERAR_DAS: { idServico: 'GERARDAS211', versao: '1.0' } },
    PERTMEI:   { GERAR_DAS: { idServico: 'GERARDAS221', versao: '1.0' } },
    RELPMEI:   { GERAR_DAS: { idServico: 'GERARDAS231', versao: '1.0' } },
    // Eventos de atualizacao cadastral (assincrono em lote)
    EVENTOSATUALIZACAO: {
      SOLIC_EVENTOS_PF: { idServico: 'SOLICEVENTOSPF131', versao: '1.0' },
      SOLIC_EVENTOS_PJ: { idServico: 'SOLICEVENTOSPJ132', versao: '1.0' },
      OBTER_EVENTOS_PF: { idServico: 'OBTEREVENTOSPF133', versao: '1.0' },
      OBTER_EVENTOS_PJ: { idServico: 'OBTEREVENTOSPJ134', versao: '1.0' },
    },
    // Redesim (vinculos do contador)
    PNRCONTADOR: {
      CONSULTAR_VINCULOS: { idServico: 'CONSVINCULOS261', versao: '1.0' },
      SOLICITAR_RENUNCIA: { idServico: 'SOLICRENUNCIA262', versao: '1.0' },
      CONSULTAR_RENUNCIAS: { idServico: 'CONSRENUNCIA263', versao: '1.0' },
      COMPROVANTE_RENUNCIA: { idServico: 'COMPRENUNCIA264', versao: '1.0' },
      SITUACAO_RENUNCIA: { idServico: 'SITSOLICRENUNCIA265', versao: '1.0' },
    },
    // e-Processo (processos administrativos)
    EPROCESSO: {
      CONSULTAR_PROCESSOS: { idServico: 'CONSPROCPORINTER271', versao: '1.0' },
      LISTAR_DOCUMENTOS: { idServico: 'OBTLISTDOCSPROC272', versao: '1.0' },
      OBTER_DOCUMENTO: { idServico: 'OBTDOCPROC273', versao: '1.0' },
      CONSULTAR_COMUNICADOS: { idServico: 'CONSCOMUNINTIM274', versao: '1.0' },
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
