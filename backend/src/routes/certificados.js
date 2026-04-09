// =====================================================
// Rotas de Gestão de Certificados Digitais A1
// Upload, validação e consulta
// =====================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { autenticado, apenasEscritorio, apenasEscritorio } = require('../middleware/auth');
const certificadoService = require('../services/certificadoService');
const { getDb } = require('../database/init');

// Configuração do multer para upload de certificados
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Máximo 10MB
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.pfx') || ext.endsWith('.p12')) {
      cb(null, true);
    } else {
      cb(new Error('Formato inválido. Envie um arquivo .pfx ou .p12'));
    }
  }
});

// POST /api/certificados/:clienteId/upload - Upload de certificado A1
router.post('/:clienteId/upload', autenticado, apenasEscritorio, upload.single('certificado'), async (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.clienteId);
    const { senha } = req.body;

    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo do certificado (.pfx ou .p12) é obrigatório' });
    }
    if (!senha) {
      return res.status(400).json({ erro: 'Senha do certificado é obrigatória' });
    }

    // Verifica se o cliente existe
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ? AND ativo = 1').get(clienteId);
    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    // Valida e salva o certificado
    const resultado = certificadoService.salvarCertificado(clienteId, req.file.buffer, senha);

    // Verifica se o CNPJ do certificado bate com o do cliente
    const cnpjCliente = cliente.cnpj.replace(/[.\-\/]/g, '');
    if (resultado.info.cnpj && resultado.info.cnpj !== cnpjCliente) {
      // Remove o certificado salvo
      certificadoService.removerCertificado(clienteId);
      return res.status(400).json({
        erro: `CNPJ do certificado (${resultado.info.cnpj}) não corresponde ao CNPJ do cliente (${cnpjCliente})`,
      });
    }

    // Atualiza o banco com as informações do certificado
    db.prepare(`
      UPDATE clientes
      SET certificado_a1_path = ?,
          certificado_a1_senha_encrypted = ?,
          certificado_validade = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      resultado.filepath,
      resultado.senhaEncrypted,
      resultado.info.validade.fim.split('T')[0],
      clienteId
    );

    // Log da atividade
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id)
      VALUES ('certificado_upload', ?, 'escritorio', ?, ?)
    `).run(
      `Certificado A1 atualizado para ${cliente.razao_social} (validade: ${resultado.info.validade.fim.split('T')[0]})`,
      req.usuario.id,
      clienteId
    );

    res.json({
      mensagem: 'Certificado salvo com sucesso',
      certificado: {
        titular: resultado.info.titular,
        cnpj: resultado.info.cnpj,
        emissor: resultado.info.emissor,
        validade: resultado.info.validade,
        diasRestantes: resultado.info.diasRestantes,
        tipo: resultado.info.tipo,
      }
    });

  } catch (err) {
    console.error('Erro no upload do certificado:', err);
    res.status(400).json({ erro: err.message || 'Erro ao processar certificado' });
  }
});

// GET /api/certificados/:clienteId - Consulta status do certificado
router.get('/:clienteId', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.clienteId);

    const cliente = db.prepare(`
      SELECT id, razao_social, cnpj, certificado_a1_path, certificado_validade
      FROM clientes WHERE id = ? AND ativo = 1
    `).get(clienteId);

    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    if (!cliente.certificado_a1_path) {
      return res.json({
        temCertificado: false,
        mensagem: 'Nenhum certificado A1 cadastrado para este cliente',
      });
    }

    const validade = new Date(cliente.certificado_validade);
    const agora = new Date();
    const diasRestantes = Math.ceil((validade - agora) / (1000 * 60 * 60 * 24));

    res.json({
      temCertificado: true,
      validade: cliente.certificado_validade,
      diasRestantes,
      expirado: diasRestantes <= 0,
      alertaExpiracao: diasRestantes > 0 && diasRestantes <= 30,
    });

  } catch (err) {
    console.error('Erro ao consultar certificado:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// DELETE /api/certificados/:clienteId - Remove certificado
router.delete('/:clienteId', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.clienteId);

    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    // Remove o arquivo
    certificadoService.removerCertificado(clienteId);

    // Limpa no banco
    db.prepare(`
      UPDATE clientes
      SET certificado_a1_path = NULL,
          certificado_a1_senha_encrypted = NULL,
          certificado_validade = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(clienteId);

    res.json({ mensagem: 'Certificado removido com sucesso' });

  } catch (err) {
    console.error('Erro ao remover certificado:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/certificados - Lista status de certificados de todos os clientes (escritório)
router.get('/', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clientes = db.prepare(`
      SELECT id, razao_social, cnpj, certificado_a1_path, certificado_validade
      FROM clientes WHERE ativo = 1
      ORDER BY razao_social
    `).all();

    const agora = new Date();
    const resultado = clientes.map(c => {
      if (!c.certificado_a1_path) {
        return { ...c, status: 'sem_certificado', diasRestantes: null };
      }
      const validade = new Date(c.certificado_validade);
      const diasRestantes = Math.ceil((validade - agora) / (1000 * 60 * 60 * 24));
      let status = 'valido';
      if (diasRestantes <= 0) status = 'expirado';
      else if (diasRestantes <= 30) status = 'expirando';

      return { ...c, status, diasRestantes };
    });

    res.json(resultado);

  } catch (err) {
    console.error('Erro ao listar certificados:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

module.exports = router;
