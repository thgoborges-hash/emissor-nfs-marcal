// =====================================================
// Serviço de Gestão de Certificados Digitais A1
// Upload, validação, armazenamento seguro
// =====================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const nfseConfig = require('../config/nfse');

class CertificadoService {
  constructor() {
    this.certDir = nfseConfig.certificadosDir;
    this.encryptionKey = nfseConfig.encryptionKey;
    this._ensureCertDir();
  }

  _ensureCertDir() {
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true });
    }
  }

  /**
   * Criptografa a senha do certificado para armazenamento seguro
   */
  encryptPassword(password) {
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Descriptografa a senha do certificado
   */
  decryptPassword(encryptedPassword) {
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const [ivHex, authTagHex, encrypted] = encryptedPassword.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Valida um certificado A1 (.pfx/.p12) e extrai informações
   * @param {Buffer} pfxBuffer - Conteúdo do arquivo .pfx
   * @param {string} senha - Senha do certificado
   * @returns {object} Informações do certificado
   */
  validarCertificado(pfxBuffer, senha) {
    try {
      // Converte o buffer PFX para formato ASN1
      const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);

      // Extrai certificados
      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const certBag = certBags[forge.pki.oids.certBag];
      if (!certBag || certBag.length === 0) {
        throw new Error('Nenhum certificado encontrado no arquivo PFX');
      }

      const cert = certBag[0].cert;

      // Extrai chave privada
      const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
      const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
      if (!keyBag || keyBag.length === 0) {
        throw new Error('Chave privada não encontrada no certificado');
      }

      // Extrai informações do certificado
      const subject = cert.subject.attributes.reduce((acc, attr) => {
        acc[attr.shortName || attr.name] = attr.value;
        return acc;
      }, {});

      const issuer = cert.issuer.attributes.reduce((acc, attr) => {
        acc[attr.shortName || attr.name] = attr.value;
        return acc;
      }, {});

      // Extrai CNPJ do certificado (campo OtherName do subjectAltName)
      let cnpjCertificado = null;
      const sanExtension = cert.getExtension('subjectAltName');
      if (sanExtension && sanExtension.altNames) {
        for (const altName of sanExtension.altNames) {
          // O CNPJ geralmente está no OID 2.16.76.1.3.3
          if (altName.type === 0 && altName.value) {
            // Tenta extrair CNPJ do campo
            const cnpjMatch = altName.value.toString().match(/\d{14}/);
            if (cnpjMatch) {
              cnpjCertificado = cnpjMatch[0];
            }
          }
        }
      }

      // Se não encontrou no SAN, tenta do CN
      if (!cnpjCertificado && subject.CN) {
        const cnpjMatch = subject.CN.match(/\d{14}/);
        if (cnpjMatch) {
          cnpjCertificado = cnpjMatch[0];
        }
      }

      const validade = {
        inicio: cert.validity.notBefore,
        fim: cert.validity.notAfter,
      };

      // Verifica se está dentro da validade
      const agora = new Date();
      const expirado = agora > validade.fim;
      const aindaNaoValido = agora < validade.inicio;
      const diasRestantes = Math.ceil((validade.fim - agora) / (1000 * 60 * 60 * 24));

      return {
        valido: !expirado && !aindaNaoValido,
        expirado,
        aindaNaoValido,
        diasRestantes,
        cnpj: cnpjCertificado,
        titular: subject.CN || subject.O || 'Desconhecido',
        emissor: issuer.CN || issuer.O || 'Desconhecido',
        serialNumber: cert.serialNumber,
        validade: {
          inicio: validade.inicio.toISOString(),
          fim: validade.fim.toISOString(),
        },
        tipo: 'A1', // Certificado em arquivo = A1
      };
    } catch (err) {
      if (err.message && (err.message.includes('Invalid password') ||
          err.message.includes('PKCS#12 MAC could not be verified'))) {
        throw new Error('Senha do certificado incorreta');
      }
      throw new Error(`Erro ao validar certificado: ${err.message}`);
    }
  }

  /**
   * Salva o certificado de forma segura no servidor
   * @param {number} clienteId - ID do cliente
   * @param {Buffer} pfxBuffer - Conteúdo do arquivo .pfx
   * @param {string} senha - Senha do certificado
   * @returns {object} Caminho do arquivo e informações
   */
  salvarCertificado(clienteId, pfxBuffer, senha) {
    // Valida primeiro
    const info = this.validarCertificado(pfxBuffer, senha);

    if (info.expirado) {
      throw new Error(`Certificado expirado em ${info.validade.fim}`);
    }

    // Salva o arquivo com nome baseado no clienteId
    const filename = `cliente_${clienteId}.pfx`;
    const filepath = path.join(this.certDir, filename);

    // Remove certificado antigo se existir
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }

    fs.writeFileSync(filepath, pfxBuffer);

    // Criptografa a senha para armazenamento no banco
    const senhaEncrypted = this.encryptPassword(senha);

    return {
      filepath: filename, // Salva apenas o nome do arquivo no banco
      senhaEncrypted,
      info,
    };
  }

  /**
   * Carrega o certificado e chave privada para uso em mTLS e assinatura
   * @param {number} clienteId - ID do cliente
   * @param {string} senhaEncrypted - Senha criptografada
   * @returns {object} { pfxBuffer, senha, cert, key }
   */
  carregarCertificado(clienteId, senhaEncrypted) {
    const filename = `cliente_${clienteId}.pfx`;
    const filepath = path.join(this.certDir, filename);

    if (!fs.existsSync(filepath)) {
      throw new Error('Certificado não encontrado. Faça upload do certificado A1.');
    }

    const pfxBuffer = fs.readFileSync(filepath);
    const senha = this.decryptPassword(senhaEncrypted);

    // Valida o certificado
    const info = this.validarCertificado(pfxBuffer, senha);
    if (info.expirado) {
      throw new Error(`Certificado expirado em ${info.validade.fim}. Faça upload de um novo certificado.`);
    }

    // Converte PFX → PEM (key + cert) pra uso em https.request com key/cert.
    // Necessário porque OpenSSL 3.x (Render Linux) rejeita alguns PFX modernos quando
    // passados via opção `pfx`, mas aceita `key`+`cert` em PEM sem problema.
    let keyPem = null;
    let certPem = null;
    try {
      const pem = this._pfxParaPem(pfxBuffer, senha);
      keyPem = pem.key;
      certPem = pem.cert;
    } catch (err) {
      console.warn(`[CertificadoService] Conversão PFX→PEM falhou: ${err.message}. Seguirá usando pfx bruto.`);
    }

    return {
      pfxBuffer,
      senha,
      info,
      keyPem,
      certPem,
    };
  }

  /**
   * Converte um buffer PFX em PEM {key, cert} via OpenSSL CLI.
   * Tenta primeiro sem -legacy; se falhar, retry com -legacy (pra PFX antigos).
   * Lança erro com contexto se ambos falharem.
   */
  _pfxParaPem(pfxBuffer, senha) {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-'));
    const pfxPath = path.join(tmpDir, 'cert.pfx');
    fs.writeFileSync(pfxPath, pfxBuffer);
    const limpar = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    const args = ['pkcs12', '-in', pfxPath, '-nodes', '-passin', `pass:${senha}`];
    let pemTxt = null;
    try {
      pemTxt = execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (e1) {
      try {
        pemTxt = execFileSync('openssl', [...args, '-legacy'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      } catch (e2) {
        limpar();
        const msg1 = (e1.stderr || e1.message || '').toString().slice(0, 200);
        const msg2 = (e2.stderr || e2.message || '').toString().slice(0, 200);
        throw new Error(`openssl pkcs12 falhou (padrão: ${msg1}; -legacy: ${msg2})`);
      }
    }
    limpar();
    const keyMatch = pemTxt.match(/-----BEGIN (?:ENCRYPTED |RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:ENCRYPTED |RSA )?PRIVATE KEY-----/);
    const certMatches = pemTxt.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!keyMatch) throw new Error('PEM sem chave privada');
    if (!certMatches || certMatches.length === 0) throw new Error('PEM sem certificado');
    return {
      key: keyMatch[0],
      cert: certMatches.join('\n'),
    };
  }

  /**
   * Remove o certificado de um cliente
   */
  removerCertificado(clienteId) {
    const filename = `cliente_${clienteId}.pfx`;
    const filepath = path.join(this.certDir, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
}

module.exports = new CertificadoService();
