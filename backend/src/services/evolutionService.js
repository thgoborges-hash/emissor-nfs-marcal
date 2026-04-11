/**
 * Evolution API WhatsApp Service
 * Serviço para envio e recebimento de mensagens via Evolution API
 * (WhatsApp não-oficial baseado em Baileys — suporta grupos)
 *
 * Docs: https://doc.evolution-api.com
 *
 * Variáveis de ambiente esperadas:
 *   EVOLUTION_API_URL      — ex: https://evo.marcal.com.br  (sem barra no final)
 *   EVOLUTION_API_KEY      — API key global da instância
 *   EVOLUTION_INSTANCE     — nome da instância (ex: "ana-marcal")
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getDb } = require('../database/init');

class EvolutionService {
  constructor() {
    this.apiUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
    this.apiKey = process.env.EVOLUTION_API_KEY;
    this.instance = process.env.EVOLUTION_INSTANCE || 'ana-marcal';
  }

  /**
   * Verifica se o serviço está configurado
   */
  isConfigured() {
    return !!(this.apiUrl && this.apiKey && this.instance);
  }

  /**
   * Faz requisição HTTP para a API da Evolution
   */
  async apiRequest(path, method = 'POST', body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(`${this.apiUrl}${path}`);
      } catch (e) {
        return reject(new Error(`EVOLUTION_API_URL inválida: ${this.apiUrl}`));
      }

      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'apikey': this.apiKey,
          'Content-Type': 'application/json'
        }
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              console.error('[Evolution] API erro:', res.statusCode, parsed);
              reject(new Error(parsed?.message || parsed?.error || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            reject(new Error(`Resposta inválida: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ============================================================
  // DETECÇÃO DE DESTINO (privado vs grupo)
  // ============================================================

  /**
   * Verifica se um destino é grupo (JID termina em @g.us)
   */
  isGroup(destino) {
    return typeof destino === 'string' && destino.endsWith('@g.us');
  }

  /**
   * Normaliza o destino para o formato aceito pelo endpoint sendText.
   * Grupos: retorna o JID completo (ex: 120363...@g.us)
   * Privado: retorna só os dígitos do número (a Evolution aceita só o número)
   */
  normalizarDestino(destino) {
    if (this.isGroup(destino)) return destino;
    // Se vier com sufixo @s.whatsapp.net, remove
    const limpo = destino.replace(/@s\.whatsapp\.net$/, '');
    return this.formatarTelefone(limpo);
  }

  // ============================================================
  // ENVIO DE MENSAGENS
  // ============================================================

  /**
   * Envia mensagem de texto simples
   * @param {string} destino - Telefone (5541999999999) OU group JID (120363...@g.us)
   * @param {string} texto - Conteúdo da mensagem
   */
  async enviarTexto(destino, texto) {
    const dest = this.normalizarDestino(destino);
    const body = {
      number: dest,
      text: texto,
      delay: 1200 // delay "humano" antes do envio (ms)
    };

    const result = await this.apiRequest(
      `/message/sendText/${encodeURIComponent(this.instance)}`,
      'POST',
      body
    );

    const msgId = result?.key?.id || result?.messageId || null;
    const destinoBanco = this.isGroup(destino) ? destino : this.formatarTelefone(destino);
    this.salvarMensagem(destinoBanco, 'saida', 'texto', texto, msgId, 'bot');

    return result;
  }

  /**
   * Envia documento (PDF, etc.)
   */
  async enviarDocumento(destino, linkDocumento, nomeArquivo, legenda) {
    const dest = this.normalizarDestino(destino);

    // Endpoint Evolution: /message/sendMedia/{instance}
    const body = {
      number: dest,
      mediatype: 'document',
      media: linkDocumento, // URL pública do arquivo
      fileName: nomeArquivo,
      caption: legenda || '',
      delay: 1200
    };

    const result = await this.apiRequest(
      `/message/sendMedia/${encodeURIComponent(this.instance)}`,
      'POST',
      body
    );

    const msgId = result?.key?.id || result?.messageId || null;
    const destinoBanco = this.isGroup(destino) ? destino : this.formatarTelefone(destino);
    this.salvarMensagem(destinoBanco, 'saida', 'documento', legenda || nomeArquivo, msgId, 'sistema');

    return result;
  }

  /**
   * Marca mensagem como lida (via endpoint de read receipt)
   */
  async marcarComoLida(remoteJid, messageId, fromMe = false) {
    try {
      const body = {
        readMessages: [{
          remoteJid,
          id: messageId,
          fromMe
        }]
      };
      return await this.apiRequest(
        `/chat/markMessageAsRead/${encodeURIComponent(this.instance)}`,
        'POST',
        body
      );
    } catch (err) {
      // Não é crítico se falhar
      console.error('[Evolution] Erro ao marcar como lida:', err.message);
    }
  }

  // ============================================================
  // GRUPOS — UTILITÁRIOS
  // ============================================================

  /**
   * Lista todos os grupos em que o número está (útil para onboarding e debug)
   */
  async listarGrupos() {
    try {
      const result = await this.apiRequest(
        `/group/fetchAllGroups/${encodeURIComponent(this.instance)}?getParticipants=false`,
        'GET'
      );
      // Evolution retorna array de grupos; normalizamos
      if (Array.isArray(result)) return result;
      if (Array.isArray(result?.groups)) return result.groups;
      return [];
    } catch (err) {
      console.error('[Evolution] Erro ao listar grupos:', err.message);
      return [];
    }
  }

  /**
   * Status da conexão da instância (connected/disconnected/qrcode)
   */
  async statusConexao() {
    try {
      return await this.apiRequest(
        `/instance/connectionState/${encodeURIComponent(this.instance)}`,
        'GET'
      );
    } catch (err) {
      console.error('[Evolution] Erro ao consultar status:', err.message);
      return null;
    }
  }

  /**
   * Retorna o QR code atual pra parear o número (base64)
   */
  async obterQRCode() {
    try {
      return await this.apiRequest(
        `/instance/connect/${encodeURIComponent(this.instance)}`,
        'GET'
      );
    } catch (err) {
      console.error('[Evolution] Erro ao obter QR code:', err.message);
      return null;
    }
  }

  // ============================================================
  // NOTIFICAÇÃO DE NF EMITIDA
  // ============================================================

  /**
   * Notifica cliente (ou grupo) sobre NF emitida
   */
  async notificarNFEmitida(destino, dadosNF) {
    const { razao_social_tomador, numero_dps, valor_servico, descricao_servico, link_danfse } = dadosNF;

    const texto = `📄 *Nota Fiscal Emitida*\n\n` +
      `Nota emitida para *${razao_social_tomador}*.\n\n` +
      `📋 *DPS Nº:* ${numero_dps}\n` +
      `💰 *Valor:* R$ ${valor_servico.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n` +
      `📝 *Serviço:* ${descricao_servico}`;

    await this.enviarTexto(destino, texto);

    if (link_danfse) {
      await this.enviarDocumento(
        destino,
        link_danfse,
        `NFSe_DPS_${numero_dps}.html`,
        'DANFSe - Documento da Nota Fiscal'
      );
    }

    // Registra notificação
    try {
      const db = getDb();
      const destBanco = this.isGroup(destino) ? destino : this.formatarTelefone(destino);
      const contato = db.prepare('SELECT id FROM whatsapp_contatos WHERE telefone = ?').get(destBanco);
      if (contato) {
        db.prepare(`
          INSERT INTO whatsapp_notificacoes (contato_id, tipo, mensagem, enviado, enviado_at)
          VALUES (?, 'nf_emitida', ?, 1, CURRENT_TIMESTAMP)
        `).run(contato.id, `NF ${numero_dps} emitida - R$ ${valor_servico}`);
      }
    } catch (err) {
      console.error('[Evolution] Erro ao registrar notificação:', err);
    }
  }

  // ============================================================
  // UTILITÁRIOS DE FORMATAÇÃO
  // ============================================================

  /**
   * Formata número de telefone para formato internacional
   * (igual ao whatsappService/blipService pra manter consistência)
   */
  formatarTelefone(telefone) {
    if (!telefone) return '';
    // Se já é um JID de grupo, retorna sem alterar
    if (typeof telefone === 'string' && telefone.endsWith('@g.us')) return telefone;

    let limpo = String(telefone).replace(/\D/g, '');
    if (limpo.startsWith('0')) limpo = limpo.slice(1);
    if (!limpo.startsWith('55') && limpo.length <= 11) {
      limpo = '55' + limpo;
    }
    return limpo;
  }

  /**
   * Extrai telefone/JID do formato remoteJid da Evolution
   *   5541999999999@s.whatsapp.net → 5541999999999
   *   120363025552242228@g.us       → 120363025552242228@g.us (mantém, é grupo)
   */
  extrairDestinoDoJid(remoteJid) {
    if (!remoteJid) return '';
    if (remoteJid.endsWith('@g.us')) return remoteJid;
    return remoteJid.split('@')[0].replace(/\D/g, '');
  }

  // ============================================================
  // PERSISTÊNCIA (banco)
  // ============================================================

  /**
   * Salva mensagem no banco de dados
   * @param {string} telefone - Pra privado: número limpo (5541999...); pra grupo: o próprio JID (120363...@g.us)
   */
  salvarMensagem(telefone, direcao, tipo, conteudo, evolutionMsgId, remetente) {
    try {
      const db = getDb();

      // Busca ou cria contato (o "telefone" pode ser um JID de grupo, tudo bem)
      let contato = db.prepare('SELECT id FROM whatsapp_contatos WHERE telefone = ?').get(telefone);
      if (!contato) {
        // Pra grupos, marca tipo = 'grupo' para diferenciar no painel do escritório
        const tipoContato = this.isGroup(telefone) ? 'grupo' : null;
        if (tipoContato) {
          const result = db.prepare('INSERT INTO whatsapp_contatos (telefone, tipo) VALUES (?, ?)').run(telefone, tipoContato);
          contato = { id: result.lastInsertRowid };
        } else {
          const result = db.prepare('INSERT INTO whatsapp_contatos (telefone) VALUES (?)').run(telefone);
          contato = { id: result.lastInsertRowid };
        }
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
      `).run(conversa.id, direcao, tipo, conteudo, evolutionMsgId || null, remetente || null);

      db.prepare('UPDATE whatsapp_conversas SET ultimo_mensagem_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversa.id);

      return conversa.id;
    } catch (err) {
      console.error('[Evolution] Erro ao salvar mensagem:', err);
      return null;
    }
  }

  /**
   * Vincula contato (privado ou grupo) a um cliente
   */
  vincularContatoCliente(destino, clienteId) {
    try {
      const db = getDb();
      const chave = this.isGroup(destino) ? destino : this.formatarTelefone(destino);
      const tipoContato = this.isGroup(destino) ? 'grupo' : 'cliente';

      db.prepare(`
        INSERT INTO whatsapp_contatos (telefone, cliente_id, tipo)
        VALUES (?, ?, ?)
        ON CONFLICT(telefone) DO UPDATE SET cliente_id = ?, tipo = ?, updated_at = CURRENT_TIMESTAMP
      `).run(chave, clienteId, tipoContato, clienteId, tipoContato);

      return true;
    } catch (err) {
      console.error('[Evolution] Erro ao vincular contato:', err);
      return false;
    }
  }
}

module.exports = new EvolutionService();
