/**
 * ANA — Router Haiku (pré-classificador de intenção)
 *
 * Sprint 1.1 da revisão arquitetural. Promove o Haiku (que era só validador
 * pós-fato pra promessa vazia) a ROUTER que classifica a intenção, modo e
 * confiança ANTES do Sonnet rodar.
 *
 * Inspirado em: Klarna AI Assistant, Conta Azul AI, Anthropic agent design
 * (Building effective agents, dez/2024).
 *
 * Por que vale: 80% das mensagens da ANA caem em poucas categorias bem
 * definidas (saudação, consulta DAS, pedir NF, transferir humano, ignorar
 * grupo). Classificar antes:
 *   - Reduz custo (Haiku é ~20x mais barato; em "ignorar grupo" nem chama Sonnet)
 *   - Reduz erros (intenção classificada vira hint pro Sonnet — "essa é uma
 *     consulta DAS" vs deixar Sonnet adivinhar misturando consulta+ação)
 *   - Permite handoff cedo em casos de baixa confiança (mata o "ANA chuta
 *     a ação errada com confiança")
 *
 * Saída estruturada (JSON):
 *   {
 *     intencao:    'saudacao' | 'consulta_info' | 'acao_emitir_nf' |
 *                  'acao_consultar_serpro' | 'acao_baixar_documento' |
 *                  'acao_atualizar_cadastro' | 'handoff_humano' | 'ignorar_grupo',
 *     modo_inferido: 'cliente' | 'equipe',     // pista: muda contexto do prompt
 *     confianca:   0..100,
 *     campos_faltantes: ['valor', 'cnpj_tomador', ...],  // pra acoes
 *     motivo:      string                       // explicação curta
 *   }
 *
 * Regras de uso:
 *   - confianca < 60 → handoff humano direto (não chama Sonnet)
 *   - intencao === 'ignorar_grupo' → não responde, não chama Sonnet
 *   - intencao === 'handoff_humano' → resposta canned + TRANSFERIR_HUMANO
 *   - resto → chama Sonnet com a intenção como hint no system prompt
 */

const https = require('https');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const INTENCOES_VALIDAS = new Set([
  'saudacao',
  'consulta_info',
  'acao_emitir_nf',
  'acao_consultar_serpro',
  'acao_baixar_documento',
  'acao_atualizar_cadastro',
  'handoff_humano',
  'ignorar_grupo',
]);

const SYSTEM_ROUTER = `Você é um classificador de intenção para a ANA, atendente de contabilidade no WhatsApp da Marçal Contabilidade. Sua função é examinar UMA mensagem (com contexto leve) e classificar em UMA categoria.

CATEGORIAS:

- saudacao: "oi", "bom dia", "tudo bem?", "obrigado". Mensagem sem demanda específica. Ana responde curto e espera.

- consulta_info: pergunta factual sem ação ("qual o vencimento do DAS?", "preciso emitir NF como?", "quanto é a alíquota do Simples?"). Resposta é informativa, sem disparar tool de escrita.

- acao_emitir_nf: cliente ou equipe pedindo emissão de NFS-e. Sinais: "emite uma nota", "preciso de uma NF", "manda nota pra X". Pode vir com valor + tomador + descrição já no texto (campos_faltantes vazia) ou parcial.

- acao_consultar_serpro: consulta SERPRO/Receita (read-only). PGDAS-D, DCTFWeb, caixa postal e-CAC, procurações, situação fiscal. Equipe pede "consulta o DAS do CNPJ X", "tem caixa postal nova pra Y?".

- acao_baixar_documento: pedido de PDF/documento existente. DANFSe ("manda a nota X em PDF"), DAS Simples/MEI ("gera o DAS"), DARF, CCMEI, SITFIS, segunda via.

- acao_atualizar_cadastro: cadastro/atualização (CADASTRAR_A1, ATUALIZAR_CLIENTE, VINCULAR_CLIENTE). "Sobe o A1 desse cliente", "atualiza o código de serviço pra 1.07", "vincula meu CNPJ".

- handoff_humano: situação que ANA não resolve (ex: cliente irritado, dúvida fora do escopo contábil, problema técnico complexo, pedido vago demais). Melhor passar pra equipe humana.

- ignorar_grupo: mensagem em grupo que NÃO é pra ANA (conversa interna do cliente, saudação genérica, piada, alguém falando de outro assunto). Sinais: ausência de menção a ANA/Marçal/NF/contabilidade + tipo_contato='grupo'.

CONTEXTO QUE VOCÊ RECEBE:
- mensagem (string)
- modo_detectado: 'cliente' | 'equipe' | 'desconhecido' (já vem da camada de detecção de modo equipe)
- tipo_contato: 'cliente' | 'tomador' | 'grupo' | 'desconhecido' | 'escritorio'
- ultimas_3_msgs (array opcional, pra desambiguar)

REGRAS DE OURO:
1. NA DÚVIDA, escolha 'handoff_humano' com confianca baixa. É melhor passar pra humano do que ANA chutar errado.
2. Em 'tipo_contato=grupo', se a mensagem não menciona Ana/Marçal/NF/contabilidade explicitamente, classifique 'ignorar_grupo'.
3. 'modo_inferido' deve refletir QUEM mandou (cliente final vs equipe Marçal), não o destinatário da ação. Use modo_detectado como pista forte.
4. confianca:
   - 90-100: sinal claro e inequívoco
   - 70-89: provável mas tem nuance
   - 50-69: ambíguo; melhor checar
   - <50: muito incerto; handoff
5. campos_faltantes só pra ações (emitir_nf, baixar_documento). Liste o que falta pra executar (ex: ['valor', 'cnpj_tomador', 'descricao']).

SAÍDA: APENAS JSON válido, sem markdown nem texto fora. Schema:
{"intencao":"...","modo_inferido":"...","confianca":NN,"campos_faltantes":[...],"motivo":"..."}`;

