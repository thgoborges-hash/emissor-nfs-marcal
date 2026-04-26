/**
 * oneDriveService.js
 *
 * Cliente do Microsoft Graph API pra leitura do OneDrive da Marçal.
 * Auth: OAuth2 client_credentials (app-only, permission Files.Read.All).
 *
 * Env vars necessárias (Render):
 *   ONEDRIVE_TENANT_ID    — directory ID do tenant Azure AD
 *   ONEDRIVE_CLIENT_ID    — application (client) ID do app registrado
 *   ONEDRIVE_CLIENT_SECRET — client secret value
 *   ONEDRIVE_USER_EMAIL   — email do dono do OneDrive (ex: thiago@marcalcontabilidade.com.br)
 *   ONEDRIVE_ROOT_PATH    — path da pasta raiz a sincronizar (default: /Docs Clientes)
 */

const https = require('https');

const TENANT = process.env.ONEDRIVE_TENANT_ID || '';
const CLIENT = process.env.ONEDRIVE_CLIENT_ID || '';
const SECRET = process.env.ONEDRIVE_CLIENT_SECRET || '';
const USER = process.env.ONEDRIVE_USER_EMAIL || '';
const ROOT = process.env.ONEDRIVE_ROOT_PATH || '/Docs Clientes';

let tokenCache = { value: null, expiresAt: 0 };

/**
 * GET token via OAuth2 client_credentials.
 * Cacheia em memória (tokens duram ~1h).
 */
async function _obterToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.value;
  }
  if (!TENANT || !CLIENT || !SECRET) {
    throw new Error('OneDrive não configurado: ONEDRIVE_TENANT_ID/CLIENT_ID/CLIENT_SECRET ausentes');
  }
  const url = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT,
    client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();

  const resp = await _httpRequest(url, 'POST', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  if (resp.statusCode !== 200) {
    throw new Error(`OAuth falhou (${resp.statusCode}): ${resp.body.substring(0, 300)}`);
  }
  const data = JSON.parse(resp.body);
  tokenCache.value = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return tokenCache.value;
}

async function _graphGet(path) {
  const token = await _obterToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const resp = await _httpRequest(url, 'GET', null, {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Graph GET ${path} falhou (${resp.statusCode}): ${resp.body.substring(0, 300)}`);
  }
  return JSON.parse(resp.body);
}

function _httpRequest(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        'Content-Length': body ? Buffer.byteLength(body) : 0,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Testa a conexão (auth + drive existe).
 * @returns { ok, user, drive }
 */
async function testarConexao() {
  if (!USER) throw new Error('ONEDRIVE_USER_EMAIL ausente');
  await _obterToken(); // auth
  const userInfo = await _graphGet(`/users/${encodeURIComponent(USER)}`);
  const driveInfo = await _graphGet(`/users/${encodeURIComponent(USER)}/drive`);
  return {
    ok: true,
    user: { id: userInfo.id, mail: userInfo.mail, displayName: userInfo.displayName },
    drive: { id: driveInfo.id, name: driveInfo.name, total: driveInfo.quota?.total, used: driveInfo.quota?.used },
  };
}

/**
 * Lista as pastas-filho de ROOT (uma pasta por cliente).
 * @returns Array<{id, name, webUrl, lastModifiedDateTime, childCount}>
 */
async function listarClientes() {
  if (!USER) throw new Error('ONEDRIVE_USER_EMAIL ausente');
  const path = `/users/${encodeURIComponent(USER)}/drive/root:${ROOT}:/children?$select=id,name,webUrl,lastModifiedDateTime,folder&$top=200`;
  const data = await _graphGet(path);
  return (data.value || [])
    .filter(item => item.folder)
    .map(it => ({
      id: it.id,
      name: it.name,
      webUrl: it.webUrl,
      lastModifiedDateTime: it.lastModifiedDateTime,
      childCount: it.folder?.childCount || 0,
    }));
}

/**
 * Lista os arquivos de uma pasta de cliente.
 */
async function listarArquivosPasta(folderId) {
  const path = `/users/${encodeURIComponent(USER)}/drive/items/${folderId}/children?$select=id,name,size,file,folder,lastModifiedDateTime&$top=200`;
  const data = await _graphGet(path);
  return (data.value || []).map(it => ({
    id: it.id,
    name: it.name,
    size: it.size,
    isFolder: !!it.folder,
    mimeType: it.file?.mimeType,
    lastModifiedDateTime: it.lastModifiedDateTime,
  }));
}

/**
 * Baixa o conteúdo binário de um arquivo (Buffer).
 */
async function baixarArquivo(itemId) {
  const token = await _obterToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(USER)}/drive/items/${itemId}/content`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const tentar = (target) => {
      const tu = new URL(target);
      const req = https.request({
        hostname: tu.hostname,
        path: tu.pathname + tu.search,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // Graph redireciona pra preauth URL do conteúdo
          tentar(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download falhou (${res.statusCode})`));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('Timeout download')));
      req.end();
    };
    tentar(url);
  });
}

module.exports = {
  testarConexao,
  listarClientes,
  listarArquivosPasta,
  baixarArquivo,
  _config: { TENANT_set: !!TENANT, CLIENT_set: !!CLIENT, SECRET_set: !!SECRET, USER, ROOT },
};
