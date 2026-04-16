/**
 * Rotas do WhatsApp - Webhook e Gerenciamento
 * Suporta Meta Cloud API, Blip (BSP), Evolution API e Z-API (não-oficiais com grupos)
 */

const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio, gerarToken } = require('../middleware/auth');
const whatsappService = require('../services/whatsappService');
const agenteIA = require('../services/agenteIAService');
const horarioComercial = require('../services/horarioComercialService');

// Detecta qual provider usar: 'zapi', 'evolution', 'blip' ou 'meta' (padrão)
const WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || 'meta';
let blipService = null;
let evolutionService = null;
let zapiService = null;

// ============================================================
// WHITELIST DE DESTINOS (modo piloto)
// ============================================================
// Quando setada, a ANA SÓ responde pra esses destinos (grupos ou privados).
// Útil no rollout inicial pra testar comportamento num grupo interno antes
// de liberar pros 80+ grupos de clientes.
//
// Formato: string separada por vírgula, aceita:
//   - IDs de grupo com ou sem sufixo (ex: "120363025552242228" ou "120363025552242228@g.us")
//   - Telefones internacionais (ex: "5541999999999")
//
// Exemplo:
//   ANA_WHITELIST=120363025552242228@g.us,5541999999999
//
// Se vazio/ausente, não há filtro — ANA responde normalmente em todo lugar.
const ANA_WHITELIST_RAW = process.env.ANA_WHITELIST || '';
const ANA_WHITELIST = ANA_WHITELIST_RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    // Normaliza: remove não-dígitos pra privado, mantém @g.us pra grupo
    if (s.endsWith('@g.us')) return s;
    const limpo = s.replace(/\D/g, '');
    // Grupo: >15 dígitos → adiciona @g.us
    if (limpo.length > 15) return `${limpo}@g.us`;
    // Privado: só os dígitos (já normalizado pelos services)
    return limpo;
  });

if (ANA_WHITELIST.length > 0) {
  console.log(`[WhatsApp] ⚠️  Modo PILOTO ativo — ANA só responde para: ${ANA_WHITELIST.join(', ')}`);
}

/**
 * Verifica se um destino está na whitelist (ou se whitelist está desativada)
 * @param {string} chave - Chave de armazenamento (telefone ou JID de grupo com @g.us)
 * @returns {boolean} true se permitido
 */
function destinoPermitido(chave) {
  if (ANA_WHITELIST.length === 0) return true; // Sem whitelist = libera geral
  if (!chave) return false;
  // Normaliza pra comparação: Z-API usa "-group" no ID, Evolution não.
  // Extraímos só os dígitos pra garantir match independente do sufixo.
  const normalizar = (s) => s.replace(/-group/g, '').replace(/@g\.us$/, '').replace(/\D/g, '');
  const chaveNorm = normalizar(chave);
  return ANA_WHITELIST.some(w => normalizar(w) === chaveNorm);
}

if (WHATSAPP_PROVIDER === 'blip') {
  blipService = require('../services/blipService');
  console.log('[WhatsApp] Provider: Blip (BSP)');
} else if (WHATSAPP_PROVIDER === 'evolution') {
  evolutionService = require('../services/evolutionService');
  console.log('[WhatsApp] Provider: Evolution API (suporta grupos)');
} else if (WHATSAPP_PROVIDER === 'zapi') {
  zapiService = require('../services/zapiService');
  console.log('[WhatsApp] Provider: Z-API (suporta grupos)');
} else {
  console.log('[WhatsApp] Provider: Meta Cloud API');
}

