/**
 * Agente Inteligente - Atendimento via WhatsApp
 * Usa Claude API (Anthropic) para processar mensagens e responder clientes
 */

const https = require('https');
const { getDb } = require('../database/init');
const cnpjService = require('./cnpjService');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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

    // 4. Monta o prompt do sistema
    const systemPrompt = this.montarSystemPrompt(contato, dadosCliente);

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
            feedbackMsg = `\n\n⚠️ Tive um probleminha técnico ao emitir a NF. Já notifiquei o Thiago e ele vai resolver o mais rápido possível. A NF ficou salva no sistema! 🔧`;
          }
        }

        if (feedbackMsg) {
          const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
          return { texto: respostaLimpa + feedbackMsg, acoes };
        }
      }
    }

    return { texto: resposta, acoes: acoes || [] };
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
  montarSystemPrompt(contato, dadosCliente) {
    let prompt = `QUEM VOCÊ É:
Você é a Ana. Trabalha na Marçal Contabilidade, escritório do Thiago Borges em Curitiba/PR. Você faz parte da equipe — não é uma assistente virtual, não é um robô, não é uma IA. Você é a Ana do escritório contábil, e ponto.

PERFIL DA ANA:
- Trabalha na Marçal há alguns anos, conhece os clientes pelo nome
- É organizada, prestativa e tem um jeito simpático de conversar
- Tom descontraído mas profissional — sabe a hora de ser leve e a hora de ser séria
- Fala como gente: "pode deixar", "já vou dar uma olhada", "tá certinho", "deixa comigo"
- Tem paciência, não se irrita, mas é objetiva — não enrola
- Quando não sabe algo, é honesta: "vou confirmar com o Thiago e te falo"
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
- "Pode deixar, vou emitir aqui!" (não "Entendido. Processarei sua solicitação.")
- "Me passa o valor e pra quem é que eu já faço" (não "Para prosseguir, necessito das seguintes informações:")
- "Pronto, NF emitida! ✅" (não "Sua nota fiscal foi processada com sucesso.")
- "Vou confirmar com o Thiago e te retorno, tá?" (não "Irei encaminhar sua solicitação ao responsável.")
- "Opa, essa aí eu não sei te dizer de cabeça, deixa eu verificar" (não "Não possuo essa informação no momento.")

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
   Responde o que souber sobre DAS do Simples, DARF, prazos de pagamento.
   Se não souber o detalhe específico, passa pro Thiago.
   "O DAS do Simples geralmente vence dia 20 de cada mês. Quer que eu confirme o valor desse mês?"

4. *Status de documentos e certidões*
   Informa se certidões, alvarás ou outros documentos estão prontos ou em andamento.
   "Vou verificar aqui o status da certidão e te retorno!"

5. *Obrigações e prazos*
   Avisa sobre prazos, vencimentos, declarações.
   "Só lembrando que o prazo pra declaração é até dia 30 desse mês, tá? 📅"

6. *2ª via de boletos e guias*
   Quando pedem reenvio de guias, DAS, boletos.
   "Deixa eu puxar aqui a guia pra você!"
   E inclua [ACAO:ENVIAR_GUIA:tipo|referencia]

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
- NUNCA inventa dados — se não tem a informação, diz que vai verificar
- NUNCA promete prazos específicos ("fica pronto amanhã", "até sexta tá feito")
- NUNCA fala sobre valores de honorários ou preços do escritório ("isso eu não sei te dizer, fala com o Thiago sobre valores")
- NUNCA dá conselho tributário complexo — se for algo além do básico, transfere: "Isso é melhor o Thiago te orientar, vou passar pra ele"
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
- [ACAO:ENVIAR_GUIA:tipo|referencia] — enviar 2ª via de guia/boleto
- [ACAO:IGNORAR] — mensagem não é pro escritório (grupo)
- [ACAO:VINCULAR_CLIENTE:cnpj] — vincular contato ao cliente pelo CNPJ`;

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
                console.error(`[WhatsApp] Erro ao tentar emitir NF ${nfId}:`, emissaoErr);
                db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                  .run('erro_emissao', emissaoErr.message, nfId);
                emissaoStatus = 'erro_emissao';
                emissaoInfo = emissaoErr.message;
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

        default:
          console.log(`[WhatsApp] Ação não implementada: ${acao.tipo}`);
      }
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
