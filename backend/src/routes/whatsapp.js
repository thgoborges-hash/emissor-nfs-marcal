/**
 * Rotas do WhatsApp - Webhook e Gerenciamento
 */

const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio } = require('../middleware/auth');
const whatsappService = require('../services/whatsappService');
const agenteIA = require('../services/agenteIAService');

const router = express.Router();

// =====================================================
// WEBHOOK - Meta Cloud API
// =====================================================

// GET /api/whatsapp/webhook - Verificação do webhook (Meta)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === whatsappService.verifyToken) {
    console.log('[WhatsApp] Webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    console.warn('[WhatsApp] Falha na verificação do webhook');
    res.sendStatus(403);
  }
});

// POST /api/whatsapp/webhook - Receber mensagens
router.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente (Meta exige resposta rápida)
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;

        // Processa status de mensagens (entregue, lida, etc.)
        if (value.statuses) {
          for (const status of value.statuses) {
            processarStatus(status);
          }
        }

        // Processa mensagens recebidas
        if (value.messages) {
          for (const message of value.messages) {
            const contato = value.contacts?.[0];
            await processarMensagemRecebida(message, contato);
          }
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Erro ao processar webhook:', err);
  }
});

/**
 * Processa uma mensagem recebida
 */
async function processarMensagemRecebida(message, contatoWhatsapp) {
  const telefone = message.from;
  const nome = contatoWhatsapp?.profile?.name || '';
  const messageId = message.id;

  console.log(`[WhatsApp] Mensagem recebida de ${telefone} (${nome}): ${message.type}`);

  // Extrai texto da mensagem
  let texto = '';
  switch (message.type) {
    case 'text':
      texto = message.text?.body || '';
      break;
    case 'interactive':
      texto = message.interactive?.button_reply?.title ||
              message.interactive?.list_reply?.title || '';
      break;
    case 'image':
      texto = message.image?.caption || '[Imagem recebida]';
      break;
    case 'document':
      texto = message.document?.caption || '[Documento recebido]';
      break;
    case 'audio':
      texto = '[Áudio recebido]';
      break;
    default:
      texto = `[${message.type} recebido]`;
  }

  if (!texto) return;

  // Atualiza nome do contato se disponível
  const db = getDb();
  if (nome) {
    db.prepare(`
      INSERT INTO whatsapp_contatos (telefone, nome)
      VALUES (?, ?)
      ON CONFLICT(telefone) DO UPDATE SET nome = ?, updated_at = CURRENT_TIMESTAMP
    `).run(telefone, nome, nome);
  }

  // Salva mensagem de entrada
  const conversaId = whatsappService.salvarMensagem(telefone, 'entrada', message.type, texto, messageId, 'cliente');

  // Marca como lida
  try {
    await whatsappService.marcarComoLida(messageId);
  } catch (err) {
    console.error('[WhatsApp] Erro ao marcar como lida:', err);
  }

  // Verifica se a conversa está aguardando humano
  const conversa = db.prepare('SELECT status FROM whatsapp_conversas WHERE id = ?').get(conversaId);
  if (conversa?.status === 'aguardando_humano') {
    console.log(`[WhatsApp] Conversa ${conversaId} aguardando atendimento humano, ignorando bot`);
    return;
  }

  // Gera resposta com IA
  try {
    const respostaCompleta = await agenteIA.processarMensagem(telefone, texto, conversaId);
    const respostaLimpa = agenteIA.limparResposta(respostaCompleta);

    if (respostaLimpa) {
      await whatsappService.enviarTexto(telefone, respostaLimpa);
    }
  } catch (err) {
    console.error('[WhatsApp] Erro ao gerar resposta IA:', err);
    try {
      await whatsappService.enviarTexto(telefone,
        'Desculpe, estou com dificuldades técnicas. O escritório foi notificado e retornará em breve. 🙏'
      );
    } catch (e) {
      console.error('[WhatsApp] Erro ao enviar mensagem de erro:', e);
    }
  }
}

/**
 * Processa atualização de status de mensagem
 */