// Helper: retorna o serviço ativo
function getActiveService() {
  if (WHATSAPP_PROVIDER === 'blip') return blipService;
  if (WHATSAPP_PROVIDER === 'evolution') return evolutionService;
  if (WHATSAPP_PROVIDER === 'zapi') return zapiService;
  return whatsappService;
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

    // Horário comercial
    const checkHorario = horarioComercial.podeResponder({ isGroup: false, conversaId });
    if (!checkHorario.permitido) {
      console.log(`[Blip] Fora do horário comercial (${checkHorario.motivo}), não chamando IA`);
      if (checkHorario.mensagemAusencia && blipService) {
        try {
          await blipService.enviarTexto(telefone, checkHorario.mensagemAusencia);
          const ult = db
            .prepare(
              `SELECT id FROM whatsapp_mensagens
               WHERE conversa_id = ? AND direcao = 'saida' AND conteudo = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(conversaId, checkHorario.mensagemAusencia);
          if (ult) {
            db.prepare(`UPDATE whatsapp_mensagens SET remetente='sistema' WHERE id=?`).run(ult.id);
          }
        } catch (err) {
          console.error('[Blip] Erro ao enviar auto-resposta de ausência:', err);
        }
      }
      return;
    }

    // Gera resposta com IA
    try {
      const { texto: respostaCompleta } = await agenteIA.processarMensagem(telefone, texto, conversaId);
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
// WEBHOOK - Evolution API (não-oficial, com suporte a grupos)
// =====================================================

// POST /api/whatsapp/webhook/evolution - Recebe eventos da Evolution API
// Configurar na Evolution: POST https://<evolution>/webhook/set/<instance>
//   body: { url: "<render_url>/api/whatsapp/webhook/evolution", events: ["MESSAGES_UPSERT"] }
router.post('/webhook/evolution', async (req, res) => {
  // Responde 200 imediatamente
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body) return;

    // Evolution envia vários tipos de eventos. Só tratamos mensagens recebidas.
    const eventName = body.event || body.eventName;
    // Aceita 'messages.upsert' (snake) ou 'MESSAGES_UPSERT'
    const isMessageUpsert = eventName === 'messages.upsert' || eventName === 'MESSAGES_UPSERT';
    if (!isMessageUpsert) {
      // Outros eventos (connection.update, presence.update, etc.) — ignora silenciosamente
      return;
    }

    // Dados da mensagem podem vir em body.data ou direto em body
    const data = body.data || body;

    // Evolution pode mandar uma mensagem só (objeto) ou várias (array)
    const mensagens = Array.isArray(data) ? data : (Array.isArray(data.messages) ? data.messages : [data]);

    for (const msg of mensagens) {
      await processarMensagemEvolution(msg, body.instance);
    }
  } catch (err) {
    console.error('[Evolution] Erro ao processar webhook:', err);
  }
});

/**
 * Processa uma mensagem individual vinda do webhook da Evolution API
 */
async function processarMensagemEvolution(msg, instance) {
  if (!evolutionService) {
    console.warn('[Evolution] Recebi webhook mas provider não é evolution. Ignorando.');
    return;
  }

  // Estrutura esperada (baileys-style):
  // {
  //   key: { remoteJid: "...@s.whatsapp.net" | "...@g.us", fromMe: false, id: "...", participant: "...@s.whatsapp.net" (só grupo) },
  //   message: { conversation: "texto" } | { extendedTextMessage: { text: "texto" } } | { imageMessage: {...} } | ...
  //   pushName: "Nome do remetente",
  //   messageTimestamp: 1234567890
  // }
  const key = msg.key || {};
  const remoteJid = key.remoteJid;
  if (!remoteJid) {
    console.log('[Evolution] Mensagem sem remoteJid, ignorando');
    return;
  }

  // Ignora mensagens enviadas pelo próprio bot (fromMe = true)
  if (key.fromMe) {
    return;
  }

  // Ignora status broadcast
  if (remoteJid === 'status@broadcast') return;

  const isGroup = remoteJid.endsWith('@g.us');

  // WHITELIST: em modo piloto, ignora tudo que não esteja na lista
  const chaveTeste = isGroup
    ? remoteJid
    : evolutionService.extrairDestinoDoJid(remoteJid);
  if (!destinoPermitido(chaveTeste)) {
    console.log(`[Evolution] 🔒 Destino fora da whitelist, ignorando: ${chaveTeste}`);
    return;
  }

  const messageId = key.id || '';
  const participant = key.participant || remoteJid; // Quem enviou (em grupo, é diferente do grupo)
  const pushName = msg.pushName || '';

  // Extrai o texto da mensagem (Baileys suporta vários formatos)
  const message = msg.message || {};
  let texto = '';
  let tipoMsg = 'texto';

  if (message.conversation) {
    texto = message.conversation;
  } else if (message.extendedTextMessage?.text) {
    texto = message.extendedTextMessage.text;
  } else if (message.imageMessage) {
    texto = message.imageMessage.caption || '[Imagem recebida]';
    tipoMsg = 'imagem';
  } else if (message.videoMessage) {
    texto = message.videoMessage.caption || '[Vídeo recebido]';
    tipoMsg = 'video';
  } else if (message.documentMessage) {
    texto = message.documentMessage.caption || message.documentMessage.fileName || '[Documento recebido]';
    tipoMsg = 'documento';
  } else if (message.audioMessage) {
    texto = '[Áudio recebido]';
    tipoMsg = 'audio';
  } else if (message.stickerMessage) {
    texto = '[Figurinha]';
    tipoMsg = 'sticker';
  } else if (message.reactionMessage) {
    // Ignora reações — poluição
    return;
  } else if (message.buttonsResponseMessage) {
    texto = message.buttonsResponseMessage.selectedDisplayText || '[Resposta de botão]';
  } else if (message.listResponseMessage) {
    texto = message.listResponseMessage.title || message.listResponseMessage.singleSelectReply?.selectedRowId || '[Resposta de lista]';
  } else {
    // Tipo desconhecido — ignora ao invés de poluir o banco
    const tipos = Object.keys(message).join(',');
    console.log(`[Evolution] Tipo de mensagem não suportado: ${tipos}`);
    return;
  }

  if (!texto) return;

  // Chave de armazenamento: em grupo usamos o remoteJid do grupo; em privado usamos o número
  const chaveArmazenamento = isGroup
    ? remoteJid
    : evolutionService.extrairDestinoDoJid(remoteJid);

  // Atualiza nome do contato se disponível
  const db = getDb();
  if (pushName && !isGroup) {
    db.prepare(`
      INSERT INTO whatsapp_contatos (telefone, nome)
      VALUES (?, ?)
      ON CONFLICT(telefone) DO UPDATE SET nome = COALESCE(NULLIF(nome, ''), ?), updated_at = CURRENT_TIMESTAMP
    `).run(chaveArmazenamento, pushName, pushName);
  }

  // Em grupo, o "nome" do contato pode ser o nome do grupo (fica pra um futuro aprimoramento)
  // Por enquanto, registramos o group JID como contato tipo 'grupo'.

  // Salva mensagem de entrada
  // Prefixamos o texto com o pushName se for grupo, pra IA saber quem falou
  const textoComRemetente = isGroup && pushName
    ? `[${pushName}] ${texto}`
    : texto;

  const conversaId = evolutionService.salvarMensagem(
    chaveArmazenamento,
    'entrada',
    tipoMsg,
    textoComRemetente,
    messageId,
    'cliente'
  );

  console.log(`[Evolution] Mensagem recebida (${isGroup ? 'GRUPO' : 'privado'}) de ${pushName || chaveArmazenamento}: ${texto.substring(0, 80)}`);

  // Marca como lida (best-effort)
  try {
    await evolutionService.marcarComoLida(remoteJid, messageId, false);
  } catch (err) {
    // não crítico
  }

  // Verifica se a conversa está aguardando humano
  const conversa = db.prepare('SELECT status FROM whatsapp_conversas WHERE id = ?').get(conversaId);
  if (conversa?.status === 'aguardando_humano') {
    console.log(`[Evolution] Conversa ${conversaId} aguardando atendimento humano, bot em silêncio`);
    return;
  }

  // Heurística extra pra grupos: só responde se for claramente pra ANA
  // O prompt da ANA já tem [ACAO:IGNORAR] pra mensagens que não são pra ela,
  // mas adicionamos um filtro barato antes de chamar a API pra não gastar tokens à toa
  if (isGroup && !mensagemEhParaAna(texto)) {
    console.log('[Evolution] Mensagem de grupo não parece ser pra ANA, ignorando sem chamar IA');
    return;
  }

  // Horário comercial: fora dele, ANA não responde automaticamente
  // (em grupo = silêncio total; em privado = auto-resposta de ausência 1x a cada 6h)
  const checkHorario = horarioComercial.podeResponder({ isGroup, conversaId });
  if (!checkHorario.permitido) {
    console.log(`[Evolution] Fora do horário comercial (${checkHorario.motivo}), não chamando IA`);
    if (checkHorario.mensagemAusencia && evolutionService) {
      try {
        await evolutionService.enviarTexto(remoteJid, checkHorario.mensagemAusencia);
        // A enviarTexto já salva a mensagem no banco, mas como 'bot'.
        // Reclassificamos como 'sistema' pra o rate-limit de autoRespondeuRecentemente funcionar.
        try {
          db.prepare(
            `UPDATE whatsapp_mensagens
               SET remetente = 'sistema'
             WHERE conversa_id = ?
               AND direcao = 'saida'
               AND conteudo = ?
             ORDER BY id DESC
             LIMIT 1`
          ).run(conversaId, checkHorario.mensagemAusencia);
        } catch (e) {
          // SQLite não suporta ORDER BY / LIMIT em UPDATE em versões antigas — fallback:
          const ult = db
            .prepare(
              `SELECT id FROM whatsapp_mensagens
               WHERE conversa_id = ? AND direcao = 'saida' AND conteudo = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(conversaId, checkHorario.mensagemAusencia);
          if (ult) {
            db.prepare(`UPDATE whatsapp_mensagens SET remetente='sistema' WHERE id=?`).run(ult.id);
          }
        }
      } catch (err) {
        console.error('[Evolution] Erro ao enviar auto-resposta de ausência:', err);
      }
    }
    return;
  }

  // Gera resposta com IA
  try {
    const { texto: respostaCompleta } = await agenteIA.processarMensagem(chaveArmazenamento, textoComRemetente, conversaId);

    // Se a IA decidiu ignorar, respeita
    if (/\[ACAO:IGNORAR\]/i.test(respostaCompleta)) {
      console.log('[Evolution] Agente IA marcou mensagem como IGNORAR');
      return;
    }

    const respostaLimpa = agenteIA.limparResposta(respostaCompleta);

    if (respostaLimpa && evolutionService) {
      await evolutionService.enviarTexto(remoteJid, respostaLimpa);
    }
  } catch (err) {
    console.error('[Evolution] Erro ao gerar resposta IA:', err);
    // Em grupo, evitamos mandar "desculpe, com dificuldades" pra não poluir
    if (!isGroup) {
      try {
        await evolutionService.enviarTexto(remoteJid,
          'Desculpe, estou com dificuldades técnicas. O escritório foi notificado e retornará em breve. 🙏'
        );
      } catch (e) {
        console.error('[Evolution] Erro ao enviar mensagem de erro:', e);
      }
    }
  }
}

