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

  // Migração: linhas antigas (pré-fix) com fonte='manual' sem responsavel_id são mock
  try {
    const r = db.prepare(`
      UPDATE entregas_mensais
      SET fonte = 'mock'
      WHERE fonte = 'manual' AND responsavel_id IS NULL
    `).run();
    if (r.changes > 0) {
      console.log('[migration] entregas_mensais: ' + r.changes + ' linha(s) antigas reclassificadas como fonte=mock');
    }
  } catch (e) {
    console.warn('[migration] reclassificar mock:', e.message);
  }

  // Migração: desativa clientes óbvios de teste (razão EXEMPLO/MODELO/TESTE
  // ou CNPJs fictícios conhecidos) pra não poluir a tela Entregas.
  try {
    const fakeCnpjs = [
      '12.345.678/0001-90','55.555.555/0001-91','77.777.777/0001-91',
      '67.676.767/0001-06','87.878.787/0001-77','91.919.191/0001-45',
      '98.765.432/0001-98','12.312.312/0001-10',
    ];
    const stmt1 = db.prepare(`
      UPDATE clientes SET ativo = 0, updated_at = CURRENT_TIMESTAMP
      WHERE ativo = 1 AND (
        razao_social LIKE '%EXEMPLO%' OR
        razao_social LIKE '%MODELO%' OR
        razao_social LIKE '%TESTE%'
      )
    `);
    const r1 = stmt1.run();
    const stmt2 = db.prepare(`UPDATE clientes SET ativo = 0, updated_at = CURRENT_TIMESTAMP WHERE ativo = 1 AND cnpj = ?`);
    let r2 = 0;
    for (const c of fakeCnpjs) { r2 += stmt2.run(c).changes; }
    if (r1.changes > 0 || r2 > 0) {
      console.log('[migration] desativados ' + (r1.changes + r2) + ' cliente(s) de teste');
    }
  } catch (e) {
    console.warn('[migration] desativar testes:', e.message);
  }

  // Migração: desativa clientes específicos que o Thiago pediu (23/04/2026)
  try {
    const patterns = ['%4PAY%', '%SBARAINI%', '%SBENX%', '%LMM %', '%LMM ADMIN%',
                      '%TITLES%', '%ALASKA%', '%EVOLUA%'];
    const stmt = db.prepare(`UPDATE clientes SET ativo = 0, updated_at = CURRENT_TIMESTAMP
                             WHERE ativo = 1 AND razao_social LIKE ?`);
    let totalDesat = 0;
    for (const pat of patterns) totalDesat += stmt.run(pat).changes;
    if (totalDesat > 0) console.log('[migration] desativados ' + totalDesat + ' cliente(s) de lista Thiago 23/04');
  } catch (e) {
    console.warn('[migration] desativar lista Thiago:', e.message);
  }

  // Migração idempotente: adiciona dominio_integration_key em clientes
  try {
    const cols = db.prepare("PRAGMA table_info(clientes)").all();
    if (!cols.some(c => c.name === 'dominio_integration_key')) {
      db.exec("ALTER TABLE clientes ADD COLUMN dominio_integration_key TEXT");
      console.log('[migration] clientes.dominio_integration_key adicionada');
    }
  } catch (e) {
    console.warn('[migration] clientes.dominio_integration_key:', e.message);
  }

  // Seed idempotente da tabela cTribNac (Lista LC 116/2003)
  // Carrega do JSON em src/data/codigos_servico_nacional.json
  try {
    const cnRow = db.prepare('SELECT COUNT(*) as count FROM codigos_servico_nacional').get();
    const jsonPath = path.join(__dirname, '../data/codigos_servico_nacional.json');
    if (fs.existsSync(jsonPath)) {
      const codigos = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const ftsRow = db.prepare('SELECT COUNT(*) as count FROM codigos_servico_nacional_fts').get();
      const precisaSeed = cnRow.count !== codigos.length || ftsRow.count !== codigos.length;
      if (precisaSeed) {
        db.exec('DELETE FROM codigos_servico_nacional');
        db.exec('DELETE FROM codigos_servico_nacional_fts');
        const ins = db.prepare(`INSERT INTO codigos_servico_nacional
          (codigo, descricao, grupo, palavras_chave, cnae_afins) VALUES (?, ?, ?, ?, ?)`);
        const insFts = db.prepare(`INSERT INTO codigos_servico_nacional_fts
          (codigo, descricao, palavras_chave) VALUES (?, ?, ?)`);
        const tx = db.transaction((arr) => {
          for (const c of arr) {
            const palavras = (c.palavras_chave || []).join(' ');
            const cnaes = JSON.stringify(c.cnae_afins || []);
            ins.run(c.codigo, c.descricao, c.grupo || '', palavras, cnaes);
            insFts.run(c.codigo, c.descricao, palavras);
          }
        });
        tx(codigos);
        console.log(`[migration] codigos_servico_nacional populada: ${codigos.length} itens`);
      }
    } else {
      console.warn('[migration] codigos_servico_nacional.json não encontrado em ' + jsonPath);
    }
  } catch (e) {
    console.warn('[migration] codigos_servico_nacional seed:', e.message);
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
