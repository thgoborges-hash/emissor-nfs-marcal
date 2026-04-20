/**
 * DANFSe PDF Service
 *
 * Gera DANFSe no padrão oficial v1.0 (layout governo) como PDF
 * usando Puppeteer para converter HTML → PDF.
 *
 * O DANFSe é um documento AUXILIAR — a validade fiscal é do XML.
 * Qualquer sistema pode gerar desde que siga o layout padrão.
 */

let browserInstance = null;
let browserLaunchPromise = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    try {
      const puppeteer = require('puppeteer');
      console.log('[DANFSe-PDF] Iniciando Puppeteer...');

      const opts = {
        headless: 'new',
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-extensions', '--single-process', '--no-zygote',
        ],
        timeout: 30000,
      };
      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      browserInstance = await puppeteer.launch(opts);
      browserInstance.on('disconnected', () => {
        browserInstance = null;
        browserLaunchPromise = null;
      });
      console.log('[DANFSe-PDF] Puppeteer pronto.');
      return browserInstance;
    } catch (err) {
      console.error('[DANFSe-PDF] Erro Puppeteer:', err.message);
      browserLaunchPromise = null;
      throw err;
    }
  })();
  return browserLaunchPromise;
}

/**
 * Converte HTML em PDF via Puppeteer.
 */
async function htmlParaPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

async function fechar() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) {}
    browserInstance = null;
    browserLaunchPromise = null;
  }
}

// =====================================================
// DANFSe OFICIAL via endpoint ADN (Ambiente de Dados Nacional)
// https://adn.nfse.gov.br/danfse/{chaveAcesso}  (mTLS com A1)
// Confirmado 200 OK em 18/04/2026 — retorna PDF oficial 230KB
// =====================================================

const https = require('https');
const { URL } = require('url');

const ADN_BASE_URL = process.env.ADN_DANFSE_BASE_URL || 'https://adn.nfse.gov.br';
const ADN_TIMEOUT_MS = Number(process.env.ADN_DANFSE_TIMEOUT_MS || 20000);

/**
 * Tenta baixar o DANFSe oficial direto do ADN (Receita Federal).
 * @param {string} chaveAcesso — 50 chars
 * @param {Buffer} pfxBuffer — A1 pfx buffer
 * @param {string} senha — senha do cert
 * @returns {Promise<Buffer|null>} PDF buffer ou null se falhar
 */
async function baixarDanfseOficial(chaveAcesso, pfxBuffer, senha) {
  if (!chaveAcesso || !pfxBuffer || !senha) {
    console.log('[DANFSe-ADN] Parâmetros ausentes, pulando tentativa oficial');
    return null;
  }

  const url = new URL(`${ADN_BASE_URL}/danfse/${chaveAcesso}`);
  const options = {
    method: 'GET',
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    pfx: pfxBuffer,
    passphrase: senha,
    headers: { 'Accept': 'application/pdf' },
    timeout: ADN_TIMEOUT_MS,
  };

  const inicio = Date.now();
  return new Promise((resolve) => {
    const req = https.request(options, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const tempo = Date.now() - inicio;
        const buffer = Buffer.concat(chunks);
        const ePdf = buffer.slice(0, 4).toString() === '%PDF';

        if (r.statusCode === 200 && ePdf) {
          console.log(`[DANFSe-ADN] ✓ OFICIAL em ${tempo}ms (${buffer.length} bytes) chave=${chaveAcesso.slice(-6)}`);
          resolve(buffer);
        } else {
          console.warn(`[DANFSe-ADN] ✗ ADN retornou status=${r.statusCode} ePdf=${ePdf} em ${tempo}ms — vai fazer fallback`);
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      console.warn(`[DANFSe-ADN] ✗ Timeout ${ADN_TIMEOUT_MS}ms — vai fazer fallback`);
      req.destroy();
      resolve(null);
    });
    req.on('error', (err) => {
      console.warn(`[DANFSe-ADN] ✗ Erro de rede: ${err.message} — vai fazer fallback`);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Estratégia em cascata: tenta ADN oficial primeiro, se falhar usa Puppeteer local.
 * @param {object} opts
 * @param {string} opts.chaveAcesso
 * @param {Buffer} [opts.pfxBuffer] — cert A1 do cliente (opcional)
 * @param {string} [opts.senha]     — senha do cert (opcional)
 * @param {string} opts.htmlLocal   — HTML fallback já montado (obrigatório)
 * @returns {Promise<{ pdf: Buffer, fonte: 'oficial'|'local' }>}
 */
async function obterDanfseCascata({ chaveAcesso, pfxBuffer, senha, htmlLocal }) {
  // 1ª tentativa: endpoint oficial
  try {
    const pdfOficial = await baixarDanfseOficial(chaveAcesso, pfxBuffer, senha);
    if (pdfOficial) {
      return { pdf: pdfOficial, fonte: 'oficial' };
    }
  } catch (err) {
    console.warn('[DANFSe-Cascata] Falha oficial (catch):', err.message);
  }

  // Fallback: Puppeteer local com template v1.0
  console.log('[DANFSe-Cascata] ↓ Usando fallback local (Puppeteer)');
  const pdfLocal = await htmlParaPdf(htmlLocal);
  return { pdf: pdfLocal, fonte: 'local' };
}

module.exports = {
  htmlParaPdf,
  fechar,
  baixarDanfseOficial,
  obterDanfseCascata,
};
