/**
 * Cache em memória do PDF DANFSe, por nfId.
 *
 * Contexto: o Z-API baixa o link do PDF pra enviar como documento no WhatsApp.
 * Em seguida (~2s depois), o WhatsApp/iPhone re-fetcha o mesmo link pra gerar
 * preview/thumbnail. Como o ADN oficial é intermitente (502), essa 2ª chamada
 * frequentemente cai no Puppeteer — e pode ser essa versão que o WhatsApp
 * renderiza. Cacheando o PDF oficial por alguns minutos, re-fetches entregam o
 * mesmo conteúdo do 1º download.
 *
 * Política:
 * - Só cacheia PDF oficial (fonte === 'oficial'); Puppeteer não é cacheado pra
 *   que a próxima tentativa possa pegar a ADN de volta.
 * - TTL de 10 minutos — curto o suficiente pra não servir conteúdo desatualizado
 *   se a NF for reemitida, longo o suficiente pra cobrir re-fetches e previews.
 * - Limpeza lazy quando o mapa passa de 200 entradas.
 */

const CACHE = new Map(); // nfId → { pdf: Buffer, fonte: 'oficial', ts: number }
const TTL_MS = 10 * 60 * 1000;
const MAX_SIZE = 200;

function ler(nfId) {
  const hit = CACHE.get(nfId);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) {
    CACHE.delete(nfId);
    return null;
  }
  return hit;
}

function gravar(nfId, pdf, fonte) {
  if (fonte !== 'oficial') return; // só cacheia oficial
  CACHE.set(nfId, { pdf, fonte, ts: Date.now() });
  if (CACHE.size > MAX_SIZE) {
    const agora = Date.now();
    for (const [k, v] of CACHE) {
      if (agora - v.ts > TTL_MS) CACHE.delete(k);
    }
  }
}

function invalidar(nfId) {
  CACHE.delete(nfId);
}

function stats() {
  return { size: CACHE.size, ttlMs: TTL_MS };
}

module.exports = { ler, gravar, invalidar, stats };
