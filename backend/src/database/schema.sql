-- =====================================================
-- Emissor NFS-e - Marçal Contabilidade
-- Schema do Banco de Dados
-- =====================================================

-- Escritório (configuração do escritório de contabilidade)
CREATE TABLE IF NOT EXISTS escritorio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  cnpj TEXT NOT NULL UNIQUE,
  email TEXT,
  telefone TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Usuários do escritório (admin)
CREATE TABLE IF NOT EXISTS usuarios_escritorio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'operador', -- 'admin', 'operador'
  ativo INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Clientes (empresas prestadoras de serviço)
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  cnpj TEXT NOT NULL UNIQUE,
  inscricao_municipal TEXT,

  -- Endereço
  logradouro TEXT,
  numero TEXT,
  complemento TEXT,
  bairro TEXT,
  codigo_municipio TEXT, -- código IBGE
  municipio TEXT,
  uf TEXT,
  cep TEXT,

  -- Contato
  email TEXT NOT NULL,
  telefone TEXT,

  -- Configurações de NFS-e
  codigo_servico TEXT, -- código do subitem da lista de serviços (padrão)
  descricao_servico_padrao TEXT, -- descrição padrão do serviço
  aliquota_iss REAL, -- alíquota ISS padrão (ex: 0.05 = 5%)
  regime_especial TEXT, -- regime especial de tributação
  optante_simples INTEGER DEFAULT 0,
  incentivo_fiscal INTEGER DEFAULT 0,

  -- Regime tributário pra apuração gerencial.
  -- Valores: 'simples' | 'presumido' | 'real' | 'mei' | NULL (não classificado)
  regime_tributario TEXT,

  -- Certificado digital
  certificado_a1_path TEXT, -- caminho do arquivo .pfx
  certificado_a1_senha_encrypted TEXT, -- senha do certificado (criptografada)
  certificado_validade DATE,
  -- Integracao Dominio (Thomson Reuters / Onvio)
  dominio_integration_key TEXT,

  -- Permissões
  modo_emissao TEXT NOT NULL DEFAULT 'aprovacao', -- 'autonomo' ou 'aprovacao'

  -- DEPRECATED: portal do cliente foi descontinuado em 04/2026.
  -- Coluna mantida apenas pra compatibilidade com instalações existentes.
  -- Interação com cliente agora é 100% via ANA no WhatsApp.
  senha_hash TEXT,

  ativo INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tomadores (quem recebe/contrata o serviço)
CREATE TABLE IF NOT EXISTS tomadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,

  -- Identificação
  tipo_documento TEXT NOT NULL DEFAULT 'CNPJ', -- 'CPF' ou 'CNPJ'
  documento TEXT NOT NULL, -- CPF ou CNPJ
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT,
  inscricao_municipal TEXT,

  -- Endereço
  logradouro TEXT,
  numero TEXT,
  complemento TEXT,
  bairro TEXT,
  codigo_municipio TEXT,
  municipio TEXT,
  uf TEXT,
  cep TEXT,

  -- Contato
  email TEXT,
  telefone TEXT,

  favorito INTEGER DEFAULT 0, -- tomadores favoritos aparecem primeiro
  ativo INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  UNIQUE(cliente_id, documento)
);