/**
 * Classifica uma mensagem.
 *
 * @param {Object} params
 * @param {string} params.mensagem
 * @param {string} [params.modoDetectado='desconhecido'] — vem do anaModoEquipeService.detectar
 * @param {string} [params.tipoContato='desconhecido']
 * @param {Array<{direcao:string, conteudo:string}>} [params.ultimas3Msgs=[]]
 * @param {string} [params.apiKey] — default ANTHROPIC_API_KEY env
 * @param {string} [params.modelo] — default ANTHROPIC_VALIDADOR_MODEL env
 * @returns {Promise<{intencao:string, modo_inferido:string, confianca:number, campos_faltantes:string[], motivo:string, deve_chamar_sonnet:boolean, deve_ignorar:boolean, deve_handoff:boolean}>}
 */
async function classificar({ mensagem, modoDetectado = 'desconhecido', tipoContato = 'desconhecido', ultimas3Msgs = [], apiKey, modelo } = {}) {
  if (!mensagem || typeof mensagem !== 'string') {
    return _decisaoFallback('mensagem vazia ou inválida');
  }

  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return _decisaoFallback('ANTHROPIC_API_KEY não configurada');

  const modeloUsado = modelo || process.env.ANTHROPIC_VALIDADOR_MODEL || 'claude-haiku-4-5-20251001';

  const userPrompt = JSON.stringify({
    mensagem: mensagem.slice(0, 1500),
    modo_detectado: modoDetectado,
    tipo_contato: tipoContato,
    ultimas_3_msgs: (ultimas3Msgs || []).slice(-3).map(m => ({
      direcao: m.direcao,
      conteudo: (m.conteudo || '').replace(/\[ACAO:[^\]]+\]/g, '').slice(0, 200),
    })),
  });

  try {
    const resp = await _chamarHaiku({
      apiKey: key,
      modelo: modeloUsado,
      systemPrompt: SYSTEM_ROUTER,
      userPrompt,
      maxTokens: 220,
      timeoutMs: 6000,
    });
    return _interpretarRespostaHaiku(resp);
  } catch (err) {
    console.warn('[ana-router] erro chamando Haiku, fallback handoff:', err.message);
    return _decisaoFallback(`erro router: ${err.message}`);
  }
}

function _interpretarRespostaHaiku(textoBruto) {
  const match = textoBruto.match(/\{[\s\S]*\}/);
  if (!match) {
    return _decisaoFallback('haiku não retornou JSON');
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    return _decisaoFallback('haiku retornou JSON inválido');
  }

  const intencao = INTENCOES_VALIDAS.has(parsed.intencao) ? parsed.intencao : 'handoff_humano';
  const confianca = Math.max(0, Math.min(100, Number(parsed.confianca) || 0));
  const modoInferido = ['cliente', 'equipe'].includes(parsed.modo_inferido) ? parsed.modo_inferido : 'cliente';
  const camposFaltantes = Array.isArray(parsed.campos_faltantes) ? parsed.campos_faltantes.slice(0, 10) : [];
  const motivo = String(parsed.motivo || '').slice(0, 300);

  // Threshold configurável via env (default 40, era 60 hardcoded).
  // 60 era conservador demais — pedidos técnicos completos (cTribNac, retenções,
  // descrições longas) caíam <60 e iam pra handoff mesmo sendo claramente
  // emitir_nf. 40 deixa o Sonnet (que conhece todas as tools) lidar com a nuance.
  const thresholdEnv = Number(process.env.ANA_ROUTER_HANDOFF_THRESHOLD);
  const confiancaMinima = Number.isFinite(thresholdEnv) && thresholdEnv > 0 && thresholdEnv <= 100
    ? thresholdEnv
    : 40;

  const deveIgnorar = intencao === 'ignorar_grupo';
  const deveHandoff = intencao === 'handoff_humano' || confianca < confiancaMinima;
  const deveChamarSonnet = !deveIgnorar && !deveHandoff;

  return {
    intencao,
    modo_inferido: modoInferido,
    confianca,
    confianca_minima: confiancaMinima,
    campos_faltantes: camposFaltantes,
    motivo,
    deve_chamar_sonnet: deveChamarSonnet,
    deve_ignorar: deveIgnorar,
    deve_handoff: deveHandoff,
  };
}

function _decisaoFallback(motivo) {
  // Fail-safe: na dúvida, handoff humano. Nunca queremos ANA chutando.
  return {
    intencao: 'handoff_humano',
    modo_inferido: 'cliente',
    confianca: 0,
    campos_faltantes: [],
    motivo,
    deve_chamar_sonnet: false,
    deve_ignorar: false,
    deve_handoff: true,
  };
}

function _chamarHaiku({ apiKey, modelo, systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      system: systemPrompt,
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
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error) return reject(new Error(payload.error.message || 'erro API'));
          const texto = payload.content?.[0]?.text || '';
          if (!texto) return reject(new Error('resposta vazia do Haiku'));
          resolve(texto);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout router Haiku')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  classificar,
  // Exports só pra teste:
  _interpretarRespostaHaiku,
  _decisaoFallback,
  INTENCOES_VALIDAS,
  SYSTEM_ROUTER,
};