function processarStatus(status) {
  const db = getDb();
  const statusMap = {
    'sent': 'enviada',
    'delivered': 'entregue',
    'read': 'lida',
    'failed': 'erro'
  };

  const novoStatus = statusMap[status.status] || status.status;

  db.prepare(`
    UPDATE whatsapp_mensagens SET status_envio = ? WHERE whatsapp_message_id = ?
  `).run(novoStatus, status.id);
}

// =====================================================
// API DE GERENCIAMENTO (escritório)
// =====================================================

// GET /api/whatsapp/conversas - Lista conversas
router.get('/conversas', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const { status, limite } = req.query;

    let query = `
      SELECT wconv.id, wconv.status, wconv.ultimo_mensagem_at, wconv.created_at,
             wcont.telefone, wcont.nome, wcont.tipo,
             c.razao_social, c.cnpj,
             (SELECT conteudo FROM whatsapp_mensagens WHERE conversa_id = wconv.id ORDER BY created_at DESC LIMIT 1) as ultima_mensagem,
             (SELECT COUNT(*) FROM whatsapp_mensagens WHERE conversa_id = wconv.id AND direcao = 'entrada' AND status_envio != 'lida') as nao_lidas
      FROM whatsapp_conversas wconv
      JOIN whatsapp_contatos wcont ON wconv.contato_id = wcont.id
      LEFT JOIN clientes c ON wcont.cliente_id = c.id
    `;

    const params = [];
    if (status) {
      query += ' WHERE wconv.status = ?';
      params.push(status);
    }

    query += ' ORDER BY wconv.ultimo_mensagem_at DESC LIMIT ?';
    params.push(parseInt(limite) || 50);

    const conversas = db.prepare(query).all(...params);
    res.json(conversas);
  } catch (err) {
    console.error('Erro ao listar conversas:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/whatsapp/conversas/:id/mensagens - Mensagens de uma conversa
router.get('/conversas/:id/mensagens', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const conversaId = parseInt(req.params.id);

    const mensagens = db.prepare(`
      SELECT id, direcao, tipo, conteudo, remetente, status_envio, created_at
      FROM whatsapp_mensagens
      WHERE conversa_id = ?
      ORDER BY created_at ASC
    `).all(conversaId);

    res.json(mensagens);
  } catch (err) {
    console.error('Erro ao listar mensagens:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// POST /api/whatsapp/conversas/:id/responder - Enviar mensagem humana
router.post('/conversas/:id/responder', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const db = getDb();
    const conversaId = parseInt(req.params.id);
    const { mensagem } = req.body;

    if (!mensagem) {
      return res.status(400).json({ erro: 'Mensagem é obrigatória' });
    }

    // Busca telefone do contato
    const conversa = db.prepare(`
      SELECT wconv.id, wcont.telefone
      FROM whatsapp_conversas wconv
      JOIN whatsapp_contatos wcont ON wconv.contato_id = wcont.id
      WHERE wconv.id = ?
    `).get(conversaId);

    if (!conversa) {
      return res.status(404).json({ erro: 'Conversa não encontrada' });
    }

    // Envia mensagem via WhatsApp
    await whatsappService.enviarTexto(conversa.telefone, mensagem);

    // Salva como mensagem do humano
    db.prepare(`
      INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, conteudo, remetente)
      VALUES (?, 'saida', 'texto', ?, 'humano')
    `).run(conversaId, mensagem);

    res.json({ mensagem: 'Mensagem enviada com sucesso' });
  } catch (err) {
    console.error('Erro ao enviar resposta:', err);
    res.status(500).json({ erro: 'Erro ao enviar mensagem' });
  }
});

// PUT /api/whatsapp/conversas/:id/transferir - Transferir para humano
router.put('/conversas/:id/transferir', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const conversaId = parseInt(req.params.id);

    db.prepare('UPDATE whatsapp_conversas SET status = ?, atendente_id = ? WHERE id = ?')
      .run('aguardando_humano', req.usuario.id, conversaId);

    res.json({ mensagem: 'Conversa transferida para atendimento humano' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao transferir conversa' });
  }
});

// PUT /api/whatsapp/conversas/:id/devolver-bot - Devolver para o bot
router.put('/conversas/:id/devolver-bot', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const conversaId = parseInt(req.params.id);

    db.prepare('UPDATE whatsapp_conversas SET status = ?, atendente_id = NULL WHERE id = ?')
      .run('ativa', conversaId);

    res.json({ mensagem: 'Conversa devolvida para o bot' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao devolver conversa' });
  }
});

// GET /api/whatsapp/status - Status do serviço
router.get('/status', autenticado, apenasEscritorio, (req, res) => {
  res.json({
    whatsapp_configurado: whatsappService.isConfigured(),
    ia_configurada: agenteIA.isConfigured(),
    webhook_url: `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`
  });
});

// POST /api/whatsapp/enviar - Enviar mensagem avulsa (escritório)
router.post('/enviar', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const { telefone, mensagem } = req.body;

    if (!telefone || !mensagem) {
      return res.status(400).json({ erro: 'Telefone e mensagem são obrigatórios' });
    }

    if (!whatsappService.isConfigured()) {
      return res.status(503).json({ erro: 'WhatsApp não configurado. Configure WHATSAPP_PHONE_ID e WHATSAPP_TOKEN nas variáveis de ambiente.' });
    }

    await whatsappService.enviarTexto(telefone, mensagem);
    res.json({ mensagem: 'Mensagem enviada com sucesso' });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ erro: err.message || 'Erro ao enviar mensagem' });
  }
});

