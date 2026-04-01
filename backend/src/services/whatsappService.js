/**
 * WhatsApp Business Cloud API Service
 * Serviço para envio e recebimento de mensagens via Meta Cloud API
 */

const https = require('https');
const { getDb } = require('../database/init');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

class WhatsAppService {
  constructor() {
    this.phoneNumberId = process.env.WHATSAPP_PHONE_ID;
    this.accessToken = process.env.WHATSAPP_TOKEN;
    this.verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'marcal_verify_2026';
  }

  /**
   * Verifica se o serviço está configurado
   */
  isConfigured() {
    return !!(this.phoneNumberId && this.accessToken);
  }

  /**
   * Faz requisição HTTP para a API do WhatsApp
   */
  async apiRequest(endpoint, method, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${WHATSAPP_API_URL}/${endpoint}`);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: method || 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              console.error('WhatsApp API erro:', parsed);
              reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
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
   * Envia mensagem de texto simples
   */
  async enviarTexto(telefone, texto) {
    const telefoneLimpo = this.formatarTelefone(telefone);
    const body = {
      messaging_product: 'whatsapp',
      to: telefoneLimpo,
      type: 'text',
      text: { body: texto }
    };

    const result = await this.apiRequest(`${this.phoneNumberId}/messages`, 'POST', body);

    // Salva mensagem no banco
    this.salvarMensagem(telefoneLimpo, 'saida', 'texto', texto, result.messages?.[0]?.id, 'bot');

    return result;
  }

  /**
   * Envia documento (PDF, etc.)
   */
  async enviarDocumento(telefone, linkDocumento, nomeArquivo, legenda) {
    const telefoneLimpo = this.formatarTelefone(telefone);
    const body = {
      messaging_product: 'whatsapp',
      to: telefoneLimpo,
      type: 'document',
      document: {
        link: linkDocumento,
        filename: nomeArquivo,
        caption: legenda || ''
      }
    };

    const result = await this.apiRequest(`${this.phoneNumberId}/messages`, 'POST', body);
    this.salvarMensagem(telefoneLimpo, 'saida', 'documento', legenda || nomeArquivo, result.messages?.[0]?.id, 'sistema');

    return result;
  }

  /**
   * Envia mensagem com botões interativos
   */
  async enviarBotoes(telefone, textoCorpo, botoes, textoHeader) {
    const telefoneLimpo = this.formatarTelefone(telefone);
    const body = {
      messaging_product: 'whatsapp',
      to: telefoneLimpo,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: textoHeader ? { type: 'text', text: textoHeader } : undefined,
        body: { text: textoCorpo },
        action: {
          buttons: botoes.map((btn, i) => ({
            type: 'reply',
            reply: { id: btn.id || `btn_${i}`, title: btn.titulo }
          }))
        }
      }
    };

    const result = await this.apiRequest(`${this.phoneNumberId}/messages`, 'POST', body);
    this.salvarMensagem(telefoneLimpo, 'saida', 'texto', textoCorpo, result.messages?.[0]?.id, 'bot');

    return result;
  }

  /**
   * Envia mensagem com lista de opções
   */
  async enviarLista(telefone, textoCorpo, textoBotao, secoes) {
    const telefoneLimpo = this.formatarTelefone(telefone);
    const body = {
      messaging_product: 'whatsapp',
      to: telefoneLimpo,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: textoCorpo },
        action: {
          button: textoBotao,
          sections: secoes
        }
      }
    };

    const result = await this.apiRequest(`${this.phoneNumberId}/messages`, 'POST', body);
    this.salvarMensagem(telefoneLimpo, 'saida', 'texto', textoCorpo, result.messages?.[0]?.id, 'bot');

    return result;
  }

  /**
   * Marca mensagem como lida
   */
  async marcarComoLida(messageId) {
    return this.apiRequest(`${this.phoneNumberId}/messages`, 'POST', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    });
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
   * Formata número de telefone para formato internacional
   */
  formatarTelefone(telefone) {
    let limpo = telefone.replace(/\D/g, '');
    // Se começa com 0, remove
    if (limpo.startsWith('0')) limpo = limpo.slice(1);
    // Se não tem código do país, adiciona 55 (Brasil)
    if (!limpo.startsWith('55') && limpo.length <= 11) {
      limpo = '55' + limpo;
    }
    return limpo;
  }

  /**
   * Salva mensagem no banco de dados
   */
  salvarMensagem(telefone, direcao, tipo, conteudo, whatsappMsgId, remetente) {
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
      `).run(conversa.id, direcao, tipo, conteudo, whatsappMsgId || null, remetente || null);

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

module.exports = new WhatsAppService();
