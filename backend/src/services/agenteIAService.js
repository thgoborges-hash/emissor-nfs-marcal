/**
 * Agente Inteligente - Atendimento via WhatsApp
 * Usa Claude API (Anthropic) para processar mensagens e responder clientes
 */

const https = require('https');
const { getDb } = require('../database/init');
const anexoCacheService = require('./anexoCacheService');
const certificadoService = require('./certificadoService');
const cnpjService = require('./cnpjService');
const integraContadorService = require('./integraContadorService');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Regex pra detectar prefixo de operador vindo do Messenger do Domínio.
// Aceita:
//   (a) Mensagem crua: "Janaina Alves: Segue a declaração..."
//   (b) Mensagem de grupo prefixada pelo whatsapp.js: "[Marçal Contabilidade] Janaina Alves: ..."
//   (c) Formatação de negrito do WhatsApp: "*Janaina Alves:*" com asteriscos.
// Grupo `[...]` inicial opcional; asteriscos opcionais antes do nome e depois dos ":".
const OPERADOR_DOMINIO_REGEX = /^(?:\[[^\]]+\]\s*)?\*?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,40}):\*?\s*(.*)/s;

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
    let modoEquipe = this.detectarModoEquipe(mensagem);
    if (modoEquipe.ehEquipe) {
      console.log(`[AgenteIA] Modo EQUIPE detectado via prefixo — operador: ${modoEquipe.operador}`);
    }

    // 3.5.1. Se a conversa é um grupo interno do escritório (ANA_STAFF_GROUP_IDS),
    // SEMPRE tratar como modo equipe — só equipe tem acesso ao grupo.
    // Cobre o caso do Thiago (ou qualquer staff) mandando NF no grupo Staff sem
    // prefixar 'Nome:' — o whatsapp.js já prefixa '[PushName] texto' que não casa
    // com o regex do Messenger Domínio.
    if (!modoEquipe.ehEquipe) {
      const staffGroups = (process.env.ANA_STAFF_GROUP_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const tel = String(telefone || '');
      // Z-API entrega grupos como "<id>-group@g.us"; na env.var normalmente o user
      // salva "<id>@g.us" (sem -group). Comparar só o prefixo numérico cobre ambos.
      const extrairIdNum = (str) => (String(str).match(/^(\d+)/) || [])[1] || '';
      const telId = extrairIdNum(tel);
      const ehGrupoStaff = !!telId && staffGroups.some(id => extrairIdNum(id) === telId);
      console.log(`[AgenteIA] staff-check: tel="${tel}" telId="${telId}" groups=${JSON.stringify(staffGroups)} match=${ehGrupoStaff}`);
      if (ehGrupoStaff) {
        const pushMatch = mensagem.match(/^\[([^\]]+)\]\s*([\s\S]*)/);
        modoEquipe = {
          ehEquipe: true,
          operador: pushMatch ? pushMatch[1].trim() : 'Equipe',
          mensagemSemPrefixo: pushMatch ? pushMatch[2].trim() : mensagem,
        };
        console.log(`[AgenteIA] Modo EQUIPE ativado por grupo staff — operador: ${modoEquipe.operador} (groupId=${tel})`);
      }
    }

    // 3.6. Detecta se o contato é o admin (pra destravar modo equipe em conversa privada)
    const ehAdmin = this._ehAdmin(contato);
    if (ehAdmin && !modoEquipe.ehEquipe) {
      console.log(`[AgenteIA] Contato admin detectado — tratando como modo equipe`);
    }

    // 4. Monta o prompt do sistema
    const systemPrompt = this.montarSystemPrompt(contato, dadosCliente, modoEquipe, { ehAdmin });

    // 5. Monta mensagens para a API
    const messages = this.montarMensagens(historico, mensagem);

    // 6. Chama a Claude API
    let resposta = await this.chamarClaude(systemPrompt, messages);

    // DEBUG: loga resposta bruta do Claude pra diagnosticar ações
    console.log(`[AgenteIA] Resposta bruta (${resposta.length} chars): ${resposta.substring(0, 300)}`);

    // 6.5. AUTO-VALIDAÇÃO — detecta promessas vazias (só modo cliente, skip modo equipe)
    if (!modoEquipe.ehEquipe) {
      const validacao = await this._validarResposta(mensagem, resposta);
      if (!validacao.ok) {
        console.warn(`[AgenteIA] ⚠ Auto-validação rejeitou resposta: ${validacao.motivo}`);
        console.log(`[AgenteIA] Resposta rejeitada: ${resposta.substring(0, 200)}`);
        resposta = `Essa eu prefiro deixar o Thiago te responder com calma — já tô chamando ele aqui mesmo pra dar atenção, tá? 👍 [ACAO:TRANSFERIR_HUMANO]`;
      }
    }

    // 7. Verifica se precisa executar ações
    const acoes = this.extrairAcoes(resposta);
    console.log(`[AgenteIA] Ações extraídas: ${acoes.length > 0 ? acoes.map(a => `${a.tipo}(${(a.parametro||'').substring(0,50)})`).join(', ') : 'nenhuma'}`);

    if (acoes.length > 0) {
      // Passa a mensagem original e modoEquipe via contato pra que
      // ações como BUSCAR_DANFSE possam extrair CNPJ mencionado / detectar admin.
      // Cria nova referência — `contato` original é parâmetro const, não dá pra reatribuir.
      const contatoExpandido = { ...contato, mensagemOriginal: mensagem, modoEquipe, ehAdmin };
      await this.executarAcoes(acoes, contatoExpandido, conversaId);

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

      // Feedback das acoes SERPRO que geram PDF (ANA avisa sucesso/erro, envio do documento
      // acontece em routes/whatsapp.js via acao.feedback.pdfEnvio)
      const acoesPdfSerpro = acoes.filter(a =>
        ['GERAR_DAS_SIMPLES', 'GERAR_DAS_SIMPLES_AVULSO', 'GERAR_DAS_MEI', 'SOLICITAR_SITFIS', 'EMITIR_CCMEI', 'EMITIR_DARF'].includes(a.tipo)
        && a.feedback
      );
      if (acoesPdfSerpro.length > 0) {
        let blocos = '';
        for (const a of acoesPdfSerpro) {
          const fb = a.feedback;
          if (fb.sucesso) {
            blocos += `\n\n\u2705 ${fb.rotulo} gerado${fb.cnpj ? ` (CNPJ ${fb.cnpj})` : ''}. Mandando o PDF aqui...`;
          } else {
            blocos += `\n\n\u26a0\ufe0f Nao consegui gerar ${fb.rotulo || 'o documento'}: ${fb.erro}`;
          }
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        // Nao retornamos ainda — deixamos cair no proximo bloco (integra contador read-only) tambem
        // mas armazenamos a mensagem ja pronta em acoes pra o caller usar. Na pratica so uma
        // dessas vai ter feedback por vez, entao retornamos direto:
        return { texto: respostaLimpa + blocos, acoes };
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

  /**
   * Detecta se o contato é o admin (Thiago) — matching tolerante de telefone.
   * Compartilhado entre montarSystemPrompt (pra destravar modo equipe)
   * e ações individuais (BUSCAR_DANFSE, etc).
   */
  _ehAdmin(contato) {
    const adminPhoneRaw = (process.env.ANA_ADMIN_WHATSAPP || '').replace(/\D/g, '');
    const telefoneContatoRaw = (contato?.telefone || '').replace(/\D/g, '');
    if (!adminPhoneRaw || !telefoneContatoRaw) return false;
    const variantes = (num) => {
      const v = new Set([num]);
      if (num.length === 13 && num.startsWith('55') && num[4] === '9') {
        v.add(num.slice(0, 4) + num.slice(5));
      } else if (num.length === 12 && num.startsWith('55')) {
        v.add(num.slice(0, 4) + '9' + num.slice(4));
      }
      return v;
    };
    const va = variantes(adminPhoneRaw);
    const vb = variantes(telefoneContatoRaw);
    for (const x of va) for (const y of vb) {
      if (x === y) return true;
      const menor = x.length < y.length ? x : y;
      const maior = x.length < y.length ? y : x;
      if (menor.length >= 10 && maior.startsWith(menor)) return true;
    }
    return false;
  }

  montarSystemPrompt(contato, dadosCliente, modoEquipe = { ehEquipe: false }, opcoes = {}) {
    const ehAdmin = !!opcoes.ehAdmin;
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

   🔎 Se você não tem certeza do prazo, houve prorrogação recente, ou a pergunta envolve Reforma Tributária, IN da RFB, lei nova, portaria, alíquota atualizada, LC 214/25, CBS/IBS, split payment, ou qualquer novidade fiscal — USE a ferramenta web_search pra consultar a Receita/Planalto antes de responder. Prefira sempre citar a fonte ("segundo a IN RFB XXXX/YYYY publicada em...") quando a informação vier da busca. Se mesmo com a busca ficar em dúvida pro cliente específico, aí sim transfira.

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
- Qualquer coisa que a Ana não tenha certeza E que web_search não tenha clareado

QUANDO USAR web_search (e quando NÃO usar):
- USE pra: prazos de obrigações (ECD, ECF, DCTF, DEFIS, DIRF, DIMOB, DASN-SIMEI, etc), prorrogações via IN da RFB, novidades da Reforma Tributária (LC 214/25, CBS, IBS, IS, split payment, transição), atos normativos novos (IN, portaria, ato declaratório), alíquotas atualizadas, decisões de tribunais com impacto fiscal.
- NÃO USE pra: saudações, conversa social, dados internos do cliente (banco), emissão de NF, consulta de NF já emitida, status de procuração — isso já tem ferramenta própria.
- Quando usar, seja sucinta na busca e cite a fonte na resposta. Evite mais de 1 busca por mensagem se já tiver achado a resposta.

AÇÕES (inclua no final da resposta — o cliente não vê isso):
- [ACAO:EMITIR_NF:valor|cnpj_cpf|razao_social|descricao] — emitir NF direto, sem pedir confirmação (CNPJ/CPF só números)
- [ACAO:TRANSFERIR_HUMANO] — passar pro Thiago/equipe
- [ACAO:CONSULTAR_NF:numero] — consultar NF específica
- [ACAO:CANCELAR_NF:numero_ou_chave|motivo] — cancela uma NF já emitida (motivo min 15 chars; exige que o emitente tenha A1 válido). Aceita número da NFS-e ou chave de acesso (47 dígitos). Se houver ambiguidade (mesmo número em emitentes diferentes), peça a chave.
- [ACAO:CADASTRAR_A1:cnpj|senha] — cadastra o certificado digital A1 do cliente. Pré-requisito: o arquivo .pfx deve ter sido ENVIADO como documento no WhatsApp momentos antes dessa mensagem (TTL 30min). Se não houver anexo recente, o sistema avisa. Exemplo: "A1 do DDA CNPJ 27.998.575/0001-00, senha: 123456" (após anexar o .pfx) → [ACAO:CADASTRAR_A1:27998575000100|123456]
- [ACAO:ATUALIZAR_CLIENTE:cnpj|campo=valor|campo=valor...] — atualiza cadastro do cliente emitente. Campos aceitos: optante_simples (1/0), aliquota_iss (0.02 = 2%, aceita "2%" ou "2"), codigo_servico (ex: 04.01.01), descricao_servico_padrao, regime_especial, incentivo_fiscal, inscricao_municipal, municipio, codigo_municipio (IBGE), uf, cep, logradouro, numero, bairro.
  Use quando o sistema reclamar de campo faltando no cadastro, ou quando a equipe passar dados pra configurar um cliente novo. Exemplo: "configura o DDA como Simples, ISS 2%" → [ACAO:ATUALIZAR_CLIENTE:27998575000100|optante_simples=1|aliquota_iss=0.02]
- [ACAO:LISTAR_NFS] — listar NFs do cliente
- [ACAO:BUSCAR_DANFSE:numero_nf] — buscar e enviar o PDF da DANFSe de uma NF já emitida (quando o cliente pedir o PDF, nota, documento)
- [ACAO:ENVIAR_GUIA:tipo|referencia] — enviar 2ª via de guia/boleto
- [ACAO:IGNORAR] — mensagem não é pro escritório (grupo)
- [ACAO:VINCULAR_CLIENTE:cnpj] — vincular contato ao cliente pelo CNPJ`;

    // Bloco MODO EQUIPE — aparece quando:
    //   (a) a mensagem veio com prefixo "Nome:" do Messenger Domínio, OU
    //   (b) o contato é o admin (Thiago) — destrava o modo no WhatsApp direto
    if (modoEquipe.ehEquipe || ehAdmin) {
      const operadorNome = modoEquipe.operador || contato?.nome || 'Thiago';
      prompt += `\n\n=== MODO EQUIPE INTERNA — ${operadorNome} ===

Essa mensagem veio de alguém da equipe Marçal (Messenger do Domínio ou admin no WhatsApp). Quem está falando é a/o ${operadorNome}, da equipe da Marçal — NÃO é cliente. Trate como colega de trabalho.

Diferenças importantes no MODO EQUIPE:
- Tom mais direto e técnico, sem firulas. ${operadorNome} sabe contabilidade e tem pressa.
- A equipe pode pedir consultas e emissões em nome de QUALQUER cliente da carteira (não só do contato atual)
- Sempre que a equipe mencionar um cliente, peça o CNPJ se ainda não tiver — sem CNPJ não dá pra consultar/emitir
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

- [ACAO:GERAR_DAS_SIMPLES:cnpj|periodoApuracao] — gera DAS do Simples Nacional pra um periodo ja declarado (formato YYYYMM)
  Use quando: "gera o DAS da Empresa X de abril/2026", "emite DAS do Simples"

- [ACAO:GERAR_DAS_SIMPLES_AVULSO:cnpj|periodoApuracao] — gera DAS Simples em modalidade AVULSA (reemissao, periodo sem declaracao)
  Use quando: "reemite o DAS Simples", "gera a 2a via do DAS abril"

- [ACAO:GERAR_DAS_MEI:cnpj|periodoApuracao] — gera DAS do MEI em PDF (formato YYYY, ano)
  Use quando: "gera DAS do MEI Fulano", "emite DAS MEI de 2026"

- [ACAO:SOLICITAR_SITFIS:cnpj] — gera o Relatorio de Situacao Fiscal (substituto oficial da Certidao Negativa de Debitos)
  Use quando: "tira a certidao negativa do cliente X", "precisa da CND", "situacao fiscal", "relatorio de pendencias"

- [ACAO:EMITIR_CCMEI:cnpj] — emite o Certificado de Condicao de MEI em PDF
  Use quando: "gera o CCMEI", "certificado de MEI", "comprovante de MEI"

- [ACAO:EMITIR_DARF:cnpj|codigoReceita|periodoApuracao|dataVencimento|valorPrincipal] — gera DARF via Sicalc
  Use quando: "gera DARF pra Empresa X", "emite guia DARF". Formatos: periodoApuracao=YYYYMM, dataVencimento=DDMMYYYY, valorPrincipal=decimal

⚠️⚠️⚠️ EMISSÃO DE NF EM MODO EQUIPE — REGRA INVIOLÁVEL ⚠️⚠️⚠️

NO MODO EQUIPE, A TAG [ACAO:EMITIR_NF:...] DEVE TER **EXATAMENTE 5 CAMPOS**, NUNCA 4:

  FORMATO CORRETO:   [ACAO:EMITIR_NF:cnpj_EMITENTE|valor|cnpj_TOMADOR|razao_tomador|descricao]
  FORMATO PROIBIDO:  [ACAO:EMITIR_NF:valor|cnpj_tomador|razao|descricao]   ← NUNCA USAR

POR QUÊ? O formato de 4 campos emite pela Marçal por default. Em modo equipe, as NFs SEMPRE saem em nome de UM CLIENTE DA CARTEIRA (Marçal é contadora, não emite NF pra clientes dos seus clientes). Se você usar 4 campos, o sistema vai BLOQUEAR a emissão e devolver erro.

COMO IDENTIFICAR O EMITENTE NA MENSAGEM DA EQUIPE:

O emitente MUDA A CADA NF. Nunca, jamais, assuma padrão. Nunca assuma "Marçal". Você TEM que extrair da mensagem — ou perguntar.

Padrões comuns da equipe ao passar o emitente (todos válidos — aceite qualquer um):
- "emite NF do DDA Clinica Medica (CNPJ 27.998.575/0001-00) pra Maysa..."
- "Emitente: DDA CLINICA MEDICA LTDA - CNPJ: 27.998.575/0001-00\nTomador: Maysa..."
- "NF do CNPJ 27998575000100 (DDA) pra Maysa..."
- "Do Estudio Soma (12.345.678/0001-90), emite NF pra ..."

Em TODOS esses, o CNPJ do emitente está explícito. Extraia como dígitos só (14 chars) e use como 1º campo.

FLUXO OBRIGATÓRIO EM MODO EQUIPE:

1. Leia TODA a mensagem. Procure por "Emitente:", "NF do <empresa> (CNPJ ...)", "do CNPJ X", ou outro padrão onde a equipe diz QUEM vai emitir.
2. Se achou CNPJ do emitente (14 dígitos) → identifica também valor, CNPJ/CPF do tomador, razão social do tomador, descrição.
3. Monta a tag. Formato pleno (6 campos, o 6º é opcional):
   [ACAO:EMITIR_NF:cnpj_emitente|valor|cnpj_tomador|razao_tomador|descricao|competencia_ou_codigo_servico]

   Exemplo SEM código de serviço (cliente já tem no cadastro):
   [ACAO:EMITIR_NF:27998575000100|890.00|04406995927|Maysa Bittencourt|Atendimentos e Consultas medicas]

   Exemplo COM código de serviço (mensagem da equipe menciona "Código de Tributação Nacional: X" ou "cTribNac: Y" ou "código de serviço Z"):
   [ACAO:EMITIR_NF:27998575000100|890.00|04406995927|Maysa Bittencourt|Atendimentos e Consultas medicas||123012200]

   Observação: se quiser usar o 6º campo sem passar competência (5º), deixe o 5º vazio com || como no exemplo acima.

CÓDIGO DE SERVIÇO (cTribNac) — quando passar:
- Se a mensagem trouxer explicitamente "Código de Tributação Nacional", "cTribNac", ou "código de serviço" com um número, EXTRAIA esse número (só dígitos) e passe como 6º campo da tag.
- Exemplo prático: "Código de Tributação Nacional: 04.01.01 - Medicina; 123012200 - Serviços médicos" → use 123012200 (o número com 9 dígitos é o cTribNac Nacional; o 04.01.01 é código municipal, ignore).
- Se a mensagem não mencionar código, não precisa do 6º campo — o sistema usa o que estiver no cadastro do cliente emitente.
- Se o sistema responder erro "código de serviço ausente", significa que o cliente emitente é novo e não tem código cadastrado — peça à equipe qual cTribNac usar.

SE VOCÊ NÃO CONSEGUIU IDENTIFICAR O CNPJ DO EMITENTE NA MENSAGEM:
- NÃO invente. NÃO use 4 campos. NÃO coloque tag nenhuma.
- NÃO chute "Marçal". NÃO assuma "é nosso padrão".
- Pergunte direto: "De qual empresa sai essa NF? Me passa o CNPJ do emitente."
- Só dispara a tag DEPOIS que receber o CNPJ confirmado.

UMA NF POR PEDIDO:
- Inclua a tag [ACAO:EMITIR_NF:...] **UMA ÚNICA VEZ** por resposta, mesmo que você esteja explicando ou confirmando algo — colar a tag duas vezes não "emite duas notas", só confunde o sistema e pode ser rejeitado.
- Se a equipe pedir duas NFs no mesmo texto, você ainda responde com UMA tag — e diz "essa eu emito agora, qual é a segunda?". Peça uma de cada vez.

Regras de apoio:
- Se o cliente emitente não tiver certificado A1, o dispatcher devolve erro claro ("Fulano não tem A1 configurado") — só passa pro operador e pede pra subir o certificado.
- CNPJ do emitente = cliente da Marçal. CNPJ do tomador = pra quem o cliente vendeu/prestou.

═══════════════════════════════════════════════════════
TEMPLATES DE FORMULÁRIO — MODO EQUIPE
═══════════════════════════════════════════════════════

QUANDO USAR: se a equipe pedir uma operação (NF, DAS, DARF, etc) SEM todos os dados necessários, em vez de perguntar campo por campo você responde com o template da operação em formato de formulário pronto pra copy-paste. Aí a equipe só preenche e reenvia numa mensagem só.

QUANDO NÃO USAR: se a mensagem já trouxer TODOS os dados (você consegue montar a tag de ação sem faltar nada), dispare a ação direto — nada de template desnecessário que só atrasa. Template é último recurso, não padrão.

FORMATO DE RESPOSTA: copie EXATAMENTE o template abaixo, sem reformatar, sem reescrever. Use o bullet "•" e mantenha os "_____" como campos vazios. Só adicione uma frase curta antes ("Show, pra emitir me passa assim:") — nada de explicação longa depois do template.

--- NF (emitir) ---

📝 *EMITIR NF*
• Emitente: _____ (razão social + CNPJ do cliente que vai emitir)
• Tomador: _____ (nome/razão + CPF ou CNPJ)
• Valor: R$ _____
• Descrição: _____
• Cód. tributação (1ª NF do cliente novo): _____

--- DAS (2ª via / avulso) ---

📝 *2ª via de DAS*
• Empresa: _____
• CNPJ: _____
• Competência: __/____  (MM/AAAA)
• Tipo: ( ) Simples Nacional  ( ) MEI

--- SITFIS (situação fiscal / substitui CND) ---

📝 *Situação Fiscal (SITFIS)*
• Empresa: _____
• CNPJ: _____

--- CCMEI ---

📝 *Certificado de MEI (CCMEI)*
• CNPJ do MEI: _____

--- DAS MEI ---

📝 *DAS MEI*
• CNPJ do MEI: _____
• Ano: ____

--- CADASTRAR A1 ---

📝 *CADASTRAR CERTIFICADO A1*
• CNPJ do cliente: _____
• Senha do certificado: _____

⚠️ *Antes de enviar isso*, anexe o arquivo .pfx como documento na mesma conversa (máx 30 min antes).

--- CANCELAR NF ---

📝 *CANCELAR NF*
• Número da NF (ou chave de acesso 47 dígitos): _____
• Motivo do cancelamento: _____ (mínimo 15 caracteres)

(Se houver risco de ambiguidade, prefira a chave de acesso.)

--- DARF ---

📝 *DARF (Sicalc)*
• CNPJ: _____
• Tributo: _____ (IRPJ, CSLL, COFINS, PIS, IRRF, INSS — ou código RFB de 4 dígitos)
• Período: __/____  (MM/AAAA)
• Valor: R$ _____

(Vencimento eu calculo sozinha — último dia útil do mês seguinte. Se for outra data, me avise.)

═══════════════════════════════════════════════════════

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
      // Ferramenta de busca web (server-side tool da Anthropic).
      // Restrita a fontes oficiais: Receita Federal, Planalto, Imprensa Nacional, Portal Fazenda, SPED, gov.br.
      // max_uses cap pra controlar custo (cada busca ~$0.01).
      const webSearchTool = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 2,
        allowed_domains: [
          'receita.fazenda.gov.br',
          'gov.br',
          'planalto.gov.br',
          'in.gov.br',
          'portal.fazenda.gov.br',
          'sped.rfb.gov.br',
          'www38.receita.fazenda.gov.br'
        ]
      };

      const body = JSON.stringify({
        model: this.modelo,
        max_tokens: 1200,
        system: systemPrompt,
        messages: messages,
        tools: [webSearchTool]
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
              // Quando a ANA usa web_search, o content vem com múltiplos blocos:
              // [text?, server_tool_use, web_search_tool_result, text].
              // Concatena todos os blocos de texto pra formar a resposta final.
              const blocos = Array.isArray(parsed.content) ? parsed.content : [];
              const textos = blocos.filter(b => b.type === 'text').map(b => b.text).filter(Boolean);
              const texto = textos.join('\n\n').trim() || 'Desculpe, não consegui processar sua mensagem.';

              // Log se a busca foi usada (pra acompanhar custo e comportamento)
              const usouBusca = blocos.some(b => b.type === 'server_tool_use' && b.name === 'web_search');
              if (usouBusca) {
                const queries = blocos
                  .filter(b => b.type === 'server_tool_use' && b.name === 'web_search')
                  .map(b => b.input?.query)
                  .filter(Boolean);
                console.log('[AgenteIA] 🔎 ANA usou web_search:', queries.join(' | '));
              }

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
    // Dedupe: remove ações duplicadas (mesmo tipo + mesmo parâmetro) na mesma resposta.
    // Protege contra alucinação do modelo que às vezes anuncia "vou emitir as duas" e
    // cola a tag duas vezes com parâmetros idênticos → emitiria 2 NFs na SEFIN.
    const vistas = new Set();
    const acoesDedup = [];
    for (const a of acoes) {
      const chave = `${a.tipo}::${a.parametro || ''}`;
      if (vistas.has(chave)) {
        console.warn(`[AgenteIA] Tag duplicada ignorada: ${chave.substring(0, 80)}`);
        continue;
      }
      vistas.add(chave);
      acoesDedup.push(a);
    }
    return acoesDedup;
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
          // Notifica o admin via WhatsApp (não bloqueia o fluxo se falhar)
          this._notificarAdminTransferencia(conversaId, contato).catch(err =>
            console.warn('[WhatsApp] Falha ao notificar admin:', err.message)
          );
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
            // ===== MULTI-EMITENTE =====
            // Formato novo (modo equipe): cnpj_emitente|valor|cnpj_tomador|razao|descricao
            // Formato antigo (modo cliente): valor|cnpj_tomador|razao|descricao
            // Detector: se primeiro campo tem 14 dígitos após strip E tem 5+ campos, é CNPJ emitente
            const partesDetectEmitente = acao.parametro.split('|');
            const primeiroLimpo = (partesDetectEmitente[0] || '').replace(/\D/g, '');
            const pareceCnpjEmitente = primeiroLimpo.length === 14 && partesDetectEmitente.length >= 5;

            // GUARD MODO EQUIPE: em modo equipe (ou admin direto), NÃO aceitar formato de 4
            // campos — isso emitiria pela Marçal por default. Emissão em nome da Marçal
            // exige que a equipe explicite usando [ACAO:EMITIR_NF:<cnpj_marcal>|...] com
            // 5 campos, pra garantir intenção.
            const ehContextoEquipe = !!(contato?.modoEquipe?.ehEquipe || contato?.ehAdmin);
            if (ehContextoEquipe && !pareceCnpjEmitente) {
              console.log(`[WhatsApp] 🛑 EMITIR_NF bloqueado: modo equipe exige CNPJ do emitente como 1º campo (5 campos). Recebido: ${acao.parametro.substring(0, 100)}`);
              acao.feedback = { sucesso: false, erro: 'Pra emitir em modo equipe preciso do CNPJ do cliente que vai emitir a NF como primeiro campo da tag. Me passa o CNPJ do emitente?' };
              break;
            }
            if (pareceCnpjEmitente) {
              const clienteEmitente = db.prepare(
                `SELECT id, razao_social, certificado_a1_path, certificado_a1_senha_encrypted
                 FROM clientes
                 WHERE REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
                 LIMIT 1`
              ).get(primeiroLimpo);
              if (!clienteEmitente) {
                console.log(`[WhatsApp] ❌ EMITIR_NF: cliente emitente CNPJ ${primeiroLimpo} não encontrado na carteira`);
                acao.feedback = { sucesso: false, erro: `Não achei cliente com CNPJ ${primeiroLimpo} na carteira. Confere o CNPJ?` };
                break;
              }
              if (!clienteEmitente.certificado_a1_path || !clienteEmitente.certificado_a1_senha_encrypted) {
                console.log(`[WhatsApp] ❌ EMITIR_NF: ${clienteEmitente.razao_social} sem certificado A1`);
                acao.feedback = { sucesso: false, erro: `${clienteEmitente.razao_social} não tem certificado A1 configurado no portal. Sobe o certificado antes de emitir.` };
                break;
              }
              // Override: a NF vai sair em nome desse cliente, não do vínculo default do contato
              if (contato) {
                contato.cliente_id = clienteEmitente.id;
              } else {
                contato = { cliente_id: clienteEmitente.id };
              }
              console.log(`[WhatsApp] EMITIR_NF: emitente explícito = ${clienteEmitente.razao_social} (ID ${clienteEmitente.id})`);
            }
            // ===== fim MULTI-EMITENTE =====

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
              // Formato novo (multi-emitente): cnpj_emitente|valor|cnpj_tomador|razao|descricao|[competencia]
              // Formato antigo (emissor default): valor|cnpj_tomador|razao|descricao|[competencia]
              const partes = acao.parametro.split('|');
              const primeiroLimpoParse = (partes[0] || '').replace(/\D/g, '');
              const temEmitenteExplicito = primeiroLimpoParse.length === 14 && partes.length >= 5;
              const idx = temEmitenteExplicito ? 1 : 0; // pula o campo emitente se presente
              const valor = parseFloat(partes[idx]?.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
              const documentoTomador = (partes[idx + 1]?.trim() || '').replace(/\D/g, ''); // só números
              const razaoSocialTomador = partes[idx + 2]?.trim() || '';
              const descricao = partes[idx + 3]?.trim() || 'Serviços prestados';
              const competencia = partes[idx + 4]?.trim() || new Date().toISOString().slice(0, 7);
              // 6º campo opcional: código de serviço (cTribNac) — usado quando o cliente emitente
              // ainda não tem código_servico cadastrado no painel (cliente novo ou múltiplas atividades).
              // A equipe extrai da mensagem (ex: "Código de Tributação Nacional: 04.01.01 - Medicina")
              // e passa como último campo da tag.
              const codigoServicoOverride = partes[idx + 5]?.trim() || '';

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
                codigoServicoOverride || clienteData?.codigo_servico || '',
                aliquotaIss,
                valorIss,
                baseCalculo,
                valorLiquido,
                numeroDps
              );

              const nfId = result.lastInsertRowid;
              console.log(`[WhatsApp] NF criada: ID ${nfId}, R$ ${valor} para ${tomador.razao_social} (${tomador.documento})`);

              // Auto-persistência: se a Ana passou cTribNac explicitamente (6º campo) E o cliente
              // emitente não tinha código cadastrado, grava no cadastro pra não precisar passar de
              // novo na próxima NF. Protegido pra NÃO sobrescrever clientes que já tenham código
              // (respeita cliente com múltiplas atividades onde o código muda por NF).
              if (codigoServicoOverride && (!clienteData?.codigo_servico || clienteData.codigo_servico.trim() === '')) {
                try {
                  db.prepare('UPDATE clientes SET codigo_servico = ?, updated_at = datetime(\'now\') WHERE id = ? AND (codigo_servico IS NULL OR codigo_servico = \'\')').run(codigoServicoOverride, contato.cliente_id);
                  console.log(`[WhatsApp] auto-upsert: codigo_servico=${codigoServicoOverride} gravado no cliente ${contato.cliente_id} (era vazio)`);
                } catch (e) {
                  console.warn(`[WhatsApp] auto-upsert de codigo_servico falhou: ${e.message}`);
                }
              }

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

        case 'CADASTRAR_A1':
          // Formato: [ACAO:CADASTRAR_A1:cnpj|senha]
          // A equipe deve ter anexado o arquivo .pfx nos últimos 30min na mesma conversa.
          if (acao.parametro) {
            try {
              const a1Partes = acao.parametro.split('|');
              const cnpjA1 = (a1Partes[0] || '').replace(/\D/g, '');
              const senhaA1 = (a1Partes.slice(1).join('|') || '').trim(); // senha pode ter pipes

              if (cnpjA1.length !== 14) {
                acao.feedback = { sucesso: false, erro: 'CNPJ inválido — precisa dos 14 dígitos do cliente dono do certificado.' };
                break;
              }
              if (!senhaA1) {
                acao.feedback = { sucesso: false, erro: 'Senha do certificado ausente. Formato: [ACAO:CADASTRAR_A1:cnpj|senha].' };
                break;
              }

              const cliA1 = db.prepare(`SELECT id, razao_social FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(cnpjA1);
              if (!cliA1) {
                acao.feedback = { sucesso: false, erro: `Cliente com CNPJ ${cnpjA1} não encontrado na carteira. Cadastre o cliente antes de subir o A1.` };
                break;
              }

              const anexo = anexoCacheService.buscarUltimo(conversaId);
              if (!anexo || !anexo.url) {
                acao.feedback = { sucesso: false, erro: 'Não achei arquivo .pfx anexado nessa conversa (ou expirou, TTL 30min). Reenvie o certificado como documento e já emenda a mensagem "CADASTRAR_A1".' };
                break;
              }

              // Baixa o arquivo do URL Z-API
              const pfxBuffer = await new Promise((resolve, reject) => {
                const req = https.get(anexo.url, (res) => {
                  if (res.statusCode !== 200) {
                    reject(new Error(`Download do anexo falhou (HTTP ${res.statusCode})`));
                    return;
                  }
                  const chunks = [];
                  res.on('data', c => chunks.push(c));
                  res.on('end', () => resolve(Buffer.concat(chunks)));
                });
                req.on('error', reject);
                req.setTimeout(20000, () => req.destroy(new Error('Download timeout')));
              });

              if (pfxBuffer.length < 100) {
                acao.feedback = { sucesso: false, erro: 'Arquivo baixado é muito pequeno — anexo corrompido ou URL inválida.' };
                break;
              }

              // Valida + salva (certificadoService faz ambos)
              let infoCert;
              try {
                const resultSalvar = certificadoService.salvarCertificado(cliA1.id, pfxBuffer, senhaA1);
                infoCert = resultSalvar.info;
              } catch (errCert) {
                acao.feedback = { sucesso: false, erro: `Certificado inválido: ${errCert.message}` };
                break;
              }

              console.log(`[WhatsApp] CADASTRAR_A1: cliente ${cliA1.id} (${cliA1.razao_social}) — A1 válido até ${infoCert.validade?.fim}, CNPJ cert=${infoCert.cnpj}`);

              // Limpa o cache após uso (evita re-cadastro acidental)
              anexoCacheService.esquecer(conversaId);

              acao.feedback = {
                sucesso: true,
                clienteId: cliA1.id,
                razao: cliA1.razao_social,
                titular: infoCert.titular,
                cnpjCert: infoCert.cnpj,
                validade: infoCert.validade?.fim,
                diasRestantes: infoCert.diasRestantes,
              };
            } catch (err) {
              console.error('[WhatsApp] Erro CADASTRAR_A1:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'ATUALIZAR_CLIENTE':
          // Formato: [ACAO:ATUALIZAR_CLIENTE:cnpj|campo=valor|campo=valor...]
          // Campos permitidos (whitelist): optante_simples, aliquota_iss, codigo_servico,
          // descricao_servico_padrao, regime_especial, incentivo_fiscal, inscricao_municipal,
          // codigo_municipio, municipio, uf, cep, logradouro, numero, bairro
          if (acao.parametro) {
            try {
              const atuPartes = acao.parametro.split('|');
              const cnpjAlvo = (atuPartes[0] || '').replace(/\D/g, '');
              if (cnpjAlvo.length !== 14) {
                acao.feedback = { sucesso: false, erro: 'CNPJ inválido — preciso dos 14 dígitos do cliente emitente.' };
                break;
              }
              const cliAlvo = db.prepare(`SELECT id, razao_social, optante_simples, aliquota_iss, codigo_servico FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(cnpjAlvo);
              if (!cliAlvo) {
                acao.feedback = { sucesso: false, erro: `Cliente com CNPJ ${cnpjAlvo} não encontrado na carteira.` };
                break;
              }

              const CAMPOS_PERMITIDOS = new Set([
                'optante_simples', 'aliquota_iss', 'codigo_servico', 'descricao_servico_padrao',
                'regime_especial', 'incentivo_fiscal', 'inscricao_municipal',
                'codigo_municipio', 'municipio', 'uf', 'cep', 'logradouro', 'numero', 'bairro',
              ]);
              const normalizarBool = (v) => {
                const x = String(v).trim().toLowerCase();
                if (['1','true','sim','yes','simples','y','t','s'].includes(x)) return 1;
                if (['0','false','nao','não','no','n','f'].includes(x)) return 0;
                return null;
              };
              const normalizarAliquota = (v) => {
                const x = String(v).replace('%','').replace(',','.').trim();
                const n = parseFloat(x);
                if (isNaN(n)) return null;
                // Se veio como percentual (ex: "5" ou "5.0"), converte pra fração (0.05)
                return n > 1 ? n / 100 : n;
              };

              const updates = {};
              const erros = [];
              for (let i = 1; i < atuPartes.length; i++) {
                const kv = atuPartes[i];
                const eq = kv.indexOf('=');
                if (eq < 0) continue;
                const campo = kv.slice(0, eq).trim().toLowerCase();
                const valor = kv.slice(eq + 1).trim();
                if (!CAMPOS_PERMITIDOS.has(campo)) {
                  erros.push(`campo "${campo}" não permitido (permitidos: ${[...CAMPOS_PERMITIDOS].join(', ')})`);
                  continue;
                }
                if (campo === 'optante_simples' || campo === 'incentivo_fiscal') {
                  const b = normalizarBool(valor);
                  if (b === null) { erros.push(`${campo}: valor "${valor}" inválido, use 1/0 ou sim/não`); continue; }
                  updates[campo] = b;
                } else if (campo === 'aliquota_iss') {
                  const a = normalizarAliquota(valor);
                  if (a === null) { erros.push(`aliquota_iss: valor "${valor}" inválido`); continue; }
                  updates[campo] = a;
                } else if (campo === 'uf') {
                  updates[campo] = valor.toUpperCase().slice(0, 2);
                } else {
                  updates[campo] = valor;
                }
              }

              if (erros.length > 0) {
                acao.feedback = { sucesso: false, erro: 'Falhas na validação: ' + erros.join('; ') };
                break;
              }
              if (Object.keys(updates).length === 0) {
                acao.feedback = { sucesso: false, erro: 'Nenhum campo válido informado.' };
                break;
              }

              const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
              const valuesArr = Object.values(updates);
              db.prepare(`UPDATE clientes SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(...valuesArr, cliAlvo.id);
              console.log(`[WhatsApp] ATUALIZAR_CLIENTE: cliente ${cliAlvo.id} (${cliAlvo.razao_social}) — ${Object.entries(updates).map(([k,v])=>`${k}=${v}`).join(', ')}`);

              acao.feedback = {
                sucesso: true,
                clienteId: cliAlvo.id,
                razao: cliAlvo.razao_social,
                atualizados: updates,
              };
            } catch (err) {
              console.error('[WhatsApp] Erro ATUALIZAR_CLIENTE:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'CANCELAR_NF':
          // Formato: [ACAO:CANCELAR_NF:numero_ou_chave|motivo]
          // - numero_ou_chave: número da NFS-e (4+ dígitos) OU chave de acesso (47+ dígitos)
          // - motivo: texto livre (exigido pela RFB, min 15 chars; se menor, completa)
          if (acao.parametro) {
            try {
              const cancPartes = acao.parametro.split('|');
              const alvo = (cancPartes[0] || '').trim();
              let motivo = (cancPartes[1] || '').trim();

              if (!alvo) {
                acao.feedback = { sucesso: false, erro: 'Informe o número da NF ou chave de acesso.' };
                break;
              }

              // Motivo min 15 chars (exigência do padrão nacional); se menor, preenche
              if (!motivo) motivo = 'Cancelamento solicitado pelo emitente';
              if (motivo.length < 15) motivo = motivo.padEnd(15, '.');

              // Busca a NF: chave (>=40 dígitos) tem prioridade; senão tenta por número
              const alvoLimpo = alvo.replace(/\D/g, '');
              let nf = null;
              if (alvoLimpo.length >= 40) {
                nf = db.prepare(`SELECT id, cliente_id, numero_nfse, chave_acesso, status FROM notas_fiscais WHERE chave_acesso = ? LIMIT 1`).get(alvoLimpo);
              } else if (alvoLimpo.length >= 1) {
                const matches = db.prepare(`SELECT id, cliente_id, numero_nfse, chave_acesso, status FROM notas_fiscais WHERE numero_nfse = ? ORDER BY id DESC`).all(alvoLimpo);
                if (matches.length === 1) nf = matches[0];
                else if (matches.length > 1) {
                  acao.feedback = { sucesso: false, erro: `Achei ${matches.length} NFs com o número ${alvoLimpo}. Me passa a chave de acesso completa (47 dígitos) pra eu cancelar a certa.` };
                  break;
                }
              }

              if (!nf) {
                acao.feedback = { sucesso: false, erro: `NF não encontrada (${alvo}). Confere o número ou manda a chave.` };
                break;
              }
              if (nf.status === 'cancelada') {
                acao.feedback = { sucesso: false, erro: `NF ${nf.numero_nfse} já está cancelada.` };
                break;
              }
              if (!nf.chave_acesso) {
                acao.feedback = { sucesso: false, erro: `NF ${nf.numero_nfse} não tem chave de acesso no sistema — pode não ter sido autorizada ainda.` };
                break;
              }

              const clienteEmit = db.prepare('SELECT id, razao_social, certificado_a1_senha_encrypted FROM clientes WHERE id = ?').get(nf.cliente_id);
              if (!clienteEmit || !clienteEmit.certificado_a1_senha_encrypted) {
                acao.feedback = { sucesso: false, erro: `Cliente emitente (ID ${nf.cliente_id}) sem certificado A1 configurado — não dá pra assinar o cancelamento.` };
                break;
              }

              console.log(`[WhatsApp] CANCELAR_NF: NF ${nf.id}, num=${nf.numero_nfse}, chave=${nf.chave_acesso}, emit=${clienteEmit.razao_social}`);
              const nfseService = require('./nfseNacionalService');
              let resultadoCanc;
              try {
                resultadoCanc = await nfseService.cancelarNFSe(nf.chave_acesso, motivo, clienteEmit.id, clienteEmit.certificado_a1_senha_encrypted);
              } catch (errCanc) {
                const msg = errCanc.mensagem || errCanc.message || JSON.stringify(errCanc).substring(0, 400);
                console.error(`[WhatsApp] Erro ao cancelar NF ${nf.id}:`, msg);
                acao.feedback = { sucesso: false, erro: `SEFIN rejeitou: ${msg}` };
                break;
              }

              db.prepare(`UPDATE notas_fiscais SET status = 'cancelada', data_cancelamento = datetime('now'), observacoes = COALESCE(observacoes || ' | ', '') || ? WHERE id = ?`).run('Cancelamento ANA: ' + motivo, nf.id);
              console.log(`[WhatsApp] NF ${nf.id} (num ${nf.numero_nfse}) cancelada com sucesso pelo emitente ${clienteEmit.razao_social}`);

              acao.feedback = {
                sucesso: true,
                nfId: nf.id,
                numero: nf.numero_nfse,
                chaveAcesso: nf.chave_acesso,
                emitente: clienteEmit.razao_social,
                motivo,
              };
            } catch (err) {
              console.error('[WhatsApp] Erro ao processar CANCELAR_NF:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'BUSCAR_DANFSE':
          if (acao.parametro) {
            try {
              const busca = acao.parametro.trim();

              // Detecta admin/equipe com matching tolerante (variações de formato
              // Z-API: com/sem "9 extra" de celular, possível truncamento do último dígito).
              const adminPhoneRaw = (process.env.ANA_ADMIN_WHATSAPP || '').replace(/\D/g, '');
              const telefoneContatoRaw = (contato?.telefone || '').replace(/\D/g, '');
              const variantesTelefone = (num) => {
                if (!num) return new Set();
                const v = new Set([num]);
                // Com/sem 9 extra (13 ↔ 12 dígitos, BR)
                if (num.length === 13 && num.startsWith('55') && num[4] === '9') {
                  v.add(num.slice(0, 4) + num.slice(5));
                } else if (num.length === 12 && num.startsWith('55')) {
                  v.add(num.slice(0, 4) + '9' + num.slice(4));
                }
                return v;
              };
              const matchTelefone = (a, b) => {
                if (!a || !b) return false;
                const va = variantesTelefone(a);
                const vb = variantesTelefone(b);
                for (const x of va) for (const y of vb) {
                  if (x === y) return true;
                  // Tolerância final: prefixo comum de ≥10 dígitos cobre truncamento do último
                  const menor = x.length < y.length ? x : y;
                  const maior = x.length < y.length ? y : x;
                  if (menor.length >= 10 && maior.startsWith(menor)) return true;
                }
                return false;
              };
              const ehAdmin = matchTelefone(adminPhoneRaw, telefoneContatoRaw);
              const ehEquipe = ehAdmin || contato?.modoEquipe?.ehEquipe;

              // Sempre tenta extrair CNPJ da mensagem — se achou, usa como cliente_id.
              // Isso funciona pra admin E pra cliente que por acaso mencione o próprio CNPJ.
              let clienteIdParaBusca = contato?.cliente_id || null;
              let cnpjMencionado = null;
              if (contato?.mensagemOriginal) {
                const cnpjMatch = contato.mensagemOriginal.match(/(\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2})/);
                if (cnpjMatch) {
                  const cnpjLimpo = cnpjMatch[1].replace(/\D/g, '');
                  if (cnpjLimpo.length === 14) {
                    cnpjMencionado = cnpjLimpo;
                    // Comparação em JS pra tolerar qualquer formato de armazenamento no banco
                    // (com pontuação, espaços, mascarado etc).
                    // Busca todos com CNPJ não-vazio e compara em JS (tolera qualquer formato de armazenamento).
                    // Nota: SQLite usa aspas SIMPLES pra string literal; "" seria referência a coluna.
                    const todosClientes = db.prepare("SELECT id, razao_social, cnpj FROM clientes WHERE cnpj IS NOT NULL AND TRIM(cnpj) != ''").all();
                    const clienteEncontrado = todosClientes.find(c => (c.cnpj || '').replace(/\D/g, '') === cnpjLimpo);
                    if (clienteEncontrado) {
                      clienteIdParaBusca = clienteEncontrado.id;
                      console.log(`[WhatsApp] BUSCAR_DANFSE: CNPJ ${cnpjLimpo} → ${clienteEncontrado.razao_social} (id=${clienteIdParaBusca})${ehEquipe ? ' (modo equipe)' : ''}`);
                    } else {
                      console.log(`[WhatsApp] BUSCAR_DANFSE: CNPJ ${cnpjLimpo} não encontrado na base de ${todosClientes.length} clientes`);
                    }
                  }
                }
              }

              // Monta a query: com filtro de cliente_id se soubermos (modo cliente ou admin com CNPJ),
              // sem filtro (global) se for admin sem CNPJ — pois aí ele está buscando numa base grande.
              let nfEncontrada = null;
              if (clienteIdParaBusca) {
                nfEncontrada = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso, cliente_id, status
                  FROM notas_fiscais
                  WHERE cliente_id = ? AND status = 'emitida'
                  AND (numero_nfse = ? OR CAST(id AS TEXT) = ? OR numero_dps = ?)
                  ORDER BY created_at DESC LIMIT 1
                `).get(clienteIdParaBusca, busca, busca, busca);
              } else if (ehEquipe) {
                // Admin sem CNPJ mencionado → busca global, mas pede desambiguação se achar mais de um
                const candidatos = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso, cliente_id
                  FROM notas_fiscais
                  WHERE status = 'emitida' AND chave_acesso IS NOT NULL
                  AND (numero_nfse = ? OR CAST(id AS TEXT) = ? OR numero_dps = ?)
                  ORDER BY created_at DESC LIMIT 5
                `).all(busca, busca, busca);
                if (candidatos.length === 1) {
                  nfEncontrada = candidatos[0];
                } else if (candidatos.length > 1) {
                  const listaClientes = candidatos.map(c => {
                    const cli = db.prepare('SELECT razao_social, cnpj FROM clientes WHERE id = ?').get(c.cliente_id);
                    return `• NF ${c.numero_nfse || c.id} — ${cli?.razao_social || 'cliente ' + c.cliente_id} (CNPJ ${cli?.cnpj || '-'})`;
                  }).join('\n');
                  acao.feedback = {
                    sucesso: false,
                    erro: `Achei ${candidatos.length} NFs com esse número. Me diz o CNPJ do cliente:\n${listaClientes}`
                  };
                  console.log(`[WhatsApp] BUSCAR_DANFSE modo equipe: ambíguo (${candidatos.length} candidatos) pra busca "${busca}"`);
                  break;
                }
              }

              if (nfEncontrada && nfEncontrada.chave_acesso) {
                acao.feedback = {
                  sucesso: true,
                  nfId: nfEncontrada.id,
                  numero: nfEncontrada.numero_nfse || nfEncontrada.numero_dps,
                  chaveAcesso: nfEncontrada.chave_acesso
                };
                console.log(`[WhatsApp] DANFSe encontrado: NF ${nfEncontrada.numero_nfse || nfEncontrada.id}${ehEquipe ? ' (modo equipe)' : ''}`);
              } else if (clienteIdParaBusca) {
                // Fallback no modo cliente: pega a última NF emitida do cliente
                const ultimaNf = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso
                  FROM notas_fiscais
                  WHERE cliente_id = ? AND status = 'emitida' AND chave_acesso IS NOT NULL
                  ORDER BY created_at DESC LIMIT 1
                `).get(clienteIdParaBusca);

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
              } else {
                acao.feedback = { sucesso: false, erro: `Não achei nenhuma NF com número ${busca}. Me passa o CNPJ do cliente pra eu buscar certo.` };
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

        case 'GERAR_DAS_SIMPLES':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'DAS Simples Nacional',
            metodo: 'gerarDASSimples',
            prefixoArquivo: 'DAS_Simples',
            tipoParam: 'cnpj|periodoApuracao',
          });
          break;

        case 'GERAR_DAS_SIMPLES_AVULSO':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'DAS Simples (Avulso)',
            metodo: 'gerarDASSimplesAvulso',
            prefixoArquivo: 'DAS_Avulso',
            tipoParam: 'cnpj|periodoApuracao',
          });
          break;

        case 'GERAR_DAS_MEI':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'DAS MEI',
            metodo: 'gerarDASMEI',
            prefixoArquivo: 'DAS_MEI',
            tipoParam: 'cnpj|periodoApuracao',
          });
          break;

        case 'SOLICITAR_SITFIS':
          await this._executarAcaoSitfis(acao);
          break;

        case 'EMITIR_CCMEI':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'Certificado de Condicao de MEI',
            metodo: 'emitirCCMEI',
            prefixoArquivo: 'CCMEI',
            tipoParam: 'cnpj',
          });
          break;

        case 'EMITIR_DARF':
          await this._executarAcaoDarf(acao);
          break;

        default:
          console.log(`[WhatsApp] Ação não implementada: ${acao.tipo}`);
      }
    }
  }

  /**
   * Helper: executa uma acao SERPRO que retorna PDF base64. Decodifica, cacheia via
   * serproDocumentoService, gera token de download e popula acao.feedback com o link pronto.
   */
  async _executarAcaoSerproComPdf(acao, { rotulo, metodo, prefixoArquivo, tipoParam }) {
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'Parametros ausentes na acao', rotulo };
      return;
    }
    const partes = String(acao.parametro).split('|');
    const cnpj = (partes[0] || '').replace(/\D/g, '');
    if (cnpj.length !== 14) {
      acao.feedback = { sucesso: false, erro: `CNPJ invalido: ${partes[0]}`, rotulo };
      return;
    }
    const periodoApuracao = partes[1] || '';

    try {
      console.log(`[AgenteIA] ${rotulo}: chamando SERPRO pra ${cnpj} periodo=${periodoApuracao || 'N/A'}`);
      const serproDocumentoService = require('./serproDocumentoService');
      const certificadoService = require('./certificadoService');
      let resposta;
      if (tipoParam === 'cnpj|periodoApuracao') {
        if (!periodoApuracao) {
          acao.feedback = { sucesso: false, erro: 'Periodo de apuracao obrigatorio (YYYYMM ou YYYY)', rotulo };
          return;
        }
        resposta = await integraContadorService[metodo](cnpj, periodoApuracao);
      } else {
        resposta = await integraContadorService[metodo](cnpj);
      }

      const dados = this._parseDadosSerproResposta(resposta);
      const pdfBase64 = dados && (dados.pdf || dados.documento || dados.relatorio);
      if (!pdfBase64 || typeof pdfBase64 !== 'string' || pdfBase64.length < 100) {
        acao.feedback = { sucesso: false, erro: 'SERPRO nao retornou PDF no payload', rotulo, resposta_raw: resposta };
        return;
      }

      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      if (pdfBuffer.slice(0, 4).toString() !== '%PDF') {
        acao.feedback = { sucesso: false, erro: 'Conteudo recebido nao e PDF valido', rotulo };
        return;
      }

      const sufixo = periodoApuracao ? `_${periodoApuracao}` : '';
      const nomeArquivo = `${prefixoArquivo}_${cnpj}${sufixo}.pdf`;
      const titulo = `${rotulo}${periodoApuracao ? ` ${periodoApuracao}` : ''}`;
      const token = serproDocumentoService.gravar({
        pdf: pdfBuffer,
        nomeArquivo,
        titulo,
        metadata: { cnpj, operacao: metodo, periodoApuracao },
      });

      const { gerarToken } = require('../middleware/auth');
      const jwtToken = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'serpro-doc' });
      let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
      }
      const link = `${baseUrl}/api/integra-contador/documento/${token}?token=${jwtToken}`;

      acao.feedback = {
        sucesso: true,
        rotulo,
        cnpj,
        periodoApuracao,
        tamanhoPdfKb: Math.round(pdfBuffer.length / 1024),
        pdfEnvio: { link, nomeArquivo, titulo },
      };
    } catch (err) {
      console.error(`[AgenteIA] Falha ${rotulo} (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo };
    }
  }

  /**
   * Helper SITFIS: assincrono (solicita protocolo -> aguarda -> emite relatorio).
   * Usa o wrapper obterRelatorioSitfis do service que ja orquestra isso.
   */
  async _executarAcaoSitfis(acao) {
    const rotulo = 'Relatorio de Situacao Fiscal';
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'CNPJ obrigatorio', rotulo };
      return;
    }
    const cnpj = String(acao.parametro).replace(/\D/g, '');
    if (cnpj.length !== 14) {
      acao.feedback = { sucesso: false, erro: `CNPJ invalido: ${acao.parametro}`, rotulo };
      return;
    }
    try {
      const serproDocumentoService = require('./serproDocumentoService');
      console.log(`[AgenteIA] SITFIS: solicitando pra ${cnpj}...`);
      const { pdfBase64, protocolo, tentativas } = await integraContadorService.obterRelatorioSitfis(cnpj);
      if (!pdfBase64) {
        acao.feedback = { sucesso: false, erro: 'SITFIS sem PDF apos retries', rotulo };
        return;
      }
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const nomeArquivo = `SITFIS_${cnpj}.pdf`;
      const titulo = `Situacao Fiscal — CNPJ ${cnpj}`;
      const token = serproDocumentoService.gravar({ pdf: pdfBuffer, nomeArquivo, titulo, metadata: { cnpj, operacao: 'sitfis', protocolo } });
      const { gerarToken } = require('../middleware/auth');
      const jwtToken = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'serpro-doc' });
      let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
      }
      const link = `${baseUrl}/api/integra-contador/documento/${token}?token=${jwtToken}`;
      acao.feedback = {
        sucesso: true,
        rotulo,
        cnpj,
        tentativas,
        protocolo,
        tamanhoPdfKb: Math.round(pdfBuffer.length / 1024),
        pdfEnvio: { link, nomeArquivo, titulo },
      };
    } catch (err) {
      console.error(`[AgenteIA] SITFIS falhou (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo };
    }
  }

  /**
   * Helper DARF via Sicalc — parametros: cnpj|codigoReceita|periodoApuracao|dataVencimento|valorPrincipal
   */
  async _executarAcaoDarf(acao) {
    const rotulo = 'DARF (Sicalc)';
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'Parametros ausentes', rotulo };
      return;
    }
    const partes = String(acao.parametro).split('|');
    const cnpj = (partes[0] || '').replace(/\D/g, '');
    let codigoReceita = String(partes[1] || '').trim();
    const periodoApuracao = String(partes[2] || '').trim();
    let dataVencimento = String(partes[3] || '').trim();
    const valorPrincipal = parseFloat(partes[4] || '0');

    const mapaTributo = {
      IRPJ: '2362', CSLL: '2372', COFINS: '5952', PIS: '8109',
      PISPASEP: '8109', IRRF: '0561', INSS: '1007',
    };
    if (codigoReceita && !/^\d{3,4}$/.test(codigoReceita)) {
      const up = codigoReceita.toUpperCase().replace(/[^A-Z]/g, '');
      if (mapaTributo[up]) {
        console.log(`[AgenteIA] DARF: tributo "${codigoReceita}" -> codigo ${mapaTributo[up]}`);
        codigoReceita = mapaTributo[up];
      }
    }

    if (!dataVencimento && /^\d{6}$/.test(periodoApuracao)) {
      const ano = parseInt(periodoApuracao.slice(0, 4), 10);
      const mes = parseInt(periodoApuracao.slice(4, 6), 10);
      const proxMes = mes === 12 ? 1 : mes + 1;
      const proxAno = mes === 12 ? ano + 1 : ano;
      const diaUltimo = new Date(proxAno, proxMes, 0).getDate();
      let dt = new Date(proxAno, proxMes - 1, diaUltimo);
      while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() - 1);
      const dd = String(dt.getDate()).padStart(2, '0');
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const aaaa = String(dt.getFullYear());
      dataVencimento = `${dd}${mm}${aaaa}`;
      console.log(`[AgenteIA] DARF: vencimento calculado ${dataVencimento} (periodo ${periodoApuracao})`);
    }

    if (cnpj.length !== 14 || !codigoReceita || !periodoApuracao || !dataVencimento || !valorPrincipal) {
      acao.feedback = { sucesso: false, erro: 'Faltou algum campo obrigatorio (cnpj, tributo/codigo, periodo YYYYMM, valor). Vencimento e opcional - eu calculo.', rotulo };
      return;
    }
    try {
      const serproDocumentoService = require('./serproDocumentoService');
      const dados = { codigoReceita, periodoApuracao, dataVencimento, valorPrincipal };
      console.log(`[AgenteIA] DARF: ${cnpj} cod=${codigoReceita} periodo=${periodoApuracao}`);
      const resposta = await integraContadorService.gerarDARF(cnpj, dados);
      const d = this._parseDadosSerproResposta(resposta);
      const pdfBase64 = d && (d.pdf || d.documento);
      if (!pdfBase64) {
        acao.feedback = { sucesso: false, erro: 'SERPRO nao retornou PDF do DARF', rotulo, resposta_raw: resposta };
        return;
      }
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const nomeArquivo = `DARF_${cnpj}_${periodoApuracao}.pdf`;
      const titulo = `DARF — CNPJ ${cnpj} ${periodoApuracao}`;
      const token = serproDocumentoService.gravar({ pdf: pdfBuffer, nomeArquivo, titulo, metadata: { cnpj, operacao: 'darf', periodoApuracao } });
      const { gerarToken } = require('../middleware/auth');
      const jwtToken = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'serpro-doc' });
      let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
      }
      const link = `${baseUrl}/api/integra-contador/documento/${token}?token=${jwtToken}`;
      acao.feedback = { sucesso: true, rotulo, cnpj, tamanhoPdfKb: Math.round(pdfBuffer.length / 1024), pdfEnvio: { link, nomeArquivo, titulo } };
    } catch (err) {
      console.error(`[AgenteIA] DARF falhou (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo };
    }
  }

  /**
   * Extrai 'dados' da resposta SERPRO (pode vir como string JSON).
   */
  _parseDadosSerproResposta(resposta) {
    if (!resposta) return null;
    let d = resposta.dados;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { /* mantem string */ }
    }
    return d;
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

  /**
   * Seleciona o provider WhatsApp ativo (mesmo dispatcher de routes/whatsapp.js)
   */
  _obterWhatsAppProvider() {
    const provider = process.env.WHATSAPP_PROVIDER || 'meta';
    if (provider === 'blip') return require('./blipService');
    if (provider === 'evolution') return require('./evolutionService');
    if (provider === 'zapi') return require('./zapiService');
    return require('./whatsappService'); // meta cloud api
  }

  /**
   * Notifica o admin (Thiago) via WhatsApp quando uma conversa é transferida.
   * Roda em background — falhas não bloqueiam a resposta ao cliente.
   */
  async _notificarAdminTransferencia(conversaId, contato) {
    const adminPhone = process.env.ANA_ADMIN_WHATSAPP || '5541996104498';
    if (!adminPhone) {
      console.warn('[WhatsApp] ANA_ADMIN_WHATSAPP não configurado — alerta não enviado');
      return;
    }

    const db = getDb();

    // Pega últimas 5 mensagens da conversa pra dar contexto
    const ultimas = db.prepare(`
      SELECT direcao, conteudo, remetente, created_at
      FROM whatsapp_mensagens
      WHERE conversa_id = ?
      ORDER BY created_at DESC LIMIT 5
    `).all(conversaId).reverse();

    // Monta informação do cliente
    let clienteInfo = 'Contato desconhecido';
    let telefoneCliente = contato?.telefone || '?';
    if (contato?.cliente_id) {
      const c = db.prepare('SELECT razao_social, cnpj FROM clientes WHERE id = ?').get(contato.cliente_id);
      if (c) clienteInfo = `${c.razao_social} (${c.cnpj})`;
    } else if (contato?.nome) {
      clienteInfo = contato.nome;
    }

    // Monta histórico resumido
    const historicoTxt = ultimas
      .map(m => {
        const quem = m.direcao === 'entrada' ? '👤 Cliente' : (m.remetente === 'bot' ? '🤖 ANA' : '👨 Equipe');
        const conteudo = (m.conteudo || '').replace(/\[ACAO:[^\]]+\]/g, '').trim().slice(0, 200);
        return `${quem}: ${conteudo}`;
      })
      .join('\n');

    const baseUrl = process.env.APP_BASE_URL || 'https://emissor-nfs-marcal.onrender.com';
    const mensagem = `🔔 *ANA pediu reforço*

Cliente: *${clienteInfo}*
WhatsApp: ${telefoneCliente}

_Últimas mensagens:_
${historicoTxt}

Abra o painel pra responder:
${baseUrl}/escritorio/whatsapp`;

    try {
      const provider = this._obterWhatsAppProvider();
      if (!provider.isConfigured?.()) {
        console.warn('[WhatsApp] Provider não configurado, alerta admin não enviado');
        return;
      }
      await provider.enviarTexto(adminPhone, mensagem);
      console.log(`[WhatsApp] ✓ Admin (${adminPhone}) notificado da transferência da conversa ${conversaId}`);
    } catch (err) {
      console.error('[WhatsApp] Erro enviando alerta admin:', err.message);
    }
  }

  // =====================================================
  // AUTO-VALIDAÇÃO DE RESPOSTA (anti-promessa vazia)
  // Detecta quando ANA promete "vou verificar e te retorno"
  // sem ter mecanismo de retorno, e força transferência humana
  // =====================================================

  /**
   * Retorna { ok: bool, motivo: string }
   * Otimizado: regex detecta sinais antes de gastar tokens no Haiku
   */
  async _validarResposta(mensagemCliente, respostaAna) {
    // Skip se resposta já tem ação concreta — presume que é boa
    if (/\[ACAO:[^\]]+\]/.test(respostaAna)) {
      return { ok: true, motivo: 'tem ação concreta' };
    }

    // Resposta muito curta (< 30 chars) — provavelmente saudação simples, deixa passar
    if (respostaAna.trim().length < 30) {
      return { ok: true, motivo: 'resposta curta' };
    }

    // Detecta sinais de promessa vazia por regex
    const sinaisPromessa = /\b(vou\s+(verificar|confirmar|olhar|consultar|checar|analisar|pesquisar|ver|dar uma olhada|dar uma verificada|conferir|pegar)|deixa\s+(eu|que\s+eu)\s+(ver|verificar|olhar|consultar|checar|conferir)|te\s+(retorno|aviso|falo|respondo|confirmo)|já\s+(te|lhe)?\s*(retorno|aviso|respondo|falo|confirmo)|(daqui|em)\s+\w+\s+(minuto|segundo|instante|momento))/i;

    if (!sinaisPromessa.test(respostaAna)) {
      return { ok: true, motivo: 'sem sinais de promessa vazia' };
    }

    // Tem sinal suspeito — chama Haiku pra confirmar
    console.log('[AgenteIA] 🔍 Sinal de promessa detectado, validando com Haiku...');

    try {
      return await this._chamarClaudeValidacao(mensagemCliente, respostaAna);
    } catch (err) {
      // Fail-safe: se validação quebrar, deixa passar (não queremos bloquear ANA por erro nosso)
      console.warn('[AgenteIA] Erro na auto-validação, deixando passar:', err.message);
      return { ok: true, motivo: 'validador offline' };
    }
  }

  _chamarClaudeValidacao(mensagemCliente, respostaAna) {
    const systemValidador = `Você é o avaliador de qualidade da ANA, atendente de contabilidade no WhatsApp. Avalie se a resposta dela vai resolver o problema do cliente ou deixá-lo esperando indefinidamente.

REGRA CRÍTICA: ANA não tem mecanismo de "voltar depois". Se ela promete algo no futuro (ex: "vou verificar e te retorno") sem cumprir AGORA, vira promessa vazia — cliente fica pra sempre esperando.

ok=TRUE quando a resposta:
- Resolve a dúvida do cliente de forma concreta
- Faz uma pergunta clara pra coletar info que ANA precisa pra agir
- Transfere explicitamente pro humano ("vou chamar o Thiago aqui no chat agora")
- É saudação genérica simples ("Oi! Tudo bem?")

ok=FALSE quando a resposta:
- Promete "vou verificar/confirmar/olhar/consultar e te retorno" sem mecanismo real de retorno
- Diz "te aviso depois" / "daqui a pouco eu volto" / "já te respondo" sem garantia
- Deixa o cliente esperando sem próximo passo claro

Responda APENAS em JSON válido, sem markdown: {"ok": true|false, "motivo": "explicação curta"}`;

    const userPrompt = `Cliente: "${mensagemCliente.slice(0, 500)}"\nANA: "${respostaAna.slice(0, 800)}"\n\nEssa resposta resolve ou deixa em aberto?`;

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: process.env.ANTHROPIC_VALIDADOR_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: systemValidador,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const url = new URL(ANTHROPIC_API_URL);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
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
            const texto = payload.content?.[0]?.text || '';
            const match = texto.match(/\{[\s\S]*?\}/);
            if (!match) {
              console.log('[AgenteIA] Validador não devolveu JSON, deixando passar. Texto:', texto.substring(0, 150));
              return resolve({ ok: true, motivo: 'sem json válido' });
            }
            const json = JSON.parse(match[0]);
            resolve({ ok: !!json.ok, motivo: json.motivo || '' });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('Timeout validador Haiku')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = new AgenteIAService();
