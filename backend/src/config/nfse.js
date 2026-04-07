// =====================================================
// Configuração da API NFS-e Nacional
// =====================================================

const AMBIENTES = {
  homologacao: {
    nome: 'Produção Restrita (Homologação)',
    baseUrl: 'https://sefin.producaorestrita.nfse.gov.br',
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    danfse: 'https://sefin.producaorestrita.nfse.gov.br/danfse',
  },
  producao: {
    nome: 'Produção',
    baseUrl: 'https://sefin.nfse.gov.br',
    sefin: 'https://sefin.nfse.gov.br/SefinNacional',
    danfse: 'https://sefin.nfse.gov.br/danfse',
  }
};

// Ambiente ativo (mudar para 'producao' quando estiver pronto)
const AMBIENTE_ATIVO = process.env.NFSE_AMBIENTE || 'homologacao';

const config = {
  ambiente: AMBIENTES[AMBIENTE_ATIVO],
  ambienteNome: AMBIENTE_ATIVO,

  // Endpoints da API NFS-e Nacional (relativos ao sefin/SefinNacional)
  // Ref: https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/docs/index
  endpoints: {
    // POST /nfse - Recepciona a DPS e Gera a NFS-e de forma síncrona
    enviarDPS: '/nfse',
    // GET /dps/{id} - Consulta DPS (retorna chave de acesso)
    consultarDPS: '/dps',
    // HEAD /dps/{id} - Verifica se DPS já virou NFS-e
    verificarDPS: '/dps',

    // GET /nfse/{chaveAcesso} - Consulta NFS-e
    consultarNFSe: '/nfse',

    // POST /nfse/{chaveAcesso}/eventos - Registra evento (cancelamento, substituição)
    enviarEvento: '/nfse',
    // GET /nfse/{chaveAcesso}/eventos - Consulta eventos
    consultarEventos: '/nfse',

    // DANFSe (PDF) - GET /danfse/{chaveAcesso}
    danfse: '/danfse',

    // Parâmetros municipais
    parametrosMunicipais: '/parametros-municipais',
  },

  // Configurações de assinatura XML
  xmldsig: {
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transformAlgorithm: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  },

  // Versão do layout
  versaoLayout: '1.00',

  // Timeout das requisições (ms)
  timeout: 30000,

  // Diretório de armazenamento de certificados
  certificadosDir: process.env.CERTIFICADOS_DIR || '/app/data/certificados',

  // Chave para criptografar senhas dos certificados
  encryptionKey: process.env.CERT_ENCRYPTION_KEY || 'marcal-contabilidade-dev-key-change-in-prod',
};

module.exports = config;
