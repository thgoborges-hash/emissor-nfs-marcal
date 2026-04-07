// =====================================================
// Serviço de Integração com API NFS-e Nacional
// mTLS, DPS, emissão, consulta e cancelamento
// =====================================================

const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const forge = require('node-forge');
const nfseConfig = require('../config/nfse');
const certificadoService = require('./certificadoService');
const xmlSignerService = require('./xmlSignerService');

class NfseNacionalService {

  /**
   * Emite uma NFS-e via API Nacional
   * @param {object} nota - Dados da nota fiscal do banco
   * @param {object} cliente - Dados do cliente
   * @param {object} tomador - Dados do tomador
   * @returns {object} Resultado da emissão
   */
  async emitirNFSe(nota, cliente, tomador) {
    console.log(`[NFS-e] Iniciando emissão para NF ${nota.id}, cliente ${cliente.razao_social}`);

    // 1. Carrega o certificado do cliente
    const cert = certificadoService.carregarCertificado(
      cliente.id,
      cliente.certificado_a1_senha_encrypted
    );
    console.log(`[NFS-e] Certificado carregado: ${cert.info.titular}, valido ate ${cert.info.validade?.fim}`);

    // 2. Gera o XML da DPS
    const { xml: dpsXml, idDPS } = this._gerarDpsXml(nota, cliente, tomador);
    console.log(`[NFS-e] XML DPS gerado (${dpsXml.length} chars), idDPS: ${idDPS}`);

    // 3. Assina o XML (referência aponta para o Id do infDPS)
    const dpsXmlAssinado = xmlSignerService.assinarXml(
      dpsXml,
      cert.pfxBuffer,
      cert.senha,
      idDPS
    );
    console.log(`[NFS-e] XML assinado (${dpsXmlAssinado.length} chars)`);

    // 4. Comprime com GZip e codifica em Base64
    const xmlGzipBase64 = await this._comprimirECodificar(dpsXmlAssinado);

    // 5. Monta o payload JSON
    const payload = {
      dpsXmlGZipB64: xmlGzipBase64,
    };

    // 6. Envia para a API via mTLS
    const endpoint = `${nfseConfig.ambiente.sefin}${nfseConfig.endpoints.enviarDPS}`;
    console.log(`[NFS-e] Enviando para: ${endpoint}`);
    const resultado = await this._requisicaoMTLS(endpoint, 'POST', payload, cert.pfxBuffer, cert.senha);
    console.log(`[NFS-e] Resposta recebida:`, JSON.stringify(resultado).substring(0, 500));

    // A API retorna nfseXmlGZipB64 com o XML da NFS-e quando sucesso (status 201)
    // Extrai dados do resultado
    const chaveAcesso = resultado.chaveAcesso || resultado.chave_acesso || resultado.chaveNFSe;
    const numeroNfse = resultado.nfseNumero || resultado.numero || resultado.numeroNfse;

    return {
      sucesso: true,
      numeroNfse: numeroNfse,
      chaveAcesso: chaveAcesso,
      dataEmissao: resultado.dataEmissao || resultado.data_emissao || new Date().toISOString(),
      protocolo: resultado.protocolo || resultado.idDPS || resultado.id,
      xmlEnvio: dpsXmlAssinado,
      xmlRetorno: JSON.stringify(resultado),
      nfseXmlGZipB64: resultado.nfseXmlGZipB64,
    };
  }

  /**
   * Consulta uma NFS-e pela chave de acesso
   */
  async consultarNFSe(chaveAcesso, clienteId, senhaEncrypted) {
    const cert = certificadoService.carregarCertificado(clienteId, senhaEncrypted);
    const endpoint = `${nfseConfig.ambiente.sefin}${nfseConfig.endpoints.consultarNFSe}/${chaveAcesso}`;
    return await this._requisicaoMTLS(endpoint, 'GET', null, cert.pfxBuffer, cert.senha);
  }

  /**
   * Baixa o DANFSe (PDF) de uma NFS-e
   */
  async baixarDanfse(chaveAcesso, clienteId, senhaEncrypted) {
    const cert = certificadoService.carregarCertificado(clienteId, senhaEncrypted);
    const endpoint = `${nfseConfig.ambiente.danfse}${nfseConfig.endpoints.danfse}/${chaveAcesso}`;
    return await this._requisicaoMTLS(endpoint, 'GET', null, cert.pfxBuffer, cert.senha, true);
  }