-- Notas Fiscais de Serviço
CREATE TABLE IF NOT EXISTS notas_fiscais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,
  tomador_id INTEGER,

  -- Número e controle
  numero_dps TEXT, -- número da DPS (gerado pelo sistema)
  serie_dps TEXT DEFAULT '1',
  numero_nfse TEXT, -- número da NFS-e (retornado pela SEFIN)
  chave_acesso TEXT, -- chave de acesso de 50 caracteres

  -- Status
  status TEXT NOT NULL DEFAULT 'rascunho',
  -- 'rascunho': criada mas não enviada
  -- 'pendente_aprovacao': aguardando aprovação do escritório
  -- 'aprovada': aprovada, pronta para emissão
  -- 'processando': enviada para API, aguardando retorno
  -- 'emitida': NFS-e emitida com sucesso
  -- 'rejeitada': rejeitada pela API (erro nos dados)
  -- 'cancelada': NFS-e cancelada

  -- Dados do serviço
  codigo_servico TEXT NOT NULL, -- código do subitem da lista de serviços
  descricao_servico TEXT NOT NULL,

  -- Valores
  valor_servico REAL NOT NULL,
  valor_deducoes REAL DEFAULT 0,
  valor_pis REAL DEFAULT 0,
  valor_cofins REAL DEFAULT 0,
  valor_inss REAL DEFAULT 0,
  valor_ir REAL DEFAULT 0,
  valor_csll REAL DEFAULT 0,
  valor_iss REAL DEFAULT 0,
  aliquota_iss REAL,
  base_calculo REAL,
  valor_liquido REAL,

  -- Tributação
  iss_retido INTEGER DEFAULT 0, -- 1 = ISS retido pelo tomador

  -- Datas
  data_competencia DATE NOT NULL, -- mês/ano de competência
  data_emissao DATETIME, -- quando foi emitida
  data_cancelamento DATETIME,

  -- Observações
  observacoes TEXT,

  -- Resposta da API
  xml_envio TEXT, -- XML enviado à API
  xml_retorno TEXT, -- XML de retorno da API
  pdf_path TEXT, -- caminho do PDF da DANFSe
  mensagem_erro TEXT, -- mensagem de erro se rejeitada

  -- Quem criou/aprovou
  criado_por TEXT, -- 'cliente' ou 'escritorio'
  aprovado_por INTEGER, -- id do usuario_escritorio que aprovou
  data_aprovacao DATETIME,

  -- Origem (para rastreabilidade)
  origem TEXT DEFAULT 'portal', -- 'portal', 'whatsapp', 'api'
  mensagem_original TEXT, -- mensagem original do WhatsApp (se aplicável)

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  FOREIGN KEY (tomador_id) REFERENCES tomadores(id),
  FOREIGN KEY (aprovado_por) REFERENCES usuarios_escritorio(id)
);

-- Log de atividades (auditoria)
CREATE TABLE IF NOT EXISTS log_atividades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL, -- 'nf_criada', 'nf_aprovada', 'nf_emitida', 'nf_cancelada', 'login', etc.
  descricao TEXT NOT NULL,
  usuario_tipo TEXT, -- 'escritorio' ou 'cliente'
  usuario_id INTEGER,
  cliente_id INTEGER,
  nota_fiscal_id INTEGER,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- WhatsApp - Conversas e Mensagens
-- =====================================================

-- Contatos WhatsApp (vinculados a clientes ou tomadores)
CREATE TABLE IF NOT EXISTS whatsapp_contatos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefone TEXT NOT NULL UNIQUE, -- número no formato internacional (5541999999999)
  nome TEXT, -- nome do contato no WhatsApp
  cliente_id INTEGER, -- vínculo com cliente (se for cliente do escritório)
  tipo TEXT DEFAULT 'desconhecido', -- 'cliente', 'tomador', 'escritorio', 'desconhecido'
  ativo INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

-- Conversas WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_conversas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contato_id INTEGER NOT NULL,
  status TEXT DEFAULT 'ativa', -- 'ativa', 'encerrada', 'aguardando_humano'
  contexto TEXT, -- JSON com contexto da conversa pro agente IA
  ultimo_mensagem_at DATETIME,
  atendente_id INTEGER, -- se foi transferido pra atendimento humano
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contato_id) REFERENCES whatsapp_contatos(id),
  FOREIGN KEY (atendente_id) REFERENCES usuarios_escritorio(id)
);