/**
 * Heurística barata (sem IA) pra decidir se uma mensagem de grupo PARECE ser pra ANA.
 * Funciona como filtro antes de chamar a Claude API — economiza tokens em grupos movimentados.
 * A decisão final ainda é da IA (que pode marcar [ACAO:IGNORAR] mesmo assim).
 */
function mensagemEhParaAna(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();

  // Menções diretas
  if (/@ana\b|\bana\b/.test(t)) return true;

  // Palavras-chave de NF/fiscal/escritório
  const keywords = [
    'nota fiscal', 'nota', 'nfs', 'nfse', 'nf-e', 'nfe', 'nf ',
    'emitir', 'emissão', 'emissao',
    'fiscal', 'imposto', 'das', 'darf', 'simples nacional',
    'contabilidade', 'contador', 'escritório', 'escritorio', 'marçal', 'marcal',
    'certidão', 'certidao', 'alvará', 'alvara',
    'boleto', 'guia', '2ª via', 'segunda via',
    'folha', 'pro-labore', 'prolabore', 'inss', 'fgts'
  ];

  return keywords.some(kw => t.includes(kw));
}

// =====================================================
// WEBHOOK - Z-API
// =====================================================

// POST /api/whatsapp/webhook/zapi - Recebe eventos da Z-API
// Configurar na Z-API: painel → Instância → Webhook "Ao receber"
//   url: "<render_url>/api/whatsapp/webhook/zapi"
router.post('/webhook/zapi', async (req, res) => {
  // Responde 200 imediatamente
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body) return;

    // Ignora mensagens enviadas pelo próprio bot
    if (body.fromMe) return;

    // Ignora mensagens de status (broadcast)
    if (body.isStatusReply) return;

    // Processa mensagem recebida
    await processarMensagemZapi(body);
  } catch (err) {
    console.error('[Z-API] Erro ao processar webhook:', err);
  }
});