  /**
   * Cancela uma NFS-e emitida
   */
  async cancelarNFSe(chaveAcesso, motivo, clienteId, senhaEncrypted) {
    const cert = certificadoService.carregarCertificado(clienteId, senhaEncrypted);

    // Gera XML do evento de cancelamento
    const eventoXml = this._gerarEventoCancelamentoXml(chaveAcesso, motivo);

    // Assina o XML
    const eventoXmlAssinado = xmlSignerService.assinarXml(
      eventoXml,
      cert.pfxBuffer,
      cert.senha,
      `CANC_${chaveAcesso}`
    );

    // Comprime
    const xmlGzipBase64 = await this._comprimirECodificar(eventoXmlAssinado);

    const payload = {
      eventoXmlGZipB64: xmlGzipBase64,
    };

    const endpoint = `${nfseConfig.ambiente.sefin}${nfseConfig.endpoints.enviarEvento}/${chaveAcesso}/eventos`;
    return await this._requisicaoMTLS(endpoint, 'POST', payload, cert.pfxBuffer, cert.senha);
  }

  /**
   * Consulta parâmetros municipais (alíquotas, serviços disponíveis)
   */
  async consultarParametrosMunicipais(codigoMunicipio, clienteId, senhaEncrypted) {
    const cert = certificadoService.carregarCertificado(clienteId, senhaEncrypted);
    const endpoint = `${nfseConfig.ambiente.sefin}${nfseConfig.endpoints.parametrosMunicipais}/${codigoMunicipio}`;
    return await this._requisicaoMTLS(endpoint, 'GET', null, cert.pfxBuffer, cert.senha);
  }

  // ===========================================================================
  // MÉTODOS PRIVADOS
  // ===========================================================================

  /**
   * Gera o ID da DPS no formato TSIdDPS (45 posições)
   * Formato: DPS + codigoMunicipio(7) + tipoInscricao(1) + inscricaoFederal(14) + serie(5) + numero(15)
   */
  _gerarIdDPS(cliente, nota) {
    const codigoMunicipio = (cliente.codigo_municipio || '0000000').padStart(7, '0');
    const cnpj = (cliente.cnpj || '').replace(/\D/g, '');
    const tipoInscricao = cnpj.length <= 11 ? '2' : '1'; // 1=CNPJ, 2=CPF
    const inscricaoFederal = cnpj.padStart(14, '0');
    const serie = (nota.serie_dps || '1').padStart(5, '0');
    const numero = String(nota.numero_dps || '0').padStart(15, '0');
    return `DPS${codigoMunicipio}${tipoInscricao}${inscricaoFederal}${serie}${numero}`;
  }

  /**
   * Gera endereço no formato correto do schema XSD (TCEndereco)
   * Estrutura: end > { endNac{cMun, CEP} | endExt }, xLgr, nro, xCpl?, xBairro
   * IMPORTANTE: xLgr, nro, xBairro são filhos de <end>, NÃO de <endNac>
   * <endNac> contém APENAS cMun e CEP
   */
  _gerarEnderecoXml(dados) {
    if (!dados.logradouro && !dados.cep) return '';
    const cep = dados.cep ? dados.cep.replace(/\D/g, '') : '';
    return `<end>
          ${(dados.codigo_municipio || cep) ? `<endNac>
            ${dados.codigo_municipio ? `<cMun>${dados.codigo_municipio}</cMun>` : ''}
            ${cep ? `<CEP>${cep}</CEP>` : ''}
          </endNac>` : ''}
          ${dados.logradouro ? `<xLgr>${this._escapeXml(dados.logradouro)}</xLgr>` : ''}
          ${dados.numero ? `<nro>${this._escapeXml(dados.numero)}</nro>` : ''}
          ${dados.complemento ? `<xCpl>${this._escapeXml(dados.complemento)}</xCpl>` : ''}
          ${dados.bairro ? `<xBairro>${this._escapeXml(dados.bairro)}</xBairro>` : ''}
        </end>`;
  }

