// =====================================================
// Emissão em lote de NFS-e a partir de CSV.
// Aceita colunas (header flexível, normalizado lower+sem acento):
//   cnpj_emitente, valor, cnpj_tomador, razao_tomador, descricao,
//   codigo_servico (opcional), competencia (opcional YYYY-MM)
//
// Fluxo:
//   1. parseCSV — valida e devolve linhas estruturadas
//   2. criarLote — insere NFs com status 'pendente_emissao', retorna loteId
//   3. processarLote (background) — emite uma a uma com delay entre chamadas
//   4. statusLote — consulta progresso + resultado
// =====================================================

const { getDb } = require('../database/init');
const cnpjService = require('./cnpjService');
const preValidacaoService = require('./preValidacaoNfseService');
const nfseService = require('./nfseNacionalService');

const DELAY_ENTRE_EMISSOES_MS = 1500;

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseCSV(texto) {
  if (!texto) throw new Error('CSV vazio');
  // Detecta separador (vírgula ou ponto-e-vírgula)
  const firstLine = texto.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ';' : ',';

  const linhas = texto.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (linhas.length < 2) throw new Error('CSV precisa ter header + ao menos 1 linha de dados');

  const header = linhas[0].split(sep).map(h => _norm(h));

  // Aliases tolerantes
  const ALIAS = {
    cnpj_emitente: ['cnpjemitente','emitente','cnpj_do_emitente','empresa_emitente','cnpj_empresa'],
    valor:         ['valor_servico','vlr','preco','valor_total'],
    cnpj_tomador:  ['cnpjtomador','tomador','cnpj_do_tomador','documento_tomador','cpf_tomador','cpf_cnpj_tomador','documento'],
    razao_tomador: ['razaotomador','nome_tomador','razao_social_tomador','nome'],
    descricao:     ['descricao_servico','servico','desc'],
    codigo_servico:['codigoservico','codigo_tributacao','ctribnac','codigo_de_tributacao','cod_servico','servico_codigo'],
    competencia:   ['data_competencia','comp','periodo'],
  };

  const idxDe = (campo) => {
    let i = header.indexOf(campo);
    if (i >= 0) return i;
    for (const alias of (ALIAS[campo] || [])) {
      i = header.indexOf(alias);
      if (i >= 0) return i;
    }
    return -1;
  };

  const obrig = ['cnpj_emitente','valor','cnpj_tomador','descricao'];
  const faltantes = obrig.filter(c => idxDe(c) < 0);
  if (faltantes.length > 0) {
    throw new Error(`Colunas obrigatórias ausentes: ${faltantes.join(', ')}. Header detectado: ${header.join('|')}`);
  }

  const cols = {
    cnpj_emitente: idxDe('cnpj_emitente'),
    valor:         idxDe('valor'),
    cnpj_tomador:  idxDe('cnpj_tomador'),
    razao_tomador: idxDe('razao_tomador'),
    descricao:     idxDe('descricao'),
    codigo_servico:idxDe('codigo_servico'),
    competencia:   idxDe('competencia'),
  };

  const registros = [];
  const erros = [];
  for (let i = 1; i < linhas.length; i++) {
    const raw = linhas[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    const reg = {
      linha: i + 1,
      cnpj_emitente: (raw[cols.cnpj_emitente] || '').replace(/\D/g, ''),
      valor:         parseFloat(String(raw[cols.valor] || '').replace(/[^\d.,-]/g, '').replace(',', '.')),
      cnpj_tomador:  (raw[cols.cnpj_tomador] || '').replace(/\D/g, ''),
      razao_tomador: cols.razao_tomador >= 0 ? raw[cols.razao_tomador] : '',
      descricao:     raw[cols.descricao] || '',
      codigo_servico:cols.codigo_servico >= 0 ? raw[cols.codigo_servico] : '',
      competencia:   cols.competencia >= 0 ? raw[cols.competencia] : '',
    };
    if (reg.cnpj_emitente.length !== 14) erros.push({ linha: reg.linha, erro: `cnpj_emitente inválido: ${raw[cols.cnpj_emitente]}` });
    if (!(reg.valor > 0)) erros.push({ linha: reg.linha, erro: `valor inválido: ${raw[cols.valor]}` });
    if (!(reg.cnpj_tomador.length === 11 || reg.cnpj_tomador.length === 14)) erros.push({ linha: reg.linha, erro: `cnpj_tomador inválido: ${raw[cols.cnpj_tomador]}` });
    if (!reg.descricao) erros.push({ linha: reg.linha, erro: `descricao vazia` });
    registros.push(reg);
  }

  return { registros, erros, total: registros.length };
}

function criarLote({ registros, criadoPor }) {
  const db = getDb();
  // Cria um "lote" implícito usando um UUID-like simples (timestamp + random)
  const loteId = `lote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const nfsIds = [];
  for (const reg of registros) {
    // Busca cliente emitente (deve existir + ter A1)
    const cliEmit = db.prepare(`SELECT id, codigo_servico, aliquota_iss FROM clientes WHERE REPLACE(REPLACE(REPLACE(cnpj,'.',''),'/',''),'-','') = ?`).get(reg.cnpj_emitente);
    if (!cliEmit) {
      nfsIds.push({ linha: reg.linha, erro: `cliente emitente ${reg.cnpj_emitente} não está na carteira` });
      continue;
    }

    // Cria/obtém tomador
    let tomador = db.prepare(`
      SELECT id FROM tomadores
      WHERE cliente_id = ? AND REPLACE(REPLACE(REPLACE(documento,'.',''),'/',''),'-','') = ?
      LIMIT 1
    `).get(cliEmit.id, reg.cnpj_tomador);
    if (!tomador) {
      const tipo = reg.cnpj_tomador.length === 14 ? 'CNPJ' : 'CPF';
      const ins = db.prepare(`
        INSERT INTO tomadores (cliente_id, razao_social, documento, tipo_documento, ativo, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `).run(cliEmit.id, reg.razao_tomador || '(a consultar)', reg.cnpj_tomador, tipo);
      tomador = { id: ins.lastInsertRowid };
    }

    // Cria NF pendente
    const aliq = cliEmit.aliquota_iss || 0;
    const vIss = reg.valor * aliq;
    const comp = reg.competencia || new Date().toISOString().slice(0, 7);
    const ins = db.prepare(`
      INSERT INTO notas_fiscais (
        cliente_id, tomador_id, valor_servico, descricao_servico,
        data_competencia, status, codigo_servico, aliquota_iss,
        valor_iss, base_calculo, valor_liquido, origem, observacoes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pendente_emissao', ?, ?, ?, ?, ?, 'lote', ?, datetime('now'), datetime('now'))
    `).run(
      cliEmit.id, tomador.id, reg.valor, reg.descricao,
      comp,
      reg.codigo_servico || cliEmit.codigo_servico || '',
      aliq,
      vIss, reg.valor, reg.valor - vIss,
      `LOTE:${loteId}`
    );
    nfsIds.push({ linha: reg.linha, nfId: ins.lastInsertRowid, clienteId: cliEmit.id, tomadorId: tomador.id });
  }

  return { loteId, itens: nfsIds };
}

async function processarLote(loteId) {
  const db = getDb();
  const itens = db.prepare(`
    SELECT id, cliente_id, tomador_id FROM notas_fiscais
    WHERE observacoes LIKE ? AND status = 'pendente_emissao'
    ORDER BY id
  `).all(`LOTE:${loteId}%`);

  console.log(`[Lote ${loteId}] Processando ${itens.length} NFs em background...`);
  let ok = 0, fail = 0;
  for (const it of itens) {
    try {
      const nota = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(it.id);
      const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(it.cliente_id);
      const tomador = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(it.tomador_id);

      // Enriquecer tomador via Receita se razão estiver vazia
      if ((!tomador.razao_social || tomador.razao_social === '(a consultar)') && tomador.documento.length === 14) {
        try {
          const dados = await cnpjService.consultarCNPJ(tomador.documento);
          if (dados) {
            db.prepare(`UPDATE tomadores SET razao_social=?, logradouro=?, numero=?, bairro=?, municipio=?, uf=?, cep=?, codigo_municipio=? WHERE id=?`)
              .run(dados.razaoSocial || tomador.razao_social, dados.logradouro || '', dados.numero || '', dados.bairro || '', dados.municipio || '', dados.uf || '', dados.cep || '', dados.codigoMunicipio || '', tomador.id);
            tomador.razao_social = dados.razaoSocial;
          }
        } catch {}
      }

      const validacao = await preValidacaoService.validarEEnriquecer(nota, cliente, tomador);
      if (!validacao.valido) {
        db.prepare(`UPDATE notas_fiscais SET status='erro_emissao', observacoes=observacoes || ' | Pre-val: ' || ? WHERE id=?`)
          .run(validacao.erros.join('; '), nota.id);
        fail++;
        continue;
      }

      if (!cliente.certificado_a1_path) {
        db.prepare(`UPDATE notas_fiscais SET status='erro_emissao', observacoes=observacoes || ' | Sem A1' WHERE id=?`).run(nota.id);
        fail++;
        continue;
      }

      const resultado = await nfseService.emitirNFSe(nota, cliente, tomador);
      if (resultado.sucesso) {
        db.prepare(`UPDATE notas_fiscais SET status='emitida', numero_nfse=?, chave_acesso=?, data_emissao=datetime('now'), updated_at=datetime('now') WHERE id=?`)
          .run(resultado.numeroNfse, resultado.chaveAcesso, nota.id);
        ok++;
      } else {
        db.prepare(`UPDATE notas_fiscais SET status='erro_emissao', observacoes=observacoes || ' | ' || ? WHERE id=?`).run(resultado.erro || 'erro desconhecido', nota.id);
        fail++;
      }
    } catch (err) {
      console.error(`[Lote ${loteId}] Erro NF ${it.id}:`, err.message);
      try {
        db.prepare(`UPDATE notas_fiscais SET status='erro_emissao', observacoes=observacoes || ' | EX: ' || ? WHERE id=?`).run(String(err.message).slice(0, 200), it.id);
      } catch {}
      fail++;
    }

    await new Promise(r => setTimeout(r, DELAY_ENTRE_EMISSOES_MS));
  }
  console.log(`[Lote ${loteId}] Concluído: ok=${ok}, fail=${fail}`);
  return { total: itens.length, ok, fail };
}

function statusLote(loteId) {
  const db = getDb();
  const itens = db.prepare(`
    SELECT id, status, numero_nfse, observacoes, valor_servico FROM notas_fiscais
    WHERE observacoes LIKE ? ORDER BY id
  `).all(`LOTE:${loteId}%`);
  const total = itens.length;
  const emitidas = itens.filter(i => i.status === 'emitida').length;
  const pendentes = itens.filter(i => i.status === 'pendente_emissao').length;
  const erros = itens.filter(i => i.status === 'erro_emissao').length;
  return { loteId, total, emitidas, pendentes, erros, itens };
}

module.exports = { parseCSV, criarLote, processarLote, statusLote };
