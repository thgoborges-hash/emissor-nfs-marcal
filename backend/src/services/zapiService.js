/**
 * Z-API WhatsApp Service
 * Serviço para envio e recebimento de mensagens via Z-API (z-api.io)
 * API paga, estável, suporta grupos. Abstrai o Baileys por baixo.
 *
 * Docs: https://developer.z-api.io
 *
 * Variáveis de ambiente esperadas:
 *   ZAPI_INSTANCE_ID   — ID da instância (ex: 3F1BBEE2E86AB30B2E58AAE399BC1248)
 *   ZAPI_TOKEN         — Token da instância (ex: 403B8EBA513D062F5AF432FC)
 *   ZAPI_CLIENT_TOKEN  — Account Security Token (Segurança → Client-Token)
 */

const https = require('https');
const { URL } = require('url');
const { getDb } = require('../database/init');

const ZAPI_BASE = 'https://api.z-api.io';

class ZapiService {
  constructor() {
    this.instanceId = process.env.ZAPI_INSTANCE_ID || '';
    this.token = process.env.ZAPI_TOKEN || '';
    this.clientToken = process.env.ZAPI_CLIENT_TOKEN || '';
  }

  /**
   * Verifica se o serviço está configurado
   */
  isConfigured() {
    return !!(this.instanceId && this.token && this.clientToken);
  }

