// =====================================================
// Configuração da API SIEG (nova API — ativa até 31/07/2026
// a antiga é depreciada nesta data)
// =====================================================
// Docs: https://sieg.movidesk.com/kb/pt-br/article/356445

const config = {
  // Endpoint de download em lote (retorna JSON com array de XMLs em base64)
  downloadEndpoint: 'https://api.sieg.com/BaixarXmls',

  // Endpoint de upload (envio de XMLs pro cofre)
  uploadEndpoint: 'https://up.sieg.com/aws/api-xml.ashx',

  // API Key — gerada em: SIEG → Minha Conta → Integrações API SIEG
  // Validade recomendada: 60 meses, permissão Full Access
  apiKey: process.env.SIEG_API_KEY || '',

  // Email da conta SIEG (pareamento)
  email: process.env.SIEG_EMAIL || '',

  // Tipos de documento fiscal suportados (XMLType na API)
  tipoDocumento: {
    NFE: 55,    // Nota Fiscal Eletrônica (saída/entrada)
    NFCE: 65,   // Nota Fiscal do Consumidor Eletrônica
    CTE: 57,    // Conhecimento de Transporte Eletrônico
    CFESAT: 59, // CF-e SAT
    NFSE: 99,   // Nota Fiscal de Serviços (varia por município)
  },

  // Limites da API
  limites: {
    // A API retorna até 50 XMLs por chamada (docs oficiais)
    xmlsPorChamada: 50,
    // Timeout conservador por request
    timeoutMs: 30000,
    // Delay entre chamadas pra não estourar rate limit
    delayEntreChamadasMs: 1500,
  },

  // Configuração do worker de sincronização diária
  sync: {
    // Cron: diariamente às 06:30 (puxa o que caiu na SEFAZ na madrugada)
    cronSchedule: process.env.SIEG_SYNC_CRON || '30 6 * * *',
    // Janela de busca — 7 dias pra trás na primeira sync, depois 1 dia nas diárias
    janelaInicialDias: 7,
    janelaDiariaDias: 1,
    habilitado: process.env.SIEG_SYNC_ENABLED === 'true',
  },
};

if (!config.apiKey) {
  console.warn('[SIEG] SIEG_API_KEY não configurada. Gere em sieg.com.br → Minha Conta → Integrações API SIEG.');
}

module.exports = config;
