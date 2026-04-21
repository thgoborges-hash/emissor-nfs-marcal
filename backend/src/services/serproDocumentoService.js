/**
 * Cache em memoria de PDFs gerados por acoes SERPRO (DAS, DARF, SITFIS, CCMEI).
 *
 * A ANA solicita o PDF ao SERPRO, armazena aqui com um token curto e manda
 * o link pelo WhatsApp apontando pra rota /api/integra-contador/documento/:token.
 * O Z-API baixa o link e entrega o documento pro destinatario final.
 *
 * TTL de 15min e limite de 100 entradas pra evitar vazamento de memoria.
 * Auto-limpeza lazy quando o mapa cresce.
 */

const crypto = require('crypto');

const CACHE = new Map();         // token -> { pdf: Buffer, nomeArquivo, titulo, metadata, ts }
const TTL_MS = 15 * 60 * 1000;
const MAX_SIZE = 100;

function gerarToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Grava um PDF no cache e retorna o token gerado.
 * @param {object} opts
 * @param {Buffer} opts.pdf        - PDF em buffer (nao base64)
 * @param {string} opts.nomeArquivo- ex: 'DAS_36749464_202604.pdf'
 * @param {string} opts.titulo     - legenda curta pro WhatsApp (ex: 'DAS Simples abril/2026')
 * @param {object} [opts.metadata] - info pra logs/debug { operacao, cnpj, periodo, ... }
 * @returns {string} token
 */
function gravar({ pdf, nomeArquivo, titulo, metadata }) {
  if (!pdf || !Buffer.isBuffer(pdf)) {
    throw new Error('serproDocumentoService.gravar: pdf precisa ser Buffer');
  }
  const token = gerarToken();
  CACHE.set(token, { pdf, nomeArquivo: nomeArquivo || 'documento.pdf', titulo: titulo || 'Documento SERPRO', metadata: metadata || {}, ts: Date.now() });
  // Limpeza lazy
  if (CACHE.size > MAX_SIZE) {
    const agora = Date.now();
    for (const [k, v] of CACHE) {
      if (agora - v.ts > TTL_MS) CACHE.delete(k);
    }
  }
  console.log(`[SerproDoc] +cache token=${token.slice(0,8)}... ${nomeArquivo} (${pdf.length} bytes, fila=${CACHE.size})`);
  return token;
}

function ler(token) {
  const hit = CACHE.get(token);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) {
    CACHE.delete(token);
    return null;
  }
  return hit;
}

function remover(token) {
  CACHE.delete(token);
}

function stats() {
  return { size: CACHE.size, ttlMs: TTL_MS, max: MAX_SIZE };
}

module.exports = { gravar, ler, remover, stats };