  /**
   * Gera o XML da DPS (Declaração de Prestação de Serviço)
   * Estrutura conforme schema XSD NFS-e Nacional v1.00/v1.01
   */
  _gerarDpsXml(nota, cliente, tomador) {
    const cnpjPrestador = cliente.cnpj.replace(/[.\-\/]/g, '');
    const documentoTomador = tomador.documento.replace(/[.\-\/]/g, '');
    const codMunicipio = cliente.codigo_municipio || '0000000';

    // Gera o ID da DPS no formato correto (TSIdDPS - 45 posições)
    const idDPS = this._gerarIdDPS(cliente, nota);

    // Formata valores com 2 casas decimais
    const fmt = (v) => (v || 0).toFixed(2);

    // Data de competência precisa ser YYYY-MM-DD
    const dCompet = nota.data_competencia?.length === 7
      ? nota.data_competencia + '-01'
      : nota.data_competencia;

    // Base de cálculo
    const baseCalculo = nota.base_calculo || (nota.valor_servico - (nota.valor_deducoes || 0));
    const aliquotaPercent = nota.aliquota_iss ? (nota.aliquota_iss * 100) : 0;

    // Tributos federais (só inclui se valor > 0)
    let tribFedXml = '';
    const temTribFed = (nota.valor_ir > 0) || (nota.valor_csll > 0) || (nota.valor_inss > 0);
    if (temTribFed) {
      tribFedXml = `<tribFed>
          ${nota.valor_inss > 0 ? `<vRetCP>${fmt(nota.valor_inss)}</vRetCP>` : ''}
          ${nota.valor_ir > 0 ? `<vRetIRRF>${fmt(nota.valor_ir)}</vRetIRRF>` : ''}
          ${nota.valor_csll > 0 ? `<vRetCSLL>${fmt(nota.valor_csll)}</vRetCSLL>` : ''}
        </tribFed>`;
    }

    // Regime tributário do prestador (obrigatório no XSD)
    // opSimpNac: 1=Não Optante, 2=MEI, 3=ME/EPP
    const opSimpNac = cliente.regime_simples_nacional || '1';
    // regEspTrib: 0=Nenhum, 1=Cooperativa, 2=Estimativa, 3=Microempresa, 4=Notário, 5=Autônomo, 6=Sociedade
    const regEspTrib = cliente.regime_especial_tributacao || '0';

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${nfseConfig.versaoLayout}">
  <infDPS Id="${idDPS}">
    <tpAmb>${nfseConfig.ambienteNome === 'producao' ? '1' : '2'}</tpAmb>
    <dhEmi>${this._formatarDataUTC(new Date())}</dhEmi>
    <verAplic>EmissorMarcal_1.0</verAplic>
    <serie>${nota.serie_dps || '1'}</serie>
    <nDPS>${nota.numero_dps}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${codMunicipio}</cLocEmi>

    <prest>
      <CNPJ>${cnpjPrestador}</CNPJ>
      ${cliente.inscricao_municipal ? `<IM>${cliente.inscricao_municipal}</IM>` : ''}
      <xNome>${this._escapeXml(cliente.razao_social)}</xNome>
      ${this._gerarEnderecoXml(cliente)}
      <regTrib>
        <opSimpNac>${opSimpNac}</opSimpNac>
        <regEspTrib>${regEspTrib}</regEspTrib>
      </regTrib>
    </prest>

    <toma>
      ${tomador.tipo_documento === 'CNPJ'
        ? `<CNPJ>${documentoTomador}</CNPJ>`
        : `<CPF>${documentoTomador}</CPF>`
      }
      <xNome>${this._escapeXml(tomador.razao_social)}</xNome>
      ${this._gerarEnderecoXml(tomador)}
      ${tomador.email ? `<email>${this._escapeXml(tomador.email)}</email>` : ''}
    </toma>

    <serv>
      <locPrest>
        <cLocPrestacao>${codMunicipio}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${nota.codigo_servico}</cTribNac>
        <xDescServ>${this._escapeXml(nota.descricao_servico)}</xDescServ>
      </cServ>
      ${nota.observacoes ? `<infoCompl><xInfComp>${this._escapeXml(nota.observacoes)}</xInfComp></infoCompl>` : ''}
    </serv>

    <valores>
      <vServPrest>
        <vServ>${fmt(nota.valor_servico)}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <pAliq>${fmt(aliquotaPercent)}</pAliq>
          <tpRetISSQN>${nota.iss_retido ? '2' : '1'}</tpRetISSQN>
        </tribMun>
        ${tribFedXml}
        <totTrib>
          <indTotTrib>0</indTotTrib>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;

    return { xml, idDPS };
  }