-- Mensagens WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id INTEGER NOT NULL,
  direcao TEXT NOT NULL, -- 'entrada' (do cliente) ou 'saida' (do bot/escritório)
  tipo TEXT DEFAULT 'texto', -- 'texto', 'imagem', 'documento', 'audio', 'template'
  conteudo TEXT NOT NULL, -- texto da mensagem ou URL da mídia
  whatsapp_message_id TEXT, -- ID da mensagem no WhatsApp (para tracking)
  status_envio TEXT DEFAULT 'enviada', -- 'enviada', 'entregue', 'lida', 'erro'
  remetente TEXT, -- 'bot', 'humano', 'cliente', 'sistema'
  metadata TEXT, -- JSON com dados extras (template usado, nota fiscal, etc.)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversa_id) REFERENCES whatsapp_conversas(id)
);

-- Configuração do WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chave TEXT NOT NULL UNIQUE,
  valor TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Notificações agendadas
CREATE TABLE IF NOT EXISTS whatsapp_notificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contato_id INTEGER NOT NULL,
  tipo TEXT NOT NULL, -- 'nf_emitida', 'vencimento', 'cobranca', 'lembrete'
  referencia_id INTEGER, -- ID da nota fiscal ou outro recurso
  mensagem TEXT NOT NULL,
  agendado_para DATETIME,
  enviado INTEGER DEFAULT 0,
  enviado_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contato_id) REFERENCES whatsapp_contatos(id)
);

-- =====================================================
-- ANA — Operadores autorizados (whitelist do modo equipe)
-- =====================================================
-- Lista de operadores que ficam autorizados a interagir com a ANA em modo
-- equipe quando aparecem com prefixo "Nome:" nas mensagens. Camada extra
-- de segurança contra falsos positivos (ex: "Olá:", "T:", "Cliente XYZ:").
--
-- Pode ser populada também via env var ANA_OPERADORES="Janaina Alves,Lucas
-- Silva,Thiago Borges" (tabela é a fonte preferida — env serve de fallback
-- e bootstrap).
CREATE TABLE IF NOT EXISTS ana_operadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  nome_normalizado TEXT NOT NULL UNIQUE, -- lowercase + sem acentos pra match
  telefone TEXT,                          -- opcional, formato 5541999999999
  papel TEXT DEFAULT 'operador',          -- 'admin' | 'operador'
  ativo INTEGER DEFAULT 1,
  observacoes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ana_operadores_ativo ON ana_operadores(ativo);
CREATE INDEX IF NOT EXISTS idx_ana_operadores_telefone ON ana_operadores(telefone);

-- =====================================================
-- Entregas Mensais por Cliente (dashboard gerencial)
-- Status do mês por tipo de obrigação (DCTFWeb, PGDAS-D, DAS, Balancete, etc)
-- =====================================================
CREATE TABLE IF NOT EXISTS entregas_mensais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,
  competencia TEXT NOT NULL,         -- 'YYYY-MM'
  tipo_entrega TEXT NOT NULL,        -- 'DCTFWEB', 'PGDASD', 'DAS', 'DCTF', 'BALANCETE', 'FOLHA', 'ESOCIAL', 'EFDREINF'
  status TEXT NOT NULL DEFAULT 'pendente', -- 'ok', 'pendente', 'atrasado', 'nao_aplicavel'
  data_vencimento DATE,
  data_entrega DATE,
  responsavel_id INTEGER,            -- usuario_escritorio quem fechou
  responsavel_nome TEXT,             -- snapshot do nome (pra preservar histórico)
  observacao TEXT,
  valor_referencia REAL,             -- se aplicável (ex: valor do DAS)
  fonte TEXT DEFAULT 'manual',       -- 'manual', 'mock', 'serpro'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cliente_id, competencia, tipo_entrega),
  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  FOREIGN KEY (responsavel_id) REFERENCES usuarios_escritorio(id)
);
CREATE INDEX IF NOT EXISTS idx_entregas_competencia ON entregas_mensais(competencia);
CREATE INDEX IF NOT EXISTS idx_entregas_cliente ON entregas_mensais(cliente_id);
CREATE INDEX IF NOT EXISTS idx_entregas_status ON entregas_mensais(status);
CREATE INDEX IF NOT EXISTS idx_entregas_tipo ON entregas_mensais(tipo_entrega);

