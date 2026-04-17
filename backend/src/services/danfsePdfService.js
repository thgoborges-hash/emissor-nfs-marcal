/**
 * DANFSe PDF Service
 *
 * Baixa o DANFSe OFICIAL do portal de Consulta Pública da SEFIN Nacional
 * usando Puppeteer para automatizar o fluxo:
 *   1. Acessa https://www.nfse.gov.br/consultapublica
 *   2. Insere a chave de acesso
 *   3. Clica em Consultar
 *   4. Clica em Download DANFSe
 *   5. Intercepta o PDF baixado
 *
 * Fallback: se o portal estiver fora, gera PDF do nosso HTML interno.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

let browserInstance = null;
let browserLaunchPromise = null;

const CONSULTA_PUBLICA_URL = 'https://www.nfse.gov.br/consultapublica';

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

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

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      browserInstance = await puppeteer.launch(launchOptions);

      browserInstance.on('disconnected', () => {
        console.log('[DANFSe-PDF] Browser desconectado.');
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
 * Baixa o DANFSe oficial do portal de Consulta Pública.
 *
 * @param {string} chaveAcesso - Chave de acesso da NFS-e (50+ dígitos)
 * @returns {Promise<Buffer>} - Buffer do PDF oficial
 */
async function gerarPdfOficial(chaveAcesso) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Diretório temporário para downloads
  const downloadDir = path.join(os.tmpdir(), `danfse-download-${Date.now()}`);
  fs.mkdirSync(downloadDir, { recursive: true });

  try {
    // Configura interceptação de downloads
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    console.log(`[DANFSe-PDF] Acessando Consulta Pública: ${CONSULTA_PUBLICA_URL}`);

    // 1. Abre a página de consulta pública
    await page.goto(CONSULTA_PUBLICA_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // 2. Espera o campo de chave de acesso aparecer
    // O portal pode usar diferentes seletores — vamos tentar os mais comuns
    console.log('[DANFSe-PDF] Procurando campo de chave de acesso...');

    // Tenta encontrar o campo de input para a chave
    const inputSelector = await page.evaluate(() => {
      // Tenta por placeholder
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
      for (const input of inputs) {
        const ph = (input.placeholder || '').toLowerCase();
        const label = (input.getAttribute('aria-label') || '').toLowerCase();
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        if (ph.includes('chave') || label.includes('chave') || name.includes('chave') || id.includes('chave') ||
            ph.includes('acesso') || label.includes('acesso') || name.includes('acesso') || id.includes('acesso')) {
          return `#${input.id}` || `[name="${input.name}"]`;
        }
      }
      // Fallback: primeiro input de texto visível
      const firstInput = document.querySelector('input[type="text"]:not([hidden])') ||
                         document.querySelector('input:not([type]):not([hidden])');
      if (firstInput) {
        if (firstInput.id) return `#${firstInput.id}`;
        if (firstInput.name) return `[name="${firstInput.name}"]`;
        return 'input[type="text"]';
      }
      return null;
    });

    if (!inputSelector) {
      // Loga o HTML da página para debug
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
      console.error(`[DANFSe-PDF] Não encontrou campo de input. Conteúdo da página: ${bodyText}`);
      throw new Error('Campo de chave de acesso não encontrado na página de consulta pública');
    }

    console.log(`[DANFSe-PDF] Campo encontrado: ${inputSelector}`);

    // 3. Preenche a chave de acesso
    await page.click(inputSelector);
    await page.type(inputSelector, chaveAcesso, { delay: 20 });

    // 4. Clica no botão de consultar
    console.log('[DANFSe-PDF] Clicando em Consultar...');
    const buttonClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
      for (const btn of buttons) {
        const text = (btn.innerText || btn.value || '').toLowerCase();
        if (text.includes('consultar') || text.includes('pesquisar') || text.includes('buscar')) {
          btn.click();
          return true;
        }
      }
      // Tenta form submit
      const form = document.querySelector('form');
      if (form) {
        form.submit();
        return true;
      }
      return false;
    });

    if (!buttonClicked) {
      throw new Error('Botão de consultar não encontrado');
    }

    // 5. Espera a página de resultado carregar
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('[DANFSe-PDF] Resultado carregado, procurando link de download...');

    // 6. Procura o link/botão de download do DANFSe
    const downloadUrl = await page.evaluate(() => {
      // Procura link direto para download
      const links = Array.from(document.querySelectorAll('a[href*="DANFSe"], a[href*="danfse"], a[href*="Download"]'));
      for (const link of links) {
        const href = link.href || '';
        const text = (link.innerText || '').toLowerCase();
        if (href.includes('DANFSe') || href.includes('danfse') || text.includes('danfse') || text.includes('download')) {
          return href;
        }
      }

      // Procura botão com texto DANFSe
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const btn of buttons) {
        const text = (btn.innerText || '').toLowerCase();
        if (text.includes('danfse') || text.includes('download') || text.includes('pdf')) {
          if (btn.href) return btn.href;
          return '__CLICK__:' + (btn.id || btn.className || 'button');
        }
      }

      return null;
    });

    let pdfBuffer;

    if (downloadUrl && downloadUrl.startsWith('http')) {
      // Download direto via URL
      console.log(`[DANFSe-PDF] Link de download encontrado: ${downloadUrl}`);

      // Navega para o URL de download e intercepta a resposta
      const downloadPage = await browser.newPage();
      try {
        const response = await downloadPage.goto(downloadUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('pdf')) {
          pdfBuffer = await response.buffer();
          console.log(`[DANFSe-PDF] PDF baixado diretamente: ${pdfBuffer.length} bytes`);
        } else {
          // Se não veio como PDF direto, tenta imprimir a página como PDF
          console.log(`[DANFSe-PDF] Content-Type: ${contentType}, gerando PDF da página...`);
          pdfBuffer = await downloadPage.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' },
          });
        }
      } finally {
        await downloadPage.close().catch(() => {});
      }
    } else if (downloadUrl && downloadUrl.startsWith('__CLICK__')) {
      // Precisa clicar no botão e esperar o download
      console.log('[DANFSe-PDF] Clicando no botão de download...');
      const btnId = downloadUrl.replace('__CLICK__:', '');
      await page.evaluate((id) => {
        const btn = document.getElementById(id) ||
                    document.querySelector(`.${id}`) ||
                    Array.from(document.querySelectorAll('button, a')).find(b =>
                      (b.innerText || '').toLowerCase().includes('danfse'));
        if (btn) btn.click();
      }, btnId);

      // Espera o download completar
      pdfBuffer = await waitForDownload(downloadDir, 15000);
    } else {
      // Não encontrou link de download — tenta capturar a página inteira como PDF
      console.warn('[DANFSe-PDF] Link de download não encontrado. Capturando página como PDF...');
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log(`[DANFSe-PDF] Conteúdo da página: ${pageText}`);

      pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' },
      });
    }

    if (!pdfBuffer || pdfBuffer.length < 100) {
      throw new Error('PDF gerado está vazio ou muito pequeno');
    }

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
    // Limpa diretório temporário
    try {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    } catch (e) { /* ignora */ }
  }
}

/**
 * Espera um arquivo aparecer no diretório de download.
 */
async function waitForDownload(dir, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
    if (files.length > 0) {
      const filePath = path.join(dir, files[0]);
      const buffer = fs.readFileSync(filePath);
      console.log(`[DANFSe-PDF] Arquivo baixado: ${files[0]} (${buffer.length} bytes)`);
      return buffer;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Timeout esperando download do PDF');
}

/**
 * Fallback: Gera PDF a partir de HTML customizado.
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
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      preferCSSPageSize: false,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fecha o browser.
 */
async function fechar() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (e) { /* */ }
    browserInstance = null;
    browserLaunchPromise = null;
  }
}

module.exports = { gerarPdfOficial, gerarPdfHtml, fechar };
