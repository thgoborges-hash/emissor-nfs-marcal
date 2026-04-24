// =====================================================
// Cache em memória de anexos recebidos pelo WhatsApp.
// Chave: conversaId (string). Valor: { url, fileName, mimeType, expiresAt }.
// TTL padrão: 30 minutos — suficiente pra equipe anexar o arquivo e
// mandar a mensagem textual com o comando em seguida.
//
// Cache é resetado em cada restart do processo; se a equipe mandar o
// arquivo antes do restart e depois a mensagem, precisa reenviar.
// =====================================================

const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

function _limparExpirados() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (!v || v.expiresAt < now) cache.delete(k);
  }
}

function registrar(conversaId, anexo) {
  if (!conversaId || !anexo) return;
  cache.set(String(conversaId), {
    url: anexo.url,
    fileName: anexo.fileName || null,
    mimeType: anexo.mimeType || null,
    expiresAt: Date.now() + TTL_MS,
  });
  _limparExpirados();
}

function buscarUltimo(conversaId) {
  _limparExpirados();
  const item = cache.get(String(conversaId));
  return item || null;
}

function esquecer(conversaId) {
  cache.delete(String(conversaId));
}

module.exports = { registrar, buscarUltimo, esquecer };
