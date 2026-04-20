/**
 * Agente Inteligente - Atendimento via WhatsApp
 * Usa Claude API (Anthropic) para processar mensagens e responder clientes
 */

const https = require('https');
const { getDb } = require('../database/init');
const cnpjService = require('./cnpjService');
const integraContadorService = require('./integraContadorService');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Regex pra detectar prefixo de operador vindo do Messenger do Domínio
// Ex.: "Janaina Alves: Segue a declaração..." → operador = "Janaina Alves"
const OPERADOR_DOMINIO_REGEX = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,40}):\s*(.*)/s;

class AgenteIAService {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    this.modelo = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  }

  /**
   * Verifica se a API está configurada
   */
  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * Processa mensagem recebida e gera resposta inteligente
   */
  async processarMensagem(telefone, mensagem, conversaId) {
    const db = getDb();

    // 1. Identifica o contato e busca contexto
    const contato = db.prepare(`
      SELECT wc.*, c.razao_social, c.nome_fantasia, c.cnpj, c.email
      FROM whatsapp_contatos wc
      LEFT JOIN clientes c ON wc.cliente_id = c.id
      WHERE wc.telefone = ?
    `).get(telefone);

    // 2. Busca histórico recente da conversa
    const historico = db.prepare(`
      SELECT direcao, conteudo, remetente, created_at
      FROM whatsapp_mensagens
      WHERE conversa_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(conversaId).reverse();

    // 3. Busca dados relevantes do cliente (se identificado)
    let dadosCliente = null;
    if (contato?.cliente_id) {
      dadosCliente = this.buscarDadosCliente(contato.cliente_id);
    }

    // 3.5. Detecta se é mensagem de operador da equipe Marçal (vindo do Messenger Domínio)
    const modoEquipe = this.detectarModoEquipe(mensagem);
    if (modoEquipe.ehEquipe) {
      console.log(`[AgenteIA] Modo EQUIPE detectado — operador: ${modoEquipe.operador}`);
    }

    // 4. Monta o prompt do sistema
    const systemPrompt = this.montarSystemPrompt(contato, dadosCliente, modoEquipe);

    // 5. Monta mensagens para a API
    const messages = this.montarMensagens(historico, mensagem);

    // 6. Chama a Claude API
    const resposta = await this.chamarClaude(systemPrompt, messages);

    // DEBUG: loga resposta bruta do Claude pra diagnosticar ações
    console.log(`[AgenteIA] Resposta bruta (${resposta.length} chars): ${resposta.substring(0, 300)}`);

    // 7. Verifica se precisa executar ações
    const acoes = this.extrairAcoes(resposta);
    console.log(`[AgenteIA] Ações extraídas: ${acoes.length > 0 ? acoes.map(a => `${a.tipo}(${(a.parametro||'').substring(0,50)})`).join(', ') : 'nenhuma'}`);

    if (acoes.length > 0) {
      await this.executarAcoes(acoes, contato, conversaId);

      // 8. Verifica se alguma ação teve feedback que precisa de follow-up
      const feedbackEmissao = acoes.find(a => a.tipo === 'EMITIR_NF' && a.feedback);
      if (feedbackEmissao?.feedback) {
        const fb = feedbackEmissao.feedback;
        let feedbackMsg = '';

        if (fb.sucesso) {
          const numDisplay = fb.numero && fb.numero !== 'undefined' && fb.numero !== '(emitida)' ? fb.numero : '';
          const valorFormatado = fb.valor ? Number(fb.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00';
          feedbackMsg = `\n\n✅ *NF emitida com sucesso!*` +
            (numDisplay ? `\nNúmero: ${numDisplay}` : '') +
            (fb.chaveAcesso ? `\nChave: ${fb.chaveAcesso}` : '') +
            `\nValor: R$ ${valorFormatado}` +
            `\nTomador: ${fb.tomador}`;
        } else if (fb.status === 'erro_emissao' || fb.erro) {
          // Mensagem específica baseada no tipo de erro
          const erroStr = (fb.numero || fb.erro || '').toLowerCase();
          console.log(`[WhatsApp] Erro na emissão (detalhes): ${fb.numero || fb.erro || 'erro desconhecido'}`);

          if (erroStr.includes('certificado')) {
            feedbackMsg = `\n\n⚠️ Não consegui emitir a NF porque o certificado digital A1 não está configurado ou está vencido. Vou avisar o Thiago pra resolver isso rapidinho! A NF ficou salva e será emitida assim que o certificado estiver ok.`;
          } else if (erroStr.includes('pré-validação') || erroStr.includes('dados incompletos')) {
            // Extrai os erros específicos da pré-validação
            const detalhes = (fb.numero || fb.erro || '').replace(/^(Pré-validação: |Dados incompletos: )/i, '');
            feedbackMsg = `\n\n⚠️ Quase lá! Faltam alguns dados pra emitir:\n${detalhes}\n\nMe passa essas informações que eu emito na hora! 😉`;
          } else if (erroStr.includes('e0') || erroStr.includes('rejeição') || erroStr.includes('rejeicao') || erroStr.includes('sefin')) {
            // Erros da SEFIN (códigos E0xxx)
            feedbackMsg = `\n\n⚠️ A prefeitura rejeitou a emissão. O Thiago já foi notificado e vai verificar o que precisa ser ajustado. Assim que resolver, a NF será emitida! 🔧`;
          } else if (erroStr.includes('timeout') || erroStr.includes('econnrefused') || erroStr.includes('network') || erroStr.includes('socket')) {
            feedbackMsg = `\n\n⚠️ O sistema da prefeitura está instável no momento. Sua NF foi salva e vou tentar emitir novamente em breve! ⏳`;
          } else {
            console.log(`[WhatsApp] ⚠️ Erro genérico na emissão — detalhes completos: fb.numero="${fb.numero}", fb.erro="${fb.erro}", fb.status="${fb.status}"`);
            feedbackMsg = `\n\n⚠️ Tive um probleminha técnico ao emitir a NF. Já notifiquei o Thiago e ele vai resolver o mais rápido possível. A NF ficou salva no sistema! 🔧`;
          }
        }

        if (feedbackMsg) {
          const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
          return { texto: respostaLimpa + feedbackMsg, acoes };
        }
      }

      // Feedback de busca de DANFSe
      const feedbackDanfse = acoes.find(a => a.tipo === 'BUSCAR_DANFSE' && a.feedback);
      if (feedbackDanfse?.feedback) {
        const fb = feedbackDanfse.feedback;
        let feedbackMsg = '';
        if (fb.sucesso) {
          feedbackMsg = `\n\n📄 Encontrei a NF ${fb.numero}! Enviando o PDF pra você...`;
        } else {
          feedbackMsg = `\n\n⚠️ ${fb.erro || 'Não encontrei essa NF no sistema.'}`;
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        return { texto: respostaLimpa + feedbackMsg, acoes };
      }

      // Feedback das consultas Integra Contador (modo equipe)
      const acoesIntegra = acoes.filter(a =>
        ['CONSULTAR_PGDASD_ULTIMA', 'CONSULTAR_PROCURACOES', 'CONSULTAR_DCTFWEB', 'LISTAR_CAIXA_POSTAL'].includes(a.tipo)
        && a.feedback
      );
      if (acoesIntegra.length > 0) {
        let blocos = '';
        for (const a of acoesIntegra) {
          blocos += '\n\n' + this._formatarFeedbackIntegraContador(a.feedback);
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        return { texto: respostaLimpa + blocos, acoes };
      }
    }

    return { texto: resposta, acoes: acoes || [] };
  }

  /**
   * Formata retorno do Integra Contador em mensagem legível pra WhatsApp
   */
  _formatarFeedbackIntegraContador(fb) {
    if (!fb.sucesso) {
      return `⚠️ *${fb.rotulo || 'Consulta SERPRO'}:* ${fb.erro || 'falhou'}`;
    }
    const r = fb.resultado || {};
    const status = r.status;
    const mensagens = Array.isArray(r.mensagens) ? r.mensagens : [];
    let msg = `🔎 *${fb.rotulo}* — CNPJ ${fb.cnpj}\n`;

    if (status && status !== 200) {
      msg += `_Status SERPRO: ${status}_\n`;
    }
    if (mensagens.length > 0) {
      const textos = mensagens.map(m => m.texto || m.codigo).filter(Boolean).join(' | ');
      if (textos) msg += `_${textos}_\n`;
    }

    // Tenta parsear o campo 'dados' (vem como string JSON)
    if (r.dados) {
      let dados = r.dados;
      if (typeof dados === 'string') {
        try { dados = JSON.parse(dados); } catch (e) { /* mantém string */ }
      }
      if (typeof dados === 'object' && dados !== null) {
        const resumo = JSON.stringify(dados, null, 2);
        // Trunca pra WhatsApp (limite de 4096 chars na mensagem)
        msg += '```\n' + (resumo.length > 2500 ? resumo.substring(0, 2500) + '\n[...truncado...]' : resumo) + '\n```';
      } else if (typeof dados === 'string' && dados.length > 0) {
        msg += dados.length > 2500 ? dados.substring(0, 2500) + '...' : dados;
      } else {
        msg += '_Sem dados retornados._';
      }
    } else {
      msg += '_Sem dados retornados._';
    }
    return msg;
  }

  /**
   * Busca dados relevantes do cliente no banco
   */
  buscarDadosCliente(clienteId) {
    const db = getDb();

    const cliente = db.prepare(`
      SELECT id, razao_social, nome_fantasia, cnpj, email, telefone, municipio, uf,
             codigo_servico, aliquota_iss, modo_emissao
      FROM clientes WHERE id = ?
    `).get(clienteId);

    const nfsRecentes = db.prepare(`
      SELECT nf.id, nf.numero_dps, nf.status, nf.valor_servico, nf.descricao_servico,
             nf.data_competencia, nf.data_emissao, t.razao_social as tomador
      FROM notas_fiscais nf
      LEFT JOIN tomadores t ON nf.tomador_id = t.id
      WHERE nf.cliente_id = ?
      ORDER BY nf.created_at DESC
      LIMIT 10
    `).all(clienteId);

    const tomadores = db.prepare(`
      SELECT id, razao_social, documento, email, telefone
      FROM tomadores
      WHERE cliente_id = ? AND ativo = 1
      ORDER BY favorito DESC, razao_social
      LIMIT 20
    `).all(clienteId);

    const resumo = db.prepare(`
      SELECT
        COUNT(*) as total_nfs,
        SUM(CASE WHEN status = 'emitida' THEN 1 ELSE 0 END) as emitidas,
        SUM(CASE WHEN status = 'pendente_aprovacao' THEN 1 ELSE 0 END) as pendentes,
        SUM(CASE WHEN status = 'rascunho' THEN 1 ELSE 0 END) as rascunhos,
        SUM(CASE WHEN status = 'emitida' THEN valor_servico ELSE 0 END) as valor_total_emitidas
      FROM notas_fiscais
      WHERE cliente_id = ?
    `).get(clienteId);

    return { cliente, nfsRecentes, tomadores, resumo };
  }

  /**
   * Monta o prompt do sistema para o agente
   */
  /**
   * Detecta se a mensagem veio de um operador da equipe Marçal
   * (Messenger do Domínio adiciona prefixo "Nome:" automaticamente)
   * @returns {{ ehEquipe: boolean, operador: string|null, mensagemSemPrefixo: string }}
   */
  detectarModoEquipe(mensagem) {
    if (!mensagem || typeof mensagem !== 'string') {
      return { ehEquipe: false, operador: null, mensagemSemPrefixo: mensagem };
    }
    const match = mensagem.match(OPERADOR_DOMINIO_REGEX);
    if (!match) {
      return { ehEquipe: false, operador: null, mensagemSemPrefixo: mensagem };
    }
    // Heurística simples: nomes próprios começam com maiúscula e têm 2-4 palavras
    const possivelNome = match[1].trim();
    const palavras = possivelNome.split(/\s+/);
    const pareceNome = palavras.length >= 1 && palavras.length <= 4 &&
                       palavras.every(p => /^[A-ZÀ-Ÿ]/.test(p));
    if (!pareceNome) {
      return { ehEquipe: false, operador: null, mensagemSemPrefixo: mensagem };
    }
    return {
      ehEquipe: true,
      operador: possivelNome,
      mensagemSemPrefixo: match[2].trim(),
    };
  }

  montarSystemPrompt(contato, dadosCliente, modoEquipe = { ehEquipe: false }) {
    let prompt = `QUEM VOCÊ É:
Você é a Ana. Trabalha na Marçal Contabilidade, escritório do Thiago Borges em Curitiba/PR. Você faz parte da equipe — não é uma assistente virtual, não é um robô, não é uma IA. Você é a Ana do escritório contábil, e ponto.

PERFIL DA ANA:
- Trabalha na Marçal há alguns anos, conhece os clientes pelo nome
- É organizada, prestativa e tem um jeito simpático de conversar
- Tom descontraído mas profissional — sabe a hora de ser leve e a hora de ser séria
- Fala como gente: "pode deixar", "tá certinho", "deixa comigo"
- Tem paciência, não se irrita, mas é objetiva — não enrola
- Quando não sabe algo, ela TRANSFERE na hora em vez de prometer voltar: "essa eu não sei te responder agora — já tô chamando o Thiago pra te atender aqui mesmo" (+ ACAO:TRANSFERIR_HUMANO)
- Usa emoji com moderação (um 😊 ou ✅ aqui e ali, sem transformar a conversa em carnaval)

COMO A ANA CONVERSA:
- Mensagens curtas e naturais, como qualquer pessoa no WhatsApp do trabalho
- Nunca lista opções tipo menu ("Escolha: 1, 2 ou 3") — isso mata a naturalidade
- Nunca começa com "Como posso te ajudar?" ou "Estou aqui para ajudá-lo" — isso é coisa de chatbot
- Se o cliente mandar só "oi" ou "bom dia", responde de volta e espera: "Oi! Tudo bem? 😊"
- Varia as respostas — não repete sempre a mesma frase de abertura
- Usa formatação do WhatsApp quando faz sentido: *negrito* pra destacar, _itálico_ pra ênfase
- NUNCA usa # ou ## ou --- ou listas com - (isso é markdown, não WhatsApp)
- Quando precisa listar algo (ex: dados de uma NF), faz de forma conversacional ou usa quebras de linha simples

EXEMPLOS DE COMO A ANA FALA:
- "Oi! Tudo bem? 😊" (não "Olá! Como posso ajudá-lo hoje?")
- "Pode deixar, vou emitir aqui!" + [ACAO:EMITIR_NF:...] (não "Entendido. Processarei sua solicitação.")
- "Me passa o valor e pra quem é que eu já faço" (não "Para prosseguir, necessito das seguintes informações:")
- "Pronto, NF emitida! ✅" (não "Sua nota fiscal foi processada com sucesso.")
- "Essa eu não sei te responder de cabeça — já tô chamando o Thiago aqui mesmo" + [ACAO:TRANSFERIR_HUMANO] (não "Vou verificar e te retorno")

CONTEXTO DE GRUPO:
Você está num grupo de WhatsApp do cliente com várias pessoas. Quando a mensagem vem de um grupo, o sistema prefixa quem enviou assim: "[Nome da Pessoa] texto da mensagem". Use o nome pra personalizar a resposta ("Pode deixar, João!").

Regras de ouro pra grupo (MUITO IMPORTANTE — seja CONSERVADORA):
- Se a mensagem for claramente sobre NF, contabilidade, impostos, ou mencionarem "@Ana", "Ana", "Marçal", "escritório", "nota", "fiscal" — é pra você, responda
- Se é conversa entre a equipe do cliente (ex: "João, manda aquele relatório pro fornecedor", "bom dia pessoal", "alguém viu a chave do cofre?") — FICA EM SILÊNCIO e inclua [ACAO:IGNORAR]
- Saudações genéricas pro grupo inteiro ("bom dia", "tudo bem?") — NÃO responda, [ACAO:IGNORAR]
- Piadas, conversas pessoais, comentários sobre time, política, clima — [ACAO:IGNORAR]
- Áudios/imagens/figurinhas sem contexto claro sobre NF — [ACAO:IGNORAR]
- Se a mensagem começar com "@Ana" ou mencionar seu nome diretamente — responde sempre
- **NA DÚVIDA, FICA QUIETA.** É 10x melhor não responder do que se intrometer numa conversa interna. Você é uma colega educada, não uma intrusa.
- Você não precisa responder a tudo. Ninguém espera isso de você.

Quando responder em grupo, é mais profissional e mais curta do que em privado — outras pessoas vão ler.

O QUE A ANA FAZ:

1. *Emissão de Nota Fiscal* (o principal)
   Quando pedem pra emitir NF, você precisa de:
   - *Valor* do serviço (obrigatório)
   - *CNPJ ou CPF do tomador* (obrigatório — é pra quem vai a NF)
   - *Descrição do serviço* (se não disser, pergunta de forma natural)

   IMPORTANTE: Você PRECISA do CNPJ ou CPF do tomador. Sem isso, não dá pra emitir.
   Se o cliente mandou só o nome da empresa, pede o CNPJ de forma natural:
   "Me passa o CNPJ deles que eu já emito!" ou "Qual o CNPJ da empresa?"

   Se o tomador já está na lista de TOMADORES CADASTRADOS abaixo, você pode usar o CNPJ/CPF de lá e não precisa pedir de novo.

   SOBRE A RAZÃO SOCIAL: Se o cliente informar um CNPJ, nosso sistema consulta automaticamente na Receita Federal e puxa a razão social e endereço completo. Então você NÃO precisa pedir o nome da empresa — só o CNPJ basta! Se for CPF, aí sim precisa do nome da pessoa.

   EMISSÃO DIRETA (SEM CONFIRMAÇÃO): Quando o cliente passar todos os dados necessários (valor + CNPJ/CPF + descrição), emita IMEDIATAMENTE sem pedir confirmação. NÃO pergunte "Tá certinho?", "Confirmado?", "Posso emitir?". Apenas diga algo como "Emitindo pra você!" e inclua a ação.

   Se faltar informação, puxa de forma natural, uma coisa de cada vez:
   "Beleza! Pra quem é essa NF?" → "Qual o CNPJ deles?" → "E o valor?"
   NÃO pergunte tudo de uma vez — vai conversando.

   Quando tiver os dados, inclua direto: [ACAO:EMITIR_NF:valor|cnpj_cpf|razao_social_se_souber|descricao]
   Exemplo CNPJ: [ACAO:EMITIR_NF:3000.00|12345678000190||Consultoria empresarial]
   Exemplo CPF: [ACAO:EMITIR_NF:1500.00|12345678901|João da Silva|Serviços prestados]
   Nota: a razão social pode ficar vazia pra CNPJ — o sistema preenche automaticamente pela Receita Federal.
   Nota: NÃO inclua competência — o sistema define automaticamente como o mês atual.

2. *Consultas sobre NFs*
   Status, valores, quais NFs foram emitidas — responde direto com os dados que tem.
   "Sua última NF foi emitida dia 15/03, no valor de *R$ 5.000,00* pra Empresa ABC ✅"

3. *Dúvidas sobre impostos e DAS*
   Pra questões gerais de prazo/regras (ex: "DAS vence dia 20") — responde direto com o que sabe, sem prometer verificação.
   Pra valor específico de um mês, situação do cliente ou cálculo → TRANSFERE na hora com [ACAO:TRANSFERIR_HUMANO]. Não diga "quer que eu confirme o valor" — se precisar confirmar, você NÃO TEM essa função, transfira direto.

4. *Status de documentos e certidões*
   Essa você NÃO tem função pra consultar. Sempre transfere:
   "Deixa eu já chamar o Thiago pra ver o status com você aqui mesmo, tá? 👍" + [ACAO:TRANSFERIR_HUMANO]
   NUNCA diga "vou verificar e te retorno" — você não tem mecanismo pra voltar.

5. *Obrigações e prazos genéricos*
   Lembra de datas públicas (ex: prazo do Simples dia 20). "Só lembrando que o prazo pra declaração é até dia 30 desse mês, tá? 📅"
   Pra obrigação ESPECÍFICA do cliente (um valor, um status) → transfere. Não promete.

6. *2ª via de boletos e guias*
   Você NÃO tem função automática pra puxar guia ainda. Em vez de dizer "deixa eu puxar", transfira explicitamente:
   "Vou chamar o Thiago pra te mandar a 2ª via aqui mesmo, tá? Ele já localiza pra você." + [ACAO:ENVIAR_GUIA:tipo|referencia]
   A action ENVIAR_GUIA aciona a equipe — é pra eles agirem, não espera você "voltar depois".

⚠️ REGRA DE OURO — NUNCA DEIXAR NA MÃO:
Você SÓ PODE prometer coisas que você consegue entregar NA MESMA MENSAGEM, através de uma [ACAO:...].
- NUNCA diga "vou verificar", "vou confirmar", "vou olhar e te retorno", "vou dar uma olhada e te falo", "deixa eu ver", "já te retorno" — você NÃO TEM mecanismo pra voltar depois.
- Se não pode resolver agora, TRANSFIRA NA HORA com [ACAO:TRANSFERIR_HUMANO]. Frase correta: "Essa eu passo pro Thiago já já, ele te responde aqui mesmo" + a tag.
- Toda promessa sua precisa vir acompanhada de uma tag [ACAO:...] na mesma mensagem. Sem tag = promessa vazia = cliente fica esperando pra sempre.
- Se a action falhar, o sistema vai adicionar a mensagem de erro. Confie no sistema. NÃO tente "voltar depois pra confirmar".

REGRA CRÍTICA — AÇÃO DE EMISSÃO:
⚠️ NUNCA diga "emitindo", "vou emitir", "saindo a NF" ou qualquer frase que sugira emissão SEM incluir a tag [ACAO:EMITIR_NF:...] na mesma mensagem. Se você disser que vai emitir mas não incluir a tag, a NF NÃO será emitida e o cliente vai ficar esperando.

SEMPRE que for emitir, sua resposta DEVE terminar com a tag de ação. Exemplo correto:
"Emitindo pra você! [ACAO:EMITIR_NF:160.00|62680086000106||Assessoria contábil]"

SOBRE EMISSÃO E ERROS:
- A tag [ACAO:EMITIR_NF:...] é o que REALMENTE dispara a emissão — sem ela, nada acontece
- Se der certo, o sistema adiciona a mensagem de sucesso automaticamente
- Se der erro, o sistema adiciona a mensagem de erro automaticamente
- NÃO peça confirmação antes de emitir — se tem os dados (valor + CNPJ/CPF + descrição), emite direto
- NÃO mencione competência/mês — o sistema define automaticamente
- NÃO adicione mensagem de sucesso por conta própria — o sistema cuida disso

O QUE A ANA NUNCA FAZ:
- NUNCA inventa dados — se não tem a informação, TRANSFERE com [ACAO:TRANSFERIR_HUMANO] (não diz "vou verificar")
- NUNCA promete prazos específicos ("fica pronto amanhã", "até sexta tá feito")
- NUNCA promete "voltar depois" ou "te retornar" — se precisa de humano, transfere agora
- NUNCA fala sobre valores de honorários ou preços do escritório — transfere: "sobre valores fala com o Thiago, vou chamar ele aqui" + [ACAO:TRANSFERIR_HUMANO]
- NUNCA dá conselho tributário complexo — transfere na hora
- NUNCA se identifica como IA, robô ou assistente virtual — ela é a Ana, da equipe
- NUNCA responde em formato de chatbot (menus, opções numeradas, "selecione uma opção")
- NUNCA diz "o Thiago vai confirmar a emissão" quando o sistema tem emissão automática — o sistema emite na hora

QUANDO TRANSFERIR PRO THIAGO:
- Assuntos complexos de planejamento tributário
- Negociação de honorários/valores do escritório
- Reclamações ou insatisfações
- Tomador não cadastrado que precisa ser registrado
- Qualquer coisa que a Ana não tenha certeza

AÇÕES (inclua no final da resposta — o cliente não vê isso):
- [ACAO:EMITIR_NF:valor|cnpj_cpf|razao_social|descricao] — emitir NF direto, sem pedir confirmação (CNPJ/CPF só números)
- [ACAO:TRANSFERIR_HUMANO] — passar pro Thiago/equipe
- [ACAO:CONSULTAR_NF:numero] — consultar NF específica
- [ACAO:LISTAR_NFS] — listar NFs do cliente
- [ACAO:BUSCAR_DANFSE:numero_nf] — buscar e enviar o PDF da DANFSe de uma NF já emitida (quando o cliente pedir o PDF, nota, documento)
- [ACAO:ENVIAR_GUIA:tipo|referencia] — enviar 2ª via de guia/boleto
- [ACAO:IGNORAR] — mensagem não é pro escritório (grupo)
- [ACAO:VINCULAR_CLIENTE:cnpj] — vincular contato ao cliente pelo CNPJ`;

    // Bloco MODO EQUIPE — só aparece quando a mensagem veio com prefixo "Nome:" do Messenger Domínio
    if (modoEquipe.ehEquipe) {
      prompt += `\n\n=== MODO EQUIPE INTERNA — ${modoEquipe.operador} ===

Essa mensagem veio do Messenger do Domínio (sistema interno do escritório). Quem está falando é a/o ${modoEquipe.operador}, da equipe da Marçal — NÃO é cliente. Trate como colega de trabalho.

Diferenças importantes no MODO EQUIPE:
- Tom mais direto e técnico, sem firulas. ${modoEquipe.operador} sabe contabilidade e tem pressa.
- A equipe pode pedir consultas em nome de QUALQUER cliente da carteira (não só do contato atual)
- Sempre que a equipe mencionar um cliente, peça o CNPJ se ainda não tiver — sem CNPJ não dá pra consultar a Receita
- Você TEM acesso ao Integra Contador (SERPRO/RFB) pra consultas oficiais

AÇÕES EXTRA DISPONÍVEIS NO MODO EQUIPE (use o CNPJ do cliente, só dígitos, 14 chars):

- [ACAO:CONSULTAR_PGDASD_ULTIMA:cnpj] — consulta a última declaração PGDAS-D (Simples Nacional) do cliente
  Use quando: "qual a última PGDAS do cliente X", "ele já transmitiu o Simples desse mês"

- [ACAO:CONSULTAR_PROCURACOES:cnpj] — verifica se a procuração e-CAC do cliente está ativa
  Use quando: "tá com procuração?", "valida a procuração do cliente Y", "perdemos a procuração?"

- [ACAO:CONSULTAR_DCTFWEB:cnpj] — lista declarações DCTFWeb entregues pelo cliente
  Use quando: "quais DCTFWeb tá entregue", "ele tem DCTFWeb pendente?"

- [ACAO:LISTAR_CAIXA_POSTAL:cnpj] — lista mensagens da Caixa Postal e-CAC do cliente
  Use quando: "tem mensagem nova no e-CAC do cliente Z", "olha a caixa postal dele"

REGRAS IMPORTANTES NO MODO EQUIPE:
- Quando executar qualquer ação acima, o sistema vai puxar os dados e devolver pra você na próxima mensagem do histórico — você NÃO precisa inventar a resposta
- Se o operador pedir algo que não tá na sua lista (emitir DAS, transmitir DCTFWeb, etc), responda algo como "ainda tô aprendendo isso, vou pedir pro Thiago liberar essa função pra mim"
- NÃO peça confirmação pra fazer consultas — são read-only, dispare direto
- NÃO use [ACAO:IGNORAR] no modo equipe — toda mensagem da equipe merece resposta`;
    }

    if (contato?.cliente_id && dadosCliente) {
      const { cliente, nfsRecentes, tomadores, resumo } = dadosCliente;
      prompt += `\n\nCLIENTE IDENTIFICADO:
- Razão Social: ${cliente.razao_social}
- Nome Fantasia: ${cliente.nome_fantasia || 'N/A'}
- CNPJ: ${cliente.cnpj}
- Município: ${cliente.municipio || 'N/A'}/${cliente.uf || 'N/A'}
- Modo de Emissão: ${cliente.modo_emissao === 'autonomo' ? 'Autônomo' : 'Precisa aprovação'}

RESUMO DE NFs:
- Total: ${resumo.total_nfs}
- Emitidas: ${resumo.emitidas} (R$ ${(resumo.valor_total_emitidas || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })})
- Pendentes aprovação: ${resumo.pendentes}
- Rascunhos: ${resumo.rascunhos}`;

      if (nfsRecentes.length > 0) {
        prompt += '\n\nÚLTIMAS NOTAS FISCAIS:';
        nfsRecentes.forEach(nf => {
          prompt += `\n- DPS ${nf.numero_dps || 'S/N'} | ${nf.status} | R$ ${nf.valor_servico.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} | ${nf.tomador || 'S/ tomador'} | ${nf.data_competencia}`;
        });
      }

      if (tomadores.length > 0) {
        prompt += '\n\nTOMADORES CADASTRADOS:';
        tomadores.slice(0, 5).forEach(t => {
          prompt += `\n- ${t.razao_social} (${t.documento})`;
        });
        if (tomadores.length > 5) {
          prompt += `\n- ... e mais ${tomadores.length - 5} tomadores`;
        }
      }
    } else {
      prompt += `\n\nCLIENTE NÃO IDENTIFICADO:
Esse contato (${contato?.telefone || 'desconhecido'}) ainda não tá cadastrado no sistema.
Puxa o nome da empresa ou CNPJ de forma natural, como faria qualquer pessoa da equipe:
"Me fala o nome da empresa (ou o CNPJ) que eu localizo aqui rapidinho!"
Se o cliente informar o CNPJ, inclua [ACAO:VINCULAR_CLIENTE:cnpj_do_cliente] na resposta.`;
    }

    return prompt;
  }

  /**
   * Monta array de mensagens para a API
   */
  montarMensagens(historico, mensagemAtual) {
    const messages = [];

    // Adiciona histórico
    for (const msg of historico) {
      if (msg.direcao === 'entrada') {
        messages.push({ role: 'user', content: msg.conteudo });
      } else if (msg.remetente === 'bot') {
        // Remove tags de ação do histórico
        const textoLimpo = msg.conteudo.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        if (textoLimpo) {
          messages.push({ role: 'assistant', content: textoLimpo });
        }
      }
    }

    // Adiciona mensagem atual
    messages.push({ role: 'user', content: mensagemAtual });

    return messages;
  }

  /**
   * Chama a API da Anthropic (Claude)
   */
  async chamarClaude(systemPrompt, messages) {
    if (!this.isConfigured()) {
      return 'Olá! No momento estou em manutenção. Por favor, entre em contato diretamente com o escritório pelo telefone. 📞';
    }

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: this.modelo,
        max_tokens: 800,
        system: systemPrompt,
        messages: messages
      });

      const url = new URL(ANTHROPIC_API_URL);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const texto = parsed.content?.[0]?.text || 'Desculpe, não consegui processar sua mensagem.';
              resolve(texto);
            } else {
              console.error('Claude API erro:', parsed);
              resolve('Desculpe, estou com dificuldades técnicas no momento. O escritório será notificado. 🙏');
            }
          } catch (e) {
            console.error('Erro ao parsear resposta Claude:', e);
            resolve('Desculpe, ocorreu um erro. Tente novamente em alguns instantes.');
          }
        });
      });

      req.on('error', (err) => {
        console.error('Erro na requisição Claude:', err);
        resolve('Estou temporariamente indisponível. Por favor, tente novamente.');
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Extrai ações especiais da resposta do agente
   */
  extrairAcoes(resposta) {
    const acoes = [];
    const regex = /\[ACAO:([^\]]+)\]/g;
    let match;
    while ((match = regex.exec(resposta)) !== null) {
      const partes = match[1].split(':');
      acoes.push({
        tipo: partes[0],
        parametro: partes[1] || null
      });
    }
    return acoes;
  }

  /**
   * Executa ações especiais identificadas na resposta
   */
  async executarAcoes(acoes, contato, conversaId) {
    const db = getDb();

    for (const acao of acoes) {
      switch (acao.tipo) {
        case 'TRANSFERIR_HUMANO':
          db.prepare('UPDATE whatsapp_conversas SET status = ? WHERE id = ?')
            .run('aguardando_humano', conversaId);
          console.log(`[WhatsApp] Conversa ${conversaId} transferida para atendimento humano`);
          break;

        case 'VINCULAR_CLIENTE':
          if (acao.parametro) {
            const cnpjLimpo = acao.parametro.replace(/\D/g, '');
            const cliente = db.prepare('SELECT id FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj, ".", ""), "/", ""), "-", "") = ?').get(cnpjLimpo);
            if (cliente && contato) {
              db.prepare('UPDATE whatsapp_contatos SET cliente_id = ?, tipo = ? WHERE id = ?')
                .run(cliente.id, 'cliente', contato.id);
              console.log(`[WhatsApp] Contato ${contato.telefone} vinculado ao cliente ${cliente.id}`);
            }
          }
          break;

        case 'EMITIR_NF':
          // Garante que o contato está vinculado a um cliente com certificado A1
          if (acao.parametro) {
            const clienteComCert = db.prepare(
              `SELECT id, razao_social FROM clientes
               WHERE certificado_a1_path IS NOT NULL AND certificado_a1_senha_encrypted IS NOT NULL
               ORDER BY id LIMIT 1`
            ).get();

            if (!contato?.cliente_id) {
              console.log(`[WhatsApp] ⚠️ EMITIR_NF: contato ${contato?.telefone || 'desconhecido'} não tem cliente_id vinculado. Tentando vincular automaticamente...`);
              const clienteAlvo = clienteComCert || db.prepare('SELECT id, razao_social FROM clientes LIMIT 1').get();
              if (clienteAlvo && contato) {
                db.prepare('UPDATE whatsapp_contatos SET cliente_id = ?, tipo = ? WHERE id = ?')
                  .run(clienteAlvo.id, 'cliente', contato.id);
                contato.cliente_id = clienteAlvo.id;
                console.log(`[WhatsApp] ✅ Contato vinculado automaticamente ao cliente ${clienteAlvo.razao_social} (ID ${clienteAlvo.id})`);
              } else {
                console.log(`[WhatsApp] ❌ Nenhum cliente cadastrado no sistema. NF não pode ser emitida.`);
                acao.feedback = { sucesso: false, erro: 'Nenhum cliente cadastrado no sistema' };
              }
            } else if (clienteComCert && contato.cliente_id !== clienteComCert.id) {
              // Contato vinculado a cliente SEM certificado — re-vincular ao que tem
              const clienteAtual = db.prepare('SELECT id, razao_social, certificado_a1_path FROM clientes WHERE id = ?').get(contato.cliente_id);
              if (!clienteAtual?.certificado_a1_path) {
                console.log(`[WhatsApp] ⚠️ Cliente atual (ID ${contato.cliente_id}) não tem certificado. Re-vinculando ao cliente ${clienteComCert.razao_social} (ID ${clienteComCert.id})`);
                db.prepare('UPDATE whatsapp_contatos SET cliente_id = ? WHERE id = ?')
                  .run(clienteComCert.id, contato.id);
                contato.cliente_id = clienteComCert.id;
              }
            }
          }
          if (acao.parametro && contato?.cliente_id) {
            try {
              // Formato: valor|cnpj_cpf|razao_social|descricao (competencia é opcional, default = mês atual)
              const partes = acao.parametro.split('|');
              const valor = parseFloat(partes[0]?.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
              const documentoTomador = (partes[1]?.trim() || '').replace(/\D/g, ''); // só números
              const razaoSocialTomador = partes[2]?.trim() || '';
              const descricao = partes[3]?.trim() || 'Serviços prestados';
              const competencia = partes[4]?.trim() || new Date().toISOString().slice(0, 7);

              if (!documentoTomador || valor <= 0) {
                console.log(`[WhatsApp] NF não criada: CNPJ/CPF ausente (${documentoTomador}) ou valor inválido (${valor})`);
                // Armazena feedback para a resposta
                acao.feedback = { sucesso: false, erro: !documentoTomador ? 'CNPJ/CPF do tomador não informado' : 'Valor inválido' };
                break;
              }

              // Determina tipo de documento
              const tipoDocumento = documentoTomador.length <= 11 ? 'CPF' : 'CNPJ';

              // Busca tomador pelo CNPJ/CPF
              let tomador = db.prepare(`
                SELECT id, razao_social, documento FROM tomadores
                WHERE cliente_id = ? AND ativo = 1
                AND REPLACE(REPLACE(REPLACE(documento, '.', ''), '/', ''), '-', '') = ?
                LIMIT 1
              `).get(contato.cliente_id, documentoTomador);

              // Se não encontrou, consulta CNPJ na Receita e cadastra automaticamente
              if (!tomador) {
                let razaoFinal = razaoSocialTomador;
                let dadosReceita = null;

                // Se for CNPJ, consulta BrasilAPI pra pegar dados completos
                if (tipoDocumento === 'CNPJ') {
                  try {
                    dadosReceita = await cnpjService.consultarCNPJ(documentoTomador);
                    if (dadosReceita) {
                      razaoFinal = dadosReceita.razaoSocial || razaoSocialTomador;
                      console.log(`[WhatsApp] CNPJ consultado na Receita: ${razaoFinal} (${dadosReceita.situacaoCadastral})`);
                    }
                  } catch (cnpjErr) {
                    console.log(`[WhatsApp] Não conseguiu consultar CNPJ na Receita: ${cnpjErr.message}`);
                  }
                }

                if (!razaoFinal) {
                  console.log(`[WhatsApp] NF não criada: sem razão social pro tomador ${documentoTomador}`);
                  acao.feedback = { sucesso: false, erro: 'Não consegui identificar a razão social do tomador. Me passa o nome da empresa?' };
                  break;
                }

                console.log(`[WhatsApp] Cadastrando tomador: ${razaoFinal} (${documentoTomador})`);
                const insertResult = db.prepare(`
                  INSERT INTO tomadores (
                    cliente_id, razao_social, nome_fantasia, documento, tipo_documento,
                    email, logradouro, numero, complemento, bairro,
                    municipio, uf, cep, codigo_municipio,
                    ativo, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
                `).run(
                  contato.cliente_id,
                  razaoFinal,
                  dadosReceita?.nomeFantasia || '',
                  documentoTomador,
                  tipoDocumento,
                  dadosReceita?.email || '',
                  dadosReceita?.logradouro || '',
                  dadosReceita?.numero || '',
                  dadosReceita?.complemento || '',
                  dadosReceita?.bairro || '',
                  dadosReceita?.municipio || '',
                  dadosReceita?.uf || '',
                  dadosReceita?.cep || '',
                  dadosReceita?.codigoMunicipio || ''
                );

                tomador = {
                  id: insertResult.lastInsertRowid,
                  razao_social: razaoFinal,
                  documento: documentoTomador
                };
                console.log(`[WhatsApp] Tomador cadastrado: ID ${tomador.id} ${dadosReceita ? '(com dados da Receita)' : '(dados básicos)'}`);
              }

              if (!tomador) {
                console.log(`[WhatsApp] NF não criada: impossível identificar tomador`);
                acao.feedback = { sucesso: false, erro: 'Não foi possível identificar o tomador' };
                break;
              }

              // Busca dados do cliente para alíquota e código de serviço
              const clienteData = db.prepare('SELECT codigo_servico, aliquota_iss FROM clientes WHERE id = ?').get(contato.cliente_id);

              // Calcula valores fiscais
              const aliquotaIss = clienteData?.aliquota_iss || 0;
              const valorIss = valor * aliquotaIss;
              const baseCalculo = valor;
              const valorLiquido = valor - valorIss;

              // Gera próximo numero_dps para o cliente
              const ultimaDps = db.prepare(`
                SELECT numero_dps FROM notas_fiscais
                WHERE cliente_id = ? AND numero_dps IS NOT NULL
                ORDER BY CAST(numero_dps AS INTEGER) DESC LIMIT 1
              `).get(contato.cliente_id);
              const numeroDps = ultimaDps ? String(parseInt(ultimaDps.numero_dps) + 1) : '1';

              // Cria NF com status pendente_emissao
              const result = db.prepare(`
                INSERT INTO notas_fiscais (
                  cliente_id, tomador_id, valor_servico, descricao_servico,
                  data_competencia, status, codigo_servico, aliquota_iss,
                  valor_iss, base_calculo, valor_liquido, origem,
                  numero_dps, serie_dps,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pendente_emissao', ?, ?, ?, ?, ?, 'whatsapp', ?, '1', datetime('now'), datetime('now'))
              `).run(
                contato.cliente_id,
                tomador.id,
                valor,
                descricao,
                competencia,
                clienteData?.codigo_servico || '',
                aliquotaIss,
                valorIss,
                baseCalculo,
                valorLiquido,
                numeroDps
              );

              const nfId = result.lastInsertRowid;
              console.log(`[WhatsApp] NF criada: ID ${nfId}, R$ ${valor} para ${tomador.razao_social} (${tomador.documento})`);

              // Tenta emitir automaticamente
              let emissaoStatus = 'pendente_emissao';
              let emissaoInfo = '';
              let emissaoChaveAcesso = '';

              try {
                const nfseService = require('./nfseNacionalService');
                const notaCompleta = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(nfId);
                const clienteCompleto = db.prepare('SELECT * FROM clientes WHERE id = ?').get(contato.cliente_id);
                const tomadorCompleto = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomador.id);

                // Pré-validação e enriquecimento automático
                const preValidacaoService = require('./preValidacaoNfseService');
                const validacao = await preValidacaoService.validarEEnriquecer(notaCompleta, clienteCompleto, tomadorCompleto);

                if (!validacao.valido) {
                  const msgErros = validacao.erros.join('; ');
                  db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                    .run('erro_emissao', `Pré-validação: ${msgErros}`, nfId);
                  emissaoStatus = 'erro_emissao';
                  emissaoInfo = `Dados incompletos: ${msgErros}`;
                  console.log(`[WhatsApp] NF ${nfId}: pré-validação falhou - ${msgErros}`);
                } else if (process.env.NFSE_SIMULACAO === 'true') {
                  // Modo simulação
                  const numSim = `SIM-${Date.now()}`;
                  db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, data_emissao = datetime(?) WHERE id = ?')
                    .run('emitida', numSim, new Date().toISOString(), nfId);
                  emissaoStatus = 'emitida';
                  emissaoInfo = numSim;
                  console.log(`[WhatsApp] NF ${nfId} emitida em modo simulação: ${numSim}`);
                } else {
                  // Verifica se o cliente tem certificado digital
                  if (!clienteCompleto.certificado_a1_path) {
                    db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                      .run('erro_emissao', 'Cliente sem certificado digital A1 configurado', nfId);
                    emissaoStatus = 'erro_emissao';
                    emissaoInfo = 'Cliente sem certificado digital A1. A NF foi criada mas precisa do certificado pra emitir.';
                    console.log(`[WhatsApp] NF ${nfId}: cliente sem certificado A1`);
                  } else {
                    // Emissão real via Portal Nacional (dados já validados e enriquecidos)
                    const resultado = await nfseService.emitirNFSe(notaCompleta, clienteCompleto, tomadorCompleto);
                    if (resultado.sucesso) {
                      db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, chave_acesso = ?, data_emissao = datetime(?) WHERE id = ?')
                        .run('emitida', resultado.numeroNfse, resultado.chaveAcesso, new Date().toISOString(), nfId);
                      emissaoStatus = 'emitida';
                      emissaoInfo = resultado.numeroNfse;
                      emissaoChaveAcesso = resultado.chaveAcesso;
                      console.log(`[WhatsApp] NF ${nfId} emitida com sucesso: numero=${resultado.numeroNfse}, chave=${resultado.chaveAcesso}`);
                    } else {
                      db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                        .run('erro_emissao', resultado.erro, nfId);
                      emissaoStatus = 'erro_emissao';
                      emissaoInfo = resultado.erro;
                      console.error(`[WhatsApp] Erro na emissão NF ${nfId}: ${resultado.erro}`);
                    }
                  }
                }
              } catch (emissaoErr) {
                // emissaoErr pode ser um Error nativo OU um objeto custom { statusCode, mensagem, detalhes }
                const errMsg = emissaoErr.mensagem || emissaoErr.message || JSON.stringify(emissaoErr).substring(0, 500);
                const errDetalhes = emissaoErr.detalhes ? JSON.stringify(emissaoErr.detalhes, null, 2).substring(0, 1000) : '';
                console.error(`[WhatsApp] Erro ao tentar emitir NF ${nfId}: ${errMsg}`);
                if (errDetalhes) console.error(`[WhatsApp] Detalhes SEFIN: ${errDetalhes}`);
                db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                  .run('erro_emissao', `${errMsg}${errDetalhes ? ' | ' + errDetalhes : ''}`, nfId);
                emissaoStatus = 'erro_emissao';
                emissaoInfo = errMsg;
              }

              // Armazena feedback para a resposta
              acao.feedback = {
                sucesso: emissaoStatus === 'emitida',
                nfId,
                status: emissaoStatus,
                numero: emissaoInfo,
                chaveAcesso: emissaoChaveAcesso,
                tomador: tomador.razao_social,
                valor
              };

            } catch (err) {
              console.error('[WhatsApp] Erro ao criar NF:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'BUSCAR_DANFSE':
          if (acao.parametro) {
            try {
              // Parametro pode ser número da NF ou ID
              const busca = acao.parametro.trim();
              const nfEncontrada = db.prepare(`
                SELECT id, numero_nfse, numero_dps, chave_acesso, cliente_id, status
                FROM notas_fiscais
                WHERE cliente_id = ? AND status = 'emitida'
                AND (numero_nfse = ? OR CAST(id AS TEXT) = ? OR numero_dps = ?)
                ORDER BY created_at DESC LIMIT 1
              `).get(contato.cliente_id, busca, busca, busca);

              if (nfEncontrada && nfEncontrada.chave_acesso) {
                acao.feedback = {
                  sucesso: true,
                  nfId: nfEncontrada.id,
                  numero: nfEncontrada.numero_nfse || nfEncontrada.numero_dps,
                  chaveAcesso: nfEncontrada.chave_acesso
                };
                console.log(`[WhatsApp] DANFSe encontrado: NF ${nfEncontrada.numero_nfse || nfEncontrada.id}`);
              } else {
                // Tenta pegar a última NF emitida
                const ultimaNf = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso
                  FROM notas_fiscais
                  WHERE cliente_id = ? AND status = 'emitida' AND chave_acesso IS NOT NULL
                  ORDER BY created_at DESC LIMIT 1
                `).get(contato.cliente_id);

                if (ultimaNf) {
                  acao.feedback = {
                    sucesso: true,
                    nfId: ultimaNf.id,
                    numero: ultimaNf.numero_nfse || ultimaNf.numero_dps,
                    chaveAcesso: ultimaNf.chave_acesso
                  };
                  console.log(`[WhatsApp] DANFSe: usando última NF emitida: ${ultimaNf.numero_nfse || ultimaNf.id}`);
                } else {
                  acao.feedback = { sucesso: false, erro: 'Nenhuma NF emitida encontrada' };
                }
              }
            } catch (err) {
              console.error('[WhatsApp] Erro ao buscar DANFSe:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'ENVIAR_GUIA':
          if (acao.parametro) {
            console.log(`[WhatsApp] Solicitação de envio de guia: ${acao.parametro} para conversa ${conversaId}`);
            // TODO: integrar com sistema de guias/DAS quando disponível
            // Por enquanto, transfere para atendimento humano
            db.prepare('UPDATE whatsapp_conversas SET status = ? WHERE id = ?')
              .run('aguardando_humano', conversaId);
          }
          break;

        case 'IGNORAR':
          console.log(`[WhatsApp] Mensagem ignorada (não direcionada ao escritório) na conversa ${conversaId}`);
          break;

        case 'CONSULTAR_PGDASD_ULTIMA':
          await this._executarConsultaIntegraContador(acao, 'consultarUltimaDeclaracaoPGDASD', 'Última PGDAS-D');
          break;

        case 'CONSULTAR_PROCURACOES':
          await this._executarConsultaIntegraContador(acao, 'consultarProcuracoes', 'Procurações e-CAC');
          break;

        case 'CONSULTAR_DCTFWEB':
          await this._executarConsultaIntegraContador(acao, 'consultarRelacaoDCTFWeb', 'Relação DCTFWeb');
          break;

        case 'LISTAR_CAIXA_POSTAL':
          await this._executarConsultaIntegraContador(acao, 'listarMensagensCaixaPostal', 'Caixa Postal e-CAC');
          break;

        default:
          console.log(`[WhatsApp] Ação não implementada: ${acao.tipo}`);
      }
    }
  }

  /**
   * Helper: executa uma consulta read-only ao Integra Contador
   * Armazena o resultado em acao.feedback pra ser anexado à resposta
   */
  async _executarConsultaIntegraContador(acao, metodo, rotuloHumano) {
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'CNPJ não informado na ação' };
      return;
    }
    const cnpj = String(acao.parametro).replace(/\D/g, '');
    if (cnpj.length !== 14) {
      acao.feedback = { sucesso: false, erro: `CNPJ inválido: ${acao.parametro}` };
      return;
    }
    try {
      console.log(`[AgenteIA] ${rotuloHumano}: chamando Integra Contador pra ${cnpj}`);
      const resultado = await integraContadorService[metodo](cnpj);
      acao.feedback = { sucesso: true, rotulo: rotuloHumano, cnpj, resultado };
    } catch (err) {
      console.error(`[AgenteIA] Falha ${rotuloHumano} (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo: rotuloHumano };
    }
  }

  /**
   * Remove tags de ação da resposta antes de enviar ao cliente
   */
  limparResposta(resposta) {
    return resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
  }
}

module.exports = new AgenteIAService();
