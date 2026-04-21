/**
 * DANFSe Retry Queue
 *
 * Fila em memoria para re-tentar entregar o PDF oficial quando o ADN
 * esta sobrecarregado (rate limit / 502). Quando a emissao inicial nao
 * consegue pegar o PDF na primeira janela de tentativas, o whatsapp.js
 * manda um aviso textual e agenda a NF nessa fila.
 *
 * Intervalos: 2min, 5min, 10min. Se as 3 tentativas falharem,
 * o item sai da fila silenciosamente (o aviso inicial ja foi dado).
 *
 * Limitacoes:
 * - Fila em memoria: se o servidor reinicia, perde as pendencias. OK
 *   pro nivel de trafego atual (poucas NFs por dia). Se virar importante,
 *   migrar pra tabela no Postgres.
 */

const INTERVALOS_RETRY_MS = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];
const POLL_INTERVAL_MS    = 30 * 1000;

const fila = new Map(); // nfId -> { nfId, destino, numDisplay, tentativa, proximaTentativa, iniciado }

function adicionar({ nfId, destino, numDisplay }) {
  if (!nfId || !destino) return;
  if (fila.has(nfId)) {
    console.log(`[DANFSe-Retry] NF ${nfId} ja esta na fila, ignorando duplicata`);
    return;
  }
  fila.set(nfId, {
    nfId,
    destino,
    numDisplay: numDisplay || String(nfId),
    tentativa: 0,
    proximaTentativa: Date.now() + INTERVALOS_RETRY_MS[0],
    iniciado: Date.now(),
  });
  console.log(`[DANFSe-Retry] +queue NF ${nfId} destino=${destino} (fila=${fila.size}, 1a tentativa em 2min)`);
}

function remover(nfId) {
  return fila.delete(nfId);
}

function status() {
  return {
    tamanho: fila.size,
    itens: Array.from(fila.values()).map(i => ({
      nfId: i.nfId,
      destino: i.destino,
      tentativa: i.tentativa,
      proximaEm: Math.max(0, i.proximaTentativa - Date.now()),
      iniciadoHa: Date.now() - i.iniciado,
    })),
  };
}

async function _processarItem(item) {
  const { obterDanfsePdf } = require('../routes/notasFiscais');
  try {
    const resultado = await obterDanfsePdf(item.nfId);
    if (resultado && resultado.pdf) {
      await _enviarPdf(item, resultado);
      fila.delete(item.nfId);
      console.log(`[DANFSe-Retry] ✅ NF ${item.nfId} entregue na tentativa ${item.tentativa + 1}/${INTERVALOS_RETRY_MS.length} (aguardou ${Math.round((Date.now() - item.iniciado) / 1000)}s no total)`);
      return;
    }
  } catch (err) {
    console.warn(`[DANFSe-Retry] NF ${item.nfId} tentativa ${item.tentativa + 1}/${INTERVALOS_RETRY_MS.length} falhou: ${err.message}`);
  }

  item.tentativa += 1;
  if (item.tentativa >= INTERVALOS_RETRY_MS.length) {
    console.warn(`[DANFSe-Retry] ⚠️ Desistindo da NF ${item.nfId} apos ${item.tentativa} tentativas (${Math.round((Date.now() - item.iniciado) / 1000)}s)`);
    fila.delete(item.nfId);
    return;
  }
  item.proximaTentativa = Date.now() + INTERVALOS_RETRY_MS[item.tentativa];
  console.log(`[DANFSe-Retry] NF ${item.nfId} reagendada para +${Math.round(INTERVALOS_RETRY_MS[item.tentativa] / 60000)}min (tentativa ${item.tentativa + 1})`);
}

async function _enviarPdf(item, resultado) {
  const zapiService = require('./zapiService');
  const { gerarToken } = require('../middleware/auth');

  const tokenTemp = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'danfse' });
  let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
  if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
    baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
  }
  const linkDanfse = `${baseUrl}/api/notas-fiscais/${item.nfId}/danfse-pdf?token=${tokenTemp}&download=1`;

  const numDisplay = (resultado && resultado.numDisplay) || item.numDisplay;
  const msg = `✅ PDF oficial da NF ${numDisplay} acabou de ficar disponível, estou mandando agora:`;

  try {
    await zapiService.enviarTexto(item.destino, msg);
  } catch (e) {
    console.warn(`[DANFSe-Retry] Erro ao avisar destino antes de enviar PDF: ${e.message}`);
  }

  try {
    await zapiService.enviarDocumento(
      item.destino,
      linkDanfse,
      `DANFSe_NF_${numDisplay}.pdf`,
      '📄 DANFSe → Documento Auxiliar da NFS-e'
    );
  } catch (e) {
    console.error(`[DANFSe-Retry] Erro ao enviar documento para ${item.destino}: ${e.message}`);
    throw e;
  }
}

async function _processarFila() {
  if (fila.size === 0) return;
  const agora = Date.now();
  const prontos = Array.from(fila.values()).filter(i => agora >= i.proximaTentativa);
  if (prontos.length === 0) return;

  console.log(`[DANFSe-Retry] ⏳ Processando ${prontos.length} item(ns) prontos (fila total=${fila.size})`);
  for (const item of prontos) {
    await _processarItem(item);
    // pequena pausa entre items pra nao drenar rate limit do ADN
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Inicia o poller no require (singleton global pra sobreviver a hot-reload)
if (!global._danfseRetryPoller) {
  global._danfseRetryPoller = setInterval(() => {
    _processarFila().catch(err => {
      console.error('[DANFSe-Retry] Erro no processador da fila:', err);
    });
  }, POLL_INTERVAL_MS);
  console.log(`[DANFSe-Retry] Poller iniciado (check a cada ${POLL_INTERVAL_MS / 1000}s)`);
}

module.exports = { adicionar, remover, status };
