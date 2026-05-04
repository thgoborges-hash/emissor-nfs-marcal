/**
 * ANA — Validador de Grounding (pré-envio)
 *
 * Sprint 1.3 da revisão arquitetural. Move a auto-validação anti-promessa-vazia
 * de pós-fato pra PRÉ-envio, e amplia pra cobrir alucinação por afirmação
 * factual sem fonte.
 *
 * Inspirado em: Intercom Fin "I don't know" mode (separa Answer Engine de Action
 * Engine; respostas factuais SÓ saem se vieram do Help Center).
 *
 * Por que pré-envio:
 *   Hoje (`agenteIAService._validarResposta`), o Haiku roda DEPOIS da resposta
 *   ser gerada. Se ele bloqueia, a ANA já "prometeu" algo que não vai cumprir
 *   — o cliente vê a promessa, depois a transferência forçada, fica confuso.
 *   Com pré-envio: a resposta é checada antes de qualquer envio. Se rejeitada,
 *   a ANA manda direto a versão de transferência humana — uma única mensagem,
 *   sem a promessa vazia ter sido vista.
 *
 * Validações cobertas:
 *
 *   1. PROMESSA VAZIA (já existia — reaproveitada)
 *      "Vou verificar e te retorno" sem mecanismo de retorno → bloqueia.
 *
 *   2. AFIRMAÇÃO FACTUAL SEM FONTE (novo)
 *      ANA afirma valor/data/alíquota/prazo/regra fiscal sem que essa info
 *      tenha vindo de uma tool result OU de uma skill carregada. Bloqueia
 *      e força "preciso confirmar — chamando o Thiago".
 *
 *      Sinais:
 *        - "vence dia 20", "alíquota é 4%", "DAS é R$ 156,30"
 *        - Sem [ACAO:CONSULTAR_*] na resposta NEM tool result anterior na conversa
 *        - Sem citação de skill/regra
 *
 *   3. AÇÃO IRREVERSÍVEL SEM CONFIRMAÇÃO (preparação pro Sprint 2.1)
 *      Hoje só LOGA quando detecta — bloqueio efetivo será no Sprint 2.1.
 *
 * Arquitetura:
 *   - Regex pré-filtro pra cada padrão (cheap, evita gastar tokens à toa)
 *   - Se NÃO bater nenhum sinal, deixa passar (response OK)
 *   - Se BATER algum, chama Haiku pra confirmar com contexto
 *   - Haiku retorna { ok, motivo, sugestao_resposta }
 *   - Se !ok, caller substitui resposta pela sugestao_resposta (ou padrão de transferência)
 */

const https = require('https');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ── Padrões anti-promessa-vazia (carry-over do _validarResposta antigo) ────
const REGEX_PROMESSA_VAZIA = /\b(vou\s+(verificar|confirmar|olhar|consultar|checar|analisar|pesquisar|ver|dar uma olhada|dar uma verificada|conferir|pegar)|deixa\s+(eu|que\s+eu)\s+(ver|verificar|olhar|consultar|checar|conferir)|te\s+(retorno|aviso|falo|respondo|confirmo)|já\s+(te|lhe)?\s*(retorno|aviso|respondo|falo|confirmo)|(daqui|em)\s+\w+\s+(minuto|segundo|instante|momento))/i;