// =====================================================
// TESTE DO AGENTE IA (sem precisar de WhatsApp)
// =====================================================

// GET /api/whatsapp/agente/status - Verifica status do agente IA e WhatsApp
router.get('/agente/status', autenticado, (req, res) => {
  res.json({
    agente_ia: {
      configurado: agenteIA.isConfigured(),
      modelo: agenteIA.modelo || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    },
    whatsapp: {
      configurado: whatsappService.isConfigured(),
      verify_token_configurado: !!whatsappService.verifyToken,
      webhook_url: `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`,
    },
  });
});

// POST /api/whatsapp/agente/testar - Testa o agente IA com uma mensagem simulada
router.post('/agente/testar', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const { mensagem, cliente_id, historico } = req.body;

    if (!mensagem) {
      return res.status(400).json({ erro: 'Mensagem é obrigatória' });
    }

    if (!agenteIA.isConfigured()) {
      return res.status(503).json({ erro: 'Agente IA não configurado. Configure ANTHROPIC_API_KEY nas variáveis de ambiente.' });
    }

    // Monta contexto simulado
    let contato = { telefone: '5541999999999', nome: 'Teste' };
    let dadosCliente = null;

    if (cliente_id) {
      const db = getDb();
      const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(parseInt(cliente_id));
      if (cliente) {
        contato.cliente_id = cliente.id;
        contato.razao_social = cliente.razao_social;
        contato.nome_fantasia = cliente.nome_fantasia;
        contato.cnpj = cliente.cnpj;
        dadosCliente = agenteIA.buscarDadosCliente(cliente.id);
      }
    }

    // Monta system prompt
    const systemPrompt = agenteIA.montarSystemPrompt(contato, dadosCliente);

    // Monta mensagens (histórico + mensagem atual)
    const messages = [];
    if (historico && Array.isArray(historico)) {
      for (const h of historico) {
        messages.push({
          role: h.role || (h.direcao === 'entrada' ? 'user' : 'assistant'),
          content: h.content || h.conteudo
        });
      }
    }
    messages.push({ role: 'user', content: mensagem });

    // Chama Claude
    const inicio = Date.now();
    const respostaRaw = await agenteIA.chamarClaude(systemPrompt, messages);
    const tempoMs = Date.now() - inicio;

    // Extrai ações e limpa resposta
    const acoes = agenteIA.extrairAcoes(respostaRaw);
    const respostaLimpa = agenteIA.limparResposta(respostaRaw);

    res.json({
      resposta: respostaLimpa,
      resposta_raw: respostaRaw,
      acoes,
      tempo_ms: tempoMs,
      modelo: agenteIA.modelo,
      cliente_id: cliente_id || null,
      system_prompt_preview: systemPrompt.substring(0, 500) + '...',
    });
  } catch (err) {
    console.error('Erro ao testar agente:', err);
    res.status(500).json({ erro: err.message || 'Erro ao testar agente IA' });
  }
});

module.exports = router;