  /**
   * Faz requisição HTTP para a Z-API
   * @param {string} endpoint - Sem barra inicial (ex: 'send-text', 'status')
   * @param {string} method - GET / POST / PUT / DELETE
   * @param {object|null} body
   */
  async apiRequest(endpoint, method = 'POST', body = null) {
    return new Promise((resolve, reject) => {
      const path = `/instances/${this.instanceId}/token/${this.token}/${endpoint}`;
      let url;
      try {
        url = new URL(`${ZAPI_BASE}${path}`);
      } catch (e) {
        return reject(new Error(`URL Z-API inválida: ${ZAPI_BASE}${path}`));
      }

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: {
          'Client-Token': this.clientToken,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              console.error('[Z-API] API erro:', res.statusCode, parsed);
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
   * Verifica se um destino é grupo.
   * Internamente usamos o sufixo @g.us (mesmo padrão do Evolution) pra diferenciar.
   * Na Z-API o groupId vem sem sufixo — mas nós padronizamos adicionando @g.us.
   */
  isGroup(destino) {
    if (typeof destino !== 'string') return false;
    if (destino.endsWith('@g.us')) return true;
    // Group IDs do WhatsApp têm o formato 120363XXXXXXXXXXXXXXX (18-20 dígitos com "-" opcional)
    // Números de telefone têm no máx 13-14 dígitos. Acima disso, assumimos grupo.
    const limpo = destino.replace(/\D/g, '');
    return limpo.length > 15;
  }

  /**
   * Remove o sufixo @g.us pra mandar pra Z-API (ela aceita só o ID).
   * Pra números privados, retorna só dígitos.
   */
  normalizarDestino(destino) {
    if (!destino) return '';
    // Grupo: remove @g.us se tiver
    if (this.isGroup(destino)) {
      return String(destino).replace(/@g\.us$/, '');
    }
    // Privado: remove @s.whatsapp.net e normaliza
    const limpo = String(destino).replace(/@s\.whatsapp\.net$/, '');
    return this.formatarTelefone(limpo);
  }

  // ============================================================
  // ENVIO DE MENSAGENS
  // ============================================================

  /**
   * Envia mensagem de texto simples
   * @param {string} destino - Telefone (5541999999999) OU group JID (120363...@g.us ou só 120363...)
   * @param {string} texto - Conteúdo da mensagem
   */
  async enviarTexto(destino, texto) {
    const phone = this.normalizarDestino(destino);
    const body = {
      phone,
      message: texto,
      delayMessage: 2 // delay "humano" em segundos
    };

    const result = await this.apiRequest('send-text', 'POST', body);

    const msgId = result?.messageId || result?.id || null;
    // Chave de banco: em grupo, usamos o formato padronizado com @g.us pra manter compatibilidade
    const destinoBanco = this.isGroup(destino)
      ? this._garantirSufixoGrupo(destino)
      : this.formatarTelefone(destino);
    this.salvarMensagem(destinoBanco, 'saida', 'texto', texto, msgId, 'bot');

    return result;
  }

  /**
   * Envia documento (PDF, HTML, etc.)
   * @param {string} destino - Telefone ou grupo
   * @param {string} linkDocumento - URL pública do arquivo
   * @param {string} nomeArquivo - Nome com extensão (ex: NFSe_111.pdf)
   * @param {string} legenda - Caption opcional
   */
  async enviarDocumento(destino, linkDocumento, nomeArquivo, legenda) {
    const phone = this.normalizarDestino(destino);

    // Z-API: endpoint específico por extensão (send-document/{extension})
    const ext = (nomeArquivo.split('.').pop() || 'pdf').toLowerCase();

    const body = {
      phone,
      document: linkDocumento,
      fileName: nomeArquivo,
      caption: legenda || ''
    };

    const result = await this.apiRequest(`send-document/${encodeURIComponent(ext)}`, 'POST', body);

    const msgId = result?.messageId || result?.id || null;
    const destinoBanco = this.isGroup(destino)
      ? this._garantirSufixoGrupo(destino)
      : this.formatarTelefone(destino);
    this.salvarMensagem(destinoBanco, 'saida', 'documento', legenda || nomeArquivo, msgId, 'sistema');

    return result;
  }

  /**
   * Marca mensagem como lida (na Z-API o endpoint é modify-chat com actions).
   * Aceita a mesma assinatura do evolutionService pra compatibilidade.
   */
  async marcarComoLida(remoteJid, messageId, fromMe = false) {
    try {
      const phone = this.normalizarDestino(remoteJid);
      // Z-API endpoint: send-message-read
      return await this.apiRequest('send-message-read', 'POST', {
        phone,
        messageId
      });
    } catch (err) {
      // Não é crítico se falhar
      console.error('[Z-API] Erro ao marcar como lida:', err.message);
    }
  }

  // ============================================================
  // GRUPOS — UTILITÁRIOS
  // ============================================================

  /**
   * Lista todos os grupos em que o número está
   * Z-API endpoint: GET /groups?page=1&pageSize=100
   */
  async listarGrupos() {
    try {
      const result = await this.apiRequest('groups?page=1&pageSize=100', 'GET');
      if (Array.isArray(result)) return result;
      if (Array.isArray(result?.groups)) return result.groups;
      return [];
    } catch (err) {
      console.error('[Z-API] Erro ao listar grupos:', err.message);
      return [];
    }
  }

  /**
   * Status da conexão da instância
   * Z-API endpoint: GET /status
   * Retorna: { connected: true/false, session: true/false, smartphoneConnected: true/false }
   */
  async statusConexao() {
    try {
      return await this.apiRequest('status', 'GET');
    } catch (err) {
      console.error('[Z-API] Erro ao consultar status:', err.message);
      return null;
    }
  }

  /**
   * Retorna o QR code atual pra parear o número
   * Z-API endpoint: GET /qr-code/image — retorna base64 da imagem
   */
  async obterQRCode() {
    try {
      return await this.apiRequest('qr-code/image', 'GET');
    } catch (err) {
      console.error('[Z-API] Erro ao obter QR code:', err.message);
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

    // Registra notificação no banco
    try {
      const db = getDb();
      const destBanco = this.isGroup(destino)
        ? this._garantirSufixoGrupo(destino)
        : this.formatarTelefone(destino);
      const contato = db.prepare('SELECT id FROM whatsapp_contatos WHERE telefone = ?').get(destBanco);
      if (contato) {
        db.prepare(`
          INSERT INTO whatsapp_notificacoes (contato_id, tipo, mensagem, enviado, enviado_at)
          VALUES (?, 'nf_emitida', ?, 1, CURRENT_TIMESTAMP)
        `).run(contato.id, `NF ${numero_dps} emitida - R$ ${valor_servico}`);
      }
    } catch (err) {
      console.error('[Z-API] Erro ao registrar notificação:', err);
    }
  }

  // ============================================================
  // UTILITÁRIOS DE FORMATAÇÃO
  // ============================================================

  /**
   * Formata número de telefone para formato internacional (só dígitos)
   */
  formatarTelefone(telefone) {
    if (!telefone) return '';
    if (typeof telefone === 'string' && telefone.endsWith('@g.us')) return telefone;

    let limpo = String(telefone).replace(/\D/g, '');
    if (limpo.startsWith('0')) limpo = limpo.slice(1);
    if (!limpo.startsWith('55') && limpo.length <= 11) {
      limpo = '55' + limpo;
    }
    return limpo;
  }

  /**
   * Garante que o destino de grupo tenha o sufixo @g.us (padrão interno)
   */
  _garantirSufixoGrupo(destino) {
    if (typeof destino !== 'string') return destino;
    if (destino.endsWith('@g.us')) return destino;
    return `${destino}@g.us`;
  }

  /**
   * Extrai telefone/JID do payload Z-API
   * Compatibilidade com a interface do evolutionService.
   *   5541999999999@s.whatsapp.net → 5541999999999
   *   120363025552242228@g.us       → 120363025552242228@g.us (mantém, é grupo)
   *   120363025552242228            → 120363025552242228@g.us (adiciona sufixo, é grupo)
   */
  extrairDestinoDoJid(remoteJid) {
    if (!remoteJid) return '';
    if (remoteJid.endsWith('@g.us')) return remoteJid;
    if (this.isGroup(remoteJid)) return this._garantirSufixoGrupo(remoteJid);
    return String(remoteJid).split('@')[0].replace(/\D/g, '');
  }

  // ============================================================
  // PERSISTÊNCIA (banco) — idêntico ao evolutionService
  // ============================================================

  salvarMensagem(telefone, direcao, tipo, conteudo, zapiMsgId, remetente) {
    try {
      const db = getDb();

      let contato = db.prepare('SELECT id FROM whatsapp_contatos WHERE telefone = ?').get(telefone);
      if (!contato) {
        const tipoContato = this.isGroup(telefone) ? 'grupo' : null;
        if (tipoContato) {
          const result = db.prepare('INSERT INTO whatsapp_contatos (telefone, tipo) VALUES (?, ?)').run(telefone, tipoContato);
          contato = { id: result.lastInsertRowid };
        } else {
          const result = db.prepare('INSERT INTO whatsapp_contatos (telefone) VALUES (?)').run(telefone);
          contato = { id: result.lastInsertRowid };
        }
      }

      let conversa = db.prepare(
        'SELECT id FROM whatsapp_conversas WHERE contato_id = ? AND status = ? ORDER BY id DESC LIMIT 1'
      ).get(contato.id, 'ativa');

      if (!conversa) {
        const result = db.prepare(
          'INSERT INTO whatsapp_conversas (contato_id, status, ultimo_mensagem_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(contato.id, 'ativa');
        conversa = { id: result.lastInsertRowid };
      }

      db.prepare(`
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, conteudo, whatsapp_message_id, remetente)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conversa.id, direcao, tipo, conteudo, zapiMsgId || null, remetente || null);

      db.prepare('UPDATE whatsapp_conversas SET ultimo_mensagem_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversa.id);

      return conversa.id;
    } catch (err) {
      console.error('[Z-API] Erro ao salvar mensagem:', err);
      return null;
    }
  }

  vincularContatoCliente(destino, clienteId) {
    try {
      const db = getDb();
      const chave = this.isGroup(destino)
        ? this._garantirSufixoGrupo(destino)
        : this.formatarTelefone(destino);
      const tipoContato = this.isGroup(destino) ? 'grupo' : 'cliente';

      db.prepare(`
        INSERT INTO whatsapp_contatos (telefone, cliente_id, tipo)
        VALUES (?, ?, ?)
        ON CONFLICT(telefone) DO UPDATE SET cliente_id = ?, tipo = ?, updated_at = CURRENT_TIMESTAMP
      `).run(chave, clienteId, tipoContato, clienteId, tipoContato);

      return true;
    } catch (err) {
      console.error('[Z-API] Erro ao vincular contato:', err);
      return false;
    }
  }
}

module.exports = new ZapiService();
