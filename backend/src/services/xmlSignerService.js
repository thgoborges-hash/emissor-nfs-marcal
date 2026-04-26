// =====================================================
// Serviço de Assinatura XML (XMLDSIG) via xml-crypto
// Assina documentos NFS-e conforme padrão W3C XMLDSIG
// com canonicalização Exclusive C14N e RSA-SHA256
// =====================================================

const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');

class XmlSignerService {

  /**
   * Assina um XML usando certificado A1 (ICP-Brasil)
   * @param {string} xml - XML a ser assinado
   * @param {Buffer} pfxBuffer - Certificado PFX em buffer
   * @param {string} senha - Senha do certificado
   * @param {string} referenceId - Valor do atributo Id do elemento a assinar (ex: DPS41069...)
   * @returns {string} XML assinado com Signature
   */
  assinarXml(xml, pfxBuffer, senha, referenceId = '') {
    // Extrai chave privada e certificado do PFX
    const { privateKey, certificate } = this._extractFromPfx(pfxBuffer, senha);

    // Certificado X509 em Base64 puro (sem headers/footers PEM)
    const certBase64 = certificate
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\r?\n/g, '')
      .trim();

    // Configura o xml-crypto SignedXml
    const sig = new SignedXml({
      privateKey: privateKey,
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    });

    // Detecta nome do elemento a assinar pelo conteúdo do XML
    // (DPS usa infDPS, eventos como cancelamento usam infPedReg)
    const elementoAssinar = xml.includes('<infPedReg') ? 'infPedReg' : 'infDPS';
    sig.addReference({
      xpath: `//*[local-name(.)='${elementoAssinar}']`,
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });

    // KeyInfo com certificado X509 — obrigatório pela SEFIN
    sig.getKeyInfoContent = () =>
      `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`;

    // Computa assinatura e insere como último filho da raiz (DPS)
    sig.computeSignature(xml, {
      location: { reference: '/*', action: 'append' },
    });

    const signedXml = sig.getSignedXml();
    console.log(`[XMLSigner] XML assinado com xml-crypto (${signedXml.length} chars)`);

    return signedXml;
  }

  /**
   * Extrai chave privada e certificado do arquivo PFX usando node-forge
   */
  _extractFromPfx(pfxBuffer, senha) {
    const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);

    // Busca chave privada
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
    if (!keyBag || keyBag.length === 0) {
      throw new Error('Chave privada não encontrada no certificado PFX');
    }
    const privateKeyPem = forge.pki.privateKeyToPem(keyBag[0].key);

    // Busca certificados
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certs = certBags[forge.pki.oids.certBag];
    if (!certs || certs.length === 0) {
      throw new Error('Certificado X509 não encontrado no PFX');
    }

    const certificatePem = forge.pki.certificateToPem(certs[0].cert);
    const certChain = certs.map(c => forge.pki.certificateToPem(c.cert));

    return {
      privateKey: privateKeyPem,
      certificate: certificatePem,
      certChain,
    };
  }
}

module.exports = new XmlSignerService();
