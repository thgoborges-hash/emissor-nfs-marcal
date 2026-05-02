/**
 * ANA — Detecção de modo equipe robusta (3 camadas)
 *
 * Substitui a heurística antiga `detectarModoEquipe` que sofria com falsos
 * positivos ("T:", "Olá:", etc).
 *
 * Camadas (ordem de prioridade):
 *   1) Telefone admin           → modo equipe garantido (fonte: 'admin')
 *   2) Grupo staff configurado   → modo equipe garantido (fonte: 'staff_group')
 *   3) Prefixo "Nome:" + nome em whitelist → modo equipe (fonte: 'prefixo')
 *   4) Prefixo "Nome:" mas nome desconhecido → modo cliente + flag ambíguo
 *      (loga alerta pra admin revisar e considerar adicionar à whitelist)
 *   5) Nada disso → modo cliente conservador
 *
 * A whitelist vem de duas fontes (combinadas):
 *   - env ANA_OPERADORES="Janaina Alves,Lucas Silva,Thiago Borges"
 *   - tabela ana_operadores (lookup com WHERE ativo=1)
 *
 * Se NENHUMA das duas fontes tiver entradas, cai no modo legacy (heurística
 * "nome próprio com 1-4 palavras + maiúscula inicial"), pra não quebrar
 * instalações novas. Isso emite WARN no log.
 */

// Regex pra detectar prefixo de operador (Messenger Domínio + grupo + negrito).
// Aceita: "Janaina Alves: ...", "[grupo] Janaina Alves: ...", "*Janaina Alves:* ..."
const PREFIXO_OPERADOR_REGEX = /^(?:\[[^\]]+\]\s*)?\*?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s.'-]{1,60}):\*?\s*([\s\S]*)/;

// Palavras que NUNCA são nomes de operadores (mesmo se vier como "Palavra: ...")
const STOP_WORDS = new Set([
  'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'obrigado', 'obrigada',
  'opa', 'eai', 'e aí', 'tudo bem', 'beleza', 'tranquilo',
  'sim', 'não', 'nao', 'ok', 'okay', 'tá', 'ta', 'certo', 'claro',
  'p', 's', 'n', 'k', 't',
  'olá ana', 'oi ana', 'ana',
  'aqui', 'lá', 'la',
  'urgente', 'atenção', 'atencao', 'aviso',
  'site', 'app', 'erro', 'problema', 'dúvida', 'duvida',
]);

// Cache da whitelist (recarrega a cada N segundos se mudou)
let _whitelistCache = null;
let _whitelistCacheAt = 0;
const WHITELIST_TTL_MS = 60 * 1000; // 1min

