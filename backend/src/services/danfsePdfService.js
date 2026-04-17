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

module.exports = { htmlParaPdf, fechar };
