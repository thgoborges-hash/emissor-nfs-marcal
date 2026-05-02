#!/usr/bin/env node
/**
 * Exporta conversas da ANA pra análise/revisão.
 *
 * Uso:
 *   node backend/scripts/exportar-conversas-ana.js \
 *     --db /caminho/pra/emissor.db \
 *     --dias 30 \
 *     --limite 200 \
 *     --saida outputs/ana-conversas-export.json
 *
 * Defaults:
 *   --db: $DB_PATH ou backend/data/emissor.db
 *   --dias: 30
 *   --limite: 200
 *   --saida: outputs/ana-conversas-export-<timestamp>.json
 *   --sanitizar: 1 (mascara telefone/nome/CNPJ)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : '1';
      args[key] = val;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const dbPath = args.db || process.env.DB_PATH || path.resolve(__dirname, '../data/emissor.db');
const dias = Math.max(1, Math.min(365, parseInt(args.dias || '30', 10)));
const limite = Math.max(1, Math.min(2000, parseInt(args.limite || '200', 10)));
const sanitizar = args.sanitizar !== '0';
const saida = args.saida || path.resolve(
  process.cwd(),
  `outputs/ana-conversas-export-${new Date().toISOString().slice(0, 10)}.json`
);

if (!fs.existsSync(dbPath)) {
  console.error(`[exportar-conversas-ana] banco não encontrado: ${dbPath}`);
  console.error('  passe --db /caminho/pra/emissor.db ou setando DB_PATH');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const sanitizarTelefone = (tel) => {
  if (!tel || !sanitizar) return tel;
  const s = String(tel);
  if (s.length <= 6) return '***';
  return s.slice(0, 4) + '*'.repeat(Math.max(0, s.length - 6)) + s.slice(-2);
};

const sanitizarNome = (nome) => {
  if (!nome || !sanitizar) return nome;
  return String(nome).split(/\s+/).map(p => p ? p[0].toUpperCase() + '.' : '').join(' ').trim();
};

const sanitizarCnpj = (cnpj) => {
  if (!cnpj || !sanitizar) return cnpj;
  const s = String(cnpj).replace(/\D/g, '');
  if (s.length < 8) return '***';
  return s.slice(0, 2) + '.***.***/****-' + s.slice(-2);
};

const conversas = db.prepare(`
  SELECT
    c.id,
    c.contato_id,
    c.status,
    c.created_at,
    c.ultimo_mensagem_at,
    co.telefone,
    co.nome,
    co.tipo as tipo_contato,
    co.cliente_id,
    cli.razao_social,
    cli.cnpj
  FROM whatsapp_conversas c
  INNER JOIN whatsapp_contatos co ON c.contato_id = co.id
  LEFT JOIN clientes cli ON co.cliente_id = cli.id
  WHERE c.ultimo_mensagem_at >= datetime('now', '-' || ? || ' days')
  ORDER BY c.ultimo_mensagem_at DESC
  LIMIT ?
`).all(dias, limite);

const stmtMsgs = db.prepare(`
  SELECT id, direcao, tipo, conteudo, remetente, metadata, created_at
  FROM whatsapp_mensagens
  WHERE conversa_id = ?
  ORDER BY id ASC
`);

const resultado = conversas.map(c => {
  const msgs = stmtMsgs.all(c.id).map(m => {
    let metadata = null;
    try { metadata = m.metadata ? JSON.parse(m.metadata) : null; } catch { metadata = m.metadata; }
    return {
      id: m.id,
      direcao: m.direcao,
      tipo: m.tipo,
      remetente: m.remetente,
      conteudo: m.conteudo,
      metadata,
      created_at: m.created_at,
    };
  });
  return {
    conversa_id: c.id,
    status: c.status,
    criada_em: c.created_at,
    ultima_mensagem_em: c.ultimo_mensagem_at,
    contato: {
      telefone: sanitizarTelefone(c.telefone),
      nome: sanitizarNome(c.nome),
      tipo: c.tipo_contato,
      cliente_vinculado: c.cliente_id ? {
        razao_social: sanitizarNome(c.razao_social),
        cnpj: sanitizarCnpj(c.cnpj),
      } : null,
    },
    total_mensagens: msgs.length,
    mensagens: msgs,
  };
});

fs.mkdirSync(path.dirname(saida), { recursive: true });
fs.writeFileSync(saida, JSON.stringify({
  gerado_em: new Date().toISOString(),
  origem: dbPath,
  janela_dias: dias,
  sanitizado: sanitizar,
  total_conversas: resultado.length,
  conversas: resultado,
}, null, 2));

console.log(`[exportar-conversas-ana] OK`);
console.log(`  ${resultado.length} conversas exportadas`);
console.log(`  arquivo: ${saida}`);

db.close();
