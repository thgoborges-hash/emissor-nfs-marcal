/**
 * codigoServicoSugestaoService.js
 *
 * Sugere o código de tributação nacional (cTribNac) a partir da descrição do serviço
 * e do CNAE do prestador. Usa FTS5 do SQLite pra busca por palavras-chave + ranking BM25,
 * com bônus quando o CNAE bate com a afinidade conhecida do código.
 *
 * Política de auto-aplicação (top 1):
 *   - score absoluto >= LIMIAR_AUTO  E
 *   - gap relativo (top1 - top2)/top1 >= GAP_AUTO
 * Caso contrário, devolve top 3 candidatos pra a Ana mostrar pra equipe escolher.
 */

const { getDb } = require('../database/init');

// Tunables — começamos conservador. Pode ajustar via env vars sem redeploy.
const LIMIAR_AUTO = parseFloat(process.env.CTRIBNAC_LIMIAR_AUTO || '6.0');     // score BM25 mínimo
const GAP_AUTO = parseFloat(process.env.CTRIBNAC_GAP_AUTO || '0.30');           // 30% de folga p/ 2º
const TOP_N = parseInt(process.env.CTRIBNAC_TOP_N || '3', 10);

// Boost de CNAE — se o prefixo de 4 dígitos do CNAE do emitente bater com a afinidade do código,
// aumenta o ranking artificial em CNAE_BONUS pontos. Funciona em cima do BM25.
const CNAE_BONUS = parseFloat(process.env.CTRIBNAC_CNAE_BONUS || '2.0');

function _slugify(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _lematizar(token) {
  // Lematização leve pra português:
  //   "honorarios" → "honorario", "consultas" → "consulta", "medicas" → "medica"
  // Sem isso, prefix matching ("consultas*") não casaria com "consulta" no índice.
  if (token.length < 5) return token;
  if (/oes$/.test(token)) return token.slice(0, -3) + 'ao';   // exames "oes" → "ao" (ex: solucoes → solucao)
  if (/ais$/.test(token) && token.length > 5) return token.slice(0, -3) + 'al';  // patrimoniais → patrimonial
  if (/eis$/.test(token) && token.length > 5) return token.slice(0, -3) + 'el';  // imoveis → imovel
  if (/s$/.test(token) && !/ss$/.test(token)) return token.slice(0, -1);
  return token;
}

function _termosFTS(query) {
  // FTS5: tokens > 2 chars, sem operadores. Usamos OR implícito (match-any).
  const STOP = new Set([
    'de','da','do','das','dos','e','a','o','as','os','para','por','com','em',
    'no','na','nos','nas','que','seu','sua','ou','um','uma','ao','aos','pelo','pela',
    'sobre','referente','prestacao','servico','servicos','tipo','meio','meios','geral',
  ]);
  const raw = _slugify(query).split(' ').filter(t => t.length > 2 && !STOP.has(t));
  if (raw.length === 0) return null;
  // Lematiza (tira 's' final etc) e aplica prefix pra >= 4 chars
  const lemma = raw.map(_lematizar);
  return lemma.map(t => t.length >= 4 ? `"${t}"*` : `"${t}"`).join(' OR ');
}

/**
 * Busca top-N candidatos.
 * @param {string} descricao - descrição do serviço (ex: "Consulta médica")
 * @param {string} [cnae] - CNAE do emitente (ex: "8630-5/03")
 * @returns {Array<{codigo, descricao, grupo, score, score_bm25, bonus_cnae}>}
 */
function buscarCandidatos(descricao, cnae = '') {
  const db = getDb();
  const expr = _termosFTS(descricao);
  if (!expr) return [];

  let rows;
  try {
    // bm25() retorna número onde MENOR é melhor — invertemos pra MAIOR=melhor
    rows = db.prepare(`
      SELECT c.codigo, c.descricao, c.grupo, c.cnae_afins,
             -bm25(codigos_servico_nacional_fts) AS score_bm25
      FROM codigos_servico_nacional_fts
      JOIN codigos_servico_nacional c ON c.codigo = codigos_servico_nacional_fts.codigo
      WHERE codigos_servico_nacional_fts MATCH ?
      ORDER BY score_bm25 DESC
      LIMIT 30
    `).all(expr);
  } catch (e) {
    console.warn('[codigoServicoSugestao] FTS query falhou:', e.message);
    return [];
  }

  // Aplica bônus de CNAE
  const cnaePref = String(cnae || '').replace(/\D/g, '').slice(0, 4);  // primeiros 4 dígitos
  for (const r of rows) {
    let bonus = 0;
    if (cnaePref) {
      try {
        const afins = JSON.parse(r.cnae_afins || '[]');
        if (Array.isArray(afins) && afins.some(p => String(p).startsWith(cnaePref) || cnaePref.startsWith(String(p)))) {
          bonus = CNAE_BONUS;
        }
      } catch { /* ok, sem afins */ }
    }
    r.bonus_cnae = bonus;
    r.score = (r.score_bm25 || 0) + bonus;
  }

  // Reordena com bônus aplicado
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, TOP_N).map(r => ({
    codigo: r.codigo,
    descricao: r.descricao,
    grupo: r.grupo,
    score: Number(r.score.toFixed(2)),
    score_bm25: Number((r.score_bm25 || 0).toFixed(2)),
    bonus_cnae: r.bonus_cnae,
  }));
}

/**
 * Decide entre auto-aplicar o top1 ou devolver candidatos pra a equipe escolher.
 * @returns {{ auto: boolean, codigo?: string, descricao?: string, candidatos?: Array, motivo: string }}
 */
function escolher(descricao, cnae = '') {
  const candidatos = buscarCandidatos(descricao, cnae);
  if (candidatos.length === 0) {
    return { auto: false, candidatos: [], motivo: 'nenhum_candidato' };
  }
  const top1 = candidatos[0];
  const top2 = candidatos[1];

  if (top1.score < LIMIAR_AUTO) {
    return { auto: false, candidatos, motivo: `score_baixo (${top1.score} < ${LIMIAR_AUTO})` };
  }
  if (top2) {
    const gap = (top1.score - top2.score) / Math.max(top1.score, 0.0001);
    if (gap < GAP_AUTO) {
      return { auto: false, candidatos, motivo: `gap_estreito (${(gap * 100).toFixed(0)}% < ${(GAP_AUTO * 100).toFixed(0)}%)` };
    }
  }
  return {
    auto: true,
    codigo: top1.codigo,
    descricao: top1.descricao,
    grupo: top1.grupo,
    candidatos,
    motivo: 'auto_aplicado',
  };
}

module.exports = {
  buscarCandidatos,
  escolher,
  // tunables expostos pra teste
  _config: { LIMIAR_AUTO, GAP_AUTO, TOP_N, CNAE_BONUS },
};
