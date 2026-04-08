/**
 * Blip WhatsApp Service
 * Serviço para envio e recebimento de mensagens via Blip (BSP)
 * Protocolo LIME - https://docs.blip.ai
 */

const https = require('https');
const { getDb } = require('../database/init');
const crypto = require('crypto');

// Blip API endpoint para envio de mensagens
const BLIP_API_URL = 'https://http.msging.net';

class BlipService {
  constructor() {
    this.apiKey = process.env.BLIP_API_KEY; // Key do bot no Blip
    this.botIdentifier = process.env.BLIP_BOT_IDENTIFIER; // Identificador do bot (ex: meubot@msging.net)
  }

  /**
   * Verifica se o serviço está configurado
   */
  isConfigured() {
    return !!(this.apiKey);
  }

  /**
   * Gera um ID único no formato LIME
   */
  gerarId() {
    return crypto.randomUUID();
  }

  /**
   * Faz requisição HTTP para a API do Blip
   */
  async apiRequest(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${BLIP_API_URL}${path}`);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Key ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } else {
              console.error('[Blip] API erro:', res.statusCode, data);
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error(`Resposta inválida: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Envia mensagem de texto simples via Blip
   */
  async enviarTexto(telefone, texto) {
    const telefoneLimpo = this.formatarTelefone(telefone);
    const destinatario = `${telefoneLimpo}@wa.gw.msging.net`;

    const body = {
      id: this.gerarId(),
      to: destinatario,
      type: 'text/plain',
      content: texto
    };

    const result = await this.apiRequest('/messages', body);

    // Salva mensagem no banco
    this.salvarMensagem(telefoneLimpo, 'saida', 'texto', texto, body.id, 'bot');

    return result;
  }

  /**
   * Envia documento (PDF, etc.) via Blip
   */
  async enviarDocumento(telefone, linkDocumento, nomeArquivo, legenda) {
    const telefoneLimpo = this.formatarTelefone(telefone);
    const destinatario = `${telefoneLimpo}@wa.gw.msging.net`;

    const body = {
      id: this.gerarId(),
      to: destinatario,
      type: 'application/vnd.lime.media-link+json',
      content: {
        type: 'application/pdf',
        uri: linkDocumento,
        title: nomeArquivo,
        text: legenda || ''
      }
    };

    const result = await this.apiRequest('/messages', body);
    this.salvarMensagem(telefoneLimpo, 'saida', 'documento', legenda || nomeArquivo, body.id, 'sistema');

    return result;
  }

  /**
   * Marca mensagem como lida (envia notificação de consumo)
   */
  async marcarComoLida(messageId, fromAddress) {
    try {
      const body = {
        id: this.gerarId(),
        to: fromAddress,
        event: 'consumed'
      };

      await this.apiRequest('/notifications', body);
    } catch (err) {
      console.error('[Blip] Erro ao marcar como lida:', err);
    }
  }

  /**
   * Notifica cliente sobre NF emitida
   */
  async notificarNFEmitida(telefone, dadosNF) {
    const { razao_social_tomador, numero_dps, valor_servico, descricao_servico, link_danfse } = dadosNF;

    const texto = `📄 *Nota Fiscal Emitida*\n\n` +
      `Olá! Uma nota fiscal foi emitida para *${razao_social_tomador}*.\n\n` +
      `📋 *DPS Nº:* ${numero_dps}\n` +
      `💰 *Valor:* R$ ${valor_servico.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n` +
      `📝 *Serviço:* ${descricao_servico}\n\n` +
      `Acesse o documento completo no link abaixo.`;

    await this.enviarTexto(telefone, texto);

    if (link_danfse) {
      await this.enviarDocumento(telefone, link_danfse, `NFSe_DPS_${numero_dps}.html`, 'DANFSe - Documento da Nota Fiscal');
    }

    // Registra notificação
    try {
      const db = getDb();
      const contato = db.prepare('SELECT id FROM whatsapp_contatos WHERE telefone = ?').get(this.formatarTelefone(telefone));
      if (contato) {
        db.prepare(`
          INSERT INTO whatsapp_notificacoes (contato_id, tipo, mensagem, enviado, enviado_at)
          VALUES (?, 'nf_emitida', ?, 1, CURRENT_TIMESTAMP)
        `).run(contato.id, `NF ${numero_dps} emitida - R$ ${valor_servico}`);
      }
    } catch (err) {
      console.error('Erro ao registrar notificação:', err);
    }
  }

  /**
   * Extrai telefone do endereço LIME (ex: 5541999999999@wa.gw.msging.net -> 5541999999999)
   */
  extrairTelefone(limeAddress) {
    if (!limeAddress) return '';
    return limeAddress.split('@')[0].replace(/\D/g, '');
  }

  /**
   * Formata número de telefone para formato internacional
   */
  formatarTelefone(telefone) {
    let limpo = telefone.replace(/\D/g, '');
    if (limpo.startsWith('0')) limpo = limpo.slice(1);
    if (!limpo.startsWith('55') && limpo.length <= 11) {
      limpo = '55' + limpo;
    }
    return limpo;
  }

  /**
   * Salva mensagem no banco de dados
   */
  salvarMensagem(telefone, direcao, tipo, conteudo, blipMsgId, remetente) {
    try {
      const db = getDb();

      // Busca ou cria contato
      let contato = db.prepare('SELECT id FROM whatsapp_contatos WHERE telefone = ?').get(telefone);
      if (!contato) {
        const result = db.prepare('INSERT INTO whatsapp_contatos (telefone) VALUES (?)').run(telefone);
        contato = { id: result.lastInsertRowid };
      }

      // Busca ou cria conversa ativa
      let conversa = db.prepare(
        'SELECT id FROM whatsapp_conversas WHERE contato_id = ? AND status = ? ORDER BY id DESC LIMIT 1'
      ).get(contato.id, 'ativa');

      if (!conversa) {
        const result = db.prepare(
          'INSERT INTO whatsapp_conversas (contato_id, status, ultimo_mensagem_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(contato.id, 'ativa');
        conversa = { id: result.lastInsertRowid };
      }

      // Salva mensagem
      db.prepare(`
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, conteudo, whatsapp_message_id, remetente)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conversa.id, direcao, tipo, conteudo, blipMsgId || null, remetente || null);

      // Atualiza último timestamp da conversa
      db.prepare('UPDATE whatsapp_conversas SET ultimo_mensagem_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversa.id);

      return conversa.id;
    } catch (err) {
      console.error('Erro ao salvar mensagem:', err);
      return null;
    }
  }

  /**
   * Busca contato vinculado a um cliente pelo CNPJ/telefone
   */
  vincularContatoCliente(telefone, clienteId) {
    try {
      const db = getDb();
      const telefoneLimpo = this.formatarTelefone(telefone);

      db.prepare(`
        INSERT INTO whatsapp_contatos (telefone, cliente_id, tipo)
        VALUES (?, ?, 'cliente')
        ON CONFLICT(telefone) DO UPDATE SET cliente_id = ?, tipo = 'cliente', updated_at = CURRENT_TIMESTAMP
      `).run(telefoneLimpo, clienteId, clienteId);

      return true;
    } catch (err) {
      console.error('Erro ao vincular contato:', err);
      return false;
    }
  }
}

module.exports = new BlipService();
