/**
 * Agente Inteligente - Atendimento via WhatsApp
 * Usa Claude API (Anthropic) para processar mensagens e responder clientes
 */

const https = require('https');
const { getDb } = require('../database/init');
const anexoCacheService = require('./anexoCacheService');
const certificadoService = require('./certificadoService');
const cnpjService = require('./cnpjService');
const integraContadorService = require('./integraContadorService');
const anaModoEquipeService = require('./anaModoEquipeService');
const anaRouterService = require('./anaRouterService');
const anaGroundingValidator = require('./anaGroundingValidator');
const joaoService = require('./joaoService');
const clienteCadastroAuditor = require('./clienteCadastroAuditor');
const clienteSyncService = require('./clienteSyncService');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Regex pra detectar prefixo de operador vindo do Messenger do Domínio.
// Aceita:
//   (a) Mensagem crua: "Janaina Alves: Segue a declaração..."
//   (b) Mensagem de grupo prefixada pelo whatsapp.js: "[Marçal Contabilidade] Janaina Alves: ..."
//   (c) Formatação de negrito do WhatsApp: "*Janaina Alves:*" com asteriscos.
// Grupo `[...]` inicial opcional; asteriscos opcionais antes do nome e depois dos ":".
const OPERADOR_DOMINIO_REGEX = /^(?:\[[^\]]+\]\s*)?\*?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{1,40}):\*?\s*(.*)/s;

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
   * Parser de endereço a partir da mensagem livre da equipe.
   * Usado para enriquecer cadastro de tomador CPF novo (a Receita não cobre CPF).
   * Procura padrões soltos no texto:
   *   - "Endereço: Rua X, 123, bairro Y"
   *   - "Rua/Av/Travessa NomeDaVia 123"
   *   - "Bairro: Z"
   *   - "Cidade / UF"
   *   - "CEP: 99999-999"
   * Retorna { logradouro, numero, bairro, municipio, uf, cep, complemento } com
   * o que conseguiu extrair (campos vazios ficam '').
   */
  _parseEnderecoMensagem(mensagem) {
    const out = { logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', uf: '', cep: '' };
    if (!mensagem || typeof mensagem !== 'string') return out;
    const txt = mensagem.replace(/\r/g, '');

    // CEP: 8 dígitos com ou sem traço
    const cepMatch = /CEP\s*:?\s*(\d{5})[\-\s]?(\d{3})/i.exec(txt) || /\b(\d{5})[\-\s]?(\d{3})\b/.exec(txt);
    if (cepMatch) out.cep = (cepMatch[1] + cepMatch[2]).replace(/\D/g, '');

    // Cidade / UF — "Vacaria / RS", "Porto Alegre / RS"
    // Ancora em começo de linha pra evitar capturar "bairro Petrópolis.\nVacaria"
    // como cidade. Aceita só letras/espaços/ponto/hífen/apóstrofo no nome da cidade,
    // sem quebra de linha.
    const cidadeUfMatch = /(?:^|\n)\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\.\-\']{1,40}?)\s*\/\s*([A-Z]{2})(?:\s|$|[,\.])/m.exec(txt);
    if (cidadeUfMatch) {
      // limpa qualquer ruído antes/depois (mas nunca pega newlines)
      out.municipio = cidadeUfMatch[1].trim().replace(/\s+/g, ' ');
      out.uf = cidadeUfMatch[2].toUpperCase();
    }

    // Logradouro + número — "Rua Newton 381" ou "Rua Newton, 381" ou "Av. Brasil, 100"
    const logMatch = /\b(Rua|Av\.?|Avenida|Travessa|Tv\.?|Rod\.?|Rodovia|Estrada|Praça|Pra[cç]a|Alameda|Al\.?|Largo)\s+([A-Za-zÀ-ÿ0-9\.\s\-]+?)[,\s]+(\d{1,6})(?:\b|[,\s])/i.exec(txt);
    if (logMatch) {
      out.logradouro = (logMatch[1] + ' ' + logMatch[2]).trim().replace(/\s+/g, ' ');
      out.numero = logMatch[3];
    } else {
      // fallback: linha começando com Rua/Av sem número explícito
      const logSimples = /\b(Rua|Av\.?|Avenida|Travessa|Tv\.?|Rodovia|Estrada|Praça|Pra[cç]a|Alameda|Largo)\s+([A-Za-zÀ-ÿ0-9\.\s\-]{2,80})/i.exec(txt);
      if (logSimples) {
        out.logradouro = (logSimples[1] + ' ' + logSimples[2]).trim().replace(/\s+/g, ' ').replace(/[,\.]+$/, '');
      }
    }

    // Bairro — "bairro Petrópolis" ou "Bairro: X"
    const bairroMatch = /\bbairro\s*:?\s*([A-Za-zÀ-ÿ0-9\s\.\-]{2,60})(?:[,\.\n]|\sCEP|\sCidade|$)/i.exec(txt);
    if (bairroMatch) {
      out.bairro = bairroMatch[1].trim().replace(/[,\.]+$/, '');
    }

    return out;
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

    // 3.5. Detecção de modo equipe robusta (3 camadas: admin → grupo staff → prefixo+whitelist)
    // Mantém compatibilidade: mesma estrutura `{ ehEquipe, operador, mensagemSemPrefixo }`
    // mais campos novos `fonte` e `ambiguo` pra observabilidade.
    const modoEquipe = anaModoEquipeService.detectar(mensagem, contato, getDb);
    if (modoEquipe.ehEquipe) {
      console.log(
        `[AgenteIA] Modo EQUIPE detectado — fonte: ${modoEquipe.fonte}, operador: ${modoEquipe.operador}`
      );
    } else if (modoEquipe.ambiguo) {
      // Prefixo "Nome:" detectado mas não validado contra whitelist —
      // tratamos como cliente conservador, mas avisa admin pra revisar.
      console.warn(
        `[AgenteIA] ⚠ Prefixo ambíguo detectado: ${modoEquipe.motivoAmbiguidade}. Tratando como cliente.`
      );
      this._alertarAdminAmbiguidadeAsync(modoEquipe, contato, conversaId).catch(() => {});
    }

    // 3.6. Compat: ehAdmin segue exposto pra ações que dependem dele (ex: BUSCAR_DANFSE no
    // modo admin permite buscar por CNPJ). É derivado da fonte 'admin'.
    const ehAdmin = modoEquipe.fonte === 'admin';

    // 3.7. Sprint 1.1 — Router Haiku pré-classifica intenção/modo/confiança ANTES do Sonnet.
    // Early-exits: ignorar (grupo) ou handoff (baixa confiança/intenção handoff_humano).
    const router = await anaRouterService.classificar({
      mensagem: modoEquipe.mensagemSemPrefixo || mensagem,
      modoDetectado: modoEquipe.ehEquipe ? 'equipe' : 'cliente',
      tipoContato: contato?.tipo || 'desconhecido',
      ultimas3Msgs: historico.slice(-3),
    });
    console.log(
      `[AgenteIA] Router: intencao=${router.intencao} modo_inferido=${router.modo_inferido} ` +
      `conf=${router.confianca} motivo="${router.motivo}"`
    );

    if (router.deve_ignorar) {
      // Mensagem de grupo que não é pra ANA — fica em silêncio.
      return { texto: '', acoes: [{ tipo: 'IGNORAR' }] };
    }
    if (router.deve_handoff) {
      // Confiança baixa ou handoff_humano explícito — transfere direto, sem queimar Sonnet.
      const textoTransfer = `Essa eu prefiro deixar o Thiago te responder com calma — já tô chamando ele aqui mesmo 👍 [ACAO:TRANSFERIR_HUMANO]`;
      return { texto: textoTransfer, acoes: [{ tipo: 'TRANSFERIR_HUMANO' }] };
    }

    // 4. Monta o prompt do sistema (com hint do router pra reduzir alucinação de intenção)
    let systemPrompt = this.montarSystemPrompt(contato, dadosCliente, modoEquipe, { ehAdmin });
    systemPrompt += `\n\n[ROUTER]: intencao=${router.intencao}, modo_inferido=${router.modo_inferido}, confianca=${router.confianca}, campos_faltantes=${JSON.stringify(router.campos_faltantes || [])}, motivo="${router.motivo}"`;

    // 5. Monta mensagens para a API
    const messages = this.montarMensagens(historico, mensagem);

    // 6. Chama a Claude API
    let resposta = await this.chamarClaude(systemPrompt, messages);

    // DEBUG: loga resposta bruta do Claude pra diagnosticar ações
    console.log(`[AgenteIA] Resposta bruta (${resposta.length} chars): ${resposta.substring(0, 300)}`);

    // 6.5. Sprint 1.3 — Grounding pré-envio: valida promessa vazia + alucinação factual ANTES
    // de qualquer envio. Se bloquear, substitui por sugestão de transferência (sem cliente
    // ver a promessa vazia primeiro).
    const grounding = await anaGroundingValidator.validarPreEnvio({
      mensagemCliente: mensagem,
      respostaAna: resposta,
      historico,
      modoEquipe: modoEquipe.ehEquipe,
    });
    if (!grounding.ok) {
      console.warn(
        `[AgenteIA] ⚠ Grounding bloqueou (${grounding.tipo}): ${grounding.motivo}. ` +
        `Resposta original: ${resposta.substring(0, 200)}`
      );
    }
    resposta = grounding.resposta_final;

    // 7. Verifica se precisa executar ações
    const acoes = this.extrairAcoes(resposta);
    console.log(`[AgenteIA] Ações extraídas: ${acoes.length > 0 ? acoes.map(a => `${a.tipo}(${(a.parametro||'').substring(0,50)})`).join(', ') : 'nenhuma'}`);

    if (acoes.length > 0) {
      // Passa a mensagem original e modoEquipe via contato pra que
      // ações como BUSCAR_DANFSE possam extrair CNPJ mencionado / detectar admin.
      // Cria nova referência — `contato` original é parâmetro const, não dá pra reatribuir.
      const contatoExpandido = { ...contato, mensagemOriginal: mensagem, modoEquipe, ehAdmin };
      await this.executarAcoes(acoes, contatoExpandido, conversaId);

      // 8. Verifica se alguma ação teve feedback que precisa de follow-up
      const feedbackEmissao = acoes.find(a => a.tipo === 'EMITIR_NF' && a.feedback);
      if (feedbackEmissao?.feedback) {
        const fb = feedbackEmissao.feedback;
        let feedbackMsg = '';

        if (fb.sucesso) {
          const numDisplay = fb.numero && fb.numero !== 'undefined' && fb.numero !== '(emitida)' ? fb.numero : '';
          const valorFormatado = fb.valor ? Number(fb.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00';
          feedbackMsg = `\n\n✅ *NF emitida com sucesso!*` +
            (numDisplay ? `\nNúmero: ${numDisplay}` : '') +
            (fb.chaveAcesso ? `\nChave: ${fb.chaveAcesso}` : '') +
            `\nValor: R$ ${valorFormatado}` +
            `\nTomador: ${fb.tomador}`;
        } else if (fb.status === 'erro_emissao' || fb.erro) {
          // Mensagem específica baseada no tipo de erro
          const erroStr = (fb.numero || fb.erro || '').toLowerCase();
          console.log(`[WhatsApp] Erro na emissão (detalhes): ${fb.numero || fb.erro || 'erro desconhecido'}`);

          // Extrai códigos SEFIN (E0xxx, RNGxxxx) que vieram concatenados no errMsg / erroStr.
          // O catch de emitirNFSe agora joga `Codigo: Descricao | Codigo: Descricao` em fb.numero.
          const _codigosSefin = ((fb.numero || fb.erro || '').match(/\b(?:E\d{4}|RNG\d{4})\b/gi) || []).map(c => c.toUpperCase());
          // Tenta tirar a 1ª descrição como "humano-amigável"
          const _primeiraDesc = ((fb.numero || '').split('|')[0] || '').replace(/^[A-Z0-9]+:\s*/, '').trim().substring(0, 220);

          if (erroStr.includes('certificado')) {
            feedbackMsg = `\n\n⚠️ Não consegui emitir a NF porque o certificado digital A1 não está configurado ou está vencido. Vou avisar o Thiago pra resolver isso rapidinho! A NF ficou salva e será emitida assim que o certificado estiver ok.`;
          } else if (erroStr.includes('pré-validação') || erroStr.includes('dados incompletos')) {
            const detalhes = (fb.numero || fb.erro || '').replace(/^(Pré-validação: |Dados incompletos: )/i, '');
            feedbackMsg = `\n\n⚠️ Quase lá! Faltam alguns dados pra emitir:\n${detalhes}\n\nMe passa essas informações que eu emito na hora! 😉`;
          } else if (_codigosSefin.includes('E0116')) {
            feedbackMsg = `\n\n⚠️ A prefeitura rejeitou (E0116): a Inscrição Municipal cadastrada não confere com o registro oficial do município. Thiago notificado pra verificar a IM da empresa.`;
          } else if (_codigosSefin.includes('E0617') || _codigosSefin.includes('E0713')) {
            feedbackMsg = `\n\n⚠️ A prefeitura rejeitou (${_codigosSefin[0]}): regime tributário do prestador inconsistente — alíquota informada não bate com Optante/Não Optante do Simples. Thiago notificado pra ajustar o cadastro.`;
          } else if (_codigosSefin.some(c => c.startsWith('RNG'))) {
            // RNG6110 (e RNG genéricos) = "falha de schema XML" → campo obrigatório
            // faltando ou inválido no cadastro. Auditoria 2026-05-17 mostrou 4 tentativas
            // em loop com a mesma rejeição RNG6110 porque a mensagem não dizia o que
            // ajustar — equipe só descobria por tentativa-e-erro mexendo no cadastro.
            // Agora damos checklist concreto pra equipe conferir antes do retry.
            feedbackMsg = `\n\n⚠️ A prefeitura rejeitou por schema XML (${_codigosSefin[0]})${_primeiraDesc ? ': ' + _primeiraDesc : ''}.\n\nIsso geralmente é *campo obrigatório vazio ou inválido* no cadastro. Antes de pedir pra emitir de novo, confere no cadastro do *prestador* e do *tomador*:\n  • Inscrição Municipal (formato aceito pelo município)\n  • Código IBGE do município (7 dígitos)\n  • Endereço completo: CEP, logradouro, número, bairro\n  • Regime tributário (Simples Nacional optante/não optante)\n  • cTribNac (6 dígitos no formato iissdd)\n\nAjusta o que estiver vazio/errado e me chama de volta. Reenviar sem ajustar nada vai dar o mesmo erro.`;
          } else if (_codigosSefin.length > 0 || erroStr.includes('rejeição') || erroStr.includes('rejeicao') || erroStr.includes('sefin')) {
            const _codeStr = _codigosSefin.length > 0 ? _codigosSefin.join(', ') : 'rejeição';
            feedbackMsg = `\n\n⚠️ A prefeitura rejeitou a emissão (${_codeStr})${_primeiraDesc ? ': ' + _primeiraDesc : ''}. Thiago notificado pra ajustar.`;
          } else if (erroStr.includes('timeout') || erroStr.includes('econnrefused') || erroStr.includes('network') || erroStr.includes('socket')) {
            feedbackMsg = `\n\n⚠️ O sistema da prefeitura está instável no momento. Sua NF foi salva e vou tentar emitir novamente em breve! ⏳`;
          } else {
            console.log(`[WhatsApp] ⚠️ Erro genérico na emissão — detalhes completos: fb.numero="${fb.numero}", fb.erro="${fb.erro}", fb.status="${fb.status}"`);
            feedbackMsg = `\n\n⚠️ Tive um probleminha técnico ao emitir a NF. Já notifiquei o Thiago e ele vai resolver o mais rápido possível. A NF ficou salva no sistema! 🔧`;
          }
        }

        if (feedbackMsg) {
          const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
          return { texto: respostaLimpa + feedbackMsg, acoes };
        }
      }

      // Feedback do cancelamento de NF
      const feedbackCanc = acoes.find(a => a.tipo === 'CANCELAR_NF' && a.feedback);
      if (feedbackCanc?.feedback) {
        const fb = feedbackCanc.feedback;
        let feedbackMsg = '';
        if (fb.sucesso) {
          feedbackMsg = `\n\n\u2705 *NF cancelada com sucesso!*` +
            (fb.numero ? `\nNumero: ${fb.numero}` : '') +
            (fb.emitente ? `\nEmitente: ${fb.emitente}` : '') +
            (fb.motivo ? `\nMotivo: ${fb.motivo}` : '');
        } else {
          // Tenta dar mensagem util pro erro do SEFIN ou do sistema
          const errStr = String(fb.erro || '');
          const retryAgendadoTxt = fb.retryAgendado
            ? ` Vou tentar de novo automaticamente em 5min — se rolar, te aviso aqui.`
            : '';
          if (/An error has occurred|HTTP 500|status 500/i.test(errStr)) {
            feedbackMsg = `\n\n\u26a0\ufe0f Insisti com a Receita mas ela continua devolvendo erro generico (HTTP 500).${retryAgendadoTxt} Detalhe tecnico: ${errStr.substring(0, 220)}`;
          } else if (/prazo|expirou|24h|tempo/i.test(errStr)) {
            feedbackMsg = `\n\n\u26a0\ufe0f Nao consegui cancelar — o prazo de cancelamento ja expirou (geralmente 24h apos emissao). Detalhe: ${errStr.substring(0, 200)}`;
          } else if (/certificado|A1/i.test(errStr)) {
            feedbackMsg = `\n\n\u26a0\ufe0f Nao consegui cancelar — problema com o certificado A1 do emitente. Detalhe: ${errStr.substring(0, 200)}`;
          } else {
            feedbackMsg = `\n\n\u26a0\ufe0f Nao consegui cancelar a NF. Detalhe: ${errStr.substring(0, 300)}`;
          }
        }
        if (feedbackMsg) {
          const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
          return { texto: respostaLimpa + feedbackMsg, acoes };
        }
      }

      // Feedback do cadastro de A1
      const feedbackA1 = acoes.find(a => a.tipo === 'CADASTRAR_A1' && a.feedback);
      if (feedbackA1?.feedback) {
        const fb = feedbackA1.feedback;
        let feedbackMsg = '';
        if (fb.sucesso) {
          const dias = fb.diasRestantes != null ? ` (${fb.diasRestantes} dias)` : '';
          feedbackMsg = `\n\n✅ Certificado A1 cadastrado!\nTitular: ${fb.titular || fb.razao}\nValidade: ${fb.validade}${dias}\n\nAgora pode emitir NF normalmente. 🚀`;
        } else {
          feedbackMsg = `\n\n⚠️ Não consegui cadastrar o A1: ${fb.erro}`;
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        return { texto: respostaLimpa + feedbackMsg, acoes };
      }

      // Feedback de busca de DANFSe
      const feedbackDanfse = acoes.find(a => a.tipo === 'BUSCAR_DANFSE' && a.feedback);
      if (feedbackDanfse?.feedback) {
        const fb = feedbackDanfse.feedback;
        let feedbackMsg = '';
        if (fb.sucesso) {
          feedbackMsg = `\n\n📄 Encontrei a NF ${fb.numero}! Enviando o PDF pra você...`;
        } else {
          feedbackMsg = `\n\n⚠️ ${fb.erro || 'Não encontrei essa NF no sistema.'}`;
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        return { texto: respostaLimpa + feedbackMsg, acoes };
      }

      // Feedback das acoes SERPRO que geram PDF (ANA avisa sucesso/erro, envio do documento
      // acontece em routes/whatsapp.js via acao.feedback.pdfEnvio)
      const acoesPdfSerpro = acoes.filter(a =>
        ['GERAR_DAS_SIMPLES', 'GERAR_DAS_SIMPLES_AVULSO', 'GERAR_DAS_MEI', 'SOLICITAR_SITFIS', 'EMITIR_CCMEI', 'EMITIR_DARF'].includes(a.tipo)
        && a.feedback
      );
      if (acoesPdfSerpro.length > 0) {
        let blocos = '';
        for (const a of acoesPdfSerpro) {
          const fb = a.feedback;
          if (fb.sucesso) {
            blocos += `\n\n\u2705 ${fb.rotulo} gerado${fb.cnpj ? ` (CNPJ ${fb.cnpj})` : ''}. Mandando o PDF aqui...`;
          } else {
            blocos += `\n\n\u26a0\ufe0f Nao consegui gerar ${fb.rotulo || 'o documento'}: ${fb.erro}`;
          }
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        // Nao retornamos ainda — deixamos cair no proximo bloco (integra contador read-only) tambem
        // mas armazenamos a mensagem ja pronta em acoes pra o caller usar. Na pratica so uma
        // dessas vai ter feedback por vez, entao retornamos direto:
        return { texto: respostaLimpa + blocos, acoes };
      }

      // Feedback das consultas Integra Contador (modo equipe)
      const acoesIntegra = acoes.filter(a =>
        ['CONSULTAR_PGDASD_ULTIMA', 'CONSULTAR_PROCURACOES', 'CONSULTAR_DCTFWEB', 'LISTAR_CAIXA_POSTAL'].includes(a.tipo)
        && a.feedback
      );
      if (acoesIntegra.length > 0) {
        let blocos = '';
        for (const a of acoesIntegra) {
          blocos += '\n\n' + this._formatarFeedbackIntegraContador(a.feedback);
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        return { texto: respostaLimpa + blocos, acoes };
      }

      // Feedback de CONSULTAR_CADASTRO_CLIENTE
      const acaoCadastro = acoes.find(a => a.tipo === 'CONSULTAR_CADASTRO_CLIENTE' && a.feedback);
      if (acaoCadastro?.feedback) {
        const fb = acaoCadastro.feedback;
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        if (fb.sucesso && fb.relatorio) {
          return { texto: (respostaLimpa ? respostaLimpa + '\n\n' : '') + fb.relatorio, acoes };
        }
        return { texto: respostaLimpa + `\n\n⚠️ ${fb.erro || 'Não consegui consultar o cadastro.'}`, acoes };
      }

      // Feedback dos jobs João enfileirados (back-office Domínio via daemon local).
      // MONITORAR_ONVIO foi separado pra atualização imediata (sem job).
      const acoesJoao = acoes.filter(a =>
        ['CLASSIFICAR_EXTRATO', 'IMPORTAR_TXT_DOMINIO', 'GERAR_OBRIGACAO'].includes(a.tipo)
        && a.feedback
      );
      if (acoesJoao.length > 0) {
        let blocos = '';
        for (const a of acoesJoao) {
          const fb = a.feedback;
          if (fb.sucesso) {
            const emoji = fb.status === 'pending_approval' ? '⏸️' : '⏳';
            blocos += `\n\n${emoji} *${fb.rotulo}* — job #${fb.job_id} ${fb.status === 'pending_approval' ? 'aguardando aprovação no painel' : 'na fila'}.`;
          } else {
            blocos += `\n\n⚠️ Não consegui agendar *${fb.rotulo || a.tipo.toLowerCase()}*: ${fb.erro}`;
          }
        }
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        return { texto: respostaLimpa + blocos, acoes };
      }

      // Feedback MONITORAR_ONVIO (resposta imediata, sem job)
      const acaoMonOnvio = acoes.find(a => a.tipo === 'MONITORAR_ONVIO' && a.feedback);
      if (acaoMonOnvio?.feedback) {
        const fb = acaoMonOnvio.feedback;
        const respostaLimpa = resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
        if (fb.sucesso) {
          const emoji = fb.estado === 'on' ? '🟢' : '⚪';
          return { texto: respostaLimpa + `\n\n${emoji} ${fb.mensagem}`, acoes };
        }
        return { texto: respostaLimpa + `\n\n⚠️ ${fb.erro}`, acoes };
      }
    }

    return { texto: resposta, acoes: acoes || [] };
  }

  /**
   * Formata retorno do Integra Contador em mensagem legível pra WhatsApp
   */
  _formatarFeedbackIntegraContador(fb) {
    if (!fb.sucesso) {
      return `⚠️ *${fb.rotulo || 'Consulta SERPRO'}:* ${fb.erro || 'falhou'}`;
    }
    const r = fb.resultado || {};
    const status = r.status;
    const mensagens = Array.isArray(r.mensagens) ? r.mensagens : [];
    let msg = `🔎 *${fb.rotulo}* — CNPJ ${fb.cnpj}\n`;

    if (status && status !== 200) {
      msg += `_Status SERPRO: ${status}_\n`;
    }
    if (mensagens.length > 0) {
      const textos = mensagens.map(m => m.texto || m.codigo).filter(Boolean).join(' | ');
      if (textos) msg += `_${textos}_\n`;
    }

    // Tenta parsear o campo 'dados' (vem como string JSON)
    if (r.dados) {
      let dados = r.dados;
      if (typeof dados === 'string') {
        try { dados = JSON.parse(dados); } catch (e) { /* mantém string */ }
      }
      if (typeof dados === 'object' && dados !== null) {
        const resumo = JSON.stringify(dados, null, 2);
        // Trunca pra WhatsApp (limite de 4096 chars na mensagem)
        msg += '```\n' + (resumo.length > 2500 ? resumo.substring(0, 2500) + '\n[...truncado...]' : resumo) + '\n```';
      } else if (typeof dados === 'string' && dados.length > 0) {
        msg += dados.length > 2500 ? dados.substring(0, 2500) + '...' : dados;
      } else {
        msg += '_Sem dados retornados._';
      }
    } else {
      msg += '_Sem dados retornados._';
    }
    return msg;
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
  /**
   * Detecta se a mensagem veio de um operador da equipe Marçal
   * (Messenger do Domínio adiciona prefixo "Nome:" automaticamente)
   * @returns {{ ehEquipe: boolean, operador: string|null, mensagemSemPrefixo: string }}
   */
  detectarModoEquipe(mensagem) {
    if (!mensagem || typeof mensagem !== 'string') {
      return { ehEquipe: false, operador: null, mensagemSemPrefixo: mensagem };
    }
    const match = mensagem.match(OPERADOR_DOMINIO_REGEX);
    if (!match) {
      return { ehEquipe: false, operador: null, mensagemSemPrefixo: mensagem };
    }
    // Heurística simples: nomes próprios começam com maiúscula e têm 2-4 palavras
    const possivelNome = match[1].trim();
    const palavras = possivelNome.split(/\s+/);
    const pareceNome = palavras.length >= 1 && palavras.length <= 4 &&
                       palavras.every(p => /^[A-ZÀ-Ÿ]/.test(p));
    if (!pareceNome) {
      return { ehEquipe: false, operador: null, mensagemSemPrefixo: mensagem };
    }
    return {
      ehEquipe: true,
      operador: possivelNome,
      mensagemSemPrefixo: match[2].trim(),
    };
  }

  /**
   * Detecta se o contato é o admin (Thiago) — matching tolerante de telefone.
   * Compartilhado entre montarSystemPrompt (pra destravar modo equipe)
   * e ações individuais (BUSCAR_DANFSE, etc).
   */
  _ehAdmin(contato) {
    const adminPhoneRaw = (process.env.ANA_ADMIN_WHATSAPP || '').replace(/\D/g, '');
    const telefoneContatoRaw = (contato?.telefone || '').replace(/\D/g, '');
    if (!adminPhoneRaw || !telefoneContatoRaw) return false;
    const variantes = (num) => {
      const v = new Set([num]);
      if (num.length === 13 && num.startsWith('55') && num[4] === '9') {
        v.add(num.slice(0, 4) + num.slice(5));
      } else if (num.length === 12 && num.startsWith('55')) {
        v.add(num.slice(0, 4) + '9' + num.slice(4));
      }
      return v;
    };
    const va = variantes(adminPhoneRaw);
    const vb = variantes(telefoneContatoRaw);
    for (const x of va) for (const y of vb) {
      if (x === y) return true;
      const menor = x.length < y.length ? x : y;
      const maior = x.length < y.length ? y : x;
      if (menor.length >= 10 && maior.startsWith(menor)) return true;
    }
    return false;
  }

  montarSystemPrompt(contato, dadosCliente, modoEquipe = { ehEquipe: false }, opcoes = {}) {
    const ehAdmin = !!opcoes.ehAdmin;
    let prompt = `# QUEM VOCÊ É
Você é a Ana, da equipe da Marçal Contabilidade (escritório do Thiago Borges, Curitiba/PR). Você NÃO é robô, IA ou assistente virtual — é a Ana e ponto. Conhece os clientes pelo nome, é organizada, prestativa, descontraída mas profissional. Fala como gente: "pode deixar", "tá certinho", "deixa comigo".

# COMO VOCÊ CONVERSA (WhatsApp, não chatbot)
- Mensagens curtas e naturais
- Use *negrito* e _itálico_ do WhatsApp; NUNCA use markdown (#, ##, ---, listas com -)
- Não comece com "Como posso ajudar?"; não monte menus numerados
- Emoji com moderação (😊 ✅ 📅), sem exagero
- Saudação simples → resposta simples ("Oi! Tudo bem? 😊") e espera

# REGRA DE OURO — VOCÊ SÓ PROMETE O QUE ENTREGA AGORA
Você NÃO TEM mecanismo de "voltar depois". Se a entrega depende do futuro, transfere AGORA.
- NUNCA diga "vou verificar / vou olhar / te retorno / já te falo / deixa eu ver / daqui a pouco" sem uma tag [ACAO:...] na MESMA mensagem
- Sem tag = promessa vazia = cliente ou operador fica esperando pra sempre
- Se não pode resolver agora: "Essa eu prefiro deixar o Thiago te responder com calma, já tô chamando ele aqui mesmo" + [ACAO:TRANSFERIR_HUMANO]
- Confie no sistema: ele anexa as mensagens de sucesso/erro automaticamente. NÃO duplique nem invente sucesso.

# O QUE A ANA NUNCA FAZ
- NUNCA inventa dados (valor, prazo, alíquota, código de serviço) — sem fonte → transfere
- NUNCA promete prazos específicos ("fica pronto amanhã")
- NUNCA fala de honorários/valores do escritório → transfere
- NUNCA dá conselho tributário complexo → transfere
- NUNCA se identifica como IA/robô/assistente
- NUNCA monta menu/opções numeradas

# GRUPOS — SEJA CONSERVADORA
Quando a mensagem vem de grupo, o sistema prefixa "[Nome] texto". Use o nome pra personalizar ("Pode deixar, João!"). Mas:
- Mensagem clara sobre NF/contabilidade/imposto, ou menciona "@Ana"/"Ana"/"Marçal"/"escritório"/"nota"/"fiscal" → responde
- Conversa entre a equipe do cliente, saudações genéricas pro grupo, piadas, time/política/clima, áudio/figurinha sem contexto → [ACAO:IGNORAR]
- **Na dúvida, fica quieta.** Você é colega educada, não intrusa.
- No grupo, respostas mais profissionais e curtas — outras pessoas vão ler.

# EMITIR NF — CORE DO TRABALHO

## Dados necessários
- **Valor**, **CNPJ/CPF do tomador**, **Descrição**. Sem CNPJ/CPF não dá. Se cliente mandou só nome: "Me passa o CNPJ deles que eu emito agora".
- Se o tomador já está em TOMADORES CADASTRADOS abaixo, usa de lá.
- Razão social: se for CNPJ, sistema puxa da Receita automaticamente — você não precisa pedir. Se for CPF, pede o nome.

## Fluxo
- Tem todos os dados → emite IMEDIATAMENTE, sem perguntar "tá certinho?"/"posso emitir?". Diga "Emitindo!" + a tag.
- Falta dado → puxa um por um, conversando, não tudo de uma vez.
- NÃO mencione competência/mês — sistema usa o atual.

## Formato da tag — MODO CLIENTE (4 campos)
\`[ACAO:EMITIR_NF:valor|cnpj_cpf|razao_social_se_souber|descricao]\`
- Razão social pode ficar vazia pra CNPJ (sistema preenche). Pra CPF: \`[ACAO:EMITIR_NF:1500.00|12345678901|João da Silva|Serviços prestados]\`

## ⚠️ DESCRIÇÃO DA NF É LITERAL — NÃO RESUMA
Copie a descrição EXATAMENTE como o operador/cliente passou — preservando capitalização, pontuação, acentuação. Esse texto vai pro XML (xDescServ) e aparece no DANFSe oficial. **Mesmo que tenha 500-1000 caracteres, copie inteira** (sistema aguenta).
- Quebras de linha viram espaço; sem inventar formatação.
- Se a descrição contiver "|" (barra), substitua por ";" antes de colocar na tag (separador interno).
- NUNCA escreva "Prestação de serviços conforme combinado" pra resumir — isso falsifica a NF.

## ⚠️ ATENÇÃO — EMITENTE EXPLÍCITO
Se a mensagem mencionar "Emitente: <Razão> - CNPJ: <X>", "NF do <X>", "do CNPJ <X>" — você DEVE incluir o CNPJ do emitente como 1º campo (formato 5+ campos). Vale pra QUALQUER modo. Sem isso, o sistema bloqueia (evita emitir pela empresa errada).

## ⚠️ CONFIRMAÇÃO ANTES DE EMITIR — APENAS NO MODO CLIENTE EXTERNO

**Em modo cliente externo (esse contato NÃO está em modo equipe / não tem prefixo "Nome:"):** você NÃO emite de primeira. Antes de qualquer \`[ACAO:EMITIR_NF:...]\`, mostra um resumo do que vai emitir e ESPERA o cliente confirmar com "sim", "pode emitir", "confirma", "isso" ou similar.

Formato do resumo (siga esse padrão):
> Confirma a emissão?
> • Tomador: Empresa X — CNPJ 00.000.000/0001-00
> • Valor: R$ 1.500,00
> • Descrição: Consultoria de marketing
>
> Se tudo certo me responde "pode emitir".

REGRAS:
- NÃO inclua a tag \`[ACAO:EMITIR_NF:...]\` na mensagem do resumo. A tag SÓ vai na próxima resposta DEPOIS do cliente confirmar.
- Quando o cliente confirmar, dispare a tag direto na próxima mensagem ("Emitindo!" + tag).
- Se o cliente quiser corrigir ("não, era 1500 não, 5000"), atualiza o resumo e pergunta de novo.
- Se ele desistir ("deixa pra lá", "esquece"), responde tranquila: "Pode deixar! Quando quiser emitir, é só me chamar 😊"
- A confirmação tem validade implícita do turno seguinte; se ele mudar de assunto e voltar depois, mostra o resumo de novo.

**Em modo EQUIPE (operador interno):** emite DIRETO sem confirmar. A equipe sabe o que pediu, e atrasar com pergunta extra fricciona o trabalho deles.

# QUANDO TENHA QUE EMITIR MAS NÃO PODE INCLUIR A TAG
NUNCA diga "emitindo / vou emitir / saindo a NF" SEM a tag na mesma mensagem. Sem tag = NF não sai. Se faltar dado, faça a pergunta direta SEM mencionar emissão.

⚠️ Atenção: no MODO CLIENTE EXTERNO (regra de confirmação acima), a frase "Confirma a emissão?" NÃO conta como "vou emitir" — é só pedido de confirmação SEM a tag, e isso é correto. A tag sai SÓ depois do cliente dizer "pode emitir".

# ERRO DE EMISSÃO — NÃO CHUTE
Quando vier erro (RNG6110, E0116, E0617, E0713, "Falha Schema", "rejeitou"), você NUNCA:
- Inventa checklist ("falta IM? endereço? alíquota?")
- Pede dados do prestador (já estão no cadastro/prompt)
- Chuta causa ("normalmente é falta de X")

**Auto-fix automático**: o sistema (anaAutoFixService) tenta detectar erros conhecidos (logradouro vazio do tomador, IM com lixo, regime tributário Simples sem regApTribSN, codigo_municipio inválido) e CORRIGIR sozinho antes de te entregar a falha. Se chegou erro até você, o auto-fix:
- (a) tentou e SEFIN ainda recusou → observação tem "[AutoFix: ...]"
- (b) não identificou padrão mecânico

O QUE FAZER:
1. Repasse o erro LITERAL do sistema (códigos + descrição). Sem reformulação.
2. Se observação tem "[AutoFix: ...]" → mencione: "tentei corrigir X mas a prefeitura ainda recusou".
3. Erro de schema (RNG…) ou rejeição genérica → transfere: "Esse precisa do Thiago olhar" + [ACAO:TRANSFERIR_HUMANO].
4. Causa óbvia + sugestão do sistema (ex: "cTribNac não cadastrado. Sugestões: 1) X, 2) Y") → mostra opções LITERAIS e espera resposta.
5. "Consegue revisar?" depois de schema → "Não consigo revisar XML aqui, chamando o Thiago" + [ACAO:TRANSFERIR_HUMANO].

# OUTRAS COISAS QUE FAZ

- **Consultas de NF**: status, valores, histórico → responde com os dados que tem ("Sua última NF foi dia 15/03, R$ 5.000,00 pra Empresa ABC ✅").
- **Dúvidas sobre impostos/DAS genéricas**: prazo público (ex: "DAS vence dia 20") responde direto. Valor específico do cliente, situação fiscal → transfere.
- **Status de documento/certidão específica do cliente**: NÃO TEM tool — sempre transfere ("Já chamando o Thiago" + [ACAO:TRANSFERIR_HUMANO]).
- **2ª via de boleto/guia**: NÃO TEM tool automática — transfere com [ACAO:ENVIAR_GUIA:tipo|referencia] (aciona equipe).
- **Reforma Tributária / LC 214/25 / CBS/IBS / IN da RFB / prorrogação / alíquota nova**: usa web_search e cita fonte. Evite > 1 busca por mensagem.

# QUANDO TRANSFERIR PRO THIAGO
Planejamento tributário complexo · negociação de honorários · reclamação · tomador novo precisando cadastro · qualquer dúvida que web_search não resolveu.

# AÇÕES DISPONÍVEIS (incluir no fim da resposta — cliente não vê)

- \`[ACAO:EMITIR_NF:valor|cnpj_cpf|razao|descricao]\` — emite (4 campos modo cliente; ver bloco MODO EQUIPE pra 5/6 campos)
- \`[ACAO:TRANSFERIR_HUMANO]\`
- \`[ACAO:CONSULTAR_NF:numero]\`
- \`[ACAO:CANCELAR_NF:numero_ou_chave|motivo]\` — motivo ≥ 15 chars; precisa A1 do emitente; aceita número ou chave de 47 dígitos. Se houver ambiguidade (mesmo número em emitentes diferentes), peça a chave.
- \`[ACAO:CADASTRAR_A1:cnpj|senha]\` — pré-requisito: arquivo .pfx anexado nos últimos 30min. Sem anexo, sistema avisa. Ex: "A1 do DDA CNPJ 27.998.575/0001-00, senha: 123456" → \`[ACAO:CADASTRAR_A1:27998575000100|123456]\`
- \`[ACAO:ATUALIZAR_CLIENTE:cnpj|campo=valor|...]\` — campos: \`optante_simples\` (1/0), \`aliquota_iss\` (0.02 = 2%), \`codigo_servico\`, \`descricao_servico_padrao\`, \`regime_especial\`, \`incentivo_fiscal\`, \`inscricao_municipal\`, \`municipio\`, \`codigo_municipio\` (IBGE 7 dígitos), \`uf\`, \`cep\`, \`logradouro\`, \`numero\`, \`bairro\`. Ex: \`[ACAO:ATUALIZAR_CLIENTE:27998575000100|optante_simples=1|aliquota_iss=0.02]\`
- \`[ACAO:LISTAR_NFS]\` · \`[ACAO:BUSCAR_DANFSE:numero_nf]\` · \`[ACAO:ENVIAR_GUIA:tipo|ref]\` · \`[ACAO:VINCULAR_CLIENTE:cnpj]\` · \`[ACAO:IGNORAR]\``;

    // Bloco MODO EQUIPE — aparece quando:
    //   (a) a mensagem veio com prefixo "Nome:" do Messenger Domínio, OU
    //   (b) o contato é o admin (Thiago) — destrava o modo no WhatsApp direto
    if (modoEquipe.ehEquipe || ehAdmin) {
      const operadorNome = modoEquipe.operador || contato?.nome || 'Thiago';
      prompt += `\n\n# MODO EQUIPE — ${operadorNome}

Quem fala é da equipe Marçal (Messenger Domínio ou admin direto). Trate como colega — tom direto, técnico, sem firulas. ${operadorNome} sabe contabilidade e tem pressa.
- Equipe pode pedir consultas/emissões pra QUALQUER cliente da carteira. Sempre extraia o CNPJ; sem CNPJ → pergunta.
- Você TEM Integra Contador (SERPRO/RFB) liberado pra consultas oficiais.
- NÃO use [ACAO:IGNORAR] no modo equipe — toda mensagem merece resposta.
- NÃO peça confirmação pra consultas (read-only) — dispare direto.
- Se pedirem algo que não tem tool, fale: "ainda tô aprendendo isso, vou pedir pro Thiago liberar".

## ⚠️ EMITIR NF NO MODO EQUIPE — 5 CAMPOS, NUNCA 4

\`[ACAO:EMITIR_NF:cnpj_EMITENTE|valor|cnpj_TOMADOR|razao_tomador|descricao]\` ✅
\`[ACAO:EMITIR_NF:valor|cnpj_tomador|razao|descricao]\` ❌ (4 campos = sistema BLOQUEIA)

POR QUÊ: 4 campos emitiria pela Marçal por default. Em modo equipe, NF SEMPRE sai em nome de um CLIENTE da carteira (Marçal é contadora, não emite NF pelos clientes dos clientes).

### Como identificar o emitente — extraia da mensagem, NUNCA assuma "Marçal"
Padrões comuns (todos válidos):
- "emite NF do DDA Clinica Medica (CNPJ 27.998.575/0001-00) pra ..."
- "Emitente: DDA CLINICA MEDICA LTDA - CNPJ: 27.998.575/0001-00\\nTomador: ..."
- "NF do CNPJ 27998575000100 pra ..."
- "Do Estudio Soma (12.345.678/0001-90), emite NF pra ..."

Achou CNPJ (14 dígitos)? → 1º campo. **Não achou** → NÃO invente. NÃO chute Marçal. NÃO emita 4 campos. Pergunta direto: "De qual empresa sai essa NF? Me passa o CNPJ do emitente."

### Formato pleno (6 campos, 6º opcional)
\`[ACAO:EMITIR_NF:cnpj_emitente|valor|cnpj_tomador|razao_tomador|descricao|cTribNac]\`

Sem cTribNac (cliente já tem no cadastro):
\`[ACAO:EMITIR_NF:27998575000100|890.00|04406995927|Maysa Bittencourt|Atendimentos e Consultas medicas]\`

Com cTribNac (mensagem traz "Código de Tributação Nacional X" ou "cTribNac Y"):
\`[ACAO:EMITIR_NF:27998575000100|890.00|04406995927|Maysa Bittencourt|Atendimentos e Consultas medicas||040101]\` (5º campo vazio com \`||\` pra usar 6º sem competência)

### Sobre cTribNac
- 6 dígitos no formato iissdd (LC 116/2003). SEMPRE remova pontos/traços/espaços antes da tag (\`02.01.01\`, \`02-01-01\`, \`020101\` → \`020101\`).
- Sistema sugere automaticamente se cliente novo:
  - Confiança alta → AUTO-APLICA e relata "código sugerido automaticamente: X — confirme depois no cadastro"
  - Confiança baixa → mostra opções numeradas, espera equipe escolher; equipe responde "usa o 1" ou direto o código → re-emita com o código no 6º campo

### Uma tag por resposta
Inclua \`[ACAO:EMITIR_NF:...]\` **uma única vez** por mensagem. Se a equipe pediu 2 NFs no mesmo texto, dispara UMA e diz "essa eu emito agora, qual é a segunda?".

## Templates de formulário (último recurso — usa SÓ se faltam dados)
Se a mensagem já trouxer todos os dados, dispara a ação direto, sem template. Senão, copie o bloco apropriado EXATAMENTE como abaixo (use bullet "•", mantenha "_____" como campos vazios), com uma frase curta antes ("Show, me passa assim:").

\`📝 *EMITIR NF*\` • Emitente _____ (razão+CNPJ) • Tomador _____ (nome/razão+CPF/CNPJ) • Valor R$ _____ • Descrição _____ • Cód. tributação (1ª NF cliente novo) _____

\`📝 *2ª via DAS*\` • Empresa _____ • CNPJ _____ • Competência __/____ • Tipo ( )Simples ( )MEI

\`📝 *Situação Fiscal (SITFIS)*\` • Empresa _____ • CNPJ _____

\`📝 *CCMEI*\` • CNPJ do MEI _____

\`📝 *DAS MEI*\` • CNPJ do MEI _____ • Ano ____

\`📝 *CADASTRAR A1*\` • CNPJ _____ • Senha _____ — anexe .pfx até 30min antes

\`📝 *CANCELAR NF*\` • Número OU chave (47 dígitos) _____ • Motivo (≥15 chars) _____

\`📝 *DARF (Sicalc)*\` • CNPJ _____ • Tributo _____ (IRPJ/CSLL/COFINS/PIS/IRRF/INSS ou código 4 dígitos) • Período __/____ • Valor R$ _____ — vencimento calculo sozinha (último dia útil do mês seguinte) salvo aviso

## Ação de consulta de cadastro (anti-alucinação)

\`[ACAO:CONSULTAR_CADASTRO_CLIENTE:cnpj_prestador|cnpj_ou_cpf_tomador]\` (2º campo opcional)

Quando usar:
- Rejeição SEFIN do tipo schema (RNG6110, "Falha Schema Xml") → 90% das vezes é campo vazio no cadastro. Consulta antes de chutar lista genérica.
- Equipe perguntando "tá faltando algo no cadastro do X?" → consulta e responde fato, não suposição.
- Antes de emitir NF cliente novo → ver se cadastro tá pronto.

Resposta volta com checklist do prestador (e tomador se informado): 🔴 crítico vazio, 🟡 não-crítico, ✅ ok. NÃO INVENTE — só fale o que o relatório retornar.

## Ações extras (Integra Contador — só dígitos do CNPJ, 14 chars)
- \`[ACAO:CONSULTAR_PGDASD_ULTIMA:cnpj]\` — última PGDAS-D (Simples) do cliente
- \`[ACAO:CONSULTAR_PROCURACOES:cnpj]\` — procuração e-CAC ativa?
- \`[ACAO:CONSULTAR_DCTFWEB:cnpj]\` — DCTFWeb entregues
- \`[ACAO:LISTAR_CAIXA_POSTAL:cnpj]\` — Caixa Postal e-CAC
- \`[ACAO:GERAR_DAS_SIMPLES:cnpj|YYYYMM]\` — DAS Simples período já declarado
- \`[ACAO:GERAR_DAS_SIMPLES_AVULSO:cnpj|YYYYMM]\` — DAS Simples avulso (reemissão / sem declaração)
- \`[ACAO:GERAR_DAS_MEI:cnpj|YYYY]\` — DAS MEI (anual)
- \`[ACAO:SOLICITAR_SITFIS:cnpj]\` — Relatório Situação Fiscal (substitui CND)
- \`[ACAO:EMITIR_CCMEI:cnpj]\` — Certificado de MEI
- \`[ACAO:EMITIR_DARF:cnpj|codigoReceita|YYYYMM|DDMMYYYY|valor]\` — DARF via Sicalc

## Ações João (back-office / Domínio Web — fila assíncrona, daemon local executa)

Estas ações enfileiram jobs pro daemon João que roda no Mac do Thiago e opera o GO-Global do Domínio via computer-use. **Ações sensíveis** (importar TXT, gerar obrigação) entram em \`pending_approval\` — operador aprova no painel antes de rodar. Tempo médio: alguns minutos.

- \`[ACAO:CLASSIFICAR_EXTRATO:cliente_id|pdf_url]\` — pega PDF de extrato bancário (link de download), classifica lançamentos por categoria, gera entradas.txt. Responde: "tô na fila, daemon vai puxar em instantes".
- \`[ACAO:IMPORTAR_TXT_DOMINIO:cliente_id|codigo_empresa|caminho_txt|conjunto_dados]\` — importa TXT de lançamentos no Domínio Web (skill dominio-importar-txt). conjunto_dados típico: "Lançamentos Contábeis (Partida Múltiplas) (3.1) (5)". Validação CNPJ antes.
- \`[ACAO:GERAR_OBRIGACAO:cliente_id|sub_tipo|periodo]\` — sub_tipo ∈ {ecd, balancete, encerramento, dre}. periodo formato YYYY-MM (mensal) ou YYYY (anual). Roda computer-use no Domínio.
- \`[ACAO:MONITORAR_ONVIO:cliente_id|on|off]\` — liga ou desliga polling Chrome MCP no Onvio Documentos. Quando "on", daemon checa a cada 15min se tem extrato novo.

Quando equipe pedir algo do back-office, dispare a ação e responda curto: "Já enfileirei, daemon avisa quando terminar. Levam alguns minutos."

Apoio: cliente sem A1 → dispatcher devolve "Fulano não tem A1 configurado" — passe pro operador e peça pra subir o certificado.`;
    }

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
      // Ferramenta de busca web (server-side tool da Anthropic).
      // Restrita a fontes oficiais: Receita Federal, Planalto, Imprensa Nacional, Portal Fazenda, SPED, gov.br.
      // max_uses cap pra controlar custo (cada busca ~$0.01).
      const webSearchTool = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 2,
        allowed_domains: [
          'receita.fazenda.gov.br',
          'gov.br',
          'planalto.gov.br',
          'in.gov.br',
          'portal.fazenda.gov.br',
          'sped.rfb.gov.br',
          'www38.receita.fazenda.gov.br'
        ]
      };

      const body = JSON.stringify({
        model: this.modelo,
        max_tokens: 3500,
        system: systemPrompt,
        messages: messages,
        tools: [webSearchTool]
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
              // Quando a ANA usa web_search, o content vem com múltiplos blocos:
              // [text?, server_tool_use, web_search_tool_result, text].
              // Concatena todos os blocos de texto pra formar a resposta final.
              const blocos = Array.isArray(parsed.content) ? parsed.content : [];
              const textos = blocos.filter(b => b.type === 'text').map(b => b.text).filter(Boolean);
              const texto = textos.join('\n\n').trim() || 'Desculpe, não consegui processar sua mensagem.';

              // Log se a busca foi usada (pra acompanhar custo e comportamento)
              const usouBusca = blocos.some(b => b.type === 'server_tool_use' && b.name === 'web_search');
              if (usouBusca) {
                const queries = blocos
                  .filter(b => b.type === 'server_tool_use' && b.name === 'web_search')
                  .map(b => b.input?.query)
                  .filter(Boolean);
                console.log('[AgenteIA] 🔎 ANA usou web_search:', queries.join(' | '));
              }

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
    // Dedupe: remove ações duplicadas (mesmo tipo + mesmo parâmetro) na mesma resposta.
    // Protege contra alucinação do modelo que às vezes anuncia "vou emitir as duas" e
    // cola a tag duas vezes com parâmetros idênticos → emitiria 2 NFs na SEFIN.
    const vistas = new Set();
    const acoesDedup = [];
    for (const a of acoes) {
      const chave = `${a.tipo}::${a.parametro || ''}`;
      if (vistas.has(chave)) {
        console.warn(`[AgenteIA] Tag duplicada ignorada: ${chave.substring(0, 80)}`);
        continue;
      }
      vistas.add(chave);
      acoesDedup.push(a);
    }
    return acoesDedup;
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
          // Notifica o admin via WhatsApp (não bloqueia o fluxo se falhar)
          this._notificarAdminTransferencia(conversaId, contato).catch(err =>
            console.warn('[WhatsApp] Falha ao notificar admin:', err.message)
          );
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
          // Garante que o contato está vinculado a um cliente com certificado A1
          if (acao.parametro) {
            // ===== MULTI-EMITENTE =====
            // Formato novo (modo equipe): cnpj_emitente|valor|cnpj_tomador|razao|descricao
            // Formato antigo (modo cliente): valor|cnpj_tomador|razao|descricao
            // Detector: se primeiro campo tem 14 dígitos após strip E tem 5+ campos, é CNPJ emitente
            const partesDetectEmitente = acao.parametro.split('|');
            const primeiroLimpo = (partesDetectEmitente[0] || '').replace(/\D/g, '');
            const pareceCnpjEmitente = primeiroLimpo.length === 14 && partesDetectEmitente.length >= 5;

            // GUARD MODO EQUIPE: em modo equipe (ou admin direto), NÃO aceitar formato de 4
            // campos — isso emitiria pela Marçal por default. Emissão em nome da Marçal
            // exige que a equipe explicite usando [ACAO:EMITIR_NF:<cnpj_marcal>|...] com
            // 5 campos, pra garantir intenção.
            const ehContextoEquipe = !!(contato?.modoEquipe?.ehEquipe || contato?.ehAdmin);
            if (ehContextoEquipe && !pareceCnpjEmitente) {
              console.log(`[WhatsApp] 🛑 EMITIR_NF bloqueado: modo equipe exige CNPJ do emitente como 1º campo (5 campos). Recebido: ${acao.parametro.substring(0, 100)}`);
              acao.feedback = { sucesso: false, erro: 'Pra emitir em modo equipe preciso do CNPJ do cliente que vai emitir a NF como primeiro campo da tag. Me passa o CNPJ do emitente?' };
              break;
            }

            // GUARD DEFESA EM PROFUNDIDADE: se a mensagem original tem "Emitente:" ou "CNPJ do emitente:"
            // com CNPJ explícito mas a tag veio sem CNPJ emitente, bloqueia. Evita emitir pela
            // empresa errada quando o operador (admin ou não) escreveu instrução clara mas a Ana
            // gerou tag de 4 campos por engano. Crítico fiscal/legal.
            const msgOriginal = String(contato?.mensagemOriginal || '');
            const padraoEmitente = /(?:emitente|cnpj\s*do\s*emitente|nf\s+d[oa]\s+\w+\s+\(cnpj)[^0-9]{0,20}(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/i;
            const matchEmitente = padraoEmitente.exec(msgOriginal);
            if (matchEmitente && !pareceCnpjEmitente) {
              const cnpjMencionado = matchEmitente[1].replace(/\D/g, '');
              console.log(`[WhatsApp] 🛑 EMITIR_NF bloqueado: mensagem mencionou emitente CNPJ ${cnpjMencionado} mas a tag não incluiu. Evitando emissão errada.`);
              acao.feedback = { sucesso: false, erro: `Você falou que o emitente é o CNPJ ${cnpjMencionado}, mas a tag veio sem o emitente. Reemita usando esse CNPJ como primeiro campo: [ACAO:EMITIR_NF:${cnpjMencionado}|...].` };
              break;
            }
            if (pareceCnpjEmitente) {
              const clienteEmitente = db.prepare(
                `SELECT id, razao_social, certificado_a1_path, certificado_a1_senha_encrypted
                 FROM clientes
                 WHERE REPLACE(REPLACE(REPLACE(cnpj, '.', ''), '/', ''), '-', '') = ?
                 LIMIT 1`
              ).get(primeiroLimpo);
              if (!clienteEmitente) {
                console.log(`[WhatsApp] ❌ EMITIR_NF: cliente emitente CNPJ ${primeiroLimpo} não encontrado na carteira`);
                acao.feedback = { sucesso: false, erro: `Não achei cliente com CNPJ ${primeiroLimpo} na carteira. Confere o CNPJ?` };
                break;
              }
              if (!clienteEmitente.certificado_a1_path || !clienteEmitente.certificado_a1_senha_encrypted) {
                console.log(`[WhatsApp] ❌ EMITIR_NF: ${clienteEmitente.razao_social} sem certificado A1`);
                acao.feedback = { sucesso: false, erro: `${clienteEmitente.razao_social} não tem certificado A1 configurado no portal. Sobe o certificado antes de emitir.` };
                break;
              }
              // Override: a NF vai sair em nome desse cliente, não do vínculo default do contato
              if (contato) {
                contato.cliente_id = clienteEmitente.id;
              } else {
                contato = { cliente_id: clienteEmitente.id };
              }
              console.log(`[WhatsApp] EMITIR_NF: emitente explícito = ${clienteEmitente.razao_social} (ID ${clienteEmitente.id})`);
            }
            // ===== fim MULTI-EMITENTE =====

            const clienteComCert = db.prepare(
              `SELECT id, razao_social FROM clientes
               WHERE certificado_a1_path IS NOT NULL AND certificado_a1_senha_encrypted IS NOT NULL
               ORDER BY id LIMIT 1`
            ).get();

            if (!contato?.cliente_id) {
              console.log(`[WhatsApp] ⚠️ EMITIR_NF: contato ${contato?.telefone || 'desconhecido'} não tem cliente_id vinculado. Tentando vincular automaticamente...`);
              const clienteAlvo = clienteComCert || db.prepare('SELECT id, razao_social FROM clientes LIMIT 1').get();
              if (clienteAlvo && contato) {
                db.prepare('UPDATE whatsapp_contatos SET cliente_id = ?, tipo = ? WHERE id = ?')
                  .run(clienteAlvo.id, 'cliente', contato.id);
                contato.cliente_id = clienteAlvo.id;
                console.log(`[WhatsApp] ✅ Contato vinculado automaticamente ao cliente ${clienteAlvo.razao_social} (ID ${clienteAlvo.id})`);
              } else {
                console.log(`[WhatsApp] ❌ Nenhum cliente cadastrado no sistema. NF não pode ser emitida.`);
                acao.feedback = { sucesso: false, erro: 'Nenhum cliente cadastrado no sistema' };
              }
            } else if (clienteComCert && contato.cliente_id !== clienteComCert.id) {
              // Contato vinculado a cliente SEM certificado — re-vincular ao que tem
              const clienteAtual = db.prepare('SELECT id, razao_social, certificado_a1_path FROM clientes WHERE id = ?').get(contato.cliente_id);
              if (!clienteAtual?.certificado_a1_path) {
                console.log(`[WhatsApp] ⚠️ Cliente atual (ID ${contato.cliente_id}) não tem certificado. Re-vinculando ao cliente ${clienteComCert.razao_social} (ID ${clienteComCert.id})`);
                db.prepare('UPDATE whatsapp_contatos SET cliente_id = ? WHERE id = ?')
                  .run(clienteComCert.id, contato.id);
                contato.cliente_id = clienteComCert.id;
              }
            }
          }
          if (acao.parametro && contato?.cliente_id) {
            try {
              // Formato novo (multi-emitente): cnpj_emitente|valor|cnpj_tomador|razao|descricao|[competencia]
              // Formato antigo (emissor default): valor|cnpj_tomador|razao|descricao|[competencia]
              const partes = acao.parametro.split('|');
              const primeiroLimpoParse = (partes[0] || '').replace(/\D/g, '');
              const temEmitenteExplicito = primeiroLimpoParse.length === 14 && partes.length >= 5;
              const idx = temEmitenteExplicito ? 1 : 0; // pula o campo emitente se presente
              const valor = parseFloat(partes[idx]?.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
              const documentoTomador = (partes[idx + 1]?.trim() || '').replace(/\D/g, ''); // só números
              const razaoSocialTomador = partes[idx + 2]?.trim() || '';
              const descricao = partes[idx + 3]?.trim() || 'Serviços prestados';
              const competencia = partes[idx + 4]?.trim() || new Date().toISOString().slice(0, 7);
              // 6º campo opcional: código de serviço (cTribNac) — usado quando o cliente emitente
              // ainda não tem código_servico cadastrado no painel (cliente novo ou múltiplas atividades).
              // A equipe extrai da mensagem (ex: "Código de Tributação Nacional: 04.01.01 - Medicina")
              // e passa como último campo da tag.
              // Normaliza: aceita formatos com pontos/espaços (ex: "02.01.01" → "020101")
              // pq o usuario tipicamente cola o codigo no formato oficial com pontos.
              let codigoServicoOverride = (partes[idx + 5]?.trim() || '').replace(/\D/g, '');

              // FALLBACK: se a tag nao tem 6o campo mas a mensagem original do user
              // mencionou um cTribNac explicito ("codigo de servico (cTribNac) 02.01.01",
              // "Codigo de Tributacao Nacional: 04.01.01", "cTribNac: 020101", etc.),
              // extrai com regex e usa. Defesa contra a Ana esquecer de incluir o codigo.
              if (!codigoServicoOverride && contato?.mensagemOriginal) {
                const _msg = String(contato.mensagemOriginal);
                // Padrao: c[oó]digo (de) servi[cç]o|tributa[cç][aã]o (nacional)|ctribnac|nbs
                // seguido de ":", "(...)"  ou nada, e depois 2-3 grupos de 2-3 digitos
                // separados por . - / ou espaco. Captura ate 6 digitos efetivos.
                const _patterns = [
                  /(?:c[óo]digo\s*(?:de\s+)?(?:servi[çc]o|tributa[çc][ãa]o)(?:\s+nacional)?|ctribnac|c\.?trib\.?nac\.?|nbs)\s*[\(\):,\.\-]*\s*(\d{2}[.\s\-/]?\d{2}[.\s\-/]?\d{2})/i,
                  // Fallback mais largo: se aparecer numero "XX.XX.XX" no texto, captura
                  /\b(\d{2}\.\d{2}\.\d{2})\b/
                ];
                for (const re of _patterns) {
                  const m = re.exec(_msg);
                  if (m && m[1]) {
                    const cand = m[1].replace(/\D/g, '');
                    if (cand.length === 6) {
                      codigoServicoOverride = cand;
                      console.log(`[WhatsApp] cTribNac extraido por fallback regex da mensagem: ${cand}`);
                      break;
                    }
                  }
                }
              }

              if (!documentoTomador || valor <= 0) {
                console.log(`[WhatsApp] NF não criada: CNPJ/CPF ausente (${documentoTomador}) ou valor inválido (${valor})`);
                // Armazena feedback para a resposta
                acao.feedback = { sucesso: false, erro: !documentoTomador ? 'CNPJ/CPF do tomador não informado' : 'Valor inválido' };
                break;
              }

              // Determina tipo de documento
              const tipoDocumento = documentoTomador.length <= 11 ? 'CPF' : 'CNPJ';

              // Busca tomador pelo CNPJ/CPF
              let tomador = db.prepare(`
                SELECT id, razao_social, documento FROM tomadores
                WHERE cliente_id = ? AND ativo = 1
                AND REPLACE(REPLACE(REPLACE(documento, '.', ''), '/', ''), '-', '') = ?
                LIMIT 1
              `).get(contato.cliente_id, documentoTomador);

              // Se não encontrou, consulta CNPJ na Receita e cadastra automaticamente
              if (!tomador) {
                let razaoFinal = razaoSocialTomador;
                let dadosReceita = null;

                // Se for CNPJ, consulta BrasilAPI pra pegar dados completos
                if (tipoDocumento === 'CNPJ') {
                  try {
                    dadosReceita = await cnpjService.consultarCNPJ(documentoTomador);
                    if (dadosReceita) {
                      razaoFinal = dadosReceita.razaoSocial || razaoSocialTomador;
                      console.log(`[WhatsApp] CNPJ consultado na Receita: ${razaoFinal} (${dadosReceita.situacaoCadastral})`);
                    }
                  } catch (cnpjErr) {
                    console.log(`[WhatsApp] Não conseguiu consultar CNPJ na Receita: ${cnpjErr.message}`);
                  }
                }

                if (!razaoFinal) {
                  console.log(`[WhatsApp] NF não criada: sem razão social pro tomador ${documentoTomador}`);
                  acao.feedback = { sucesso: false, erro: 'Não consegui identificar a razão social do tomador. Me passa o nome da empresa?' };
                  break;
                }

                console.log(`[WhatsApp] Cadastrando tomador: ${razaoFinal} (${documentoTomador})`);

                // Para CPF (e fallback de CNPJ), tenta extrair endereço da mensagem original
                // que a equipe digitou no WhatsApp. Receita não cobre CPF, então sem isso o
                // tomador novo fica sem endereço e a NF sai sem dados de localização.
                const enderecoMsg = this._parseEnderecoMensagem(contato?.mensagemOriginal || '');
                if (tipoDocumento === 'CPF' && (enderecoMsg.logradouro || enderecoMsg.cep)) {
                  console.log(`[WhatsApp] Endereço CPF extraído da mensagem: logr="${enderecoMsg.logradouro}" num="${enderecoMsg.numero}" bairro="${enderecoMsg.bairro}" cidade="${enderecoMsg.municipio}/${enderecoMsg.uf}" cep="${enderecoMsg.cep}"`);
                }

                // Tenta resolver código IBGE pelo município/UF parseado (necessário no XSD)
                let codigoIBGEMsg = '';
                if (enderecoMsg.municipio && enderecoMsg.uf) {
                  try {
                    codigoIBGEMsg = await cnpjService._buscarCodigoIBGE(enderecoMsg.municipio, enderecoMsg.uf);
                  } catch (ibgeErr) {
                    console.warn(`[WhatsApp] Falha buscando IBGE p/ ${enderecoMsg.municipio}/${enderecoMsg.uf}: ${ibgeErr.message}`);
                  }
                }

                // Mescla: dadosReceita tem prioridade (CNPJ); senão usa parse da mensagem (CPF/casos novos)
                const _logradouro    = dadosReceita?.logradouro    || enderecoMsg.logradouro || '';
                const _numero        = dadosReceita?.numero        || enderecoMsg.numero     || '';
                const _complemento   = dadosReceita?.complemento   || enderecoMsg.complemento|| '';
                const _bairro        = dadosReceita?.bairro        || enderecoMsg.bairro     || '';
                const _municipio     = dadosReceita?.municipio     || enderecoMsg.municipio  || '';
                const _uf            = dadosReceita?.uf            || enderecoMsg.uf         || '';
                const _cep           = dadosReceita?.cep           || enderecoMsg.cep        || '';
                const _codigoMun     = dadosReceita?.codigoMunicipio || codigoIBGEMsg        || '';

                const insertResult = db.prepare(`
                  INSERT INTO tomadores (
                    cliente_id, razao_social, nome_fantasia, documento, tipo_documento,
                    email, logradouro, numero, complemento, bairro,
                    municipio, uf, cep, codigo_municipio,
                    ativo, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
                `).run(
                  contato.cliente_id,
                  razaoFinal,
                  dadosReceita?.nomeFantasia || '',
                  documentoTomador,
                  tipoDocumento,
                  dadosReceita?.email || '',
                  _logradouro,
                  _numero,
                  _complemento,
                  _bairro,
                  _municipio,
                  _uf,
                  _cep,
                  _codigoMun
                );

                tomador = {
                  id: insertResult.lastInsertRowid,
                  razao_social: razaoFinal,
                  documento: documentoTomador
                };
                console.log(`[WhatsApp] Tomador cadastrado: ID ${tomador.id} ${dadosReceita ? '(com dados da Receita)' : '(dados básicos)'}`);
              }

              if (!tomador) {
                console.log(`[WhatsApp] NF não criada: impossível identificar tomador`);
                acao.feedback = { sucesso: false, erro: 'Não foi possível identificar o tomador' };
                break;
              }

              // Busca dados do cliente para alíquota e código de serviço
              const clienteData = db.prepare('SELECT codigo_servico, aliquota_iss FROM clientes WHERE id = ?').get(contato.cliente_id);

              // Calcula valores fiscais
              const aliquotaIss = clienteData?.aliquota_iss || 0;
              const valorIss = valor * aliquotaIss;
              const baseCalculo = valor;
              const valorLiquido = valor - valorIss;

              // Gera próximo numero_dps para o cliente
              const ultimaDps = db.prepare(`
                SELECT numero_dps FROM notas_fiscais
                WHERE cliente_id = ? AND numero_dps IS NOT NULL
                ORDER BY CAST(numero_dps AS INTEGER) DESC LIMIT 1
              `).get(contato.cliente_id);
              const numeroDps = ultimaDps ? String(parseInt(ultimaDps.numero_dps) + 1) : '1';

              // Cria NF com status pendente_emissao
              const result = db.prepare(`
                INSERT INTO notas_fiscais (
                  cliente_id, tomador_id, valor_servico, descricao_servico,
                  data_competencia, status, codigo_servico, aliquota_iss,
                  valor_iss, base_calculo, valor_liquido, origem,
                  numero_dps, serie_dps,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pendente_emissao', ?, ?, ?, ?, ?, 'whatsapp', ?, '1', datetime('now'), datetime('now'))
              `).run(
                contato.cliente_id,
                tomador.id,
                valor,
                descricao,
                competencia,
                codigoServicoOverride || clienteData?.codigo_servico || '',
                aliquotaIss,
                valorIss,
                baseCalculo,
                valorLiquido,
                numeroDps
              );

              const nfId = result.lastInsertRowid;
              console.log(`[WhatsApp] NF criada: ID ${nfId}, R$ ${valor} para ${tomador.razao_social} (${tomador.documento})`);

              // Auto-persistência: se a Ana passou cTribNac explicitamente (6º campo) E o cliente
              // emitente não tinha código cadastrado, grava no cadastro pra não precisar passar de
              // novo na próxima NF. Protegido pra NÃO sobrescrever clientes que já tenham código
              // (respeita cliente com múltiplas atividades onde o código muda por NF).
              if (codigoServicoOverride && (!clienteData?.codigo_servico || clienteData.codigo_servico.trim() === '')) {
                try {
                  db.prepare('UPDATE clientes SET codigo_servico = ?, updated_at = datetime(\'now\') WHERE id = ? AND (codigo_servico IS NULL OR codigo_servico = \'\')').run(codigoServicoOverride, contato.cliente_id);
                  console.log(`[WhatsApp] auto-upsert: codigo_servico=${codigoServicoOverride} gravado no cliente ${contato.cliente_id} (era vazio)`);
                } catch (e) {
                  console.warn(`[WhatsApp] auto-upsert de codigo_servico falhou: ${e.message}`);
                }
              }

              // Tenta emitir automaticamente
              let emissaoStatus = 'pendente_emissao';
              let emissaoInfo = '';
              let emissaoChaveAcesso = '';

              try {
                const nfseService = require('./nfseNacionalService');
                const notaCompleta = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(nfId);
                const clienteCompleto = db.prepare('SELECT * FROM clientes WHERE id = ?').get(contato.cliente_id);
                const tomadorCompleto = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomador.id);

                // Pré-validação e enriquecimento automático
                const preValidacaoService = require('./preValidacaoNfseService');
                const validacao = await preValidacaoService.validarEEnriquecer(notaCompleta, clienteCompleto, tomadorCompleto);

                if (!validacao.valido) {
                  const msgErros = validacao.erros.join('; ');
                  db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                    .run('erro_emissao', `Pré-validação: ${msgErros}`, nfId);
                  emissaoStatus = 'erro_emissao';
                  emissaoInfo = `Dados incompletos: ${msgErros}`;
                  console.log(`[WhatsApp] NF ${nfId}: pré-validação falhou - ${msgErros}`);
                } else if (process.env.NFSE_SIMULACAO === 'true') {
                  // Modo simulação
                  const numSim = `SIM-${Date.now()}`;
                  db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, data_emissao = datetime(?) WHERE id = ?')
                    .run('emitida', numSim, new Date().toISOString(), nfId);
                  emissaoStatus = 'emitida';
                  emissaoInfo = numSim;
                  console.log(`[WhatsApp] NF ${nfId} emitida em modo simulação: ${numSim}`);
                } else {
                  // Verifica se o cliente tem certificado digital
                  if (!clienteCompleto.certificado_a1_path) {
                    db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                      .run('erro_emissao', 'Cliente sem certificado digital A1 configurado', nfId);
                    emissaoStatus = 'erro_emissao';
                    emissaoInfo = 'Cliente sem certificado digital A1. A NF foi criada mas precisa do certificado pra emitir.';
                    console.log(`[WhatsApp] NF ${nfId}: cliente sem certificado A1`);
                  } else {
                    // Emissão real via Portal Nacional (dados já validados e enriquecidos)
                    const resultado = await nfseService.emitirNFSe(notaCompleta, clienteCompleto, tomadorCompleto);
                    if (resultado.sucesso) {
                      db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, chave_acesso = ?, data_emissao = datetime(?) WHERE id = ?')
                        .run('emitida', resultado.numeroNfse, resultado.chaveAcesso, new Date().toISOString(), nfId);
                      emissaoStatus = 'emitida';
                      emissaoInfo = resultado.numeroNfse;
                      emissaoChaveAcesso = resultado.chaveAcesso;
                      console.log(`[WhatsApp] NF ${nfId} emitida com sucesso: numero=${resultado.numeroNfse}, chave=${resultado.chaveAcesso}`);
                    } else {
                      db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                        .run('erro_emissao', resultado.erro, nfId);
                      emissaoStatus = 'erro_emissao';
                      emissaoInfo = resultado.erro;
                      console.error(`[WhatsApp] Erro na emissão NF ${nfId}: ${resultado.erro}`);
                    }
                  }
                }
              } catch (emissaoErr) {
                // emissaoErr pode ser um Error nativo OU um objeto custom { statusCode, mensagem, detalhes }
                let errMsg = emissaoErr.mensagem || emissaoErr.message || JSON.stringify(emissaoErr).substring(0, 500);
                const errDetalhes = emissaoErr.detalhes ? JSON.stringify(emissaoErr.detalhes, null, 2).substring(0, 1000) : '';
                // Extrai erros estruturados do SEFIN (array em detalhes.erros) pra mensagem útil
                // ao usuário e pra que o classificador da Ana reconheça os códigos (E0116, E0617, RNG…).
                const _sefinErros = (emissaoErr.detalhes && Array.isArray(emissaoErr.detalhes.erros)) ? emissaoErr.detalhes.erros : [];
                if (_sefinErros.length > 0) {
                  errMsg = _sefinErros.map(e => `${e.Codigo || e.codigo || '?'}: ${e.Descricao || e.descricao || ''}`).join(' | ');
                }
                console.error(`[WhatsApp] Erro ao tentar emitir NF ${nfId}: ${errMsg}`);
                if (errDetalhes) console.error(`[WhatsApp] Detalhes SEFIN: ${errDetalhes}`);

                // Sprint 1.5 — Auto-fix: tenta corrigir mecanicamente e re-emitir UMA vez
                let autoFixObs = '';
                if (!notaCompleta._autoFixTentado) {
                  try {
                    const anaAutoFixService = require('./anaAutoFixService');
                    const codigosSefin = _sefinErros.map(e => String(e.Codigo || e.codigo || '').toUpperCase());
                    const fix = await anaAutoFixService.tentarCorrecao({
                      erroMsg: errMsg,
                      codigosSefin,
                      cliente: clienteCompleto,
                      tomador: tomadorCompleto,
                      nota: notaCompleta,
                      db,
                    });

                    if (fix && fix.aplicou) {
                      notaCompleta._autoFixTentado = true;
                      autoFixObs = ` | [AutoFix: ${fix.motivo}]`;
                      console.log(`[AutoFix] ✅ ${fix.motivo} — re-tentando emissão NF ${nfId}`);

                      // Recarrega entidades do banco se foram alteradas
                      const cli2 = fix.recarregar?.cliente
                        ? db.prepare('SELECT * FROM clientes WHERE id = ?').get(contato.cliente_id)
                        : clienteCompleto;
                      const tom2 = fix.recarregar?.tomador
                        ? db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomador.id)
                        : tomadorCompleto;

                      try {
                        const r2 = await nfseService.emitirNFSe(notaCompleta, cli2, tom2);
                        if (r2.sucesso) {
                          db.prepare('UPDATE notas_fiscais SET status = ?, numero_nfse = ?, chave_acesso = ?, data_emissao = datetime(?), observacoes = ? WHERE id = ?')
                            .run('emitida', r2.numeroNfse, r2.chaveAcesso, new Date().toISOString(), `[AutoFix aplicado: ${fix.motivo}]`, nfId);
                          emissaoStatus = 'emitida';
                          emissaoInfo = r2.numeroNfse;
                          emissaoChaveAcesso = r2.chaveAcesso;
                          console.log(`[WhatsApp] ✅ NF ${nfId} emitida APÓS AutoFix: numero=${r2.numeroNfse}`);
                        } else {
                          errMsg = `${errMsg} (auto-fix tentado: ${fix.motivo}; SEFIN ainda recusou: ${r2.erro})`;
                        }
                      } catch (e2) {
                        const e2Msg = e2.mensagem || e2.message || String(e2);
                        errMsg = `${errMsg} (auto-fix tentado: ${fix.motivo}; nova falha: ${e2Msg.substring(0, 200)})`;
                      }
                    }
                  } catch (autoFixErr) {
                    console.warn('[AutoFix] erro no service:', autoFixErr.message);
                  }
                }

                // Persiste erro só se a re-emissão não conseguiu salvar
                if (emissaoStatus !== 'emitida') {
                  db.prepare('UPDATE notas_fiscais SET status = ?, observacoes = ? WHERE id = ?')
                    .run('erro_emissao', `${errMsg}${errDetalhes ? ' | ' + errDetalhes : ''}${autoFixObs}`, nfId);
                  emissaoStatus = 'erro_emissao';
                  emissaoInfo = errMsg;
                }
              }

              // Armazena feedback para a resposta
              acao.feedback = {
                sucesso: emissaoStatus === 'emitida',
                nfId,
                status: emissaoStatus,
                numero: emissaoInfo,
                chaveAcesso: emissaoChaveAcesso,
                tomador: tomador.razao_social,
                valor
              };

            } catch (err) {
              console.error('[WhatsApp] Erro ao criar NF:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'CADASTRAR_A1':
          // Formato: [ACAO:CADASTRAR_A1:cnpj|senha]
          // A equipe deve ter anexado o arquivo .pfx nos últimos 30min na mesma conversa.
          if (acao.parametro) {
            try {
              const a1Partes = acao.parametro.split('|');
              const cnpjA1 = (a1Partes[0] || '').replace(/\D/g, '');
              const senhaA1 = (a1Partes.slice(1).join('|') || '').trim(); // senha pode ter pipes

              if (cnpjA1.length !== 14) {
                acao.feedback = { sucesso: false, erro: 'CNPJ inválido — precisa dos 14 dígitos do cliente dono do certificado.' };
                break;
              }
              if (!senhaA1) {
                acao.feedback = { sucesso: false, erro: 'Senha do certificado ausente. Formato: [ACAO:CADASTRAR_A1:cnpj|senha].' };
                break;
              }

              console.log(`[WhatsApp] CADASTRAR_A1 iniciando: cnpj=${cnpjA1}, conversaId=${conversaId}`);

              const cliA1 = db.prepare(`SELECT id, razao_social FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(cnpjA1);
              if (!cliA1) {
                console.log(`[WhatsApp] CADASTRAR_A1: cliente CNPJ ${cnpjA1} não está na carteira`);
                acao.feedback = { sucesso: false, erro: `Cliente com CNPJ ${cnpjA1} não encontrado na carteira. Cadastre o cliente antes de subir o A1.` };
                break;
              }
              console.log(`[WhatsApp] CADASTRAR_A1: cliente encontrado: ${cliA1.razao_social} (id=${cliA1.id})`);

              const anexo = anexoCacheService.buscarUltimo(conversaId);
              if (!anexo || !anexo.url) {
                console.log(`[WhatsApp] CADASTRAR_A1: NENHUM anexo encontrado pra conversaId=${conversaId}`);
                acao.feedback = { sucesso: false, erro: 'Não achei arquivo .pfx anexado nessa conversa (ou expirou, TTL 30min). Reenvie o certificado como documento e já emenda a mensagem "CADASTRAR_A1".' };
                break;
              }
              console.log(`[WhatsApp] CADASTRAR_A1: anexo encontrado, baixando de ${anexo.url.substring(0, 80)}...`);

              // Baixa o arquivo do URL Z-API
              let pfxBuffer;
              try {
                pfxBuffer = await new Promise((resolve, reject) => {
                  const req = https.get(anexo.url, (res) => {
                    if (res.statusCode !== 200) {
                      reject(new Error(`Download do anexo falhou (HTTP ${res.statusCode})`));
                      return;
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                  });
                  req.on('error', reject);
                  req.setTimeout(20000, () => req.destroy(new Error('Download timeout')));
                });
              } catch (downloadErr) {
                console.error(`[WhatsApp] CADASTRAR_A1: falha no download do anexo: ${downloadErr.message}`);
                acao.feedback = { sucesso: false, erro: `Não consegui baixar o arquivo .pfx: ${downloadErr.message}. Tenta reenviar.` };
                break;
              }
              console.log(`[WhatsApp] CADASTRAR_A1: download OK, ${pfxBuffer.length} bytes`);

              if (pfxBuffer.length < 100) {
                acao.feedback = { sucesso: false, erro: 'Arquivo baixado é muito pequeno — anexo corrompido ou URL inválida.' };
                break;
              }

              // Valida + salva (certificadoService faz ambos)
              let infoCert;
              try {
                const resultSalvar = certificadoService.salvarCertificado(cliA1.id, pfxBuffer, senhaA1);
                infoCert = resultSalvar.info;
                console.log(`[WhatsApp] CADASTRAR_A1: salvarCertificado OK, validade=${infoCert.validade?.fim}, CNPJ cert=${infoCert.cnpj}`);
              } catch (errCert) {
                console.error(`[WhatsApp] CADASTRAR_A1: salvarCertificado falhou: ${errCert.message}`);
                acao.feedback = { sucesso: false, erro: `Certificado inválido: ${errCert.message}` };
                break;
              }

              console.log(`[WhatsApp] CADASTRAR_A1: cliente ${cliA1.id} (${cliA1.razao_social}) — A1 válido até ${infoCert.validade?.fim}, CNPJ cert=${infoCert.cnpj}`);

              // Limpa o cache após uso (evita re-cadastro acidental)
              anexoCacheService.esquecer(conversaId);

              acao.feedback = {
                sucesso: true,
                clienteId: cliA1.id,
                razao: cliA1.razao_social,
                titular: infoCert.titular,
                cnpjCert: infoCert.cnpj,
                validade: infoCert.validade?.fim,
                diasRestantes: infoCert.diasRestantes,
              };
            } catch (err) {
              console.error('[WhatsApp] Erro CADASTRAR_A1:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'ATUALIZAR_CLIENTE':
          // Formato: [ACAO:ATUALIZAR_CLIENTE:cnpj|campo=valor|campo=valor...]
          // Campos permitidos (whitelist): optante_simples, aliquota_iss, codigo_servico,
          // descricao_servico_padrao, regime_especial, incentivo_fiscal, inscricao_municipal,
          // codigo_municipio, municipio, uf, cep, logradouro, numero, bairro
          if (acao.parametro) {
            try {
              const atuPartes = acao.parametro.split('|');
              const cnpjAlvo = (atuPartes[0] || '').replace(/\D/g, '');
              if (cnpjAlvo.length !== 14) {
                acao.feedback = { sucesso: false, erro: 'CNPJ inválido — preciso dos 14 dígitos do cliente emitente.' };
                break;
              }
              const cliAlvo = db.prepare(`SELECT id, razao_social, optante_simples, aliquota_iss, codigo_servico FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(cnpjAlvo);
              if (!cliAlvo) {
                acao.feedback = { sucesso: false, erro: `Cliente com CNPJ ${cnpjAlvo} não encontrado na carteira.` };
                break;
              }

              const CAMPOS_PERMITIDOS = new Set([
                'optante_simples', 'aliquota_iss', 'codigo_servico', 'descricao_servico_padrao',
                'regime_especial', 'incentivo_fiscal', 'inscricao_municipal',
                'codigo_municipio', 'municipio', 'uf', 'cep', 'logradouro', 'numero', 'bairro',
              ]);
              const normalizarBool = (v) => {
                const x = String(v).trim().toLowerCase();
                if (['1','true','sim','yes','simples','y','t','s'].includes(x)) return 1;
                if (['0','false','nao','não','no','n','f'].includes(x)) return 0;
                return null;
              };
              const normalizarAliquota = (v) => {
                const x = String(v).replace('%','').replace(',','.').trim();
                const n = parseFloat(x);
                if (isNaN(n)) return null;
                // Se veio como percentual (ex: "5" ou "5.0"), converte pra fração (0.05)
                return n > 1 ? n / 100 : n;
              };

              const updates = {};
              const erros = [];
              for (let i = 1; i < atuPartes.length; i++) {
                const kv = atuPartes[i];
                const eq = kv.indexOf('=');
                if (eq < 0) continue;
                const campo = kv.slice(0, eq).trim().toLowerCase();
                const valor = kv.slice(eq + 1).trim();
                if (!CAMPOS_PERMITIDOS.has(campo)) {
                  erros.push(`campo "${campo}" não permitido (permitidos: ${[...CAMPOS_PERMITIDOS].join(', ')})`);
                  continue;
                }
                if (campo === 'optante_simples' || campo === 'incentivo_fiscal') {
                  const b = normalizarBool(valor);
                  if (b === null) { erros.push(`${campo}: valor "${valor}" inválido, use 1/0 ou sim/não`); continue; }
                  updates[campo] = b;
                } else if (campo === 'aliquota_iss') {
                  const a = normalizarAliquota(valor);
                  if (a === null) { erros.push(`aliquota_iss: valor "${valor}" inválido`); continue; }
                  updates[campo] = a;
                } else if (campo === 'uf') {
                  updates[campo] = valor.toUpperCase().slice(0, 2);
                } else {
                  updates[campo] = valor;
                }
              }

              if (erros.length > 0) {
                acao.feedback = { sucesso: false, erro: 'Falhas na validação: ' + erros.join('; ') };
                break;
              }
              if (Object.keys(updates).length === 0) {
                acao.feedback = { sucesso: false, erro: 'Nenhum campo válido informado.' };
                break;
              }

              const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
              const valuesArr = Object.values(updates);
              db.prepare(`UPDATE clientes SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(...valuesArr, cliAlvo.id);
              console.log(`[WhatsApp] ATUALIZAR_CLIENTE: cliente ${cliAlvo.id} (${cliAlvo.razao_social}) — ${Object.entries(updates).map(([k,v])=>`${k}=${v}`).join(', ')}`);

              acao.feedback = {
                sucesso: true,
                clienteId: cliAlvo.id,
                razao: cliAlvo.razao_social,
                atualizados: updates,
              };
            } catch (err) {
              console.error('[WhatsApp] Erro ATUALIZAR_CLIENTE:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'CANCELAR_NF':
          // Formato: [ACAO:CANCELAR_NF:numero_ou_chave|motivo]
          // - numero_ou_chave: número da NFS-e (4+ dígitos) OU chave de acesso (47+ dígitos)
          // - motivo: texto livre (exigido pela RFB, min 15 chars; se menor, completa)
          if (acao.parametro) {
            try {
              const cancPartes = acao.parametro.split('|');
              const alvo = (cancPartes[0] || '').trim();
              let motivo = (cancPartes[1] || '').trim();

              if (!alvo) {
                acao.feedback = { sucesso: false, erro: 'Informe o número da NF ou chave de acesso.' };
                break;
              }

              // Motivo min 15 chars (exigência do padrão nacional); se menor, preenche
              if (!motivo) motivo = 'Cancelamento solicitado pelo emitente';
              if (motivo.length < 15) motivo = motivo.padEnd(15, '.');

              // Busca a NF: chave (>=40 dígitos) tem prioridade; senão tenta por número
              const alvoLimpo = alvo.replace(/\D/g, '');
              let nf = null;
              if (alvoLimpo.length >= 40) {
                nf = db.prepare(`SELECT id, cliente_id, numero_nfse, chave_acesso, status FROM notas_fiscais WHERE chave_acesso = ? LIMIT 1`).get(alvoLimpo);
              } else if (alvoLimpo.length >= 1) {
                const matches = db.prepare(`SELECT id, cliente_id, numero_nfse, chave_acesso, status FROM notas_fiscais WHERE numero_nfse = ? ORDER BY id DESC`).all(alvoLimpo);
                if (matches.length === 1) nf = matches[0];
                else if (matches.length > 1) {
                  acao.feedback = { sucesso: false, erro: `Achei ${matches.length} NFs com o número ${alvoLimpo}. Me passa a chave de acesso completa (47 dígitos) pra eu cancelar a certa.` };
                  break;
                }
              }

              if (!nf) {
                acao.feedback = { sucesso: false, erro: `NF não encontrada (${alvo}). Confere o número ou manda a chave.` };
                break;
              }
              if (nf.status === 'cancelada') {
                acao.feedback = { sucesso: false, erro: `NF ${nf.numero_nfse} já está cancelada.` };
                break;
              }
              if (!nf.chave_acesso) {
                acao.feedback = { sucesso: false, erro: `NF ${nf.numero_nfse} não tem chave de acesso no sistema — pode não ter sido autorizada ainda.` };
                break;
              }

              const clienteEmit = db.prepare('SELECT id, razao_social, certificado_a1_senha_encrypted FROM clientes WHERE id = ?').get(nf.cliente_id);
              if (!clienteEmit || !clienteEmit.certificado_a1_senha_encrypted) {
                acao.feedback = { sucesso: false, erro: `Cliente emitente (ID ${nf.cliente_id}) sem certificado A1 configurado — não dá pra assinar o cancelamento.` };
                break;
              }

              console.log(`[WhatsApp] CANCELAR_NF: NF ${nf.id}, num=${nf.numero_nfse}, chave=${nf.chave_acesso}, emit=${clienteEmit.razao_social}`);
              const nfseService = require('./nfseNacionalService');
              let resultadoCanc;
              try {
                resultadoCanc = await nfseService.cancelarNFSe(nf.chave_acesso, motivo, clienteEmit.id, clienteEmit.certificado_a1_senha_encrypted);
              } catch (errCanc) {
                const msg = errCanc.mensagem || errCanc.message || JSON.stringify(errCanc).substring(0, 400);
                const tentativasUsadas = errCanc.tentativasUsadas || 1;
                console.error(`[WhatsApp] Erro ao cancelar NF ${nf.id} apos ${tentativasUsadas} tentativas:`, msg);

                // Se foi erro retentavel e esgotou as tentativas, agenda 1 retry adicional em 5min em background.
                // Nao esperamos esse retry — devolvemos feedback agora pro user.
                const retentavel = nfseService._erroEhRetentavel(errCanc);
                if (retentavel) {
                  console.log(`[WhatsApp] CANCELAR_NF ${nf.id}: agendando retry final em 5min (background)`);
                  // Captura referencias do escopo atual antes do setTimeout
                  const _nfBg = { id: nf.id, chave: nf.chave_acesso, numero: nf.numero_nfse };
                  const _emitBg = { id: clienteEmit.id, senha: clienteEmit.certificado_a1_senha_encrypted };
                  const _motivoBg = motivo;
                  const _telBg = contato?.telefone || null;
                  const _wa = this._obterWhatsAppProvider ? this._obterWhatsAppProvider() : null;
                  setTimeout(async () => {
                    try {
                      console.log(`[WhatsApp] CANCELAR_NF ${_nfBg.id}: retry agendado disparado agora`);
                      await nfseService.cancelarNFSe(_nfBg.chave, _motivoBg, _emitBg.id, _emitBg.senha, { maxTentativas: 2, delays: [30] });
                      const dbBg = require('../database/db').getDb();
                      dbBg.prepare(`UPDATE notas_fiscais SET status = 'cancelada', data_cancelamento = datetime('now'), observacoes = COALESCE(observacoes || ' | ', '') || ? WHERE id = ?`).run('Cancelamento ANA (retry agendado): ' + _motivoBg, _nfBg.id);
                      console.log(`[WhatsApp] CANCELAR_NF ${_nfBg.id}: sucesso no retry agendado`);
                      try {
                        if (_wa && _telBg && _wa.enviarTexto) {
                          await _wa.enviarTexto(_telBg, `\u2705 Consegui cancelar a NF ${_nfBg.numero} agora (retry automatico). Motivo: ${_motivoBg}`);
                        }
                      } catch (sendErr) { console.warn('[WhatsApp] falhou enviar msg do retry agendado:', sendErr.message); }
                    } catch (retryErr) {
                      console.error(`[WhatsApp] CANCELAR_NF ${_nfBg.id}: retry agendado tambem falhou:`, retryErr.mensagem || retryErr.message);
                      try {
                        if (_wa && _telBg && _wa.enviarTexto) {
                          await _wa.enviarTexto(_telBg, `\u26a0\ufe0f Tentei cancelar a NF ${_nfBg.numero} mais uma vez (5min depois) e a Receita continua devolvendo erro. Pode ser instabilidade do SEFIN. Tenta de novo daqui a 30min ou avisa o Thiago.`);
                        }
                      } catch (_) {}
                    }
                  }, 5 * 60 * 1000); // 5 minutos
                }

                acao.feedback = { sucesso: false, erro: `SEFIN rejeitou apos ${tentativasUsadas} tentativa(s): ${msg}`, retryAgendado: retentavel };
                break;
              }

              db.prepare(`UPDATE notas_fiscais SET status = 'cancelada', data_cancelamento = datetime('now'), observacoes = COALESCE(observacoes || ' | ', '') || ? WHERE id = ?`).run('Cancelamento ANA: ' + motivo, nf.id);
              console.log(`[WhatsApp] NF ${nf.id} (num ${nf.numero_nfse}) cancelada com sucesso pelo emitente ${clienteEmit.razao_social}`);

              acao.feedback = {
                sucesso: true,
                nfId: nf.id,
                numero: nf.numero_nfse,
                chaveAcesso: nf.chave_acesso,
                emitente: clienteEmit.razao_social,
                motivo,
              };
            } catch (err) {
              console.error('[WhatsApp] Erro ao processar CANCELAR_NF:', err);
              acao.feedback = { sucesso: false, erro: err.message };
            }
          }
          break;

        case 'BUSCAR_DANFSE':
          if (acao.parametro) {
            try {
              const busca = acao.parametro.trim();

              // Detecta admin/equipe com matching tolerante (variações de formato
              // Z-API: com/sem "9 extra" de celular, possível truncamento do último dígito).
              const adminPhoneRaw = (process.env.ANA_ADMIN_WHATSAPP || '').replace(/\D/g, '');
              const telefoneContatoRaw = (contato?.telefone || '').replace(/\D/g, '');
              const variantesTelefone = (num) => {
                if (!num) return new Set();
                const v = new Set([num]);
                // Com/sem 9 extra (13 ↔ 12 dígitos, BR)
                if (num.length === 13 && num.startsWith('55') && num[4] === '9') {
                  v.add(num.slice(0, 4) + num.slice(5));
                } else if (num.length === 12 && num.startsWith('55')) {
                  v.add(num.slice(0, 4) + '9' + num.slice(4));
                }
                return v;
              };
              const matchTelefone = (a, b) => {
                if (!a || !b) return false;
                const va = variantesTelefone(a);
                const vb = variantesTelefone(b);
                for (const x of va) for (const y of vb) {
                  if (x === y) return true;
                  // Tolerância final: prefixo comum de ≥10 dígitos cobre truncamento do último
                  const menor = x.length < y.length ? x : y;
                  const maior = x.length < y.length ? y : x;
                  if (menor.length >= 10 && maior.startsWith(menor)) return true;
                }
                return false;
              };
              const ehAdmin = matchTelefone(adminPhoneRaw, telefoneContatoRaw);
              const ehEquipe = ehAdmin || contato?.modoEquipe?.ehEquipe;

              // Em modo equipe (admin/equipe), o contato.cliente_id default é Marçal —
              // se usássemos como filtro, NF de outro emitente nunca seria encontrada e o
              // fallback "última NF de Marçal" devolveria PDF errado (já aconteceu, NF 122
              // sendo retornada quando equipe pediu NF 359 da AUREUM). Por isso, em modo
              // equipe começamos SEM filtro de cliente — só fixamos o cliente se a mensagem
              // mencionar CNPJ explícito ou nome do emitente reconhecível.
              let clienteIdParaBusca = ehEquipe ? null : (contato?.cliente_id || null);
              let cnpjMencionado = null;
              if (contato?.mensagemOriginal) {
                const cnpjMatch = contato.mensagemOriginal.match(/(\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2})/);
                if (cnpjMatch) {
                  const cnpjLimpo = cnpjMatch[1].replace(/\D/g, '');
                  if (cnpjLimpo.length === 14) {
                    cnpjMencionado = cnpjLimpo;
                    // Comparação em JS pra tolerar qualquer formato de armazenamento no banco
                    // (com pontuação, espaços, mascarado etc).
                    // Busca todos com CNPJ não-vazio e compara em JS (tolera qualquer formato de armazenamento).
                    // Nota: SQLite usa aspas SIMPLES pra string literal; "" seria referência a coluna.
                    const todosClientes = db.prepare("SELECT id, razao_social, cnpj FROM clientes WHERE cnpj IS NOT NULL AND TRIM(cnpj) != ''").all();
                    const clienteEncontrado = todosClientes.find(c => (c.cnpj || '').replace(/\D/g, '') === cnpjLimpo);
                    if (clienteEncontrado) {
                      clienteIdParaBusca = clienteEncontrado.id;
                      console.log(`[WhatsApp] BUSCAR_DANFSE: CNPJ ${cnpjLimpo} → ${clienteEncontrado.razao_social} (id=${clienteIdParaBusca})${ehEquipe ? ' (modo equipe)' : ''}`);
                    } else {
                      console.log(`[WhatsApp] BUSCAR_DANFSE: CNPJ ${cnpjLimpo} não encontrado na base de ${todosClientes.length} clientes`);
                    }
                  }
                }

                // Em modo equipe, se ainda não fixou cliente_id, tenta fuzzy-match por nome
                // do emitente na mensagem ("PDF da NF 359 da AUREUM ESPECIALIDADES MEDICAS").
                // Pega tokens de 4+ chars e procura cliente cuja razão social contenha pelo
                // menos 2 deles (evita match espúrio com palavras comuns).
                if (!clienteIdParaBusca && ehEquipe) {
                  const msgUpper = String(contato.mensagemOriginal).toUpperCase();
                  const tokens = (msgUpper.match(/[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4,}/g) || [])
                    .filter(t => !['NOTA','FISCAL','EMITENTE','TOMADOR','PARA','PARA','SOBRE','GERAR','BAIXAR','CONSEGUIU','ENCONTRADA','EMITIR','PORTAL','NACIONAL','AINDA','DISPONIVEL','ESTÁ','ESTA','DEPOIS','ESCRITORIO','ESCRITÓRIO','MARCAL','MARÇAL','CONTABILIDADE'].includes(t));
                  if (tokens.length >= 1) {
                    const todos = db.prepare("SELECT id, razao_social, cnpj FROM clientes WHERE razao_social IS NOT NULL").all();
                    let melhor = null;
                    let melhorScore = 0;
                    for (const c of todos) {
                      const rs = (c.razao_social || '').toUpperCase();
                      let score = 0;
                      for (const t of tokens) if (rs.includes(t)) score++;
                      if (score > melhorScore && score >= 2) { melhor = c; melhorScore = score; }
                      // Se token único E muito específico (ex: 8+ chars raro), aceita score 1
                      else if (score === 1 && tokens.length === 1 && tokens[0].length >= 8 && rs.includes(tokens[0]) && melhorScore === 0) { melhor = c; melhorScore = 1; }
                    }
                    if (melhor) {
                      clienteIdParaBusca = melhor.id;
                      console.log(`[WhatsApp] BUSCAR_DANFSE: fuzzy-match por nome → ${melhor.razao_social} (id=${melhor.id}, score=${melhorScore}, tokens=${tokens.join('|')})`);
                    }
                  }
                }
              }

              // Monta a query: com filtro de cliente_id se soubermos (modo cliente ou admin com CNPJ),
              // sem filtro (global) se for admin sem CNPJ — pois aí ele está buscando numa base grande.
              let nfEncontrada = null;
              if (clienteIdParaBusca) {
                nfEncontrada = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso, cliente_id, status
                  FROM notas_fiscais
                  WHERE cliente_id = ? AND status = 'emitida'
                  AND (numero_nfse = ? OR CAST(id AS TEXT) = ? OR numero_dps = ?)
                  ORDER BY created_at DESC LIMIT 1
                `).get(clienteIdParaBusca, busca, busca, busca);
              } else if (ehEquipe) {
                // Admin sem CNPJ mencionado → busca global, mas pede desambiguação se achar mais de um
                const candidatos = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso, cliente_id
                  FROM notas_fiscais
                  WHERE status = 'emitida' AND chave_acesso IS NOT NULL
                  AND (numero_nfse = ? OR CAST(id AS TEXT) = ? OR numero_dps = ?)
                  ORDER BY created_at DESC LIMIT 5
                `).all(busca, busca, busca);
                if (candidatos.length === 1) {
                  nfEncontrada = candidatos[0];
                } else if (candidatos.length > 1) {
                  const listaClientes = candidatos.map(c => {
                    const cli = db.prepare('SELECT razao_social, cnpj FROM clientes WHERE id = ?').get(c.cliente_id);
                    return `• NF ${c.numero_nfse || c.id} — ${cli?.razao_social || 'cliente ' + c.cliente_id} (CNPJ ${cli?.cnpj || '-'})`;
                  }).join('\n');
                  acao.feedback = {
                    sucesso: false,
                    erro: `Achei ${candidatos.length} NFs com esse número. Me diz o CNPJ do cliente:\n${listaClientes}`
                  };
                  console.log(`[WhatsApp] BUSCAR_DANFSE modo equipe: ambíguo (${candidatos.length} candidatos) pra busca "${busca}"`);
                  break;
                }
              }

              if (nfEncontrada && nfEncontrada.chave_acesso) {
                acao.feedback = {
                  sucesso: true,
                  nfId: nfEncontrada.id,
                  numero: nfEncontrada.numero_nfse || nfEncontrada.numero_dps,
                  chaveAcesso: nfEncontrada.chave_acesso
                };
                console.log(`[WhatsApp] DANFSe encontrado: NF ${nfEncontrada.numero_nfse || nfEncontrada.id}${ehEquipe ? ' (modo equipe)' : ''}`);
              } else if (clienteIdParaBusca && !ehEquipe) {
                // Fallback APENAS no modo cliente: pega a última NF emitida do cliente.
                // Em modo equipe NUNCA aplica fallback "última NF" — pq o contato.cliente_id
                // default é Marçal e a equipe acaba recebendo PDF de NF errada (NF 122 da
                // Marçal quando pediu NF 359 da AUREUM).
                const ultimaNf = db.prepare(`
                  SELECT id, numero_nfse, numero_dps, chave_acesso
                  FROM notas_fiscais
                  WHERE cliente_id = ? AND status = 'emitida' AND chave_acesso IS NOT NULL
                  ORDER BY created_at DESC LIMIT 1
                `).get(clienteIdParaBusca);

                if (ultimaNf) {
                  acao.feedback = {
                    sucesso: true,
                    nfId: ultimaNf.id,
                    numero: ultimaNf.numero_nfse || ultimaNf.numero_dps,
                    chaveAcesso: ultimaNf.chave_acesso
                  };
                  console.log(`[WhatsApp] DANFSe: usando última NF emitida: ${ultimaNf.numero_nfse || ultimaNf.id}`);
                } else {
                  acao.feedback = { sucesso: false, erro: 'Nenhuma NF emitida encontrada' };
                }
              } else if (ehEquipe) {
                acao.feedback = { sucesso: false, erro: `Não achei nenhuma NF com número ${busca}. Me diz o CNPJ do emitente (ou o nome completo da empresa) pra eu buscar certo — nunca devolvo "última NF" sem confirmação em modo equipe.` };
              } else {
                acao.feedback = { sucesso: false, erro: `Não achei nenhuma NF com número ${busca}. Me passa o CNPJ do cliente pra eu buscar certo.` };
              }
            } catch (err) {
              console.error('[WhatsApp] Erro ao buscar DANFSe:', err);
              acao.feedback = { sucesso: false, erro: err.message };
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

        case 'CONSULTAR_PGDASD_ULTIMA':
          await this._executarConsultaIntegraContador(acao, 'consultarUltimaDeclaracaoPGDASD', 'Última PGDAS-D');
          break;

        case 'CONSULTAR_PROCURACOES':
          await this._executarConsultaIntegraContador(acao, 'consultarProcuracoes', 'Procurações e-CAC');
          break;

        case 'CONSULTAR_DCTFWEB':
          await this._executarConsultaIntegraContador(acao, 'consultarRelacaoDCTFWeb', 'Relação DCTFWeb');
          break;

        case 'LISTAR_CAIXA_POSTAL':
          await this._executarConsultaIntegraContador(acao, 'listarMensagensCaixaPostal', 'Caixa Postal e-CAC');
          break;

        case 'GERAR_DAS_SIMPLES':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'DAS Simples Nacional',
            metodo: 'gerarDASSimples',
            prefixoArquivo: 'DAS_Simples',
            tipoParam: 'cnpj|periodoApuracao',
          });
          break;

        case 'GERAR_DAS_SIMPLES_AVULSO':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'DAS Simples (Avulso)',
            metodo: 'gerarDASSimplesAvulso',
            prefixoArquivo: 'DAS_Avulso',
            tipoParam: 'cnpj|periodoApuracao',
          });
          break;

        case 'GERAR_DAS_MEI':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'DAS MEI',
            metodo: 'gerarDASMEI',
            prefixoArquivo: 'DAS_MEI',
            tipoParam: 'cnpj|periodoApuracao',
          });
          break;

        case 'SOLICITAR_SITFIS':
          await this._executarAcaoSitfis(acao);
          break;

        case 'EMITIR_CCMEI':
          await this._executarAcaoSerproComPdf(acao, {
            rotulo: 'Certificado de Condicao de MEI',
            metodo: 'emitirCCMEI',
            prefixoArquivo: 'CCMEI',
            tipoParam: 'cnpj',
          });
          break;

        case 'EMITIR_DARF':
          await this._executarAcaoDarf(acao);
          break;

        case 'CONSULTAR_CADASTRO_CLIENTE':
          this._executarConsultarCadastro(acao, contato);
          break;

        // ── Ações João (back-office Domínio via daemon local) ─────────────
        case 'CLASSIFICAR_EXTRATO':
          this._enfileirarJobJoao(acao, contato, conversaId, {
            tipo: 'classificar_extrato',
            campos: ['cliente_id', 'pdf_url'],
            rotulo: 'classificar extrato',
          });
          break;

        case 'IMPORTAR_TXT_DOMINIO':
          this._enfileirarJobJoao(acao, contato, conversaId, {
            tipo: 'importar_txt',
            campos: ['cliente_id', 'codigo_empresa', 'caminho_txt', 'conjunto_dados'],
            rotulo: 'importar TXT no Domínio',
          });
          break;

        case 'GERAR_OBRIGACAO':
          this._enfileirarJobJoao(acao, contato, conversaId, {
            tipo: 'gerar_obrigacao',
            campos: ['cliente_id', 'sub_tipo', 'periodo'],
            rotulo: 'gerar obrigação contábil',
          });
          break;

        case 'MONITORAR_ONVIO':
          this._executarMonitorarOnvio(acao, contato);
          break;

        default:
          console.log(`[WhatsApp] Ação não implementada: ${acao.tipo}`);
      }
    }
  }

  /**
   * Liga/desliga monitoramento Onvio Documentos pra um cliente. Resposta imediata
   * (atualiza tabela onvio_monitored_clients direto, sem precisar do daemon).
   * Daemon João consome a tabela na próxima rodada do watcher.
   *
   * Parâmetro: cliente_id|estado (estado = 'on' | 'off')
   * Modo equipe only.
   */
  _executarMonitorarOnvio(acao, contato) {
    const rotulo = 'monitorar Onvio Documentos';
    const ehContextoEquipe = !!(contato?.modoEquipe?.ehEquipe || contato?.ehAdmin);
    if (!ehContextoEquipe) {
      acao.feedback = { sucesso: false, rotulo, erro: 'Ação só pra equipe Marçal.' };
      return;
    }
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, rotulo, erro: 'Parâmetro obrigatório: cliente_id|on|off' };
      return;
    }
    const partes = String(acao.parametro).split('|');
    const clienteId = parseInt(partes[0], 10);
    const estado = (partes[1] || '').trim().toLowerCase();
    if (!Number.isFinite(clienteId)) {
      acao.feedback = { sucesso: false, rotulo, erro: `cliente_id inválido: "${partes[0]}"` };
      return;
    }
    if (!['on', 'off'].includes(estado)) {
      acao.feedback = { sucesso: false, rotulo, erro: `estado deve ser 'on' ou 'off' (recebido: "${estado}")` };
      return;
    }

    try {
      const ativadoPor = `ana:${contato?.modoEquipe?.operador || (contato?.ehAdmin ? 'admin' : 'desconhecido')}`;
      const r = clienteSyncService.setOnvioMonitorado(clienteId, {
        ativo: estado === 'on',
        ativado_por: ativadoPor,
      });
      acao.feedback = {
        sucesso: true,
        rotulo,
        cliente_id: clienteId,
        estado,
        mensagem: estado === 'on'
          ? `Monitoramento Onvio LIGADO pro cliente #${clienteId}. Daemon vai checar a pasta a cada rodada.`
          : `Monitoramento Onvio DESLIGADO pro cliente #${clienteId}.`,
      };
      console.log(`[WhatsApp] ✓ Onvio monitor ${estado}: cliente=${clienteId} por ${ativadoPor}`);
    } catch (err) {
      acao.feedback = { sucesso: false, rotulo, erro: err.message };
      console.warn(`[WhatsApp] ❌ Falha em MONITORAR_ONVIO: ${err.message}`);
    }
  }

  /**
   * Consulta o cadastro de um cliente (prestador) e opcionalmente um tomador,
   * retornando relatório com campos faltando/inválidos. Substitui a alucinação
   * "campos faltando: pode ser X, Y, Z" pelo dado real do banco.
   *
   * Parametro: cnpj_prestador|cnpj_ou_cpf_tomador (tomador opcional)
   * Modo equipe only — cliente externo não consulta cadastro de carteira.
   */
  _executarConsultarCadastro(acao, contato) {
    const rotulo = 'consultar cadastro';
    const ehContextoEquipe = !!(contato?.modoEquipe?.ehEquipe || contato?.ehAdmin);
    if (!ehContextoEquipe) {
      acao.feedback = {
        sucesso: false,
        rotulo,
        erro: 'Consulta de cadastro é só pra equipe Marçal.',
      };
      console.warn('[WhatsApp] 🛑 CONSULTAR_CADASTRO_CLIENTE bloqueado: contexto não-equipe');
      return;
    }

    if (!acao.parametro) {
      acao.feedback = { sucesso: false, rotulo, erro: 'Parâmetro obrigatório: cnpj_prestador (e cnpj_tomador opcional separado por "|").' };
      return;
    }

    const partes = String(acao.parametro).split('|');
    const cnpjPrestador = (partes[0] || '').replace(/\D/g, '');
    const docTomador = partes[1] ? partes[1].replace(/\D/g, '') : null;

    if (cnpjPrestador.length !== 14) {
      acao.feedback = { sucesso: false, rotulo, erro: `CNPJ do prestador inválido: "${partes[0]}". Tem que ter 14 dígitos.` };
      return;
    }

    try {
      const cliente = clienteCadastroAuditor.buscarClientePorCnpj(cnpjPrestador);
      if (!cliente) {
        acao.feedback = { sucesso: false, rotulo, erro: `Não achei cliente com CNPJ ${cnpjPrestador} na carteira.` };
        return;
      }
      const auditCli = clienteCadastroAuditor.auditarCliente(cliente);

      let auditTom = null;
      if (docTomador && docTomador.length >= 11) {
        const tomador = clienteCadastroAuditor.buscarTomadorDoCliente(cliente.id, docTomador);
        if (!tomador) {
          const relatorio = clienteCadastroAuditor.formatarRelatorio(auditCli, null);
          acao.feedback = {
            sucesso: true,
            rotulo,
            relatorio: relatorio + `\n\n⚠️ Tomador com documento ${docTomador} NÃO cadastrado pra esse prestador. Antes de emitir, cadastra o tomador no painel.`,
          };
          return;
        }
        auditTom = clienteCadastroAuditor.auditarTomador(tomador);
      }

      const relatorio = clienteCadastroAuditor.formatarRelatorio(auditCli, auditTom);
      acao.feedback = { sucesso: true, rotulo, relatorio, auditCli, auditTom };
      console.log(`[WhatsApp] ✓ Cadastro consultado: cliente=${cliente.id}/${cliente.razao_social} | criticos=${auditCli.criticos}${auditTom ? ` | tomador_criticos=${auditTom.criticos}` : ''}`);
    } catch (err) {
      console.error('[WhatsApp] erro em CONSULTAR_CADASTRO_CLIENTE:', err);
      acao.feedback = { sucesso: false, rotulo, erro: `Erro consultando cadastro: ${err.message}` };
    }
  }

  /**
   * Enfileira um job pro daemon João. Só permite em modo equipe (clientes finais
   * não devem disparar back-office). Marca feedback na ação pra o caller responder
   * algo tipo "tô na fila, daemon avisa quando terminar".
   *
   * @param {Object} acao
   * @param {Object} contato — contatoExpandido com modoEquipe/ehAdmin
   * @param {number} conversaId
   * @param {Object} cfg
   * @param {string} cfg.tipo — joaoService TIPOS_VALIDOS
   * @param {string[]} cfg.campos — nomes ordenados dos campos do parametro pipe-separado
   * @param {string} cfg.rotulo — descrição humana ("classificar extrato")
   * @param {boolean} [cfg.requerAprovacao] — sobrescreve default (sensível por tipo)
   */
  _enfileirarJobJoao(acao, contato, conversaId, cfg) {
    // Bloqueia se não for modo equipe — clientes finais não disparam back-office
    const ehContextoEquipe = !!(contato?.modoEquipe?.ehEquipe || contato?.ehAdmin);
    if (!ehContextoEquipe) {
      acao.feedback = {
        sucesso: false,
        rotulo: cfg.rotulo,
        erro: 'Essa ação é do back-office, só posso disparar a pedido da equipe Marçal. Vou chamar o Thiago.',
      };
      console.warn(`[WhatsApp] 🛑 ${acao.tipo} bloqueado: cliente externo não pode disparar back-office`);
      return;
    }

    if (!acao.parametro) {
      acao.feedback = { sucesso: false, rotulo: cfg.rotulo, erro: `Parâmetros obrigatórios: ${cfg.campos.join('|')}` };
      return;
    }

    const partes = String(acao.parametro).split('|');
    const parametros = {};
    for (let i = 0; i < cfg.campos.length; i++) {
      const valor = (partes[i] || '').trim();
      if (!valor) {
        acao.feedback = {
          sucesso: false,
          rotulo: cfg.rotulo,
          erro: `Campo "${cfg.campos[i]}" faltando. Esperado: ${cfg.campos.join('|')}.`,
        };
        return;
      }
      parametros[cfg.campos[i]] = valor;
    }

    // cliente_id é número se estiver presente
    if (parametros.cliente_id) {
      const n = parseInt(parametros.cliente_id, 10);
      if (!Number.isFinite(n)) {
        acao.feedback = { sucesso: false, rotulo: cfg.rotulo, erro: `cliente_id inválido: ${parametros.cliente_id}` };
        return;
      }
      parametros.cliente_id = n;
    }

    try {
      const r = joaoService.enfileirar({
        tipo: cfg.tipo,
        cliente_id: parametros.cliente_id || null,
        parametros,
        criado_por: `ana:${contato?.modoEquipe?.operador || (contato?.ehAdmin ? 'admin' : 'desconhecido')}`,
        requer_aprovacao: cfg.requerAprovacao,
        origem_conversa_id: conversaId,
        origem_telefone: contato?.telefone || null,
        prioridade: 5,
      });
      const precisaAprovacao = r.status === 'pending_approval';
      acao.feedback = {
        sucesso: true,
        rotulo: cfg.rotulo,
        job_id: r.id,
        status: r.status,
        mensagem: precisaAprovacao
          ? `Job #${r.id} (${cfg.rotulo}) criado e aguardando aprovação no painel. Aprovado → daemon executa.`
          : `Job #${r.id} (${cfg.rotulo}) enfileirado. Daemon vai puxar em instantes — eu te aviso aqui quando terminar.`,
      };
      console.log(`[WhatsApp] ✓ João job enfileirado: id=${r.id} tipo=${cfg.tipo} status=${r.status}`);
    } catch (err) {
      acao.feedback = { sucesso: false, rotulo: cfg.rotulo, erro: err.message };
      console.warn(`[WhatsApp] ❌ Falha enfileirando João job (${cfg.tipo}): ${err.message}`);
    }
  }

  /**
   * Helper: executa uma acao SERPRO que retorna PDF base64. Decodifica, cacheia via
   * serproDocumentoService, gera token de download e popula acao.feedback com o link pronto.
   */
  async _executarAcaoSerproComPdf(acao, { rotulo, metodo, prefixoArquivo, tipoParam }) {
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'Parametros ausentes na acao', rotulo };
      return;
    }
    const partes = String(acao.parametro).split('|');
    const cnpj = (partes[0] || '').replace(/\D/g, '');
    if (cnpj.length !== 14) {
      acao.feedback = { sucesso: false, erro: `CNPJ invalido: ${partes[0]}`, rotulo };
      return;
    }
    const periodoApuracao = partes[1] || '';

    try {
      console.log(`[AgenteIA] ${rotulo}: chamando SERPRO pra ${cnpj} periodo=${periodoApuracao || 'N/A'}`);
      const serproDocumentoService = require('./serproDocumentoService');
      const certificadoService = require('./certificadoService');
      let resposta;
      if (tipoParam === 'cnpj|periodoApuracao') {
        if (!periodoApuracao) {
          acao.feedback = { sucesso: false, erro: 'Periodo de apuracao obrigatorio (YYYYMM ou YYYY)', rotulo };
          return;
        }
        resposta = await integraContadorService[metodo](cnpj, periodoApuracao);
      } else {
        resposta = await integraContadorService[metodo](cnpj);
      }

      const dados = this._parseDadosSerproResposta(resposta);
      const pdfBase64 = dados && (dados.pdf || dados.documento || dados.relatorio);
      if (!pdfBase64 || typeof pdfBase64 !== 'string' || pdfBase64.length < 100) {
        acao.feedback = { sucesso: false, erro: 'SERPRO nao retornou PDF no payload', rotulo, resposta_raw: resposta };
        return;
      }

      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      if (pdfBuffer.slice(0, 4).toString() !== '%PDF') {
        acao.feedback = { sucesso: false, erro: 'Conteudo recebido nao e PDF valido', rotulo };
        return;
      }

      const sufixo = periodoApuracao ? `_${periodoApuracao}` : '';
      const nomeArquivo = `${prefixoArquivo}_${cnpj}${sufixo}.pdf`;
      const titulo = `${rotulo}${periodoApuracao ? ` ${periodoApuracao}` : ''}`;
      const token = serproDocumentoService.gravar({
        pdf: pdfBuffer,
        nomeArquivo,
        titulo,
        metadata: { cnpj, operacao: metodo, periodoApuracao },
      });

      const { gerarToken } = require('../middleware/auth');
      const jwtToken = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'serpro-doc' });
      let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
      }
      const link = `${baseUrl}/api/integra-contador/documento/${token}?token=${jwtToken}`;

      acao.feedback = {
        sucesso: true,
        rotulo,
        cnpj,
        periodoApuracao,
        tamanhoPdfKb: Math.round(pdfBuffer.length / 1024),
        pdfEnvio: { link, nomeArquivo, titulo },
      };
    } catch (err) {
      console.error(`[AgenteIA] Falha ${rotulo} (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo };
    }
  }

  /**
   * Helper SITFIS: assincrono (solicita protocolo -> aguarda -> emite relatorio).
   * Usa o wrapper obterRelatorioSitfis do service que ja orquestra isso.
   */
  async _executarAcaoSitfis(acao) {
    const rotulo = 'Relatorio de Situacao Fiscal';
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'CNPJ obrigatorio', rotulo };
      return;
    }
    const cnpj = String(acao.parametro).replace(/\D/g, '');
    if (cnpj.length !== 14) {
      acao.feedback = { sucesso: false, erro: `CNPJ invalido: ${acao.parametro}`, rotulo };
      return;
    }
    try {
      const serproDocumentoService = require('./serproDocumentoService');
      console.log(`[AgenteIA] SITFIS: solicitando pra ${cnpj}...`);
      const { pdfBase64, protocolo, tentativas } = await integraContadorService.obterRelatorioSitfis(cnpj);
      if (!pdfBase64) {
        acao.feedback = { sucesso: false, erro: 'SITFIS sem PDF apos retries', rotulo };
        return;
      }
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const nomeArquivo = `SITFIS_${cnpj}.pdf`;
      const titulo = `Situacao Fiscal — CNPJ ${cnpj}`;
      const token = serproDocumentoService.gravar({ pdf: pdfBuffer, nomeArquivo, titulo, metadata: { cnpj, operacao: 'sitfis', protocolo } });
      const { gerarToken } = require('../middleware/auth');
      const jwtToken = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'serpro-doc' });
      let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
      }
      const link = `${baseUrl}/api/integra-contador/documento/${token}?token=${jwtToken}`;
      acao.feedback = {
        sucesso: true,
        rotulo,
        cnpj,
        tentativas,
        protocolo,
        tamanhoPdfKb: Math.round(pdfBuffer.length / 1024),
        pdfEnvio: { link, nomeArquivo, titulo },
      };
    } catch (err) {
      console.error(`[AgenteIA] SITFIS falhou (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo };
    }
  }

  /**
   * Helper DARF via Sicalc — parametros: cnpj|codigoReceita|periodoApuracao|dataVencimento|valorPrincipal
   */
  async _executarAcaoDarf(acao) {
    const rotulo = 'DARF (Sicalc)';
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'Parametros ausentes', rotulo };
      return;
    }
    const partes = String(acao.parametro).split('|');
    const cnpj = (partes[0] || '').replace(/\D/g, '');
    let codigoReceita = String(partes[1] || '').trim();
    const periodoApuracao = String(partes[2] || '').trim();
    let dataVencimento = String(partes[3] || '').trim();
    const valorPrincipal = parseFloat(partes[4] || '0');

    const mapaTributo = {
      IRPJ: '2362', CSLL: '2372', COFINS: '5952', PIS: '8109',
      PISPASEP: '8109', IRRF: '0561', INSS: '1007',
    };
    if (codigoReceita && !/^\d{3,4}$/.test(codigoReceita)) {
      const up = codigoReceita.toUpperCase().replace(/[^A-Z]/g, '');
      if (mapaTributo[up]) {
        console.log(`[AgenteIA] DARF: tributo "${codigoReceita}" -> codigo ${mapaTributo[up]}`);
        codigoReceita = mapaTributo[up];
      }
    }

    if (!dataVencimento && /^\d{6}$/.test(periodoApuracao)) {
      const ano = parseInt(periodoApuracao.slice(0, 4), 10);
      const mes = parseInt(periodoApuracao.slice(4, 6), 10);
      const proxMes = mes === 12 ? 1 : mes + 1;
      const proxAno = mes === 12 ? ano + 1 : ano;
      const diaUltimo = new Date(proxAno, proxMes, 0).getDate();
      let dt = new Date(proxAno, proxMes - 1, diaUltimo);
      while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() - 1);
      const dd = String(dt.getDate()).padStart(2, '0');
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const aaaa = String(dt.getFullYear());
      dataVencimento = `${dd}${mm}${aaaa}`;
      console.log(`[AgenteIA] DARF: vencimento calculado ${dataVencimento} (periodo ${periodoApuracao})`);
    }

    if (cnpj.length !== 14 || !codigoReceita || !periodoApuracao || !dataVencimento || !valorPrincipal) {
      acao.feedback = { sucesso: false, erro: 'Faltou algum campo obrigatorio (cnpj, tributo/codigo, periodo YYYYMM, valor). Vencimento e opcional - eu calculo.', rotulo };
      return;
    }
    try {
      const serproDocumentoService = require('./serproDocumentoService');
      const dados = { codigoReceita, periodoApuracao, dataVencimento, valorPrincipal };
      console.log(`[AgenteIA] DARF: ${cnpj} cod=${codigoReceita} periodo=${periodoApuracao}`);
      const resposta = await integraContadorService.gerarDARF(cnpj, dados);
      const d = this._parseDadosSerproResposta(resposta);
      const pdfBase64 = d && (d.pdf || d.documento);
      if (!pdfBase64) {
        acao.feedback = { sucesso: false, erro: 'SERPRO nao retornou PDF do DARF', rotulo, resposta_raw: resposta };
        return;
      }
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const nomeArquivo = `DARF_${cnpj}_${periodoApuracao}.pdf`;
      const titulo = `DARF — CNPJ ${cnpj} ${periodoApuracao}`;
      const token = serproDocumentoService.gravar({ pdf: pdfBuffer, nomeArquivo, titulo, metadata: { cnpj, operacao: 'darf', periodoApuracao } });
      const { gerarToken } = require('../middleware/auth');
      const jwtToken = gerarToken({ id: 0, tipo: 'escritorio', papel: 'sistema', uso: 'serpro-doc' });
      let baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      if (baseUrl.startsWith('http://') && !baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
      }
      const link = `${baseUrl}/api/integra-contador/documento/${token}?token=${jwtToken}`;
      acao.feedback = { sucesso: true, rotulo, cnpj, tamanhoPdfKb: Math.round(pdfBuffer.length / 1024), pdfEnvio: { link, nomeArquivo, titulo } };
    } catch (err) {
      console.error(`[AgenteIA] DARF falhou (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo };
    }
  }

  /**
   * Extrai 'dados' da resposta SERPRO (pode vir como string JSON).
   */
  _parseDadosSerproResposta(resposta) {
    if (!resposta) return null;
    let d = resposta.dados;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { /* mantem string */ }
    }
    return d;
  }

  /**
   * Helper: executa uma consulta read-only ao Integra Contador
   * Armazena o resultado em acao.feedback pra ser anexado à resposta
   */
  async _executarConsultaIntegraContador(acao, metodo, rotuloHumano) {
    if (!acao.parametro) {
      acao.feedback = { sucesso: false, erro: 'CNPJ não informado na ação' };
      return;
    }
    const cnpj = String(acao.parametro).replace(/\D/g, '');
    if (cnpj.length !== 14) {
      acao.feedback = { sucesso: false, erro: `CNPJ inválido: ${acao.parametro}` };
      return;
    }
    try {
      console.log(`[AgenteIA] ${rotuloHumano}: chamando Integra Contador pra ${cnpj}`);
      const resultado = await integraContadorService[metodo](cnpj);
      acao.feedback = { sucesso: true, rotulo: rotuloHumano, cnpj, resultado };
    } catch (err) {
      console.error(`[AgenteIA] Falha ${rotuloHumano} (${cnpj}):`, err.message);
      acao.feedback = { sucesso: false, erro: err.message, rotulo: rotuloHumano };
    }
  }

  /**
   * Remove tags de ação da resposta antes de enviar ao cliente
   */
  limparResposta(resposta) {
    return resposta.replace(/\[ACAO:[^\]]+\]/g, '').trim();
  }

  /**
   * Seleciona o provider WhatsApp ativo (mesmo dispatcher de routes/whatsapp.js)
   */
  _obterWhatsAppProvider() {
    const provider = process.env.WHATSAPP_PROVIDER || 'meta';
    if (provider === 'blip') return require('./blipService');
    if (provider === 'evolution') return require('./evolutionService');
    if (provider === 'zapi') return require('./zapiService');
    return require('./whatsappService'); // meta cloud api
  }

  /**
   * Notifica o admin (Thiago) via WhatsApp quando uma conversa é transferida.
   * Roda em background — falhas não bloqueiam a resposta ao cliente.
   */
  async _notificarAdminTransferencia(conversaId, contato) {
    const adminPhone = process.env.ANA_ADMIN_WHATSAPP || '5541996104498';
    if (!adminPhone) {
      console.warn('[WhatsApp] ANA_ADMIN_WHATSAPP não configurado — alerta não enviado');
      return;
    }

    const db = getDb();

    // Pega últimas 5 mensagens da conversa pra dar contexto
    const ultimas = db.prepare(`
      SELECT direcao, conteudo, remetente, created_at
      FROM whatsapp_mensagens
      WHERE conversa_id = ?
      ORDER BY created_at DESC LIMIT 5
    `).all(conversaId).reverse();

    // Monta informação do cliente
    let clienteInfo = 'Contato desconhecido';
    let telefoneCliente = contato?.telefone || '?';
    if (contato?.cliente_id) {
      const c = db.prepare('SELECT razao_social, cnpj FROM clientes WHERE id = ?').get(contato.cliente_id);
      if (c) clienteInfo = `${c.razao_social} (${c.cnpj})`;
    } else if (contato?.nome) {
      clienteInfo = contato.nome;
    }

    // Monta histórico resumido
    const historicoTxt = ultimas
      .map(m => {
        const quem = m.direcao === 'entrada' ? '👤 Cliente' : (m.remetente === 'bot' ? '🤖 ANA' : '👨 Equipe');
        const conteudo = (m.conteudo || '').replace(/\[ACAO:[^\]]+\]/g, '').trim().slice(0, 200);
        return `${quem}: ${conteudo}`;
      })
      .join('\n');

    const baseUrl = process.env.APP_BASE_URL || 'https://emissor-nfs-marcal.onrender.com';
    const mensagem = `🔔 *ANA pediu reforço*

Cliente: *${clienteInfo}*
WhatsApp: ${telefoneCliente}

_Últimas mensagens:_
${historicoTxt}

Abra o painel pra responder:
${baseUrl}/escritorio/whatsapp`;

    try {
      const provider = this._obterWhatsAppProvider();
      if (!provider.isConfigured?.()) {
        console.warn('[WhatsApp] Provider não configurado, alerta admin não enviado');
        return;
      }
      await provider.enviarTexto(adminPhone, mensagem);
      console.log(`[WhatsApp] ✓ Admin (${adminPhone}) notificado da transferência da conversa ${conversaId}`);
    } catch (err) {
      console.error('[WhatsApp] Erro enviando alerta admin:', err.message);
    }
  }

  /**
   * Alerta admin quando uma mensagem chega com prefixo "Nome:" mas o nome
   * NÃO está na whitelist de operadores (ANA_OPERADORES ou tabela ana_operadores).
   *
   * Cenário típico: cliente externo escreveu por engano "Janaina:" ou um operador
   * novo da equipe começou a usar o Domínio sem ser cadastrado. A mensagem é
   * tratada como cliente conservador (não dispara modo equipe), mas o admin
   * recebe um aviso pra avaliar se vale adicionar o nome à whitelist.
   *
   * Throttling: máximo 1 alerta de ambiguidade por hora pro mesmo nome,
   * pra não spammar admin se cliente teimar em mandar.
   */
  async _alertarAdminAmbiguidadeAsync(modoEquipe, contato, conversaId) {
    const adminPhone = (process.env.ANA_ADMIN_WHATSAPP || '').replace(/\D/g, '');
    if (!adminPhone) return;

    // Throttle simples em memória (process-local)
    if (!this._ambiguidadeThrottle) this._ambiguidadeThrottle = new Map();
    const chave = `${modoEquipe.motivoAmbiguidade || ''}|${contato?.telefone || ''}`;
    const ultimoAlerta = this._ambiguidadeThrottle.get(chave) || 0;
    const agora = Date.now();
    const UMA_HORA = 60 * 60 * 1000;
    if (agora - ultimoAlerta < UMA_HORA) return;
    this._ambiguidadeThrottle.set(chave, agora);

    const baseUrl = process.env.APP_BASE_URL || 'https://emissor-nfs-marcal.onrender.com';
    const mensagem = `⚠️ *ANA: prefixo ambíguo detectado*

${modoEquipe.motivoAmbiguidade || 'Prefixo "Nome:" não validado'}

Telefone do contato: ${contato?.telefone || '?'}
Conversa: ${conversaId}

A ANA tratou como cliente (conservador). Se for operador legítimo, adicione na env *ANA_OPERADORES* ou na tabela *ana_operadores*.

Painel: ${baseUrl}/escritorio/whatsapp`;

    try {
      const provider = this._obterWhatsAppProvider();
      if (!provider.isConfigured?.()) return;
      await provider.enviarTexto(adminPhone, mensagem);
      console.log(`[ana-modo-equipe] ✓ Admin notificado de ambiguidade — conversa ${conversaId}`);
    } catch (err) {
      console.warn('[ana-modo-equipe] Falha enviando alerta de ambiguidade:', err.message);
    }
  }

}

module.exports = new AgenteIAService();
