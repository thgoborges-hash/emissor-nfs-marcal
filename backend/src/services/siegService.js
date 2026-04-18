// =====================================================
// Serviço SIEG — Download automático de XMLs
// de notas de entrada/saída da carteira do escritório
// =====================================================
// Docs: https://sieg.movidesk.com/kb/pt-br/article/356445

const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const config = require('../config/sieg');

class SiegService {
  /**
   * Verifica se as credenciais estão configuradas
   */
  isConfigured() {
    return !!(config.apiKey && config.email);
  }

  /**
   * Baixa XMLs em lote do SIEG
   * Retorna array de { xml, chave } onde xml é o conteúdo decodificado
   *
   * @param {object} opts
   * @param {number} opts.tipoDoc - código do tipo (55=NFe, 65=NFCe, 57=CTe, 99=NFSe)
   * @param {string} opts.dataIni - YYYY-MM-DD
   * @param {string} opts.dataFim - YYYY-MM-DD
   * @param {string} [opts.cnpjDest] - CNPJ destinatário (notas recebidas PELO cliente)
   * @param {string} [opts.cnpjEmit] - CNPJ emitente (notas emitidas PELO cliente)
   * @param {string} [opts.cnpjRem] - CNPJ remetente (CT-e)
   * @param {string} [opts.cnpjTom] - CNPJ tomador (CT-e)
   * @param {boolean} [opts.downloadevent=false] - se true, traz eventos (cancelamento, CCe, etc)
   * @param {number} [opts.skip=0] - paginação (pula N resultados)
   * @param {number} [opts.take=50] - quantos trazer (máx 50)
   */
  async baixarXMLs(opts = {}) {
    if (!this.isConfigured()) {
      throw new Error('SIEG_API_KEY ou SIEG_EMAIL não configurados. Veja Minha Conta → Integrações API SIEG.');
    }

    const {
      tipoDoc = config.tipoDocumento.NFE,
      dataIni,
      dataFim,
      cnpjDest,
      cnpjEmit,
      cnpjRem,
      cnpjTom,
      downloadevent = false,
      skip = 0,
      take = config.limites.xmlsPorChamada,
    } = opts;

    if (!dataIni || !dataFim) {
      throw new Error('dataIni e dataFim são obrigatórios (formato YYYY-MM-DD)');
    }

    // Body conforme spec da nova API SIEG (JSON)
    const body = {
      XmlType: tipoDoc,
      Take: Math.min(take, config.limites.xmlsPorChamada),
      Skip: skip,
      DataEmissaoInicio: `${dataIni}T00:00:00`,
      DataEmissaoFim: `${dataFim}T23:59:59`,
      Downloadevent: !!downloadevent,
    };

    if (cnpjDest) body.CnpjDest = cnpjDest.replace(/\D/g, '');
    if (cnpjEmit) body.CnpjEmit = cnpjEmit.replace(/\D/g, '');
    if (cnpjRem) body.CnpjRem = cnpjRem.replace(/\D/g, '');
    if (cnpjTom) body.CnpjTom = cnpjTom.replace(/\D/g, '');

    const urlCompleta = `${config.downloadEndpoint}?api_key=${encodeURIComponent(config.apiKey)}&email=${encodeURIComponent(config.email)}`;
    const bodyJson = JSON.stringify(body);

    const url = new URL(urlCompleta);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(bodyJson),
      },
      timeout: config.limites.timeoutMs,
    };

    console.log(`[SIEG] BaixarXmls tipoDoc=${tipoDoc} ${dataIni}→${dataFim} skip=${skip} take=${take}`);

    const resp = await this._httpRequest(options, bodyJson);

    if (resp.statusCode !== 200) {
      let msgErro;
      try { msgErro = JSON.parse(resp.body)?.Message || resp.body; } catch { msgErro = resp.body; }
      throw new Error(`SIEG HTTP ${resp.statusCode}: ${msgErro}`);
    }

    let payload;
    try {
      payload = JSON.parse(resp.body);
    } catch (e) {
      throw new Error(`Resposta inválida do SIEG: ${resp.body.substring(0, 200)}`);
    }

    // A resposta pode vir em 2 formatos (depende da versão/tipo):
    // 1) Array de strings base64: ["<base64>", "<base64>", ...]
    // 2) Objeto { xmls: [...], total: N } — versão nova
    let arr = [];
    if (Array.isArray(payload)) {
      arr = payload;
    } else if (Array.isArray(payload?.xmls)) {
      arr = payload.xmls;
    } else if (Array.isArray(payload?.XMLs)) {
      arr = payload.XMLs;
    } else {
      console.warn('[SIEG] Formato de resposta inesperado:', JSON.stringify(payload).substring(0, 300));
      return [];
    }

    const resultados = arr.map((item, idx) => {
      try {
        const b64 = typeof item === 'string' ? item : (item.xml || item.Xml || item.conteudo);
        if (!b64) return null;
        const xmlString = Buffer.from(b64, 'base64').toString('utf8');
        return {
          xml: xmlString,
          chave: this._extrairChave(xmlString),
          tipo: tipoDoc,
          indice: skip + idx,
        };
      } catch (e) {
        console.error(`[SIEG] Erro decodificando item ${idx}: ${e.message}`);
        return null;
      }
    }).filter(Boolean);

    console.log(`[SIEG] ✓ ${resultados.length} XMLs baixados`);
    return resultados;
  }

  /**
   * Baixa TODAS as notas de entrada (CnpjDest = CNPJ do cliente)
   * Pagina automaticamente até esgotar
   *
   * @param {string} cnpjCliente
   * @param {string} dataIni YYYY-MM-DD
   * @param {string} dataFim YYYY-MM-DD
   * @param {number} tipoDoc
   */
  async baixarNotasDeEntrada(cnpjCliente, dataIni, dataFim, tipoDoc = config.tipoDocumento.NFE) {
    return await this._baixarPaginado({ cnpjDest: cnpjCliente, dataIni, dataFim, tipoDoc });
  }

  /**
   * Baixa TODAS as notas de saída (CnpjEmit = CNPJ do cliente)
   */
  async baixarNotasDeSaida(cnpjCliente, dataIni, dataFim, tipoDoc = config.tipoDocumento.NFE) {
    return await this._baixarPaginado({ cnpjEmit: cnpjCliente, dataIni, dataFim, tipoDoc });
  }

  /**
   * Teste de conexão — pede 1 XML da última semana só pra validar credenciais
   */
  async testarConexao() {
    const hoje = new Date().toISOString().slice(0, 10);
    const semanaPassada = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const xmls = await this.baixarXMLs({
      tipoDoc: config.tipoDocumento.NFE,
      dataIni: semanaPassada,
      dataFim: hoje,
      take: 1,
    });
    return {
      ok: true,
      amostraXmls: xmls.length,
      mensagem: xmls.length > 0
        ? `Conexão SIEG OK — ${xmls.length} XML(s) recente(s) no cofre`
        : 'Conexão SIEG OK — nenhum XML na janela testada (pode ser só que não tem notas recentes)',
    };
  }

  // -------------------------------------------------
  // Helpers internos
  // -------------------------------------------------

  async _baixarPaginado({ cnpjDest, cnpjEmit, dataIni, dataFim, tipoDoc }) {
    const todos = [];
    let skip = 0;
    let continuar = true;

    while (continuar) {
      const lote = await this.baixarXMLs({
        tipoDoc,
        dataIni,
        dataFim,
        cnpjDest,
        cnpjEmit,
        skip,
        take: config.limites.xmlsPorChamada,
      });
      todos.push(...lote);
      if (lote.length < config.limites.xmlsPorChamada) {
        continuar = false;
      } else {
        skip += config.limites.xmlsPorChamada;
        await new Promise(r => setTimeout(r, config.limites.delayEntreChamadasMs));
      }
    }
    return todos;
  }

  /**
   * Extrai chave de acesso do XML (44 dígitos)
   * Funciona pra NFe, NFCe, CTe
   */
  _extrairChave(xml) {
    if (!xml) return null;
    // Tag com ID tipo <infNFe Id="NFe35200...">
    const matchId = xml.match(/Id="(?:NFe|NFCe|CTe|NFS|CFe)(\d{44})"/);
    if (matchId) return matchId[1];
    // Fallback: tag <chNFe>...</chNFe>
    const matchCh = xml.match(/<ch(?:NFe|CTe)>(\d{44})<\/ch/);
    if (matchCh) return matchCh[1];
    return null;
  }

  _httpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('timeout', () => { req.destroy(new Error('Timeout SIEG')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = new SiegService();