/**
 * Processa uma mensagem individual vinda do webhook da Z-API
 *
 * Formato do payload (principais campos):
 *   {
 *     phone: "5541988888888" | "120363XXX-XXX",  // número OU groupId
 *     isGroup: true|false,
 *     participantPhone: "5541..."  // só em grupo
 *     senderName: "João",
 *     chatName: "Nome do grupo ou contato",
 *     messageId: "...",
 *     fromMe: false,
 *     text: { message: "..." },
 *     image: { imageUrl, caption, mimeType },
 *     document: { documentUrl, fileName, caption, mimeType },
 *     audio: { audioUrl, mimeType },
 *     video: { videoUrl, caption, mimeType },
 *     sticker: { stickerUrl },
 *     reaction: { value, referencedMessage },
 *     ...
 *   }
 */
async function processarMensagemZapi(body) {
  if (!zapiService) {
    console.warn('[Z-API] Recebi webhook mas provider não é zapi. Ignorando.');
    return;
  }

  const isGroup = !!body.isGroup;
  const phone = body.phone || '';
  if (!phone) {
    console.log('[Z-API] Mensagem sem phone, ignorando');
    return;
  }

  // WHITELIST: em modo piloto, ignora tudo que não esteja na lista
  // Comparação feita com a chave de armazenamento (grupo: com @g.us; privado: só dígitos)
  const chaveTeste = isGroup
    ? zapiService._garantirSufixoGrupo(phone)
    : zapiService.formatarTelefone(phone);
  if (!destinoPermitido(chaveTeste)) {
    console.log(`[Z-API] 🔒 Destino fora da whitelist, ignorando: ${chaveTeste}`);
    return;
  }

  const messageId = body.messageId || '';
  const pushName = body.senderName || body.chatName || '';

  // Extrai o texto da mensagem (Z-API tem vários tipos)
  let texto = '';
  let tipoMsg = 'texto';

  if (body.text?.message) {
    texto = body.text.message;
  } else if (body.image) {
    texto = body.image.caption || '[Imagem recebida]';
    tipoMsg = 'imagem';
  } else if (body.video) {
    texto = body.video.caption || '[Vídeo recebido]';
    tipoMsg = 'video';
  } else if (body.document) {
    texto = body.document.caption || body.document.fileName || '[Documento recebido]';
    tipoMsg = 'documento';
  } else if (body.audio) {
    texto = '[Áudio recebido]';
    tipoMsg = 'audio';
  } else if (body.sticker) {
    texto = '[Figurinha]';
    tipoMsg = 'sticker';
  } else if (body.reaction) {
    // Ignora reações — poluição
    return;
  } else if (body.buttonsResponseMessage) {
    texto = body.buttonsResponseMessage.buttonId || body.buttonsResponseMessage.message || '[Resposta de botão]';
  } else if (body.listResponseMessage) {
    texto = body.listResponseMessage.message || body.listResponseMessage.title || '[Resposta de lista]';
  } else if (body.contact) {
    texto = `[Contato: ${body.contact.displayName || body.contact.vCard || '?'}]`;
    tipoMsg = 'contato';
  } else if (body.location) {
    texto = `[Localização: ${body.location.latitude}, ${body.location.longitude}]`;
    tipoMsg = 'localizacao';
  } else {
    const tipos = Object.keys(body).filter(k =>
      !['phone','isGroup','fromMe','messageId','senderName','chatName','senderPhoto',
        'photo','momment','status','participantPhone','connectedPhone','instanceId',
        'type','broadcast','forwarded','waitingMessage','isStatusReply','chatLid',
        'participantLid','isEdit','isNewsletter','fromApi'].includes(k)
    ).join(',');
    console.log(`[Z-API] Tipo de mensagem não suportado: ${tipos}`);
    return;
  }

  if (!texto) return;

  // Chave de armazenamento: em grupo usamos o groupId com sufixo @g.us padronizado;
  // em privado, só dígitos.
  const chaveArmazenamento = isGroup
    ? zapiService._garantirSufixoGrupo(phone)
    : zapiService.formatarTelefone(phone);

  // Destino pra envio de resposta (mesma chave, o normalizarDestino remove @g.us depois)
  const destinoResposta = chaveArmazenamento;

  // Atualiza nome do contato se disponível
  const db = getDb();
  if (pushName && !isGroup) {
    db.prepare(`
      INSERT INTO whatsapp_contatos (telefone, nome)
      VALUES (?, ?)
      ON CONFLICT(telefone) DO UPDATE SET nome = COALESCE(NULLIF(nome, ''), ?), updated_at = CURRENT_TIMESTAMP
    `).run(chaveArmazenamento, pushName, pushName);
  }

  // Salva mensagem de entrada
  // Prefixamos o texto com o pushName se for grupo, pra IA saber quem falou
  const textoComRemetente = isGroup && pushName
    ? `[${pushName}] ${texto}`
    : texto;

  const conversaId = zapiService.salvarMensagem(
    chaveArmazenamento,
    'entrada',
    tipoMsg,
    textoComRemetente,
    messageId,
    'cliente'
  );

  console.log(`[Z-API] Mensagem recebida (${isGroup ? 'GRUPO' : 'privado'}) de ${pushName || chaveArmazenamento}: ${texto.substring(0, 80)}`);

  // Marca como lida (best-effort)
  try {
    await zapiService.marcarComoLida(destinoResposta, messageId, false);
  } catch (err) {
    // não crítico
  }

  // Verifica se a conversa está aguardando humano
  const conversa = db.prepare('SELECT status FROM whatsapp_conversas WHERE id = ?').get(conversaId);
  if (conversa?.status === 'aguardando_humano') {
    console.log(`[Z-API] Conversa ${conversaId} aguardando atendimento humano, bot em silêncio`);
    return;
  }

  // Heurística extra pra grupos: só responde se for claramente pra ANA
  if (isGroup && !mensagemEhParaAna(texto)) {
    console.log('[Z-API] Mensagem de grupo não parece ser pra ANA, ignorando sem chamar IA');
    return;
  }

  // Horário comercial: fora dele, ANA não responde automaticamente
  const checkHorario = horarioComercial.podeResponder({ isGroup, conversaId });
  if (!checkHorario.permitido) {
    console.log(`[Z-API] Fora do horário comercial (${checkHorario.motivo}), não chamando IA`);
    if (checkHorario.mensagemAusencia && zapiService) {
      try {
        await zapiService.enviarTexto(destinoResposta, checkHorario.mensagemAusencia);
        // Reclassifica como 'sistema' pra o rate-limit funcionar
        try {
          db.prepare(
            `UPDATE whatsapp_mensagens
               SET remetente = 'sistema'
             WHERE conversa_id = ?
               AND direcao = 'saida'
               AND conteudo = ?
             ORDER BY id DESC
             LIMIT 1`
          ).run(conversaId, checkHorario.mensagemAusencia);
        } catch (e) {
          const ult = db
            .prepare(
              `SELECT id FROM whatsapp_mensagens
               WHERE conversa_id = ? AND direcao = 'saida' AND conteudo = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(conversaId, checkHorario.mensagemAusencia);
          if (ult) {
            db.prepare(`UPDATE whatsapp_mensagens SET remetente='sistema' WHERE id=?`).run(ult.id);
          }
        }
      } catch (err) {
        console.error('[Z-API] Erro ao enviar auto-resposta de ausência:', err);
      }
    }
    return;
  }

  // Delay na primeira resposta: se a ANA nunca respondeu nessa conversa,
  // espera ~2 min pra parecer mais natural (como se tivesse lendo antes de responder)
  const jaRespondeu = db.prepare(
    `SELECT 1 FROM whatsapp_mensagens
     WHERE conversa_id = ? AND direcao = 'saida' AND remetente = 'bot'
     LIMIT 1`
  ).get(conversaId);

  if (!jaRespondeu) {
    const delayMs = 100_000 + Math.floor(Math.random() * 40_000); // 100–140s (~2 min)
    console.log(`[Z-API] ⏳ Primeira mensagem na conversa ${conversaId} — aguardando ${Math.round(delayMs / 1000)}s antes de responder`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  // Gera resposta com IA
  try {
    const { texto: respostaCompleta, acoes } = await agenteIA.processarMensagem(chaveArmazenamento, textoComRemetente, conversaId);

    // Se a IA decidiu ignorar, respeita
    if (/\[ACAO:IGNORAR\]/i.test(respostaCompleta)) {
      console.log('[Z-API] Agente IA marcou mensagem como IGNORAR');
      return;
    }

    const respostaLimpa = agenteIA.limparResposta(respostaCompleta);

    if (respostaLimpa && zapiService) {
      await zapiService.enviarTexto(destinoResposta, respostaLimpa);
    }

    // Se emitiu NF com sucesso, envia o DANFSe como documento
    if (acoes && acoes.length > 0) {
      const nfEmitida = acoes.find(a => a.tipo === 'EMITIR_NF' && a.feedback?.sucesso);
      if (nfEmitida && zapiService) {
        try {
          const nfId = nfEmitida.feedback.nfId;
          const numDisplay = nfEmitida.feedback.numero || nfId;

          // Gera token temporário (24h) para acesso ao DANFSe sem login
          const tokenTemp = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'danfse' });
          const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
          const linkDanfse = `${baseUrl}/api/notas-fiscais/${nfId}/danfse?token=${tokenTemp}`;

          console.log(`[Z-API] 📄 Enviando DANFSe da NF ${nfId} para ${destinoResposta}`);

          await zapiService.enviarDocumento(
            destinoResposta,
            linkDanfse,
            `DANFSe_NF_${numDisplay}.html`,
            '📄 DANFSe — Documento Auxiliar da NFS-e'
          );

          console.log(`[Z-API] ✅ DANFSe da NF ${nfId} enviado com sucesso`);
        } catch (danfseErr) {
          console.error('[Z-API] Erro ao enviar DANFSe:', danfseErr);
          // Não bloqueia o fluxo — a mensagem de texto já foi enviada
        }
      }
    }
  } catch (err) {
    console.error('[Z-API] Erro ao gerar resposta IA:', err);
    if (!isGroup) {
      try {
        await zapiService.enviarTexto(destinoResposta,
          'Desculpe, estou com dificuldades técnicas. O escritório foi notificado e retornará em breve. 🙏'
        );
      } catch (e) {
        console.error('[Z-API] Erro ao enviar mensagem de erro:', e);
      }
    }
  }
}

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

  // Horário comercial: fora dele, ANA manda auto-resposta 1x a cada 6h
  // (Meta Cloud API não tem grupos, então isGroup é sempre false aqui)
  const checkHorario = horarioComercial.podeResponder({ isGroup: false, conversaId });
  if (!checkHorario.permitido) {
    console.log(`[WhatsApp] Fora do horário comercial (${checkHorario.motivo}), não chamando IA`);
    if (checkHorario.mensagemAusencia) {
      try {
        await getActiveService().enviarTexto(telefone, checkHorario.mensagemAusencia);
        const ult = db
          .prepare(
            `SELECT id FROM whatsapp_mensagens
             WHERE conversa_id = ? AND direcao = 'saida' AND conteudo = ?
             ORDER BY id DESC LIMIT 1`
          )
          .get(conversaId, checkHorario.mensagemAusencia);
        if (ult) {
          db.prepare(`UPDATE whatsapp_mensagens SET remetente='sistema' WHERE id=?`).run(ult.id);
        }
      } catch (err) {
        console.error('[WhatsApp] Erro ao enviar auto-resposta de ausência:', err);
      }
    }
    return;
  }

  // Gera resposta com IA
  try {
    const { texto: respostaCompleta } = await agenteIA.processarMensagem(telefone, texto, conversaId);
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

// Helper: retorna a URL do webhook correto para o provider ativo
function getWebhookUrl(req) {
  const base = `${req.protocol}://${req.get('host')}`;
  if (WHATSAPP_PROVIDER === 'blip') return `${base}/api/whatsapp/webhook/blip`;
  if (WHATSAPP_PROVIDER === 'evolution') return `${base}/api/whatsapp/webhook/evolution`;
  if (WHATSAPP_PROVIDER === 'zapi') return `${base}/api/whatsapp/webhook/zapi`;
  return `${base}/api/whatsapp/webhook`;
}

// GET /api/whatsapp/status - Status do serviço
router.get('/status', autenticado, apenasEscritorio, async (req, res) => {
  const provider = WHATSAPP_PROVIDER;
  const service = getActiveService();
  const resposta = {
    provider,
    whatsapp_configurado: service.isConfigured(),
    ia_configurada: agenteIA.isConfigured(),
    webhook_url: getWebhookUrl(req)
  };

  // Pra Evolution e Z-API, inclui também o status da conexão
  if ((provider === 'evolution' || provider === 'zapi') && service.isConfigured()) {
    try {
      const status = await service.statusConexao();
      if (provider === 'zapi') {
        // Z-API retorna { connected, session, smartphoneConnected }
        resposta.conexao = status?.connected ? 'open' : 'close';
        resposta.conexao_raw = status;
      } else {
        resposta.conexao = status?.state || status?.instance?.state || 'desconhecido';
      }
    } catch (e) {
      resposta.conexao = 'erro';
    }
  }

  res.json(resposta);
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
      const msgErro = WHATSAPP_PROVIDER === 'blip'
        ? 'Blip não configurado. Configure BLIP_API_KEY nas variáveis de ambiente.'
        : WHATSAPP_PROVIDER === 'evolution'
          ? 'Evolution API não configurada. Configure EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE nas variáveis de ambiente.'
          : WHATSAPP_PROVIDER === 'zapi'
            ? 'Z-API não configurada. Configure ZAPI_INSTANCE_ID, ZAPI_TOKEN e ZAPI_CLIENT_TOKEN nas variáveis de ambiente.'
            : 'WhatsApp não configurado. Configure WHATSAPP_PHONE_ID e WHATSAPP_TOKEN nas variáveis de ambiente.';
      return res.status(503).json({ erro: msgErro });
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
      webhook_url: getWebhookUrl(req),
    },
  });
});

// =====================================================
// EVOLUTION API — ROTAS ESPECÍFICAS (QR code, grupos, reconexão)
// =====================================================

// GET /api/whatsapp/evolution/qrcode - Retorna o QR code pra parear o número
router.get('/evolution/qrcode', autenticado, apenasEscritorio, async (req, res) => {
  if (WHATSAPP_PROVIDER !== 'evolution' || !evolutionService) {
    return res.status(400).json({ erro: 'Provider ativo não é Evolution API' });
  }
  try {
    const qr = await evolutionService.obterQRCode();
    res.json(qr || { erro: 'Não foi possível obter QR code' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/whatsapp/evolution/grupos - Lista grupos em que o número ANA está
router.get('/evolution/grupos', autenticado, apenasEscritorio, async (req, res) => {
  if (WHATSAPP_PROVIDER !== 'evolution' || !evolutionService) {
    return res.status(400).json({ erro: 'Provider ativo não é Evolution API' });
  }
  try {
    const grupos = await evolutionService.listarGrupos();
    res.json({ total: grupos.length, grupos });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// =====================================================
// Z-API — ROTAS ESPECÍFICAS (QR code, grupos, status)
// =====================================================

// GET /api/whatsapp/zapi/qrcode - Retorna o QR code pra parear o número
router.get('/zapi/qrcode', autenticado, apenasEscritorio, async (req, res) => {
  if (WHATSAPP_PROVIDER !== 'zapi' || !zapiService) {
    return res.status(400).json({ erro: 'Provider ativo não é Z-API' });
  }
  try {
    const qr = await zapiService.obterQRCode();
    res.json(qr || { erro: 'Não foi possível obter QR code' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/whatsapp/zapi/grupos - Lista grupos em que o número ANA está
router.get('/zapi/grupos', autenticado, apenasEscritorio, async (req, res) => {
  if (WHATSAPP_PROVIDER !== 'zapi' || !zapiService) {
    return res.status(400).json({ erro: 'Provider ativo não é Z-API' });
  }
  try {
    const grupos = await zapiService.listarGrupos();
    res.json({ total: grupos.length, grupos });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// =====================================================
// CHECKLIST DE GRUPOS ESPERADOS
// =====================================================
// Ideia: o Thiago cadastra os 80 nomes de grupos em que a ANA precisa entrar,
// e depois adiciona a ANA manualmente em cada um (não automatizamos porque:
//  a) a ANA não pode se auto-adicionar
//  b) usar o número principal do Thiago via API traria risco de ban).
// Este endpoint compara o que está cadastrado com os grupos reais em que a
// ANA já está, retornando um checklist visual pra acompanhar o rollout.

// Inicializa a tabela na primeira chamada (idempotente)
function ensureTabelaGruposEsperados() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS grupos_esperados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      notas TEXT,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_grupos_esperados_nome ON grupos_esperados(nome);
  `);
}

// GET /api/whatsapp/evolution/grupos/checklist
// Retorna lista de grupos esperados com status de presença
router.get('/evolution/grupos/checklist', autenticado, apenasEscritorio, async (req, res) => {
  try {
    ensureTabelaGruposEsperados();
    const db = getDb();
    const esperados = db
      .prepare('SELECT * FROM grupos_esperados ORDER BY nome COLLATE NOCASE')
      .all();

    // Busca grupos reais do provider ativo (se suportar grupos)
    let gruposReais = [];
    if (WHATSAPP_PROVIDER === 'evolution' && evolutionService) {
      try {
        gruposReais = await evolutionService.listarGrupos();
      } catch (e) {
        console.warn('[Checklist] Evolution indisponível:', e.message);
      }
    } else if (WHATSAPP_PROVIDER === 'zapi' && zapiService) {
      try {
        gruposReais = await zapiService.listarGrupos();
      } catch (e) {
        console.warn('[Checklist] Z-API indisponível:', e.message);
      }
    }

    // Normaliza pra comparação case-insensitive
    const mapaReais = new Map();
    for (const g of gruposReais) {
      const subject = (g.subject || g.name || '').trim().toLowerCase();
      if (subject) mapaReais.set(subject, g);
    }

    const checklist = esperados.map(e => {
      const match = mapaReais.get(e.nome.trim().toLowerCase());
      return {
        id: e.id,
        nome: e.nome,
        notas: e.notas,
        cliente_id: e.cliente_id,
        presente: !!match,
        group_jid: match?.id || match?.remoteJid || null,
        participantes: match?.size ?? match?.participants?.length ?? null,
      };
    });

    const totalEsperados = checklist.length;
    const totalPresentes = checklist.filter(c => c.presente).length;

    res.json({
      total_esperados: totalEsperados,
      total_presentes: totalPresentes,
      total_ausentes: totalEsperados - totalPresentes,
      progresso_pct: totalEsperados > 0 ? Math.round((totalPresentes / totalEsperados) * 100) : 0,
      checklist,
    });
  } catch (err) {
    console.error('[Checklist] Erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/whatsapp/evolution/grupos/esperados
// Body: { nome: "..." } OU { lista: ["nome1", "nome2", ...] }
router.post('/evolution/grupos/esperados', autenticado, apenasEscritorio, (req, res) => {
  try {
    ensureTabelaGruposEsperados();
    const db = getDb();
    const { nome, lista, notas, cliente_id } = req.body || {};

    if (Array.isArray(lista) && lista.length > 0) {
      const stmt = db.prepare(
        'INSERT INTO grupos_esperados (nome, notas, cliente_id) VALUES (?, ?, ?)'
      );
      const insercoes = db.transaction(nomes => {
        let criados = 0;
        for (const n of nomes) {
          if (typeof n === 'string' && n.trim()) {
            stmt.run(n.trim(), null, null);
            criados++;
          }
        }
        return criados;
      });
      const criados = insercoes(lista);
      return res.status(201).json({ criados });
    }

    if (!nome || typeof nome !== 'string') {
      return res.status(400).json({ erro: 'Campo "nome" é obrigatório' });
    }
    const info = db
      .prepare('INSERT INTO grupos_esperados (nome, notas, cliente_id) VALUES (?, ?, ?)')
      .run(nome.trim(), notas || null, cliente_id || null);
    res.status(201).json({ id: info.lastInsertRowid, nome: nome.trim() });
  } catch (err) {
    console.error('[Checklist] Erro ao adicionar:', err);
    res.status(500).json({ erro: err.message });
  }
});

// DELETE /api/whatsapp/evolution/grupos/esperados/:id
router.delete('/evolution/grupos/esperados/:id', autenticado, apenasEscritorio, (req, res) => {
  try {
    ensureTabelaGruposEsperados();
    const db = getDb();
    const info = db.prepare('DELETE FROM grupos_esperados WHERE id = ?').run(req.params.id);
    res.json({ removidos: info.changes });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// =====================================================
// HORÁRIO COMERCIAL
// =====================================================

// GET /api/whatsapp/horario-comercial - Config + status atual
router.get('/horario-comercial', autenticado, apenasEscritorio, (req, res) => {
  res.json(horarioComercial.getConfig());
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