// ── Padrões de afirmação factual (valor, data, alíquota, prazo, regra) ─────
// Match em coisas tipo: "vence dia 20", "vence em 20/05", "alíquota é 4%",
// "DAS é R$ 156,30", "prazo é até 30 de abril", "código 1.07"
const REGEX_FATO_DATA = /\b(?:vence|vencimento|prazo|até)\s+(?:dia\s+)?\d{1,2}(?:[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?)?\b/i;
const REGEX_FATO_ALIQUOTA = /\b(?:alíquota|aliquota|taxa|imposto)\s*(?:é|de|será)?\s*\d{1,2}(?:[,.]\d{1,2})?\s*%/i;
const REGEX_FATO_VALOR = /\b(?:R\$|valor)\s*\d{1,3}(?:[.,]\d{2,3})*(?:[.,]\d{2})?\b/i;
const REGEX_FATO_CODIGO = /\b(?:código\s+(?:de\s+)?serviço|cnae|cTribNac|cprb)\s+\d/i;

// ── Padrões de ação irreversível (warning only no Sprint 1.3) ───────────────
const REGEX_ACAO_IRREVERSIVEL = /\[ACAO:(EMITIR_NF|CANCELAR_NF|EMITIR_DARF|ATUALIZAR_CLIENTE):/;

const SYSTEM_GROUNDING = `Você é o avaliador de qualidade da ANA, atendente de contabilidade no WhatsApp da Marçal Contabilidade. Avalie se a resposta dela vai resolver o problema do cliente, deixá-lo esperando indefinidamente, OU afirmar fato sem ter fonte que sustente.

ANA NÃO TEM mecanismo de "voltar depois". Se ela promete algo no futuro sem cumprir AGORA, vira promessa vazia.

ANA NÃO PODE INVENTAR fato fiscal/contábil. Se ela afirma um valor, data, alíquota, código de serviço, prazo ou regra, isso TEM QUE vir de:
- Uma tool result anterior na conversa (ex: ANA chamou [ACAO:CONSULTAR_PGDASD_ULTIMA] e a resposta veio com o valor)
- Conteúdo da mensagem do cliente que ela está só reformulando ("certo, R$ 156 que você falou, confirmando...")
- Skill carregada explicitamente (ex: "fonte: skill/das-mei.md")

Se a afirmação NÃO tem essas fontes, é alucinação — bloqueie.

ok=TRUE quando a resposta:
- Resolve a dúvida do cliente de forma concreta com fonte ou citação
- Faz pergunta clara pra coletar info que ANA precisa
- Transfere explicitamente pro humano ("vou chamar o Thiago aqui no chat agora")
- É saudação genérica simples
- Confirma um pedido com uma tag [ACAO:...] concreta

ok=FALSE quando a resposta:
- Promete "vou verificar/te retorno" sem mecanismo real
- Afirma fato fiscal/contábil sem fonte sustentando
- Deixa cliente esperando sem próximo passo

Quando ok=FALSE, devolva também uma "sugestao_resposta" curta no estilo da ANA:
- Se promessa vazia: "essa eu não sei te responder de cabeça — já tô chamando o Thiago aqui mesmo pra te atender 😊 [ACAO:TRANSFERIR_HUMANO]"
- Se alucinação factual: "deixa eu confirmar essa informação com o Thiago antes de te passar — não quero te dar valor errado. Já tô chamando ele aqui [ACAO:TRANSFERIR_HUMANO]"

Responda APENAS em JSON válido, sem markdown:
{"ok": true|false, "tipo": "promessa_vazia"|"alucinacao_factual"|"ok", "motivo": "explicação curta", "sugestao_resposta": "..."}`;

const RESPOSTA_TRANSFER_PADRAO_PROMESSA = 'Essa eu prefiro deixar o Thiago te responder com calma — já tô chamando ele aqui mesmo pra dar atenção, tá? 👍 [ACAO:TRANSFERIR_HUMANO]';
const RESPOSTA_TRANSFER_PADRAO_ALUCINACAO = 'Deixa eu confirmar essa informação com o Thiago antes de te passar — não quero te dar valor errado. Já tô chamando ele aqui 👍 [ACAO:TRANSFERIR_HUMANO]';

/**
 * Valida resposta da ANA antes de enviar.
 *
 * @param {Object} params
 * @param {string} params.mensagemCliente - mensagem original
 * @param {string} params.respostaAna - resposta gerada pelo Sonnet
 * @param {Array<{direcao:string, conteudo:string, metadata?:any}>} [params.historico] - últimas mensagens da conversa
 * @param {boolean} [params.modoEquipe=false] - se modo equipe, mais permissivo (skip alucinação check porque equipe entende contexto)
 * @param {string} [params.apiKey]
 * @param {string} [params.modelo]
 * @returns {Promise<{ok:boolean, tipo:string, motivo:string, sugestao_resposta?:string, resposta_final:string}>}
 *   resposta_final = respostaAna se ok, ou sugestão de transferência se não ok
 */
async function validarPreEnvio({ mensagemCliente, respostaAna, historico = [], modoEquipe = false, apiKey, modelo } = {}) {
  if (!respostaAna || typeof respostaAna !== 'string') {
    return _resultOk(respostaAna || '', 'resposta vazia');
  }

  // Skip 1: resposta tem ação concreta (tag [ACAO:...]) que NÃO é só TRANSFERIR_HUMANO
  // Ações concretas são "ground truth" porque vão executar código.
  const acoesConcretas = (respostaAna.match(/\[ACAO:([A-Z_]+):/g) || [])
    .map(t => t.replace('[ACAO:', '').replace(':', ''))
    .filter(t => t !== 'TRANSFERIR_HUMANO' && t !== 'IGNORAR');
  if (acoesConcretas.length > 0) {
    // Mas ainda checa ação irreversível pra logar warning (Sprint 2.1 vai bloquear)
    if (REGEX_ACAO_IRREVERSIVEL.test(respostaAna)) {
      console.warn('[ana-grounding] ⚠ Ação irreversível disparada sem plano-antes-executar (Sprint 2.1 vai bloquear). Resposta:', respostaAna.substring(0, 200));
    }
    return _resultOk(respostaAna, 'tem ação concreta');
  }

  // Skip 2: resposta muito curta — provavelmente saudação simples
  if (respostaAna.trim().length < 30) {
    return _resultOk(respostaAna, 'resposta curta');
  }

  // Skip 3: modo equipe é mais permissivo (operador entende contexto, não precisa
  // de grounding rígido). Mantém só anti-promessa.
  const verificarFato = !modoEquipe;

  // Pré-filtro 1: promessa vazia
  const temPromessa = REGEX_PROMESSA_VAZIA.test(respostaAna);

  // Pré-filtro 2: afirmação factual sem fonte clara
  let temFatoSemFonte = false;
  if (verificarFato) {
    const temFato = REGEX_FATO_DATA.test(respostaAna)
                  || REGEX_FATO_ALIQUOTA.test(respostaAna)
                  || REGEX_FATO_VALOR.test(respostaAna)
                  || REGEX_FATO_CODIGO.test(respostaAna);
    if (temFato) {
      // Tem fato. Verifica se há fonte:
      //   (a) Tool result no histórico recente (última mensagem da bot com metadata.toolResult ou texto referenciando consulta)
      //   (b) Cliente mencionou o valor/data na própria mensagem (reformular é ok)
      const fonteEmHistorico = _temFonteRecente(historico);
      const fonteNaMensagem = _fatoVeioDoCliente(mensagemCliente, respostaAna);
      if (!fonteEmHistorico && !fonteNaMensagem) {
        temFatoSemFonte = true;
      }
    }
  }

  // Se nenhum sinal de risco, deixa passar
  if (!temPromessa && !temFatoSemFonte) {
    return _resultOk(respostaAna, 'sem sinais de risco');
  }

  // Tem sinal — chama Haiku pra confirmar
  const tipoSuspeito = temFatoSemFonte ? 'alucinacao_factual' : 'promessa_vazia';
  console.log(`[ana-grounding] 🔍 Sinal de ${tipoSuspeito} detectado, validando com Haiku...`);

  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Fail-safe: sem chave, deixa passar (não bloquear ANA por config faltando)
    return _resultOk(respostaAna, 'validador offline (sem API key)');
  }

  try {
    const resultado = await _chamarHaikuValidador({
      apiKey: key,
      modelo: modelo || process.env.ANTHROPIC_VALIDADOR_MODEL || 'claude-haiku-4-5-20251001',
      mensagemCliente,
      respostaAna,
      historico,
    });
    if (resultado.ok) {
      return _resultOk(respostaAna, resultado.motivo);
    }
    // Bloqueado — usa sugestão do Haiku ou padrão por tipo
    const sugestao = resultado.sugestao_resposta
      || (resultado.tipo === 'alucinacao_factual' ? RESPOSTA_TRANSFER_PADRAO_ALUCINACAO : RESPOSTA_TRANSFER_PADRAO_PROMESSA);
    console.warn(`[ana-grounding] ⚠ Resposta bloqueada (${resultado.tipo}): ${resultado.motivo}`);
    return {
      ok: false,
      tipo: resultado.tipo || tipoSuspeito,
      motivo: resultado.motivo || 'bloqueado pelo validador',
      sugestao_resposta: sugestao,
      resposta_final: sugestao,
    };
  } catch (err) {
    // Fail-safe: validador quebrou, deixa passar
    console.warn('[ana-grounding] erro chamando validador, deixando passar:', err.message);
    return _resultOk(respostaAna, `validador erro: ${err.message}`);
  }
}

function _resultOk(resposta, motivo) {
  return { ok: true, tipo: 'ok', motivo, resposta_final: resposta };
}

/**
 * Verifica se nas últimas N mensagens do histórico a ANA executou alguma
 * tool de consulta cujo resultado pode estar sustentando a afirmação atual.
 *
 * Heurística simples: procura por mensagens da ANA recentes que tenham:
 *   - Tags [ACAO:CONSULTAR_*] ou [ACAO:GERAR_DAS_*]
 *   - Metadata com toolResult/integraContador
 *   - Texto formatado como resultado de consulta (R$, "vencimento:", etc)
 *
 * Limitação: não valida CORRELAÇÃO da fonte com a afirmação atual — só checa
 * existência. Pra correlação real, o Haiku faz isso na chamada.
 */
function _temFonteRecente(historico) {
  if (!Array.isArray(historico)) return false;
  const ultimas = historico.slice(-6); // últimas 6 mensagens
  for (const m of ultimas) {
    const conteudo = String(m?.conteudo || '');
    const meta = m?.metadata;
    if (m?.direcao === 'saida' && (m?.remetente === 'bot' || m?.remetente === 'sistema')) {
      if (/\[ACAO:(CONSULTAR_|GERAR_DAS_|SOLICITAR_SITFIS|EMITIR_CCMEI|EMITIR_DARF|LISTAR_CAIXA_POSTAL|BUSCAR_DANFSE|LISTAR_NFS)/.test(conteudo)) {
        return true;
      }
      if (meta && (meta.toolResult || meta.integraContador || meta.serpro)) {
        return true;
      }
      // Padrão visual de resultado: "✅ DAS gerado" ou "Vencimento: " com R$
      if (/✅|⚠️/.test(conteudo) && /R\$|vencimento|alíquota|aliquota/i.test(conteudo)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Verifica se o "fato" na resposta veio do próprio cliente (que ANA está só
 * reformulando — caso comum: cliente diz "preciso emitir 50 reais" e ANA
 * confirma "ok, R$ 50,00..."). Heurística: extrai números/datas da mensagem
 * e da resposta e checa overlap.
 */
function _fatoVeioDoCliente(mensagemCliente, respostaAna) {
  if (!mensagemCliente) return false;
  const numClient = (mensagemCliente.match(/\d+/g) || []).filter(n => n.length >= 2);
  const numResp = (respostaAna.match(/\d+/g) || []).filter(n => n.length >= 2);
  if (numClient.length === 0 || numResp.length === 0) return false;
  const setCli = new Set(numClient);
  // Se TODOS os números relevantes da resposta também aparecem na mensagem do cliente,
  // ela está apenas reformulando — fonte ok.
  return numResp.every(n => setCli.has(n));
}

function _chamarHaikuValidador({ apiKey, modelo, mensagemCliente, respostaAna, historico }) {
  const histTxt = (historico || []).slice(-4).map(m => {
    const quem = m.direcao === 'entrada' ? 'Cliente' : 'ANA';
    return `${quem}: ${(m.conteudo || '').replace(/\[ACAO:[^\]]+\]/g, '').slice(0, 200)}`;
  }).join('\n');

  const userPrompt = `Histórico recente:\n${histTxt || '(nenhum)'}\n\nÚltima mensagem do cliente: "${(mensagemCliente || '').slice(0, 500)}"\n\nResposta da ANA a ser validada: "${respostaAna.slice(0, 800)}"\n\nEssa resposta resolve, deixa em aberto, ou afirma fato sem fonte?`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: modelo,
      max_tokens: 250,
      system: SYSTEM_GROUNDING,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const url = new URL(ANTHROPIC_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 6000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error) return reject(new Error(payload.error.message || 'erro API'));
          const texto = payload.content?.[0]?.text || '';
          const match = texto.match(/\{[\s\S]*\}/);
          if (!match) {
            return resolve({ ok: true, tipo: 'ok', motivo: 'haiku sem JSON' });
          }
          const json = JSON.parse(match[0]);
          resolve({
            ok: !!json.ok,
            tipo: json.tipo || 'ok',
            motivo: String(json.motivo || '').slice(0, 300),
            sugestao_resposta: typeof json.sugestao_resposta === 'string' ? json.sugestao_resposta.slice(0, 500) : null,
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout grounding Haiku')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  validarPreEnvio,
  // Exports só pra teste:
  REGEX_PROMESSA_VAZIA,
  REGEX_FATO_DATA,
  REGEX_FATO_ALIQUOTA,
  REGEX_FATO_VALOR,
  REGEX_FATO_CODIGO,
  REGEX_ACAO_IRREVERSIVEL,
  RESPOSTA_TRANSFER_PADRAO_PROMESSA,
  RESPOSTA_TRANSFER_PADRAO_ALUCINACAO,
};
