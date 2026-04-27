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
  // Não precisa ler /users/{id} — Files.Read.All não cobre isso (precisaria User.Read.All).
  // Vamos direto pro /drive do user, que basta pra confirmar acesso.
  const driveInfo = await _graphGet(`/users/${encodeURIComponent(USER)}/drive`);
  return {
    ok: true,
    drive: {
      id: driveInfo.id,
      name: driveInfo.name,
      driveType: driveInfo.driveType,
      total: driveInfo.quota?.total,
      used: driveInfo.quota?.used,
      owner: driveInfo.owner?.user?.email || driveInfo.owner?.user?.displayName,
    },
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

/**
 * Baixa um xlsx do OneDrive e devolve a primeira sheet como
 * { cabecalhos: [...], linhas: [[...], ...] }. Limita preview pra evitar payload grande.
 */
async function previewXlsx(itemId, maxLinhas = 50) {
  const buf = await baixarArquivo(itemId);
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const result = {};
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const cabecalhos = json[0] || [];
    const linhas = json.slice(1, 1 + maxLinhas);
    result[sheetName] = { cabecalhos, linhas, totalLinhas: json.length - 1 };
  }
  return result;
}


// ============================================================
// SYNC: regime tributário a partir da planilha do Controle Geral
// ============================================================

const REGIME_MAP = {
  'simples nacional': { optante_simples: 1, regime_simples_nacional: '3' },
  'simples':          { optante_simples: 1, regime_simples_nacional: '3' },
  'mei':              { optante_simples: 1, regime_simples_nacional: '2' },
  'lucro presumido':  { optante_simples: 0, regime_simples_nacional: null },
  'lucro real':       { optante_simples: 0, regime_simples_nacional: null },
  'imune':            { optante_simples: 0, regime_simples_nacional: null },
};

function _normalizarRegime(s) {
  return REGIME_MAP[String(s || '').toLowerCase().trim()] || null;
}

