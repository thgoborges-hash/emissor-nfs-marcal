const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/emissor.db');

function initDatabase() {
  // Cria diretório data se não existir
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // Habilita WAL mode para melhor performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Lê e executa o schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Migração idempotente: adiciona coluna fonte em entregas_mensais pra instalações existentes
  try {
    const cols = db.prepare("PRAGMA table_info(entregas_mensais)").all();
    if (!cols.some(c => c.name === 'fonte')) {
      db.exec("ALTER TABLE entregas_mensais ADD COLUMN fonte TEXT DEFAULT 'manual'");
      console.log('[migration] entregas_mensais.fonte adicionada');
    }
  } catch (e) {
    console.warn('[migration] entregas_mensais.fonte:', e.message);
  }

  // Insere dados iniciais se o banco estiver vazio
  const escritorioCount = db.prepare('SELECT COUNT(*) as count FROM escritorio').get();
  if (escritorioCount.count === 0) {
    console.log('Inserindo dados iniciais...');

    // Escritório
    db.prepare(`
      INSERT INTO escritorio (nome, cnpj, email)
      VALUES (?, ?, ?)
    `).run('Marçal Contabilidade', '00.000.000/0001-00', 'contato@marcalcontabilidade.com.br');

    // Usuário admin padrão
    const senhaHash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO usuarios_escritorio (nome, email, senha_hash, papel)
      VALUES (?, ?, ?, ?)
    `).run('Thiago Borges', 'thgo.borges@gmail.com', senhaHash, 'admin');

    // Cliente de exemplo
    const senhaCliente = bcrypt.hashSync('cliente123', 10);
    db.prepare(`
      INSERT INTO clientes (razao_social, nome_fantasia, cnpj, email, telefone, codigo_servico, descricao_servico_padrao, aliquota_iss, modo_emissao, senha_hash, codigo_municipio, municipio, uf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Tech Solutions Ltda',
      'Tech Solutions',
      '12.345.678/0001-90',
      'contato@techsolutions.com.br',
      '(11) 99999-0000',
      '01.01', // Análise e desenvolvimento de sistemas
      'Prestação de serviços de desenvolvimento de software',
      0.05,
      'autonomo',
      senhaCliente,
      '3550308', // São Paulo
      'São Paulo',
      'SP'
    );

    // Tomadores de exemplo
    db.prepare(`
      INSERT INTO tomadores (cliente_id, tipo_documento, documento, razao_social, email, municipio, uf, codigo_municipio, favorito)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'CNPJ', '98.765.432/0001-10', 'Empresa ABC Ltda', 'financeiro@abc.com.br', 'São Paulo', 'SP', '3550308', 1);

    db.prepare(`
      INSERT INTO tomadores (cliente_id, tipo_documento, documento, razao_social, email, municipio, uf, codigo_municipio, favorito)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'CNPJ', '11.222.333/0001-44', 'XYZ Tecnologia S.A.', 'nf@xyz.com.br', 'Rio de Janeiro', 'RJ', '3304557', 0);

    console.log('Dados iniciais inseridos com sucesso!');
  }

  console.log('Banco de dados inicializado em:', DB_PATH);
  return db;
}

// Singleton do banco
let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = initDatabase();
  }
  return dbInstance;
}

module.exports = { getDb, initDatabase };

// Se executado diretamente, inicializa o banco
if (require.main === module) {
  initDatabase();
}