  /**
   * Gera XML de evento de cancelamento
   */
  _gerarEventoCancelamentoXml(chaveAcesso, motivo) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${nfseConfig.versaoLayout}">
  <infPedReg Id="CANC_${chaveAcesso}">
    <tpAmb>${nfseConfig.ambienteNome === 'producao' ? '1' : '2'}</tpAmb>
    <verAplic>EmissorMarcal_1.0</verAplic>
    <dhEvento>${this._formatarDataUTC(new Date())}</dhEvento>
    <chNFSe>${chaveAcesso}</chNFSe>
    <nPedRegEvento>1</nPedRegEvento>
    <tpEvento>e101101</tpEvento>
    <infEvento>
      <desc>Cancelamento de NFS-e</desc>
      <cMotivo>1</cMotivo>
      <xMotivo>${this._escapeXml(motivo)}</xMotivo>
    </infEvento>
  </infPedReg>
</pedRegEvento>`;
  }

  /**
   * Comprime com GZip e codifica em Base64
   */
  _comprimirECodificar(xml) {
    return new Promise((resolve, reject) => {
      zlib.gzip(Buffer.from(xml, 'utf8'), (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed.toString('base64'));
      });
    });
  }

  /**
   * Faz requisição com mTLS (certificado digital)
   */
  _requisicaoMTLS(url, method, body, pfxBuffer, senha, isBinary = false) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      console.log(`[NFS-e mTLS] ${method} ${url}`);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: method,
        pfx: pfxBuffer,
        passphrase: senha,
        rejectUnauthorized: true, // Valida certificado do servidor
        headers: {
          'Accept': isBinary ? 'application/pdf' : 'application/json',
          'User-Agent': 'EmissorMarcal/1.0',
        },
        timeout: nfseConfig.timeout,
      };

      if (body && (method === 'POST' || method === 'PUT')) {
        const bodyStr = JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);

          if (isBinary) {
            // Retorna o PDF como buffer
            resolve({ pdf: buffer, contentType: res.headers['content-type'] });
            return;
          }

          const responseText = buffer.toString('utf8');

          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(responseText));
            } catch {
              resolve({ raw: responseText, statusCode: res.statusCode });
            }
          } else {
            let errorMsg = `API retornou status ${res.statusCode}`;
            console.error(`[NFS-e mTLS] Erro HTTP ${res.statusCode} de ${url}`);
            console.error(`[NFS-e mTLS] Resposta: ${responseText.substring(0, 500)}`);
            try {
              const errorBody = JSON.parse(responseText);
              errorMsg = errorBody.mensagem || errorBody.message || errorBody.erro || errorMsg;
              reject({ statusCode: res.statusCode, mensagem: errorMsg, detalhes: errorBody });
            } catch {
              reject({ statusCode: res.statusCode, mensagem: errorMsg, detalhes: responseText.substring(0, 500) });
            }
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'CERT_HAS_EXPIRED') {
          reject(new Error('Certificado digital inválido ou expirado'));
        } else if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
          reject(new Error('Erro de conexão mTLS - certificado não autorizado para este servidor'));
        } else {
          reject(new Error(`Erro de conexão com API NFS-e: ${err.message}`));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout na comunicação com a API NFS-e Nacional'));
      });

      if (body && (method === 'POST' || method === 'PUT')) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Formata data no padrão TSDateTimeUTC aceito pela API NFS-e Nacional
   * Formato: YYYY-MM-DDTHH:MM:SS-03:00 (sem milissegundos, com offset Brasil)
   */
  _formatarDataUTC(date) {
    // Offset Brasil -03:00
    const offset = -3;
    const d = new Date(date.getTime() + offset * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}-03:00`;
  }

  /**
   * Escapa caracteres especiais em XML
   */
  _escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = new NfseNacionalService();
