// =====================================================
// Configuracao da API Dominio (Thomson Reuters / Onvio)
// =====================================================
// Credenciais vem do Render (env vars):
//   DOMINIO_CLIENT_ID
//   DOMINIO_CLIENT_SECRET
//
// Fluxo OAuth2 (client_credentials) -> token
// Upload: multipart/form-data com x-integration-key por cliente
// =====================================================

module.exports = {
  clientId:     process.env.DOMINIO_CLIENT_ID     || '',
  clientSecret: process.env.DOMINIO_CLIENT_SECRET || '',

  // OAuth2 auth server (Thomson Reuters)
  tokenEndpoint: process.env.DOMINIO_TOKEN_ENDPOINT || 'https://auth.thomsonreuters.com/oauth/token',
  audience:      process.env.DOMINIO_AUDIENCE      || '409f91f6-dc17-44c8-a5d8-e0a1bafd8b67',

  // API Onvio (Dominio)
  apiBase: process.env.DOMINIO_API_BASE || 'https://api.onvio.com.br/dominio',

  // Cookie fixo usado pelos exemplos oficiais (did anonimo de rastreio)
  cookie: process.env.DOMINIO_COOKIE || 'did=s%3Av0%3A145b8a90-ea57-11eb-ae8a-877f15a4a518.QhUcTCGsMP28yWAB%2BYsUUZ5Gw4Srxf%2F0IDRkKPUQQHs; did_compat=s%3Av0%3A145b8a90-ea57-11eb-ae8a-877f15a4a518.QhUcTCGsMP28yWAB%2BYsUUZ5Gw4Srxf%2F0IDRkKPUQQHs',

  // Se true: envia XML marcado pra guardar no Boxe tambem (storage do cliente).
  // Se false: s6 escritura na contabilidade.
  defaultBoxeFile: String(process.env.DOMINIO_BOXE_FILE_DEFAULT || 'false').toLowerCase() === 'true',
};