-- =====================================================
-- Fila de Aprovação da ANA
-- Ações sensíveis que a ANA prepara e precisam de aval humano antes de executar
-- =====================================================
CREATE TABLE IF NOT EXISTS fila_aprovacao_ana (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_acao TEXT NOT NULL,               -- ex: EMITIR_DAS_SIMPLES, TRANSMITIR_DCTFWEB, GERAR_DRE_CLIENTE, CANCELAR_NF
  cliente_id INTEGER,                     -- cliente afetado (pode ser null pra ações globais)
  descricao TEXT NOT NULL,                -- texto legível pra equipe aprovar ("Emitir DAS de R$ X pro cliente Y referente a abril/2026")
  payload_json TEXT NOT NULL,             -- JSON com tudo que é preciso pra executar quando aprovado
  origem TEXT DEFAULT 'ana',              -- 'ana', 'sistema', 'manual'
  origem_operador TEXT,                   -- nome do operador da equipe que pediu (quando via Messenger Domínio)
  status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente', 'aprovado', 'rejeitado', 'executado', 'falhou'
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  decidido_por INTEGER,                   -- id do usuario_escritorio que aprovou/rejeitou
  decidido_em DATETIME,
  motivo_decisao TEXT,                    -- observação/motivo (obrigatório pra rejeição)
  executado_em DATETIME,
  resultado_execucao TEXT,                -- JSON com retorno da execução (ou mensagem de erro)
  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  FOREIGN KEY (decidido_por) REFERENCES usuarios_escritorio(id)
);
CREATE INDEX IF NOT EXISTS idx_fila_ana_status ON fila_aprovacao_ana(status);
CREATE INDEX IF NOT EXISTS idx_fila_ana_cliente ON fila_aprovacao_ana(cliente_id);
CREATE INDEX IF NOT EXISTS idx_fila_ana_criado_em ON fila_aprovacao_ana(criado_em);

