/**
 * Backup automatico do SQLite.
 *
 * Estrategia:
 *   - SQLite online backup via `VACUUM INTO` (consistente, sem travar writes).
 *   - Salva em /app/data/backups/emissor-YYYY-MM-DD.db (disco persistente).
 *   - Mantem os ultimos N (BACKUP_KEEP_DAYS, default 7) e apaga os mais antigos.
 *   - Agendado via cron diario (BACKUP_CRON_HORA, default 03:00).
 *
 * Por que VACUUM INTO e nao copiar o arquivo:
 *   - O arquivo .db pode estar em meio a uma escrita (WAL). Copia direta pode
 *     gerar backup corrompido. VACUUM INTO faz um snapshot consistente atomicamente.
 *
 * Rotas expostas em routes/debug.js:
 *   - GET /api/debug/backup/rodar     — dispara um backup manual (admin)
 *   - GET /api/debug/backup/listar    — lista backups disponiveis
 */

const fs = require('fs');
const path = require('path');
const cron = (() => { try { return require('node-cron'); } catch (e) { return null; } })();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/emissor.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 7);
const CRON_HORA = process.env.BACKUP_CRON_HORA || '0 3 * * *'; // 03:00 diario

function _ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function _nomeArquivo(data = new Date()) {
  const y = data.getFullYear();
  const m = String(data.getMonth() + 1).padStart(2, '0');
  const d = String(data.getDate()).padStart(2, '0');
  return `emissor-${y}-${m}-${d}.db`;
}

/**
 * Executa um backup consistente do banco atual.
 * Retorna { arquivo, tamanho, duracaoMs }.
 */
function rodarBackup() {
  _ensureDir();
  const { getDb } = require('../database/init');
  const db = getDb();
  const destino = path.join(BACKUP_DIR, _nomeArquivo());

  // Se ja existe backup de hoje, sobrescreve (VACUUM INTO falha se arquivo existir).
  if (fs.existsSync(destino)) {
    fs.unlinkSync(destino);
  }

  const inicio = Date.now();
  // VACUUM INTO gera snapshot consistente mesmo com writes concorrentes (WAL).
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const duracaoMs = Date.now() - inicio;
  const tamanho = fs.statSync(destino).size;

  console.log(`[Backup] ${path.basename(destino)} gerado (${(tamanho / 1024).toFixed(1)}KB em ${duracaoMs}ms)`);

  _limparAntigos();

  return { arquivo: path.basename(destino), tamanho, duracaoMs };
}

/**
 * Apaga backups mais antigos que KEEP_DAYS.
 */
function _limparAntigos() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const arquivos = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^emissor-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .map(f => ({ nome: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime); // mais novo primeiro

  const paraRemover = arquivos.slice(KEEP_DAYS);
  for (const a of paraRemover) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, a.nome));
      console.log(`[Backup] removido antigo: ${a.nome}`);
    } catch (err) {
      console.warn(`[Backup] falha ao remover ${a.nome}:`, err.message);
    }
  }
}

function listarBackups() {
  _ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^emissor-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { arquivo: f, tamanho: stat.size, criadoEm: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.criadoEm > b.criadoEm ? -1 : 1));
}

function iniciarCron() {
  if (!cron) {
    console.warn('[Backup] node-cron nao disponivel, pulando agendamento');
    return;
  }
  if (process.env.DISABLE_BACKUP_CRON === 'true') {
    console.log('[Backup] cron desabilitado via DISABLE_BACKUP_CRON=true');
    return;
  }
  cron.schedule(CRON_HORA, () => {
    try {
      rodarBackup();
    } catch (err) {
      console.error('[Backup] Erro no cron:', err.message);
    }
  });
  console.log(`[Backup] cron agendado: ${CRON_HORA} (mantem ${KEEP_DAYS} dias em ${BACKUP_DIR})`);

  // Roda um backup imediato no boot se nao existir o de hoje
  try {
    const hoje = path.join(BACKUP_DIR, _nomeArquivo());
    if (!fs.existsSync(hoje)) {
      console.log('[Backup] sem backup de hoje, gerando imediato...');
      rodarBackup();
    }
  } catch (err) {
    console.warn('[Backup] falha no backup de boot:', err.message);
  }
}

module.exports = { rodarBackup, listarBackups, iniciarCron };