function _normalizarCnpj(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * Lê o Controle Geral da Marçal e atualiza regime + município nos clientes.
 * Retorna {atualizados, ignorados, naoEncontrados}.
 */
async function syncRegimeTributario(planilhaId, db) {
  const data = await previewXlsx(planilhaId, 500);
  // Pega a primeira sheet (Obrigações Acessórias)
  const firstSheet = Object.keys(data)[0];
  const sh = data[firstSheet];

  // Acha linha de cabeçalho real (procura "EMPRESA" e "CNPJ")
  let cabIdx = -1;
  for (let i = 0; i < sh.linhas.length; i++) {
    const linha = sh.linhas[i];
    if (linha.includes('EMPRESA') && linha.some(c => /CNPJ/i.test(c))) {
      cabIdx = i;
      break;
    }
  }
  if (cabIdx < 0) throw new Error('Cabeçalho real não encontrado na planilha (EMPRESA/CNPJ)');

  const cab = sh.linhas[cabIdx];
  const colEmpresa = cab.findIndex(c => /EMPRESA/i.test(c));
  const colCnpj = cab.findIndex(c => /CNPJ/i.test(c));
  const colRegime = cab.findIndex(c => /REGIME/i.test(c));
  const colMun = cab.findIndex(c => /MUNIC/i.test(c));
  const colSituacao = cab.findIndex(c => /SITUA/i.test(c));

  const rows = sh.linhas.slice(cabIdx + 1).filter(r => _normalizarCnpj(r[colCnpj]).length === 14);

  const out = { atualizados: 0, ignorados: 0, naoEncontrados: [], detalhes: [] };
  for (const r of rows) {
    const cnpj = _normalizarCnpj(r[colCnpj]);
    const empresa = r[colEmpresa];
    const regimeStr = r[colRegime];
    const municipio = r[colMun];
    const situacao = r[colSituacao];
    const regime = _normalizarRegime(regimeStr);
    if (!regime) {
      out.ignorados++;
      continue;
    }
    const cliente = db.prepare(`SELECT id, razao_social, optante_simples, regime_simples_nacional, municipio FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(cnpj);
    if (!cliente) {
      out.naoEncontrados.push({ cnpj, empresa, regimeStr });
      continue;
    }
    const updates = {};
    if (cliente.optante_simples !== regime.optante_simples) updates.optante_simples = regime.optante_simples;
    if (regime.regime_simples_nacional && cliente.regime_simples_nacional !== regime.regime_simples_nacional) {
      updates.regime_simples_nacional = regime.regime_simples_nacional;
    }
    if (municipio && !cliente.municipio) updates.municipio = String(municipio).toUpperCase().trim();
    if (Object.keys(updates).length > 0) {
      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE clientes SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), cliente.id);
      out.atualizados++;
      out.detalhes.push({ cnpj, razao: cliente.razao_social, regimeStr, ...updates });
    } else {
      out.ignorados++;
    }
  }
  return out;
}

// ============================================================
// SYNC: certificados A1 das pastas dos clientes
// ============================================================

/**
 * Extrai CNPJ + senha do nome do arquivo PFX usando regex tolerante.
 * Aceita variações:
 *   "AGC..._56092666000171 - Senha 30533141.pfx"
 *   "DDA... 27998575000100 - Senha - Daniele@102030 (Vc 12-06-26).pfx"
 */
function _parsearNomePfx(nome) {
  const cnpjMatch = nome.match(/(\d{14})/);
  if (!cnpjMatch) return null;
  // Pula CPF (11 dígitos) que aparece em arquivos de sócios
  if (/(?:^|\D)(\d{11})(?:\D|$)/.test(nome) && !cnpjMatch) return null;
  const cnpj = cnpjMatch[1];

  // Senha: tudo após "Senha" até espaço, parêntese ou fim
  const senhaMatch = nome.match(/Senha[\s\-:]+([^\s\(\)]+)/i);
  if (!senhaMatch) return null;
  const senha = senhaMatch[1].replace(/\.pfx$/i, '').trim();
  return { cnpj, senha };
}

/**
 * Itera pasta-pai (ex: "02 - CLIENTES CONTABILIDADE") → cada subpasta-cliente
 * → "1 - CERTIFICADO DIGITAL" → encontra PFX com padrão de senha → cadastra.
 */
async function syncCertificadosA1(folderClientesId, db, opts = {}, onProgress = null) {
  const certificadoService = require('./certificadoService');
  const out = { processados: 0, cadastrados: 0, ignoradosJaTinham: 0, semSenha: 0, naoEncontrados: [], erros: [] };
  const pastasClientes = await listarArquivosPasta(folderClientesId);

  out.totalPastas = pastasClientes.filter(p => p.isFolder).length;
  for (const pastaCliente of pastasClientes) {
    if (!pastaCliente.isFolder) continue;
    out.processados++;
    try {
      // Acha "1 - CERTIFICADO DIGITAL" (ou variação)
      const subpastas = await listarArquivosPasta(pastaCliente.id);
      const pastaCert = subpastas.find(s => s.isFolder && /CERTIFICADO/i.test(s.name));
      if (!pastaCert) {
        out.erros.push({ cliente: pastaCliente.name, erro: 'sem subpasta CERTIFICADO' });
        continue;
      }

      // Lista PFX dentro
      const arquivos = await listarArquivosPasta(pastaCert.id);
      const pfxs = arquivos.filter(a => !a.isFolder && /\.pfx$/i.test(a.name));
      if (pfxs.length === 0) {
        out.erros.push({ cliente: pastaCliente.name, erro: 'sem .pfx' });
        continue;
      }

      // Pega o mais recente que tem padrão "Senha"
      const candidatos = pfxs
        .map(p => ({ ...p, parsed: _parsearNomePfx(p.name) }))
        .filter(p => p.parsed);
      if (candidatos.length === 0) {
        out.semSenha++;
        out.erros.push({ cliente: pastaCliente.name, erro: 'pfx sem senha no nome', arquivos: pfxs.map(a => a.name) });
        continue;
      }
      candidatos.sort((a, b) => new Date(b.lastModifiedDateTime) - new Date(a.lastModifiedDateTime));
      const pfxEscolhido = candidatos[0];

      // Acha cliente no banco pelo CNPJ
      const cliente = db.prepare(`SELECT id, razao_social, certificado_a1_path, certificado_validade FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(pfxEscolhido.parsed.cnpj);
      if (!cliente) {
        out.naoEncontrados.push({ cnpj: pfxEscolhido.parsed.cnpj, nomePasta: pastaCliente.name });
        continue;
      }

      // Pula se já tem A1 válido (caso opts.forcar=false, default)
      if (!opts.forcar && cliente.certificado_a1_path) {
        const validade = cliente.certificado_validade ? new Date(cliente.certificado_validade) : null;
        if (validade && validade > new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) {
          out.ignoradosJaTinham++;
          continue;
        }
      }

      // Baixa e cadastra
      const buf = await baixarArquivo(pfxEscolhido.id);
      const result = certificadoService.salvarCertificado(cliente.id, buf, pfxEscolhido.parsed.senha);
      // Atualiza cadastro do cliente
      db.prepare(`UPDATE clientes SET certificado_a1_path = ?, certificado_a1_senha_encrypted = ?, certificado_validade = ?, updated_at = datetime('now') WHERE id = ?`).run(
        result.filepath,
        result.senhaEncrypted,
        result.info.validade?.fim || null,
        cliente.id,
      );
      out.cadastrados++;
      console.log(`[OneDrive sync-a1] ${cliente.razao_social} (id=${cliente.id}) — A1 válido até ${result.info.validade?.fim}`);
    } catch (err) {
      out.erros.push({ cliente: pastaCliente.name, erro: err.message });
    }
    if (onProgress) {
      try { onProgress({ ...out, ultimaPasta: pastaCliente.name }); } catch {}
    }
  }
  return out;
}


module.exports = {
  testarConexao,
  listarClientes,
  listarArquivosPasta,
  baixarArquivo,
  previewXlsx,
  syncRegimeTributario,
  syncCertificadosA1,
  _config: { TENANT_set: !!TENANT, CLIENT_set: !!CLIENT, SECRET_set: !!SECRET, USER, ROOT },
};