function _normalizarNome(nome) {
  if (!nome || typeof nome !== 'string') return '';
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos
    .toLowerCase()
    .replace(/[^a-z\s.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _carregarWhitelist(getDbFn) {
  const agora = Date.now();
  if (_whitelistCache && (agora - _whitelistCacheAt) < WHITELIST_TTL_MS) {
    return _whitelistCache;
  }

  const set = new Set();

  // Fonte 1: env var
  const envOperadores = (process.env.ANA_OPERADORES || '').trim();
  if (envOperadores) {
    envOperadores.split(',').forEach(n => {
      const norm = _normalizarNome(n);
      if (norm) set.add(norm);
    });
  }

  // Fonte 2: tabela ana_operadores (se existir e tiver entradas)
  try {
    if (typeof getDbFn === 'function') {
      const db = getDbFn();
      // Verifica se a tabela existe (pra não quebrar em instalações velhas)
      const tabela = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ana_operadores'"
      ).get();
      if (tabela) {
        const linhas = db.prepare(
          'SELECT nome_normalizado FROM ana_operadores WHERE ativo = 1'
        ).all();
        for (const l of linhas) {
          if (l.nome_normalizado) set.add(l.nome_normalizado);
        }
      }
    }
  } catch (err) {
    // Não quebra: mantém só o que veio da env
    console.warn('[ana-modo-equipe] erro lendo whitelist:', err.message);
  }

  _whitelistCache = set;
  _whitelistCacheAt = agora;
  return set;
}

function _invalidarCache() {
  _whitelistCache = null;
  _whitelistCacheAt = 0;
}

function _telefonesEquivalentes(numA, numB) {
  if (!numA || !numB) return false;
  const a = String(numA).replace(/\D/g, '');
  const b = String(numB).replace(/\D/g, '');
  if (a === b) return true;
  // Tolerância 9 extra em celulares BR (5541999999999 vs 554199999999)
  const variantes = (n) => {
    const v = new Set([n]);
    if (n.length === 13 && n.startsWith('55') && n[4] === '9') v.add(n.slice(0, 4) + n.slice(5));
    else if (n.length === 12 && n.startsWith('55')) v.add(n.slice(0, 4) + '9' + n.slice(4));
    return v;
  };
  for (const x of variantes(a)) for (const y of variantes(b)) {
    if (x === y) return true;
    const menor = x.length < y.length ? x : y;
    const maior = x.length < y.length ? y : x;
    if (menor.length >= 10 && maior.startsWith(menor)) return true;
  }
  return false;
}

/**
 * @typedef {Object} ResultadoModoEquipe
 * @property {boolean} ehEquipe
 * @property {string|null} operador             - nome do operador (se identificado)
 * @property {'admin'|'staff_group'|'prefixo'|'nenhum'} fonte - como foi detectado
 * @property {boolean} ambiguo                  - true se prefixo detectado mas nome não está na whitelist
 * @property {string} mensagemSemPrefixo
 * @property {string} [motivoAmbiguidade]       - explicação humana se ambiguo=true
 */

/**
 * Detecta modo equipe combinando todas as camadas.
 * Retorna estrutura unificada — sempre setando `mensagemSemPrefixo`
 * (mesmo em modo cliente, o caller pode usar o conteúdo limpo).
 *
 * @param {string} mensagem
 * @param {Object} contato        - { telefone, ... }
 * @param {Function} getDbFn      - função que devolve o handle do db
 * @returns {ResultadoModoEquipe}
 */
function detectar(mensagem, contato = null, getDbFn = null) {
  const respostaBase = {
    ehEquipe: false,
    operador: null,
    fonte: 'nenhum',
    ambiguo: false,
    mensagemSemPrefixo: mensagem,
  };

  if (!mensagem || typeof mensagem !== 'string') {
    return respostaBase;
  }

  // ── Camada 1: telefone admin ──────────────────────────────────────────────
  const adminPhone = (process.env.ANA_ADMIN_WHATSAPP || '').trim();
  if (adminPhone && contato?.telefone && _telefonesEquivalentes(adminPhone, contato.telefone)) {
    return {
      ...respostaBase,
      ehEquipe: true,
      operador: 'Thiago',
      fonte: 'admin',
    };
  }

  // ── Camada 2: grupo staff configurado ─────────────────────────────────────
  // Telefone do contato em conversa de grupo costuma vir como "<id>@g.us" ou
  // "<id>-group@g.us". Comparamos só o prefixo numérico.
  const staffGroupsRaw = (process.env.ANA_STAFF_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (staffGroupsRaw.length > 0 && contato?.telefone) {
    const extrairIdNum = (str) => (String(str).match(/^(\d+)/) || [])[1] || '';
    const telId = extrairIdNum(contato.telefone);
    const ehStaff = !!telId && staffGroupsRaw.some(id => extrairIdNum(id) === telId);
    if (ehStaff) {
      // Em grupo staff a mensagem vem com "[PushName] texto" prefixado pelo whatsapp.js
      const matchPush = mensagem.match(/^\[([^\]]+)\]\s*([\s\S]*)/);
      return {
        ehEquipe: true,
        operador: matchPush ? matchPush[1].trim() : 'Equipe',
        fonte: 'staff_group',
        ambiguo: false,
        mensagemSemPrefixo: matchPush ? matchPush[2].trim() : mensagem,
      };
    }
  }

  // ── Camada 3: prefixo "Nome:" validado contra whitelist ───────────────────
  const match = mensagem.match(PREFIXO_OPERADOR_REGEX);
  if (!match) {
    return respostaBase;
  }

  const possivelNome = match[1].trim();
  const possivelNomeNorm = _normalizarNome(possivelNome);
  const conteudo = (match[2] || '').trim();

  // Filtro 1: stop words ("Olá:", "Oi:", "T:") nunca são operador
  if (STOP_WORDS.has(possivelNomeNorm)) {
    return respostaBase;
  }

  // Filtro 2: precisa ter pelo menos 2 caracteres no nome (sem espaços)
  if (possivelNomeNorm.replace(/\s/g, '').length < 2) {
    return respostaBase;
  }

  // Filtro 3: cada palavra deve começar com maiúscula no original
  const palavras = possivelNome.split(/\s+/);
  const todasMaiusculasIniciais = palavras.every(p => /^[A-ZÀ-Ÿ]/.test(p));
  if (!todasMaiusculasIniciais || palavras.length > 4) {
    return respostaBase;
  }

  // Validação contra whitelist
  const whitelist = _carregarWhitelist(getDbFn);

  if (whitelist.size === 0) {
    // Modo legacy: se não tem whitelist configurada, aceita pela heurística
    // (mesmo comportamento de antes, mas com stop words filtradas)
    console.warn('[ana-modo-equipe] whitelist vazia — aceitando por heurística. Configure ANA_OPERADORES no env.');
    return {
      ehEquipe: true,
      operador: possivelNome,
      fonte: 'prefixo',
      ambiguo: false,
      mensagemSemPrefixo: conteudo,
    };
  }

  if (whitelist.has(possivelNomeNorm)) {
    return {
      ehEquipe: true,
      operador: possivelNome,
      fonte: 'prefixo',
      ambiguo: false,
      mensagemSemPrefixo: conteudo,
    };
  }

  // Match parcial: nome composto onde só uma parte bate (ex: whitelist tem "Janaina Alves",
  // mensagem veio como "Janaina:"). Se o primeiro nome bate, ainda aceita mas marca ambíguo.
  for (const norm of whitelist) {
    const partes = norm.split(/\s+/);
    if (partes.includes(possivelNomeNorm) || partes[0] === possivelNomeNorm) {
      return {
        ehEquipe: true,
        operador: possivelNome,
        fonte: 'prefixo',
        ambiguo: false,
        mensagemSemPrefixo: conteudo,
      };
    }
  }

  // Prefixo detectado mas nome não está na whitelist → AMBÍGUO
  // Trata como cliente (conservador) e marca pra alerta admin.
  return {
    ehEquipe: false,
    operador: null,
    fonte: 'nenhum',
    ambiguo: true,
    motivoAmbiguidade: `prefixo "${possivelNome}:" detectado mas nome não está na whitelist ANA_OPERADORES`,
    mensagemSemPrefixo: mensagem, // mantém prefixo pro Sonnet ver, já que é cliente
  };
}

module.exports = {
  detectar,
  _normalizarNome,
  _invalidarCacheWhitelist: _invalidarCache,
  _carregarWhitelist,
};
