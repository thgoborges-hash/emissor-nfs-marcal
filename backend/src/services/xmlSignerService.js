// =====================================================
// Serviço de Assinatura XML (XMLDSIG)
// Assina documentos NFS-e conforme padrão W3C
// =====================================================

const crypto = require('crypto');
const forge = require('node-forge');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const nfseConfig = require('../config/nfse');

class XmlSignerService {

  /**
   * Assina um XML usando certificado A1
   * @param {string} xml - XML a ser assinado
   * @param {Buffer} pfxBuffer - Certificado PFX
   * @param {string} senha - Senha do certificado
   * @param {string} referenceUri - URI do elemento a assinar (ID)
   * @returns {string} XML assinado
   */
  assinarXml(xml, pfxBuffer, senha, referenceUri = '') {
    // Extrai chave privada e certificado do PFX
    const { privateKey, certificate, certChain } = this._extractFromPfx(pfxBuffer, senha);

    // Parse do XML
    const doc = new DOMParser().parseFromString(xml, 'text/xml');

    // Cria o nó Signature
    const signatureNode = this._createSignatureNode(doc, privateKey, certificate, certChain, referenceUri);

    // Insere a assinatura no XML
    const root = doc.documentElement;
    root.appendChild(signatureNode);

    return new XMLSerializer().serializeToString(doc);
  }

  /**
   * Extrai chave privada e certificado do PFX usando node-forge
   */
  _extractFromPfx(pfxBuffer, senha) {
    const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);

    // Chave privada
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
    if (!keyBag || keyBag.length === 0) {
      throw new Error('Chave privada não encontrada no certificado');
    }
    const privateKeyForge = keyBag[0].key;

    // Converte chave privada para PEM
    const privateKeyPem = forge.pki.privateKeyToPem(privateKeyForge);

    // Certificados
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certs = certBags[forge.pki.oids.certBag];
    if (!certs || certs.length === 0) {
      throw new Error('Certificado não encontrado');
    }

    const certificate = certs[0].cert;
    const certPem = forge.pki.certificateToPem(certificate);

    // Cadeia de certificados
    const certChain = certs.map(c => forge.pki.certificateToPem(c.cert));

    return {
      privateKey: privateKeyPem,
      certificate: certPem,
      certChain,
    };
  }

  /**
   * Cria o nó de assinatura XMLDSIG
   */
  _createSignatureNode(doc, privateKeyPem, certPem, certChain, referenceUri) {
    const { canonicalizationAlgorithm, signatureAlgorithm, digestAlgorithm, transformAlgorithm } = nfseConfig.xmldsig;

    // Canonicaliza o conteúdo que será assinado
    const serializer = new XMLSerializer();
    const xmlContent = serializer.serializeToString(doc.documentElement);

    // Calcula o digest do conteúdo
    const digest = this._calculateDigest(xmlContent);

    // Monta o SignedInfo
    const signedInfoXml = this._buildSignedInfo(referenceUri, digest, {
      canonicalizationAlgorithm,
      signatureAlgorithm,
      digestAlgorithm,
      transformAlgorithm,
    });

    // Assina o SignedInfo
    const signatureValue = this._signContent(signedInfoXml, privateKeyPem);

    // Extrai o certificado em Base64 (sem headers PEM)
    const certBase64 = certPem
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\r?\n/g, '');

    // Monta o XML da assinatura completa
    const signatureXml = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
      signedInfoXml +
      `<SignatureValue>${signatureValue}</SignatureValue>` +
      `<KeyInfo>` +
      `<X509Data>` +
      `<X509Certificate>${certBase64}</X509Certificate>` +
      `</X509Data>` +
      `</KeyInfo>` +
      `</Signature>`;

    const sigDoc = new DOMParser().parseFromString(signatureXml, 'text/xml');
    return sigDoc.documentElement;
  }

  /**
   * Constrói o XML do SignedInfo
   */
  _buildSignedInfo(referenceUri, digest, algorithms) {
    const uri = referenceUri ? `URI="#${referenceUri}"` : 'URI=""';

    return `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
      `<CanonicalizationMethod Algorithm="${algorithms.canonicalizationAlgorithm}"/>` +
      `<SignatureMethod Algorithm="${algorithms.signatureAlgorithm}"/>` +
      `<Reference ${uri}>` +
      `<Transforms>` +
      `<Transform Algorithm="${algorithms.transformAlgorithm}"/>` +
      `<Transform Algorithm="${algorithms.canonicalizationAlgorithm}"/>` +
      `</Transforms>` +
      `<DigestMethod Algorithm="${algorithms.digestAlgorithm}"/>` +
      `<DigestValue>${digest}</DigestValue>` +
      `</Reference>` +
      `</SignedInfo>`;
  }

  /**
   * Calcula o hash SHA-256 do conteúdo em Base64
   */
  _calculateDigest(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('base64');
  }

  /**
   * Assina o conteúdo com a chave privada RSA-SHA256
   */
  _signContent(content, privateKeyPem) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(content, 'utf8');
    return sign.sign(privateKeyPem, 'base64');
  }
}

module.exports = new XmlSignerService();
