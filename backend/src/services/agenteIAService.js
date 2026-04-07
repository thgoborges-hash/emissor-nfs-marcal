/**
 * Agente Inteligente - Atendimento via WhatsApp
 * Usa Claude API (Anthropic) para processar mensagens e responder clientes
 */

const https = require('https');
const { getDb } = require('../database/init');

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

    // 7. Verifica se precisa executar ações
    const acoes = this.extrairAcoes(resposta);
    if (acoes.length > 0) {
      await this.executarAcoes(acoes, contato, conversaId);
    }

    return resposta;
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
Você pode estar num grupo de WhatsApp do cliente, onde tem várias pessoas da equipe dele. Qualquer pessoa do grupo pode te pedir coisas — não precisa ser o dono.
- Se a mensagem for sobre NF, contabilidade, impostos, ou mencionarem "escritório", "contabilidade", "Ana", "Marçal", "nota" — é pra você, responda
- Se for conversa interna do cliente (ex: "João, manda aquele relatório", "bom dia pessoal") — fica em silêncio, NÃO responde, e inclua [ACAO:IGNORAR]
- Na dúvida se é pra você, fica quieta. Melhor não responder do que se intrometer

O QUE A ANA FAZ:

1. *Emissão de Nota Fiscal* (o principal)
   Quando pedem pra emitir NF, você precisa de:
   - *Valor* do serviço (obrigatório)
   - *Tomador* — pra quem é a NF (obrigatório — nome ou CNPJ)
   - *Descrição do serviço* (se não disser, pergunta de forma natural)
   - *Competência/mês* (se não disser, assume o mês atual)

   Se o cliente já mandou tudo, confirma antes de emitir:
   "Vou emitir: *R$ 3.000,00* pra *Empresa XYZ*, serviço de consultoria, competência abril/2026. Tá certinho?"

   Se faltar informação, puxa de forma natural:
   "Beleza! Pra quem é essa NF?" ou "Qual o valor do serviço?"
   NÃO pergunte tudo de uma vez — vai conversando, uma coisa de cada vez.

   Após o cliente confirmar, inclua: [ACAO:EMITIR_NF:valor|tomador|descricao|competencia]

   Se o tomador não estiver cadastrado, avisa que vai cadastrar e encaminha:
   "Esse tomador ainda não tá cadastrado aqui. Vou passar pro Thiago registrar e já emitimos, tá?"
   E inclua [ACAO:TRANSFERIR_HUMANO]

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

O QUE A ANA NUNCA FAZ:
- NUNCA inventa dados — se não tem a informação, diz que vai verificar
- NUNCA promete prazos específicos ("fica pronto amanhã", "até sexta tá feito")
- NUNCA fala sobre valores de honorários ou preços do escritório ("isso eu não sei te dizer, fala com o Thiago sobre valores")
- NUNCA dá conselho tributário complexo — se for algo além do básico, transfere: "Isso é melhor o Thiago te orientar, vou passar pra ele"
- NUNCA se identifica como IA, robô ou assistente virtual — ela é a Ana, da equipe
- NUNCA responde em formato de chatbot (menus, opções numeradas, "selecione uma opção")

QUANDO TRANSFERIR PRO THIAGO:
- Assuntos complexos de planejamento tributário
- Negociação de honorários/valores do escritório
- Reclamações ou insatisfações
- Tomador não cadastrado que precisa ser registrado
- Qualquer coisa que a Ana não tenha certeza

AÇÕES (inclua no final da resposta — o cliente não vê isso):
- [ACAO:EMITIR_NF:valor|tomador|descricao|competencia] — emitir NF após confirmação
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
              const partes = acao.parametro.split('|');
              const valor = parseFloat(partes[0]?.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
              const tomadorNome = partes[1]?.trim() || '';
              const descricao = partes[2]?.trim() || 'Serviços prestados';
              const competencia = partes[3]?.trim() || new Date().toISOString().slice(0, 7);

              // Tenta encontrar o tomador pelo nome ou CNPJ
              let tomador = null;
              if (tomadorNome) {
                tomador = db.prepare(`
                  SELECT id, razao_social, documento FROM tomadores
                  WHERE cliente_id = ? AND ativo = 1
                  AND (razao_social LIKE ? OR documento LIKE ?)
                  LIMIT 1
                `).get(contato.cliente_id, `%${tomadorNome}%`, `%${tomadorNome}%`);
              }

              if (tomador && valor > 0) {
                // Busca dados do cliente para alíquota
                const clienteData = db.prepare('SELECT codigo_servico, aliquota_iss FROM clientes WHERE id = ?').get(contato.cliente_id);

                // Cria NF com status pendente_emissao para emissão automática
                const result = db.prepare(`
                  INSERT INTO notas_fiscais (
                    cliente_id, tomador_id, valor_servico, descricao_servico,
                    data_competencia, status, codigo_servico, aliquota_iss,
                    created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, 'pendente_emissao', ?, ?, datetime('now'), datetime('now'))
                `).run(
                  contato.cliente_id,
                  tomador.id,
                  valor,
                  descricao,
                  competencia,
                  clienteData?.codigo_servico || '',
                  clienteData?.aliquota_iss || 0
                );

                console.log(`[WhatsApp] NF criada para emissão: ID ${result.lastInsertRowid}, R$ ${valor} para ${tomador.razao_social}`);

                // Tenta emitir automaticamente
                try {
                  const nfseService = require('./nfseNacionalService');
                  const notaCompleta = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(result.lastInsertRowid);
                  const clienteCompleto = db.prepare('SELECT * FROM clientes WHERE id = ?').get(contato.cliente_id);
                  const tomadorCompleto = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomador.id);

                  if (process.env.NFSE_SIMULACAO === 'true') {
                    // Modo simulação
                    db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, data_emissao = datetime(?) WHERE id = ?')
                      .run('emitida', `SIM-${Date.now()}`, new Date().toISOString(), result.lastInsertRowid);
                    console.log(`[WhatsApp] NF ${result.lastInsertRowid} emitida em modo simulação`);
                  } else {
                    // Emissão real via Portal Nacional
                    const resultado = await nfseService.emitirNFSe(notaCompleta, clienteCompleto, tomadorCompleto);
                    if (resultado.sucesso) {
                      db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, chave_acesso = ?, data_emissao = datetime(?) WHERE id = ?')
                        .run('emitida', resultado.numeroNfse, resultado.chaveAcesso, new Date().toISOString(), result.lastInsertRowid);
                      console.log(`[WhatsApp] NF ${result.lastInsertRowid} emitida com sucesso: ${resultado.numeroNfse}`);
                    } else {
                      db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                        .run('erro_emissao', resultado.erro, result.lastInsertRowid);
                      console.error(`[WhatsApp] Erro na emissão NF ${result.lastInsertRowid}: ${resultado.erro}`);
                    }
                  }
                } catch (emissaoErr) {
                  console.error(`[WhatsApp] Erro ao tentar emitir NF ${result.lastInsertRowid}:`, emissaoErr);
                  db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                    .run('erro_emissao', emissaoErr.message, result.lastInsertRowid);
                }
              } else {
                console.log(`[WhatsApp] NF não criada: tomador não encontrado (${tomadorNome}) ou valor inválido (${valor})`);
              }
            } catch (err) {
              console.error('[WhatsApp] Erro ao criar NF:', err);
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
