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

  -- Certificado digital
  certificado_a1_path TEXT, -- caminho do arquivo .pfx
  certificado_a1_senha_encrypted TEXT, -- senha do certificado (criptografada)
  certificado_validade DATE,

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

-- Índices WhatsApp
CREATE INDEX IF NOT EXISTS idx_whatsapp_contatos_telefone ON whatsapp_contatos(telefone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_contatos_cliente ON whatsapp_contatos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversas_contato ON whatsapp_conversas(contato_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_mensagens_conversa ON whatsapp_mensagens(conversa_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_notificacoes_agendado ON whatsapp_notificacoes(agendado_para);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_clientes_cnpj ON clientes(cnpj);
CREATE INDEX IF NOT EXISTS idx_tomadores_cliente ON tomadores(cliente_id);
CREATE INDEX IF NOT EXISTS idx_tomadores_documento ON tomadores(documento);
CREATE INDEX IF NOT EXISTS idx_nfs_cliente ON notas_fiscais(cliente_id);
CREATE INDEX IF NOT EXISTS idx_nfs_status ON notas_fiscais(status);
CREATE INDEX IF NOT EXISTS idx_nfs_data_competencia ON notas_fiscais(data_competencia);
CREATE INDEX IF NOT EXISTS idx_log_cliente ON log_atividades(cliente_id);
