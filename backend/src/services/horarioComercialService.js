/**
 * Horário Comercial - Controle de quando a ANA pode responder automaticamente
 *
 * Objetivo:
 * - Evitar que o agente IA responda clientes fora do horário comercial
 *   (domingo de madrugada, feriados, etc.)
 * - Em grupos: silêncio absoluto fora do horário (não poluir)
 * - Em privado: auto-resposta com mensagem de ausência, 1x por conversa/dia
 *
 * Config via env vars (com defaults sensatos):
 *   ANA_HORARIO_COMERCIAL_ATIVO   = 'true' (default) | 'false'  → desliga tudo
 *   ANA_HORARIO_INICIO            = '08'  (0-23)
 *   ANA_HORARIO_FIM               = '19'  (0-23, exclusivo)
 *   ANA_DIAS_UTEIS                = '1,2,3,4,5' (0=dom ... 6=sab)
 *   ANA_TIMEZONE                  = 'America/Sao_Paulo'
 *   ANA_MENSAGEM_FORA_HORARIO     = texto custom (default em português)
 *   ANA_INTERVALO_AUSENCIA_HORAS  = 6   → intervalo mínimo entre auto-respostas
 */

const { getDb } = require('../database/init');

const DEFAULT_MSG_FORA_HORARIO =
  '🕐 Oi! Nosso horário de atendimento é *segunda a sexta, das 8h às 19h*. ' +
  'Recebi sua mensagem e o escritório retornará no próximo horário comercial. ' +
  'Obrigada pelo contato! — *Ana (Marçal Contabilidade)*';

class HorarioComercialService {
  constructor() {
    this.ativo = (process.env.ANA_HORARIO_COMERCIAL_ATIVO || 'true').toLowerCase() !== 'false';
    this.horaInicio = parseInt(process.env.ANA_HORARIO_INICIO || '8', 10);
    this.horaFim = parseInt(process.env.ANA_HORARIO_FIM || '19', 10);
    this.diasUteis = (process.env.ANA_DIAS_UTEIS || '1,2,3,4,5')
      .split(',')
      .map(d => parseInt(d.trim(), 10))
      .filter(d => !isNaN(d));
    this.timezone = process.env.ANA_TIMEZONE || 'America/Sao_Paulo';
    this.mensagemAusencia = process.env.ANA_MENSAGEM_FORA_HORARIO || DEFAULT_MSG_FORA_HORARIO;
    this.intervaloAusenciaMs =
      parseInt(process.env.ANA_INTERVALO_AUSENCIA_HORAS || '6', 10) * 60 * 60 * 1000;
  }

  /**
   * Retorna a data/hora atual no timezone configurado como componentes.
   * Usa Intl.DateTimeFormat pra não depender de libs externas.
   */
  agoraNoTimezone() {
    const agora = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(agora);
    const weekdayStr = parts.find(p => p.type === 'weekday')?.value || 'Mon';
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      diaSemana: weekdayMap[weekdayStr] ?? agora.getDay(),
      hora: hour === 24 ? 0 : hour,
      minuto: minute,
    };
  }

  /**
   * Retorna true se estamos dentro do horário comercial configurado.
   * Se o módulo estiver desligado (ANA_HORARIO_COMERCIAL_ATIVO=false),
   * sempre retorna true (responde 24/7).
   */
  dentroHorario() {
    if (!this.ativo) return true;

    const { diaSemana, hora } = this.agoraNoTimezone();

    if (!this.diasUteis.includes(diaSemana)) return false;
    if (hora < this.horaInicio || hora >= this.horaFim) return false;
    return true;
  }

  /**
   * Decide se a ANA pode processar uma mensagem agora.
   * Retorna { permitido, motivo, mensagemAusencia? }
   *
   * @param {Object} opts
   * @param {boolean} opts.isGroup           - se a mensagem veio de grupo
   * @param {number}  [opts.conversaId]      - id da conversa (pra rate-limit de auto-resposta)
   * @returns {{permitido: boolean, motivo?: string, mensagemAusencia?: string}}
   */
  podeResponder({ isGroup, conversaId } = {}) {
    if (this.dentroHorario()) {
      return { permitido: true };
    }

    // Fora do horário comercial
    if (isGroup) {
      // Em grupos: silêncio total fora do horário
      return { permitido: false, motivo: 'fora_horario_grupo' };
    }

    // Em conversa privada: pode responder com msg de ausência,
    // mas só se ainda não mandou uma recentemente
    if (this.autoRespondeuRecentemente(conversaId)) {
      return { permitido: false, motivo: 'fora_horario_ja_avisou' };
    }

    return {
      permitido: false,
      motivo: 'fora_horario_privado',
      mensagemAusencia: this.mensagemAusencia,
    };
  }

  /**
   * Checa se já mandamos auto-resposta de ausência pra essa conversa
   * nas últimas N horas (padrão 6h).
   */
  autoRespondeuRecentemente(conversaId) {
    if (!conversaId) return false;
    try {
      const db = getDb();
      const limite = new Date(Date.now() - this.intervaloAusenciaMs).toISOString();
      const row = db
        .prepare(
          `SELECT id FROM whatsapp_mensagens
           WHERE conversa_id = ?
             AND direcao = 'saida'
             AND remetente = 'sistema'
             AND conteudo LIKE '%horário de atendimento%'
             AND created_at > ?
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get(conversaId, limite);
      return !!row;
    } catch (err) {
      console.error('[HorarioComercial] Erro ao checar auto-resposta prévia:', err.message);
      return false;
    }
  }

  /**
   * Registra uma auto-resposta de ausência no banco pra fins de rate-limit.
   * Outros serviços já salvam as mensagens de saída normalmente — essa função
   * é auxiliar pra casos onde queremos marcar explicitamente como 'sistema'.
   */
  registrarAutoResposta(conversaId, telefone) {
    try {
      const db = getDb();
      const agora = new Date().toISOString();
      db.prepare(
        `INSERT INTO whatsapp_mensagens
         (conversa_id, telefone, direcao, tipo, conteudo, remetente, created_at)
         VALUES (?, ?, 'saida', 'texto', ?, 'sistema', ?)`
      ).run(conversaId, telefone, this.mensagemAusencia, agora);
    } catch (err) {
      console.error('[HorarioComercial] Erro ao registrar auto-resposta:', err.message);
    }
  }

  /**
   * Retorna config atual pra exibir no painel do escritório.
   */
  getConfig() {
    return {
      ativo: this.ativo,
      hora_inicio: this.horaInicio,
      hora_fim: this.horaFim,
      dias_uteis: this.diasUteis,
      timezone: this.timezone,
      mensagem_ausencia: this.mensagemAusencia,
      intervalo_ausencia_horas: this.intervaloAusenciaMs / (60 * 60 * 1000),
      dentro_horario_agora: this.dentroHorario(),
      hora_atual_tz: this.agoraNoTimezone(),
    };
  }
}

module.exports = new HorarioComercialService();
