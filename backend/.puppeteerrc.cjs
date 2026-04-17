/**
 * Puppeteer config — no Docker Alpine usamos o Chromium do sistema.
 * PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true no Dockerfile impede o download.
 */
const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
