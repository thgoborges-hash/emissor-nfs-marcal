/**
 * Rotas do WhatsApp - Webhook e Gerenciamento
 * Suporta Meta Cloud API e Blip (BSP)
 */

const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio } = require('../middleware/auth');
const whatsappService = require('../services/whatsappService');
const agenteIA = require('../services/agenteIAService');

// Detecta qual provider usar: 'blip' ou 'meta' (padrão)
const WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || 'meta';
let blipService = null;
if (WHATSAPP_PROVIDER === 'blip') {
  blipService = require('../services/blipService');
  console.log('[WhatsApp] Provider: Blip (BSP)');
} else {
  console.log('[WhatsApp] Provider: Meta Cloud API');
}

// Helper: retorna o serviço ativo (Blip ou Meta)
function getActiveService() {
  return WHATSAPP_PROVIDER === 'blip' ? blipService : whatsappService;
}

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

// =====================================================
// WEBHOOK - Blip (BSP)
// =====================================================

// POST /api/whatsapp/webhook/blip - Receber mensagens da Blip
router.post('/webhook/blip', async (req, res) => {
  // Responde 200 imediatamente (Blip exige resposta rápida)
  res.sendStatus(200);

  try {
    const body = req.body;

    // Blip envia mensagens no formato LIME
    // type: "text/plain" para texto, content: "mensagem"
    // from: "5541999999999@wa.gw.msging.net"
    if (!body || !body.type || !body.content || !body.from) {
      // Pode ser uma notificação (evento) — ignora
      if (body?.event) {
        console.log(`[Blip] Notificação recebida: ${body.event} de ${body.from}`);
        return;
      }
      console.log('[Blip] Mensagem sem campos obrigatórios, ignorando');
      return;
    }

    console.log(`[Blip] Mensagem recebida: type=${body.type}, from=${body.from}`);

    // Extrai telefone do endereço LIME
    const telefone = body.from.split('@')[0].replace(/\D/g, '');
    const messageId = body.id || '';

    // Extrai texto baseado no tipo LIME
    let texto = '';
    switch (body.type) {
      case 'text/plain':
        texto = body.content || '';
        break;
      case 'application/vnd.lime.media-link+json':
        texto = body.content?.text || body.content?.title || '[Mídia recebida]';
        break;
      case 'application/vnd.lime.document-select+json':
      case 'application/vnd.lime.select+json':
        texto = body.content?.text || body.content?.header?.value || '[Seleção]';
        break;
      case 'application/vnd.lime.reply+json':
        texto = body.content?.replied?.value || body.content?.inReplyTo?.value || '[Resposta]';
        break;
      default:
        texto = typeof body.content === 'string' ? body.content : `[${body.type}]`;
    }

    if (!texto) return;

    // Atualiza contato
    const db = getDb();
    const nome = body.metadata?.['#contactName'] || body.metadata?.contactName || '';
    if (nome) {
      db.prepare(`
        INSERT INTO whatsapp_contatos (telefone, nome)
        VALUES (?, ?)
        ON CONFLICT(telefone) DO UPDATE SET nome = ?, updated_at = CURRENT_TIMESTAMP
      `).run(telefone, nome, nome);
    }

    // Salva mensagem de entrada
    const service = getActiveService();
    const conversaId = service.salvarMensagem(telefone, 'entrada', 'texto', texto, messageId, 'cliente');

    // Marca como lida
    if (blipService) {
      try {
        await blipService.marcarComoLida(messageId, body.from);
      } catch (err) {
        console.error('[Blip] Erro ao marcar como lida:', err);
      }
    }

    // Verifica se a conversa está aguardando humano
    const conversa = db.prepare('SELECT status FROM whatsapp_conversas WHERE id = ?').get(conversaId);
    if (conversa?.status === 'aguardando_humano') {
      console.log(`[Blip] Conversa ${conversaId} aguardando atendimento humano, ignorando bot`);
      return;
    }

    // Gera resposta com IA
    try {
      const respostaCompleta = await agenteIA.processarMensagem(telefone, texto, conversaId);
      const respostaLimpa = agenteIA.limparResposta(respostaCompleta);

      if (respostaLimpa && blipService) {
        await blipService.enviarTexto(telefone, respostaLimpa);
      }
    } catch (err) {
      console.error('[Blip] Erro ao gerar resposta IA:', err);
      try {
        if (blipService) {
          await blipService.enviarTexto(telefone,
            'Desculpe, estou com dificuldades técnicas. O escritório foi notificado e retornará em breve. 🙏'
          );
        }
      } catch (e) {
        console.error('[Blip] Erro ao enviar mensagem de erro:', e);
      }
    }
  } catch (err) {
    console.error('[Blip] Erro ao processar webhook:', err);
  }
});

