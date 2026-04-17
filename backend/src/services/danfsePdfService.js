/**
 * DANFSe PDF Service
 *
 * Captura o DANFSe OFICIAL do portal do Emissor Nacional (nfse.gov.br)
 * usando Puppeteer (headless Chrome) e salva como PDF.
 *
 * URL pública: https://www.nfse.gov.br/EmissorNacional/Danfse?chaveAcesso=XXXXX
 *
 * Mantém uma instância única do browser para performance.
 */

let browserInstance = null;
let browserLaunchPromise = null;

const DANFSE_URL_BASE = 'https://www.nfse.gov.br/EmissorNacional/Danfse';

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
 * Captura o DANFSe oficial do portal SEFIN e retorna como PDF.
 *
 * @param {string} chaveAcesso - Chave de acesso da NFS-e
 * @returns {Promise<Buffer>} - Buffer do PDF gerado
 */
async function gerarPdfOficial(chaveAcesso) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const url = `${DANFSE_URL_BASE}?chaveAcesso=${chaveAcesso}`;
    console.log(`[DANFSe-PDF] Acessando DANFSe oficial: ${url}`);

    // Navega até a página oficial do DANFSe
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    if (!response || !response.ok()) {
      const status = response ? response.status() : 'sem resposta';
      throw new Error(`Página do DANFSe retornou HTTP ${status}`);
    }

    // Espera o conteúdo principal carregar (o portal pode ter JS dinâmico)
    await page.waitForSelector('body', { timeout: 10000 });

    // Aguarda um pouco extra para garantir que tudo renderizou
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verifica se não caiu em página de erro
    const pageContent = await page.content();
    if (pageContent.includes('Chave de Acesso não encontrada') ||
        pageContent.includes('não encontrada') ||
        pageContent.includes('Erro')) {
      // Tenta detectar a mensagem de erro específica
      const errorText = await page.evaluate(() => {
        const body = document.body.innerText;
        return body.substring(0, 500);
      });
      console.error(`[DANFSe-PDF] Página retornou erro: ${errorText}`);
      throw new Error(`DANFSe não encontrado no portal SEFIN. Verifique a chave de acesso.`);
    }

    console.log('[DANFSe-PDF] Página carregada, gerando PDF...');

    // Gera o PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '5mm',
        right: '5mm',
        bottom: '5mm',
        left: '5mm',
      },
      preferCSSPageSize: true,
    });

    console.log(`[DANFSe-PDF] PDF oficial gerado: ${pdfBuffer.length} bytes`);
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fallback: Gera PDF a partir de HTML customizado (caso o portal esteja fora).
 *
 * @param {string} html - HTML completo da DANFSe
 * @returns {Promise<Buffer>} - Buffer do PDF gerado
 */
async function gerarPdfHtml(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
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

module.exports = { gerarPdfOficial, gerarPdfHtml, fechar };
