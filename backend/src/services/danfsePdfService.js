/**
 * DANFSe PDF Service
 *
 * Entrega APENAS o DANFSe oficial gerado pelo ADN (Ambiente de Dados
 * Nacional da Receita Federal), autenticando com mTLS + certificado A1
 * do prestador.
 *
 * Politica desde 20/04/2026: sem fallback local (Puppeteer) — se o ADN
 * nao responder apos os retries, devolvemos erro. PDF gerado fora do
 * canal oficial nao tem validade pratica (sem selo/assinatura do ADN)
 * e causaria confusao pro cliente final.
 *
 * O documento fiscal com validade legal eh o XML assinado — o DANFSe eh
 * apenas representacao visual pra apresentacao/arquivo. Por isso nao
 * tem problema retornar erro: a NF continua emitida e valida.
 */

const https = require("https");
const { URL } = require("url");

// =====================================================
// Endpoint oficial ADN / DANFSe
// https://adn.nfse.gov.br/danfse/{chaveAcesso}
// Doc: https://adn.nfse.gov.br/danfse/docs/index.html
// =====================================================

const ADN_BASE_URL       = process.env.ADN_DANFSE_BASE_URL       || "https://adn.nfse.gov.br";
const ADN_TIMEOUT_MS     = Number(process.env.ADN_DANFSE_TIMEOUT_MS     || 20000);
const ADN_RETRY_MAX      = Number(process.env.ADN_DANFSE_RETRY_MAX      || 6);
const ADN_RETRY_BASE_MS  = Number(process.env.ADN_DANFSE_RETRY_BASE_MS  || 1000);
const ADN_USER_AGENT     = process.env.ADN_DANFSE_USER_AGENT    || "emissor-nfs-marcal/1.0 (+https://emissor-nfs-marcal.onrender.com)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tentarAdn(chaveAcesso, pfxBuffer, senha) {
  const url = new URL(ADN_BASE_URL + "/danfse/" + chaveAcesso);
  const options = {
    method: "GET",
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    pfx: pfxBuffer,
    passphrase: senha,
    headers: {
      "Accept": "*/*",
      "User-Agent": ADN_USER_AGENT,
      "Connection": "close",
    },
    timeout: ADN_TIMEOUT_MS,
  };

  const inicio = Date.now();
  return new Promise((resolve) => {
    const req = https.request(options, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const tempoMs = Date.now() - inicio;
        const buffer  = Buffer.concat(chunks);
        const ePdf    = buffer.slice(0, 4).toString() === "%PDF";
        const preview = buffer.slice(0, 200).toString("utf-8").replace(/[^\x20-\x7E\n]/g, ".");
        if (r.statusCode === 200 && ePdf) {
          resolve({ status: 200, pdf: buffer, preview: "", tempoMs });
        } else {
          resolve({ status: r.statusCode, pdf: null, preview, tempoMs });
        }
      });
    });
    req.on("timeout", () => {
      const tempoMs = Date.now() - inicio;
      req.destroy();
      resolve({ status: 0, pdf: null, preview: "timeout " + ADN_TIMEOUT_MS + "ms", tempoMs });
    });
    req.on("error", (err) => {
      const tempoMs = Date.now() - inicio;
      resolve({ status: 0, pdf: null, preview: "rede: " + err.message, tempoMs });
    });
    req.end();
  });
}

async function obterDanfseOficial({ chaveAcesso, pfxBuffer, senha }) {
  if (!chaveAcesso || !pfxBuffer || !senha) {
    const err = new Error("DANFSe: parametros ausentes (chaveAcesso/pfxBuffer/senha)");
    err.code = "ADN_PARAMS_FALTANDO";
    throw err;
  }

  const historico = [];
  for (let tentativa = 1; tentativa <= ADN_RETRY_MAX; tentativa++) {
    const r = await tentarAdn(chaveAcesso, pfxBuffer, senha);
    historico.push({ tentativa, status: r.status, tempoMs: r.tempoMs });
    if (r.pdf) {
      if (tentativa > 1) {
        console.log("[DANFSe-ADN] OK na tentativa " + tentativa + "/" + ADN_RETRY_MAX + " (" + r.pdf.length + " bytes)");
      } else {
        console.log("[DANFSe-ADN] OK (" + r.pdf.length + " bytes, " + r.tempoMs + "ms) chave=" + chaveAcesso.slice(-6));
      }
      return { pdf: r.pdf, fonte: "oficial" };
    }
    console.warn("[DANFSe-ADN] tentativa " + tentativa + "/" + ADN_RETRY_MAX + " falhou: status=" + r.status + " em " + r.tempoMs + "ms | " + r.preview.slice(0, 120));

    if (tentativa < ADN_RETRY_MAX) {
      const delay = Math.min(ADN_RETRY_BASE_MS * Math.pow(2, tentativa - 1), 30000);
      await sleep(delay);
    }
  }

  const err = new Error("ADN indisponivel apos " + ADN_RETRY_MAX + " tentativas (chave " + chaveAcesso.slice(-6) + ")");
  err.code = "ADN_INDISPONIVEL";
  err.historico = historico;
  throw err;
}

module.exports = {
  obterDanfseOficial,
  obterDanfseCascata: async ({ chaveAcesso, pfxBuffer, senha }) =>
    obterDanfseOficial({ chaveAcesso, pfxBuffer, senha }),
};
