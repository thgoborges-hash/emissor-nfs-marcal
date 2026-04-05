/**
 * Serviço de E-mail - Marçal Contabilidade
 * Envia notas fiscais e notificações por e-mail
 * Usa Nodemailer com suporte a Gmail, Outlook e SMTP genérico
 */

const nodemailer = require('nodemailer');

// Configuração do transporter (lazy init)
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.warn('[Email] EMAIL_USER e EMAIL_PASS não configurados');
    return null;
  }

  let config;

  switch (provider) {
    case 'gmail':
      config = {
        service: 'gmail',
        auth: { user, pass } // usar App Password do Google
      };
      break;

    case 'outlook':
    case 'hotmail':
      config = {
        service: 'hotmail',
        auth: { user, pass }
      };
      break;

    default: // SMTP genérico
      config = {
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT || '587'),
        secure: process.env.EMAIL_SECURE === 'true',
        auth: { user, pass }
      };
  }

  transporter = nodemailer.createTransport(config);
  console.log(`[Email] Transporter configurado (${provider})`);
  return transporter;
}

/**
 * Verifica se o serviço de e-mail está configurado
 */
function isConfigured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

/**
 * Envia e-mail genérico
 */
async function enviar({ para, assunto, html, texto, anexos }) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('Serviço de e-mail não configurado');
  }

  const nomeRemetente = process.env.EMAIL_FROM_NAME || 'Marçal Contabilidade';
  const emailRemetente = process.env.EMAIL_USER;

  const mailOptions = {
    from: `"${nomeRemetente}" <${emailRemetente}>`,
    to: para,
    subject: assunto,
    html: html || undefined,
    text: texto || undefined,
    attachments: anexos || undefined,
  };

  const resultado = await transport.sendMail(mailOptions);
  console.log(`[Email] Enviado para ${para}: ${assunto} (ID: ${resultado.messageId})`);
  return resultado;
}

/**
 * Envia notificação de NF emitida para o tomador
 */