// =====================================================
// PROCESSAMENTO COMUM
// =====================================================

/**
 * Processa uma mensagem recebida (Meta Cloud API)
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
      await getActiveService().enviarTexto(telefone, respostaLimpa);
    }
  } catch (err) {
    console.error('[WhatsApp] Erro ao gerar resposta IA:', err);
    try {
      await getActiveService().enviarTexto(telefone,
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
    await getActiveService().enviarTexto(conversa.telefone, mensagem);

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
  const provider = WHATSAPP_PROVIDER;
  const service = getActiveService();
  res.json({
    provider,
    whatsapp_configurado: service.isConfigured(),
    ia_configurada: agenteIA.isConfigured(),
    webhook_url: provider === 'blip'
      ? `${req.protocol}://${req.get('host')}/api/whatsapp/webhook/blip`
      : `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`
  });
});

// POST /api/whatsapp/enviar - Enviar mensagem avulsa (escritório)
router.post('/enviar', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const { telefone, mensagem } = req.body;

    if (!telefone || !mensagem) {
      return res.status(400).json({ erro: 'Telefone e mensagem são obrigatórios' });
    }

    const service = getActiveService();
    if (!service.isConfigured()) {
      return res.status(503).json({ erro: WHATSAPP_PROVIDER === 'blip'
        ? 'Blip não configurado. Configure BLIP_API_KEY nas variáveis de ambiente.'
        : 'WhatsApp não configurado. Configure WHATSAPP_PHONE_ID e WHATSAPP_TOKEN nas variáveis de ambiente.'
      });
    }

    await getActiveService().enviarTexto(telefone, mensagem);
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
      provider: WHATSAPP_PROVIDER,
      configurado: getActiveService().isConfigured(),
      webhook_url: WHATSAPP_PROVIDER === 'blip'
        ? `${req.protocol}://${req.get('host')}/api/whatsapp/webhook/blip`
        : `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`,
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
    let respostaFinal = respostaRaw;

    // Executa as ações de verdade (para testar o fluxo completo)
    if (acoes.length > 0) {
      try {
        await agenteIA.executarAcoes(acoes, contato, null);

        // Verifica feedback de emissão
        const feedbackEmissao = acoes.find(a => a.tipo === 'EMITIR_NF' && a.feedback);
        if (feedbackEmissao?.feedback) {
          const fb = feedbackEmissao.feedback;
          let feedbackMsg = '';
          if (fb.sucesso) {
            feedbackMsg = `\n\n✅ *NF emitida com sucesso!*\nNúmero: ${fb.numero}\nValor: R$ ${fb.valor?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\nTomador: ${fb.tomador}`;
          } else if (fb.status === 'erro_emissao' || fb.erro) {
            // Mensagem amigável - detalhes técnicos só no log
            feedbackMsg = `\n\n✅ Sua solicitação foi registrada! Estou verificando alguns dados cadastrais e o Thiago vai confirmar a emissão em breve.`;
            console.log(`[Teste] Erro técnico (oculto do cliente): ${fb.numero || fb.erro || 'erro desconhecido'}`);
          }
          if (feedbackMsg) {
            respostaFinal = respostaRaw.replace(/\[ACAO:[^\]]+\]/g, '').trim() + feedbackMsg;
          }
        }
      } catch (acaoErr) {
        console.error('[Teste] Erro ao executar ações:', acaoErr);
      }
    }

    const respostaLimpa = agenteIA.limparResposta(respostaFinal);

    res.json({
      resposta: respostaLimpa,
      resposta_raw: respostaRaw,
      acoes,
      acoes_feedback: acoes.filter(a => a.feedback).map(a => a.feedback),
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

// =====================================================
// CRÉDITOS / USO DA API ANTHROPIC
// =====================================================

// GET /api/whatsapp/agente/creditos - Consulta uso e custos da API Anthropic
router.get('/agente/creditos', autenticado, apenasEscritorio, async (req, res) => {
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey) {
    return res.json({
      configurado: false,
      mensagem: 'Configure ANTHROPIC_ADMIN_API_KEY nas variáveis de ambiente do Render para ver os créditos.',
      instrucoes: 'Acesse console.anthropic.com → Settings → Admin Keys → Create Admin Key'
    });
  }

  try {
    const https = require('https');

    // Período: últimos 30 dias
    const agora = new Date();
    const inicio = new Date(agora);
    inicio.setDate(inicio.getDate() - 30);

    const startingAt = inicio.toISOString().split('.')[0] + 'Z';
    const endingAt = agora.toISOString().split('.')[0] + 'Z';

    // Consulta custos agrupados por dia
    const custoUrl = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startingAt}&ending_at=${endingAt}&bucket_width=1d`;

    const dadosCusto = await new Promise((resolve, reject) => {
      const req = https.get(custoUrl, {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': adminKey,
          'User-Agent': 'EmissorMarcal/1.0',
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              resolve(JSON.parse(data));
            } else {
              console.error(`[Anthropic] Cost API retornou ${res.statusCode}: ${data.substring(0, 300)}`);
              reject(new Error(`API retornou status ${res.statusCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });

    // Consulta uso por modelo (últimos 30 dias)
    const usoUrl = `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${startingAt}&ending_at=${endingAt}&group_by[]=model&bucket_width=1d`;

    const dadosUso = await new Promise((resolve, reject) => {
      const req = https.get(usoUrl, {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': adminKey,
          'User-Agent': 'EmissorMarcal/1.0',
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              resolve(JSON.parse(data));
            } else {
              resolve(null); // Não bloqueia se uso falhar
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });

    // Calcula total gasto nos últimos 30 dias
    let totalGasto30d = 0;
    let gastoHoje = 0;
    let gastoPorDia = [];

    if (dadosCusto && dadosCusto.data) {
      for (const bucket of dadosCusto.data) {
        const custoTotal = parseFloat(bucket.cost_cents || 0) / 100; // cents to dollars
        totalGasto30d += custoTotal;
        gastoPorDia.push({
          data: bucket.bucket_start_time,
          custo_usd: custoTotal,
        });
      }
      // Último dia = hoje
      if (gastoPorDia.length > 0) {
        gastoHoje = gastoPorDia[gastoPorDia.length - 1].custo_usd;
      }
    }

    // Calcula tokens por modelo
    let tokensPorModelo = {};
    if (dadosUso && dadosUso.data) {
      for (const bucket of dadosUso.data) {
        const modelo = bucket.model || 'desconhecido';
        if (!tokensPorModelo[modelo]) {
          tokensPorModelo[modelo] = { input: 0, output: 0, cached: 0 };
        }
        tokensPorModelo[modelo].input += bucket.input_tokens || 0;
        tokensPorModelo[modelo].output += bucket.output_tokens || 0;
        tokensPorModelo[modelo].cached += bucket.input_cached_tokens || 0;
      }
    }

    res.json({
      configurado: true,
      periodo: { inicio: startingAt, fim: endingAt },
      custos: {
        total_30d_usd: totalGasto30d.toFixed(2),
        hoje_usd: gastoHoje.toFixed(2),
        por_dia: gastoPorDia.slice(-7), // Últimos 7 dias
      },
      uso: {
        por_modelo: tokensPorModelo,
      },
      link_console: 'https://console.anthropic.com/settings/billing',
    });

  } catch (err) {
    console.error('[Anthropic] Erro ao consultar créditos:', err.message);
    res.status(500).json({
      configurado: true,
      erro: 'Não foi possível consultar a API Anthropic. Verifique a Admin API Key.',
      detalhes: err.message,
    });
  }
});

module.exports = router;