-- Índices WhatsApp
CREATE INDEX IF NOT EXISTS idx_whatsapp_contatos_telefone ON whatsapp_contatos(telefone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_contatos_cliente ON whatsapp_contatos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversas_contato ON whatsapp_conversas(contato_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_mensagens_conversa ON whatsapp_mensagens(conversa_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_notificacoes_agendado ON whatsapp_notificacoes(agendado_para);

-- Snapshot de obrigacoes por cliente (alimentado pelo worker serproSnapshotService)
-- Usado pela tela Entregas pra mostrar status sem bater na SERPRO a cada page load.
CREATE TABLE IF NOT EXISTS snapshot_obrigacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,
  obrigacao TEXT NOT NULL,           -- 'SITFIS', 'DCTFWEB', 'PGDASD', 'PROCURACAO', 'CAIXA_POSTAL'
  competencia TEXT,                  -- YYYYMM, se aplicavel (pode ser NULL pra coisas atemporais)
  status TEXT NOT NULL,              -- 'ok', 'pendente', 'atrasada', 'sem_dados', 'erro'
  resumo TEXT,                       -- resumo curto legivel (ex: 'Transmitida em 15/04')
  dados_raw TEXT,                    -- JSON bruto da SERPRO pra debug
  erro TEXT,                         -- mensagem se status='erro'
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cliente_id, obrigacao, competencia),
  FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_cliente ON snapshot_obrigacoes(cliente_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_obrigacao ON snapshot_obrigacoes(obrigacao);
CREATE INDEX IF NOT EXISTS idx_snapshot_atualizado ON snapshot_obrigacoes(atualizado_em);


-- =====================================================
-- Tabela cTribNac (Lista de Serviços anexa à LC 116/2003)
-- Fonte: gov.br/nfse — usada pelo codigoServicoSugestaoService
-- =====================================================
CREATE TABLE IF NOT EXISTS codigos_servico_nacional (
  codigo TEXT PRIMARY KEY,           -- formato iissdd (6 dígitos)
  descricao TEXT NOT NULL,
  grupo TEXT,                        -- nome humano do item (ex: "Saúde")
  palavras_chave TEXT,               -- string com termos pra match (separado por espaço)
  cnae_afins TEXT,                   -- JSON array de prefixos CNAE 4 dígitos
  atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Índice FTS5 pra busca rápida por descrição + palavras-chave
CREATE VIRTUAL TABLE IF NOT EXISTS codigos_servico_nacional_fts USING fts5(
  codigo UNINDEXED,
  descricao,
  palavras_chave,
  tokenize='unicode61 remove_diacritics 2'
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_clientes_cnpj ON clientes(cnpj);
CREATE INDEX IF NOT EXISTS idx_tomadores_cliente ON tomadores(cliente_id);
CREATE INDEX IF NOT EXISTS idx_tomadores_documento ON tomadores(documento);
CREATE INDEX IF NOT EXISTS idx_nfs_cliente ON notas_fiscais(cliente_id);
CREATE INDEX IF NOT EXISTS idx_nfs_status ON notas_fiscais(status);
CREATE INDEX IF NOT EXISTS idx_nfs_data_competencia ON notas_fiscais(data_competencia);
CREATE INDEX IF NOT EXISTS idx_log_cliente ON log_atividades(cliente_id);

-- =====================================================
-- JOÃO — Fila de jobs assíncronos
-- =====================================================
-- Tarefas que o daemon do João (rodando no Mac do Thiago) consome via long-poll.
-- O daemon executa skills via computer-use no GO-Global do Domínio Web.
--
-- Fluxo:
--   1. Ana ou painel chama POST /api/joao/jobs → linha entra como 'pending' ou
--      'pending_approval' (se ação sensível e não auto-aprovada)
--   2. Operador aprova via painel/WhatsApp → vira 'pending'
--   3. Daemon long-poll → marca 'running' → executa → marca 'done' ou 'failed'
--   4. Se origem_telefone setada, hook posterior dispara notificação no WhatsApp
--      com o resultado
--
-- Tipos suportados (parametros tem schema próprio por tipo):
--   - importar_txt: importa arquivo TXT de lançamentos no Domínio Web (skill dominio-importar-txt)
--   - classificar_extrato: PDF Itaú → entradas.txt categorizado (skill dominio-extrato-bancario-itau)
--   - gerar_obrigacao: ECD/balancete/encerramento exercício (varia por sub-tipo nos params)
--   - monitorar_onvio: ativa/desativa polling do Onvio Documentos pra um cliente
--   - generico: payload livre, daemon decide skill apropriada
CREATE TABLE IF NOT EXISTS joao_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  cliente_id INTEGER,
  parametros TEXT NOT NULL,            -- JSON com params específicos do tipo
  status TEXT NOT NULL DEFAULT 'pending',
  -- Valores: pending | pending_approval | running | done | failed | cancelled
  resultado TEXT,                       -- JSON com retorno (logs, paths, etc) quando done
  erro TEXT,                            -- mensagem de erro quando failed
  prioridade INTEGER NOT NULL DEFAULT 5, -- 1=alta, 10=baixa; daemon serve por prioridade asc + criado_em
  criado_por TEXT,                      -- 'ana' | 'painel' | nome do operador
  origem_conversa_id INTEGER,           -- FK whatsapp_conversas se veio de Ana
  origem_telefone TEXT,                 -- pra notificar via WhatsApp ao terminar
  iniciado_em DATETIME,
  finalizado_em DATETIME,
  aprovado_por TEXT,                    -- quem aprovou (operador) se pending_approval
  aprovado_em DATETIME,
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultima_tentativa DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

CREATE INDEX IF NOT EXISTS idx_joao_jobs_status ON joao_jobs(status);
CREATE INDEX IF NOT EXISTS idx_joao_jobs_tipo_status ON joao_jobs(tipo, status);
CREATE INDEX IF NOT EXISTS idx_joao_jobs_cliente ON joao_jobs(cliente_id);
CREATE INDEX IF NOT EXISTS idx_joao_jobs_origem ON joao_jobs(origem_conversa_id);

-- Heartbeat do daemon (registro mais recente que o daemon do João tá vivo).
-- Painel mostra "João online (último ping há 12s)" / "João offline (3h)".
CREATE TABLE IF NOT EXISTS joao_daemon_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton: só uma linha
  ultimo_ping DATETIME,
  hostname TEXT,
  versao TEXT,
  jobs_ativos INTEGER DEFAULT 0,
  metadata TEXT                           -- JSON livre com info do daemon (Mac, Chrome, etc)
);
INSERT OR IGNORE INTO joao_daemon_heartbeat (id, ultimo_ping) VALUES (1, NULL);

-- =====================================================
-- Sync Domínio → Emissor (cadastro de clientes)
-- =====================================================
-- Log de cada operação de sync (skill `dominio-sync-clientes` envia upserts em
-- lote via POST /api/joao/sync/clientes; servidor reconcilia com a tabela
-- `clientes` e registra aqui o que mudou. Painel mostra "última sync" + diff.
CREATE TABLE IF NOT EXISTS clientes_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  iniciado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  finalizado_em DATETIME,
  fonte TEXT NOT NULL DEFAULT 'dominio',  -- 'dominio' | 'manual' | etc
  total_recebidos INTEGER NOT NULL DEFAULT 0,
  novos INTEGER NOT NULL DEFAULT 0,
  atualizados INTEGER NOT NULL DEFAULT 0,
  inalterados INTEGER NOT NULL DEFAULT 0,
  conflitos INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER,                         -- FK joao_jobs (se veio de job)
  detalhes TEXT,                          -- JSON com diff por cliente_id
  status TEXT NOT NULL DEFAULT 'running'  -- 'running' | 'done' | 'failed'
);

CREATE INDEX IF NOT EXISTS idx_clientes_sync_log_data ON clientes_sync_log(iniciado_em DESC);

-- Última sync por cliente — pra detectar drift, e pra equipe ver
-- "ESTUDIO SOMA: sincronizado pela última vez há 3d" no painel.
CREATE TABLE IF NOT EXISTS clientes_sync_status (
  cliente_id INTEGER PRIMARY KEY,
  ultima_sync_em DATETIME,
  ultimo_log_id INTEGER,                  -- FK clientes_sync_log
  hash_dominio TEXT,                      -- hash do snapshot Domínio na última sync
  campos_dessincronizados TEXT,           -- JSON: campos que divergem (se conflito)
  FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

-- =====================================================
-- Onvio doc-watcher — clientes monitorados + arquivos vistos
-- =====================================================
-- Quando equipe pede `[ACAO:MONITORAR_ONVIO:cliente_id|on]`, cria/atualiza
-- linha aqui. Skill `onvio-doc-watcher` (rodando como job recorrente do João)
-- lê esta tabela pra saber quem monitorar, varre Onvio Documentos via Chrome
-- MCP, e enfileira `classificar_extrato` pra cada PDF novo.
CREATE TABLE IF NOT EXISTS onvio_monitored_clients (
  cliente_id INTEGER PRIMARY KEY,
  ativo INTEGER NOT NULL DEFAULT 1,
  pasta_path TEXT,                        -- caminho da pasta de extratos no Onvio (cache)
  ultima_verificacao DATETIME,
  arquivos_vistos TEXT,                   -- JSON: array de file IDs/nomes já processados
  total_extratos_processados INTEGER DEFAULT 0,
  ultimo_extrato_em DATETIME,
  ativado_por TEXT,
  ativado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

CREATE INDEX IF NOT EXISTS idx_onvio_monitored_ativo ON onvio_monitored_clients(ativo);

-- =====================================================
-- Fechamento mensal Simples Nacional (PGDAS-D)
-- =====================================================
-- Registra cada tentativa de fechar o mês de um cliente. Fluxo:
--   1. Coleta receita do mês (notas_fiscais filtradas por cliente_id + data_competencia + status='emitida')
--   2. Calcula DAS (RBA12M via SERPRO + faixa + alíquota efetiva)
--   3. Transmite PGDAS-D via SERPRO entregarDeclaracaoMensal
--   4. Gera DAS pagamento
--   5. (futuro) João lança apuração contábil no Domínio
--
-- Status:
--   draft           — calculado mas não transmitido (aguarda revisão humana)
--   pending_approval — aguarda aprovação humana antes de transmitir
--   transmitting    — em transmissão pra SERPRO
--   transmitted     — declaração entregue (recibo SERPRO obtido)
--   das_generated   — DAS pdf gerado
--   contab_lancado  — apuração contábil lançada no Domínio (etapa João)
--   done            — ciclo completo (transmitted + DAS + contab)
--   failed          — erro irrecuperável
--   cancelled       — cancelado por humano antes de transmitir
CREATE TABLE IF NOT EXISTS pgdasd_fechamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,
  periodo_apuracao TEXT NOT NULL,         -- YYYYMM
  status TEXT NOT NULL DEFAULT 'draft',
  -- Dados coletados
  receita_bruta_mes REAL,                  -- valor total emitido no mês (NFs)
  total_nfs INTEGER DEFAULT 0,
  iss_retido_total REAL DEFAULT 0,
  rba12m REAL,                             -- receita bruta acumulada 12 meses
  anexo TEXT,                              -- 'I' | 'III' | 'IV' | 'V'
  aliquota_nominal REAL,                   -- alíquota da faixa (ex: 0.073)
  parcela_deduzir REAL DEFAULT 0,
  aliquota_efetiva REAL,                   -- ((rba12m * aliq_nominal) - PD) / rba12m
  valor_das REAL,                          -- DAS calculado
  -- Transmissão
  payload_serpro TEXT,                     -- JSON enviado
  recibo_serpro TEXT,                      -- nº do recibo retornado
  resposta_serpro TEXT,                    -- JSON completo da resposta
  transmitido_em DATETIME,
  -- DAS (após transmissão)
  das_numero TEXT,
  das_pdf_path TEXT,                       -- caminho do PDF salvo localmente
  das_vencimento DATE,
  das_gerado_em DATETIME,
  -- Aprovação
  aprovado_por TEXT,
  aprovado_em DATETIME,
  motivo_cancelamento TEXT,
  cancelado_em DATETIME,
  -- Erros
  erro TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultima_tentativa DATETIME,
  -- João (etapa final contábil)
  joao_job_id INTEGER,                     -- FK joao_jobs quando João lançar no Domínio
  -- Reconciliação 2 fontes (v2): receita vem de SERPRO + Emissor em paralelo.
  -- Se valores diferem, equipe escolhe fonte_receita_escolhida ou ajusta manualmente.
  receita_serpro REAL,                     -- receita do mês via SERPRO (NFS-e Nacional + SPED Fiscal)
  receita_emissor REAL,                    -- receita do mês via tabela notas_fiscais local
  fonte_receita_escolhida TEXT,            -- 'serpro' | 'emissor' | 'manual'
  divergencia_receita INTEGER DEFAULT 0,   -- 1 se receita_serpro != receita_emissor
  anexo_origem TEXT,                       -- 'cadastro' (via cTribNac) | 'manual'
  rbt12_origem TEXT,                       -- 'serpro' | 'manual' | 'historico_emissor'
  detalhes_calculo TEXT,                   -- JSON com passos/fórmulas/avisos (transparência)
  -- Auditoria
  criado_por TEXT,
  origem TEXT,                             -- 'painel' | 'ana' | 'cron' | 'manual'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id),
  UNIQUE(cliente_id, periodo_apuracao)
);

CREATE INDEX IF NOT EXISTS idx_pgdasd_status ON pgdasd_fechamentos(status);
CREATE INDEX IF NOT EXISTS idx_pgdasd_cliente_pa ON pgdasd_fechamentos(cliente_id, periodo_apuracao);