async function notificarNFEmitida({ tomador, cliente, nota, linkDanfse }) {
  const emailTomador = tomador.email;
  if (!emailTomador) {
    console.warn(`[Email] Tomador ${tomador.razao_social} sem e-mail cadastrado`);
    return null;
  }

  const valorFormatado = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL'
  }).format(nota.valor_servico);

  const dataEmissao = nota.data_emissao
    ? new Date(nota.data_emissao).toLocaleDateString('pt-BR')
    : new Date().toLocaleDateString('pt-BR');

  const assunto = `NFS-e ${nota.numero_nfse || nota.numero_dps} - ${cliente.razao_social}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, Helvetica, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: #1a1a2e; color: #fff; padding: 24px 32px; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p { margin: 4px 0 0; opacity: 0.8; font-size: 14px; }
    .body { padding: 32px; }
    .greeting { font-size: 16px; margin-bottom: 16px; color: #333; }
    .info-box { background: #f8f9fa; border-left: 4px solid #1a1a2e; padding: 16px 20px; margin: 20px 0; border-radius: 0 6px 6px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
    .info-label { color: #666; }
    .info-value { font-weight: bold; color: #333; }
    .valor-destaque { font-size: 22px; color: #1a1a2e; font-weight: bold; }
    .btn { display: inline-block; background: #1a1a2e; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-size: 14px; margin-top: 16px; }
    .footer { background: #f8f9fa; padding: 20px 32px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; }
    .footer a { color: #1a1a2e; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Nota Fiscal de Servico Eletronica</h1>
      <p>Emitida em ${dataEmissao}</p>
    </div>
    <div class="body">
      <p class="greeting">Prezado(a) <strong>${tomador.razao_social}</strong>,</p>
      <p style="color:#555; font-size:14px; line-height:1.6;">
        Informamos que foi emitida uma Nota Fiscal de Servico Eletronica (NFS-e) referente aos servicos
        prestados por <strong>${cliente.razao_social}</strong>.
      </p>

      <div class="info-box">
        <div class="info-row">
          <span class="info-label">Numero NFS-e:</span>
          <span class="info-value">${nota.numero_nfse || nota.numero_dps}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Prestador:</span>
          <span class="info-value">${cliente.razao_social}</span>
        </div>
        <div class="info-row">
          <span class="info-label">CNPJ Prestador:</span>
          <span class="info-value">${cliente.cnpj}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Servico:</span>
          <span class="info-value">${nota.descricao_servico}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Competencia:</span>
          <span class="info-value">${nota.data_competencia}</span>
        </div>
        <div class="info-row" style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed #ddd;">
          <span class="info-label">Valor do Servico:</span>
          <span class="valor-destaque">${valorFormatado}</span>
        </div>
      </div>

      ${linkDanfse ? `
      <p style="color:#555; font-size:14px;">
        Para visualizar o documento fiscal completo (DANFSe), clique no botao abaixo:
      </p>
      <a href="${linkDanfse}" class="btn" target="_blank">Ver DANFSe</a>
      ` : ''}

      <p style="color:#999; font-size:12px; margin-top:24px;">
        Este e-mail foi enviado automaticamente pelo sistema de emissao de notas fiscais.
        Em caso de duvidas, entre em contato com ${cliente.razao_social}.
      </p>
    </div>
    <div class="footer">
      <p>Emitido por <strong>Marcal Contabilidade</strong></p>
      <p>Sistema de Emissao de NFS-e</p>
    </div>
  </div>
</body>
</html>`;

  const texto = `
NFS-e ${nota.numero_nfse || nota.numero_dps} - ${cliente.razao_social}

Prezado(a) ${tomador.razao_social},

Foi emitida uma NFS-e referente aos servicos prestados por ${cliente.razao_social} (CNPJ: ${cliente.cnpj}).

Detalhes:
- Numero: ${nota.numero_nfse || nota.numero_dps}
- Servico: ${nota.descricao_servico}
- Competencia: ${nota.data_competencia}
- Valor: ${valorFormatado}

${linkDanfse ? `Acesse o DANFSe: ${linkDanfse}` : ''}

---
Marcal Contabilidade - Sistema de Emissao de NFS-e
`;

  return enviar({
    para: emailTomador,
    assunto,
    html,
    texto,
  });
}

/**
 * Envia e-mail manual para um destinatário específico
 * (usado pelo escritório para reenviar NFs ou enviar comunicações)
 */
async function enviarNFManual({ para, nota, cliente, tomador, linkDanfse, mensagemExtra }) {
  const valorFormatado = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL'
  }).format(nota.valor_servico);

  const assunto = `NFS-e ${nota.numero_nfse || nota.numero_dps} - ${cliente.razao_social}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; padding: 20px;">
  ${mensagemExtra ? `<p style="background:#fff3cd; border:1px solid #ffc107; padding:12px; border-radius:6px;">${mensagemExtra}</p>` : ''}
  <p>Segue a Nota Fiscal de Servico Eletronica:</p>
  <ul>
    <li><strong>NFS-e:</strong> ${nota.numero_nfse || nota.numero_dps}</li>
    <li><strong>Prestador:</strong> ${cliente.razao_social} (${cliente.cnpj})</li>
    <li><strong>Tomador:</strong> ${tomador.razao_social}</li>
    <li><strong>Servico:</strong> ${nota.descricao_servico}</li>
    <li><strong>Valor:</strong> ${valorFormatado}</li>
  </ul>
  ${linkDanfse ? `<p><a href="${linkDanfse}">Clique aqui para ver o DANFSe</a></p>` : ''}
  <hr>
  <p style="font-size:12px; color:#999;">Marcal Contabilidade</p>
</body>
</html>`;

  return enviar({ para, assunto, html });
}

module.exports = {
  isConfigured,
  enviar,
  notificarNFEmitida,
  enviarNFManual,
  getTransporter,
};
