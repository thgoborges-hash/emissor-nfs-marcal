// =====================================================
// Servico API Dominio (Thomson Reuters / Onvio)
// OAuth2 client_credentials + upload multipart de XML + consulta de lote
// =====================================================
// Docs publicas: https://www.dominiosistemas.com.br/lp-centraldodesenvolvedor-api/
// Contato: api.dominio@thomsonreuters.com
// =====================================================

const config = require('../config/dominio');
const { getDb } = require('../database/init');

class DominioService {
  constructor() {
    this.tokenCache = null;
    this.expiryBufferMs = 60 * 1000; // renova 60s antes de expirar
  }

  _assertCredenciais() {
    if (!config.clientId || !config.clientSecret) {
      throw new Error('DOMINIO_CLIENT_ID/CLIENT_SECRET nao configurados. Setar no Render e redeployar.');
    }
  }

  // ------------------------------------------------------------------
  // OAuth2 client_credentials -> access_token
  // ------------------------------------------------------------------
  async obterToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + this.expiryBufferMs) {
      return this.tokenCache.accessToken;
    }
    this._assertCredenciais();

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: config.audience,
    });

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': config.cookie,
    };

    const resp = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    const texto = await resp.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* deixa raw */ }

    if (!resp.ok) {
      const msg = (json && (json.error_description || json.error)) || texto;
      throw new Error(`Falha na autenticacao Dominio (${resp.status}): ${msg}`);
    }

    const accessToken = json && json.access_token;
    const expiresIn = (json && json.expires_in) || 3600;
    if (!accessToken) throw new Error('Dominio nao retornou access_token');

    this.tokenCache = {
      accessToken,
      expiresAt: Date.now() + (expiresIn * 1000),
    };
    return accessToken;
  }

  // ------------------------------------------------------------------
  // Verifica se a integration key esta ativa e retorna CNPJs vinculados
  // ------------------------------------------------------------------
  async verificarAtivacao(integrationKey) {
    const token = await this.obterToken();
    const url = `${config.apiBase}/integration/v1/activation/info`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-integration-key': integrationKey,
      },
    });
    const texto = await resp.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* */ }
    if (!resp.ok) {
      throw new Error(`Dominio activation/info (${resp.status}): ${(json && json.message) || texto}`);
    }
    return json; // { accountantOfficeNationalIdentity, clientNationalIdentity, ... }
  }

  // ------------------------------------------------------------------
  // Gera/regenera a integration key apos ativacao
  // ------------------------------------------------------------------
  async gerarIntegrationKey(integrationKeyInicial) {
    const token = await this.obterToken();
    const url = `${config.apiBase}/integration/v1/activation/enable`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-integration-key': integrationKeyInicial,
      },
    });
    const texto = await resp.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* */ }
    if (!resp.ok) {
      throw new Error(`Dominio activation/enable (${resp.status}): ${(json && json.message) || texto}`);
    }
    return (json && json.integrationKey) || null;
  }

  // ------------------------------------------------------------------
  // Envia XML (NFe / NFS-e / NFC-e / CT-e / CF-e / Baixa) para processamento
  // ------------------------------------------------------------------
  async enviarXml({ integrationKey, xmlBuffer, filename, boxeFile = null }) {
    const token = await this.obterToken();
    const url = `${config.apiBase}/invoice/v3/batches`;

    const useBoxe = (boxeFile === null) ? config.defaultBoxeFile : !!boxeFile;

    const form = new FormData();
    form.append('query', JSON.stringify({ 'boxe/File': useBoxe }));
    form.append('file[]', new Blob([xmlBuffer], { type: 'application/xml' }), filename || 'arquivo.xml');

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-integration-key': integrationKey,
      },
      body: form,
    });

    const texto = await resp.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* */ }
    if (!resp.ok) {
      throw new Error(`Dominio envio XML (${resp.status}): ${(json && json.message) || texto}`);
    }
    return json; // { id: '...', ... }
  }

  // ------------------------------------------------------------------
  // Consulta status de um lote (pos envio)
  // ------------------------------------------------------------------
  async consultarLote(integrationKey, loteId) {
    const token = await this.obterToken();
    const url = `${config.apiBase}/invoice/v3/batches/${encodeURIComponent(loteId)}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-integration-key': integrationKey,
      },
    });
    const texto = await resp.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* */ }
    if (!resp.ok) {
      throw new Error(`Dominio consulta lote (${resp.status}): ${(json && json.message) || texto}`);
    }
    return json; // { filesExpanded: [...], apiStatus, ... }
  }

  // ------------------------------------------------------------------
  // Helpers de DB: busca integration key do cliente
  // ------------------------------------------------------------------
  buscarIntegrationKeyDoCliente(clienteId) {
    const db = getDb();
    const row = db.prepare('SELECT dominio_integration_key FROM clientes WHERE id = ?').get(clienteId);
    return row && row.dominio_integration_key;
  }

  gravarIntegrationKeyDoCliente(clienteId, integrationKey) {
    const db = getDb();
    db.prepare('UPDATE clientes SET dominio_integration_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(integrationKey || null, clienteId);
  }

  // Status geral do servico pra UI
  async statusGeral() {
    const configurado = !!(config.clientId && config.clientSecret);
    const resultado = {
      configurado,
      endpoint_token: config.tokenEndpoint,
      endpoint_api: config.apiBase,
      token_cache: !!this.tokenCache,
      token_expira_em: this.tokenCache ? new Date(this.tokenCache.expiresAt).toISOString() : null,
    };
    if (!configurado) {
      resultado.aviso = 'Set DOMINIO_CLIENT_ID/CLIENT_SECRET no Render.';
      return resultado;
    }
    try {
      await this.obterToken();
      resultado.autenticacao = 'ok';
    } catch (err) {
      resultado.autenticacao = 'erro';
      resultado.erro = err.message;
    }
    return resultado;
  }
}

module.exports = new DominioService();
