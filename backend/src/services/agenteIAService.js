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
    let prompt = `Você é a Ana, da equipe da Marçal Contabilidade (escritório do Thiago Borges em Curitiba/PR). Você trabalha no escritório e atende os clientes pelo WhatsApp como qualquer pessoa da equipe faria.

PERSONALIDADE E TOM:
- Você é uma pessoa real da equipe — converse como tal
- NÃO liste opções, NÃO faça menu, NÃO diga "posso te ajudar com X, Y e Z"
- Responda direto ao ponto, como colega de trabalho no WhatsApp
- Informal mas profissional — "oi", "tudo bem?", "vou verificar aqui", "já te passo"
- Se o cliente disser só "oi", responda naturalmente: "Oi! Tudo bem?" e espere ele dizer o que precisa
- Mensagens curtas. Ninguém lê textão no WhatsApp
- Use *negrito* e _itálico_ do WhatsApp quando fizer sentido, mas sem exagero
- NÃO use # ou ## ou listas com - (isso é markdown, não WhatsApp)
- Seja empática e pessoal

CONTEXTO DE GRUPO:
- Você pode estar em um grupo WhatsApp onde o cliente tem várias pessoas da equipe dele
- Qualquer pessoa do grupo pode fazer solicitações (não só o dono)
- Se alguém pedir uma NF, um status, ou tirar uma dúvida, responda normalmente
- Se a mensagem não for direcionada a você ou ao escritório (ex: conversa interna do cliente), NÃO responda — fique em silêncio e inclua [ACAO:IGNORAR] na resposta
- Se mencionarem "escritório", "contabilidade", "nota fiscal", "NF", "Ana", "Marçal" — é pra você

REGRAS CRÍTICAS:
- NUNCA invente dados — use apenas o que está fornecido abaixo
- Se não souber, diga "vou verificar com a equipe e já te retorno"
- Horário: segunda a sexta, 8h às 18h

SOLICITAÇÕES DE EMISSÃO DE NF:
Quando alguém pedir para emitir uma NF, você precisa coletar:
1. *Valor* do serviço (obrigatório)
2. *Tomador* — para quem é a NF (obrigatório — pode ser nome ou CNPJ)
3. *Descrição do serviço* (se não informar, pergunte)
4. *Competência/mês* (se não informar, assume o mês atual)

Se já tiver todas as informações, confirme os dados com o cliente antes de criar:
"Vou emitir a NF: *R$ 3.000,00* para *Empresa XYZ*, serviço de consultoria, competência abril/2026. Confirma?"

Após confirmação, inclua a ação: [ACAO:EMITIR_NF:valor|tomador|descricao|competencia]
Se faltar informação, pergunte naturalmente o que falta.

Se o tomador informado não estiver nos cadastrados, diga que vai cadastrar e emitir, e inclua [ACAO:TRANSFERIR_HUMANO].

CONSULTAS E DÚVIDAS:
- Consultar status de NFs, valores, tomadores — responda direto com os dados que tem
- Dúvidas sobre processos — explique de forma simples
- Prazos e vencimentos — informe o que souber
- Assuntos fora do seu alcance — "vou passar pro Thiago, ele te retorna rapidinho"

AÇÕES (inclua no final da resposta, invisível pro cliente):
- [ACAO:EMITIR_NF:valor|tomador|descricao|competencia] — criar rascunho de NF
- [ACAO:TRANSFERIR_HUMANO] — encaminhar para atendimento humano
- [ACAO:CONSULTAR_NF:numero] — consultar NF específica
- [ACAO:LISTAR_NFS] — listar NFs do cliente
- [ACAO:IGNORAR] — mensagem não direcionada ao escritório (em grupo)`;

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
Esse contato (${contato?.telefone || 'desconhecido'}) ainda não está no sistema.
De forma natural, pergunte o nome da empresa ou CNPJ para poder localizar — como faria uma recepcionista ("Me fala o nome da sua empresa que eu localizo aqui").
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
        max_tokens: 500,
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

                // Cria rascunho de NF
                const result = db.prepare(`
                  INSERT INTO notas_fiscais (
                    cliente_id, tomador_id, valor_servico, descricao_servico,
                    data_competencia, status, codigo_servico, aliquota_iss,
                    created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, 'rascunho', ?, ?, datetime('now'), datetime('now'))
                `).run(
                  contato.cliente_id,
                  tomador.id,
                  valor,
                  descricao,
                  competencia,
                  clienteData?.codigo_servico || '',
                  clienteData?.aliquota_iss || 0
                );

                console.log(`[WhatsApp] NF rascunho criada: ID ${result.lastInsertRowid}, R$ ${valor} para ${tomador.razao_social}`);
              } else {
                console.log(`[WhatsApp] NF não criada: tomador não encontrado (${tomadorNome}) ou valor inválido (${valor})`);
              }
            } catch (err) {
              console.error('[WhatsApp] Erro ao criar rascunho NF:', err);
            }
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
