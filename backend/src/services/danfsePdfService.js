/**
 * DANFSe PDF Service
 *
 * Converte o HTML da DANFSe em PDF usando Puppeteer (headless Chrome).
 * Mantém uma instância única do browser para performance.
 *
 * Uso: const pdf = await danfsePdfService.gerarPdf(htmlString);
 */

let browserInstance = null;
let browserLaunchPromise = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  // Evita múltiplos launches simultâneos
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  browserLaunchPromise = (async () => {
    try {
      const puppeteer = require('puppeteer');
      console.log('[DANFSe-PDF] Iniciando browser Puppeteer...');

      const launchOptions = {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--single-process',
          '--no-zygote',
        ],
        timeout: 30000,
      };

      // No Docker Alpine, usa o Chromium do sistema
      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      browserInstance = await puppeteer.launch(launchOptions);

      // Reconecta se o browser fechar inesperadamente
      browserInstance.on('disconnected', () => {
        console.log('[DANFSe-PDF] Browser desconectado, será reiniciado no próximo uso.');
        browserInstance = null;
        browserLaunchPromise = null;
      });

      console.log('[DANFSe-PDF] Browser Puppeteer pronto.');
      return browserInstance;
    } catch (err) {
      console.error('[DANFSe-PDF] Erro ao iniciar Puppeteer:', err.message);
      browserLaunchPromise = null;
      throw err;
    }
  })();

  return browserLaunchPromise;
}

/**
 * Gera um PDF a partir de uma string HTML.
 *
 * @param {string} html - HTML completo da DANFSe
 * @returns {Promise<Buffer>} - Buffer do PDF gerado
 */
async function gerarPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Remove o botão de imprimir do HTML (classe print-hide)
    const htmlSemBotao = html.replace(
      /<div class="print-hide">[\s\S]*?<\/div>/,
      ''
    );

    await page.setContent(htmlSemBotao, {
      waitUntil: 'networkidle0',
      timeout: 15000,
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '10mm',
        right: '10mm',
        bottom: '10mm',
        left: '10mm',
      },
      preferCSSPageSize: false,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fecha o browser (para shutdown graceful do servidor).
 */
async function fechar() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      // ignora
    }
    browserInstance = null;
    browserLaunchPromise = null;
  }
}

module.exports = { gerarPdf, fechar };
