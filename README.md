# Emissor NFs — Marçal Contabilidade

Sistema interno do escritório **Marçal Contabilidade** (Curitiba/PR). Junta em uma só plataforma:

- 🧾 **Emissão de NFS-e Nacional** via API oficial (em produção desde abr/2026)
- 🤖 **Ana** — agente IA no WhatsApp atendendo clientes finais e equipe interna 24/7
- 🛠️ **João** — daemon local que opera o Domínio Web via computer-use
- 🏛️ **Integra Contador (SERPRO/RFB)** — DAS, DCTFWeb, PGDAS-D, caixa postal e-CAC, procurações
- 📊 **Fechamento PGDAS-D** automatizado (Simples Nacional)
- 🔗 **Domínio API** (Thomson Reuters) — upload de XML fiscal
- 📁 **OneDrive Marçal** — descoberta automática de certificados A1
- ⏰ **Crons** — sync diário Domínio↔Emissor + watcher Onvio Documentos

> Sistema em produção: `https://emissor-nfs-marcal.onrender.com`

---

## Arquitetura em 30 segundos

```
┌─────────────────┐
│  WhatsApp       │  cliente final + equipe
│  (Z-API)        │
└────────┬────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│  ANA (Sonnet 4 + Haiku 4.5)                          │
│  Router → System prompt → Tools                      │
│                                                       │
│  Tools: EMITIR_NF · CANCELAR_NF · CONSULTAR_PGDASD   │
│         GERAR_DAS · CADASTRAR_A1 · ATUALIZAR_CLIENTE │
│         CONSULTAR_CADASTRO_CLIENTE                   │
│         CLASSIFICAR_EXTRATO · IMPORTAR_TXT_DOMINIO   │
│         CALCULAR_PGDASD · MONITORAR_ONVIO            │
└────────────┬─────────────────────────────────────────┘
             │
   ┌─────────┴─────────┐
   │                   │
   ▼                   ▼
API direta       Fila joao_jobs ──► JOÃO daemon (Mac do Thiago)
(SERPRO,                            invoca Claude Code subagent
NFS-e Nacional,                     que opera GO-Global / Chrome MCP
OneDrive,                           pra Domínio Web + Onvio
Domínio API)
```

---

## Funcionalidades por bloco

### 🧾 Emissão de NFS-e Nacional

- API oficial mTLS + assinatura XMLDSIG
- Certificado A1 por cliente (descoberta automática via OneDrive Marçal)
- Série DPS = 1 (API). NFs 111+ em produção desde 07/04/2026
- DANFSe PDF gerado localmente via Puppeteer + template v1.0
- Retry queue persistente: se o Portal Nacional cai, sistema reenvia automaticamente quando voltar; se esgotar 3 tentativas (17min), **avisa o cliente** que vai cuidar manualmente (não some em silêncio)

### 🤖 ANA — atendimento WhatsApp

Cliente externo e equipe interna no mesmo canal, com **detecção robusta de modo equipe** em 3 camadas (admin → grupo staff → prefixo "Nome:" + whitelist).

**Tools que dispara direto via API/local:**
- `EMITIR_NF`, `CANCELAR_NF`, `BUSCAR_DANFSE`, `LISTAR_NFS`
- `CONSULTAR_PGDASD_ULTIMA`, `CONSULTAR_PROCURACOES`, `CONSULTAR_DCTFWEB`, `LISTAR_CAIXA_POSTAL`
- `GERAR_DAS_SIMPLES`, `GERAR_DAS_MEI`, `GERAR_DAS_SIMPLES_AVULSO`
- `SOLICITAR_SITFIS`, `EMITIR_CCMEI`, `EMITIR_DARF`
- `CADASTRAR_A1`, `ATUALIZAR_CLIENTE`, `VINCULAR_CLIENTE`
- `CONSULTAR_CADASTRO_CLIENTE` — anti-alucinação: consulta o cadastro real do cliente antes de chutar "campo faltando"
- `CALCULAR_PGDASD` — calcula DAS Simples com auto-fill (anexo via cTribNac, RBT12 via SERPRO, receita reconciliada SERPRO+Emissor)

**Tools que enfileiram pro daemon João:**
- `CLASSIFICAR_EXTRATO`, `IMPORTAR_TXT_DOMINIO`, `GERAR_OBRIGACAO`, `MONITORAR_ONVIO`

**Arquitetura de segurança da Ana:**
- **Router Haiku** classifica intenção antes de chamar Sonnet (early-exit em handoff/grupo)
- **Grounding pré-envio**: bloqueia promessa-vazia + alucinação factual antes do cliente ver
- **Confirmação antes de emitir NF** (Sprint 2.1)
- **Auto-fix antes de transferir**: tenta corrigir erro tratável (E0116 IM, E0120, regime SN) antes de pedir humano
- **Fila de aprovação humana** pra ações sensíveis (importar TXT, gerar ECD)

### 🛠️ JOÃO — daemon local no Mac

Daemon Python que vive em `~/Library/Application Support/JoaoDaemon/`, conecta via OAuth do macOS keychain. Long-poll na fila `joao_jobs`, invoca Claude Code subagent (com persona João + skills de contabilidade), executa tarefas que exigem operação real do Domínio Web (computer-use no GO-Global).

**Skills do João (cada uma operada via Claude Code subagent):**
- `dominio-importar-txt` — Importador do Domínio
- `dominio-extrato-bancario-itau` — classificação PDF Itaú → entradas.txt
- `dominio-sync-clientes` — extrai cadastro do Domínio, POSTa no Emissor
- `onvio-doc-watcher` — Chrome MCP polling do Onvio Documentos
- `txt-encerramento-exercicio`, `txt-vinculacao-plano-referencial`, `ecd-pva-cli`

Daemon roda 24/7 via **launchd** (`~/Library/LaunchAgents/com.marcal.joao.daemon.plist`).

### 📊 Fechamento PGDAS-D (Simples Nacional)

Calcula DAS mensal **automaticamente** lendo dados reais:

| Campo | Origem |
|---|---|
| **Anexo** | cTribNac do cadastro → mapeamento LC 116/2003 |
| **RBT12** | SERPRO `CONSDECLARACAO13` somando últimas 12 declarações |
| **Receita do mês** | Reconciliação 2 fontes: SERPRO (NFS-e Nacional + SPED) + Emissor (notas_fiscais). Avisa se divergir — pode indicar emissão por fora |
| **DAS** | Fórmula LC 123/2006 (`aliq_efetiva = ((RBT12·nominal) - PD) / RBT12`) |

Pipeline: `calcular draft → revisar → aprovar → transmitir (SERPRO TRANSDECLARACAO11) → DAS PDF`

Painel: `/escritorio/fechamento-simples`. Transmissão exige **aprovação dupla** (irreversível).

Fora de escopo v2 (rejeita com mensagem clara): MEI (fluxo próprio), Indústria (anexo II), exportação, atividade concomitante, ISS retido, retificação, Fator R completo.

### ⏰ Crons recorrentes

| | |
|---|---|
| **03:00 BRT diário** | Enfileira job `sync_clientes_dominio` — João sincroniza cadastro Domínio → Emissor |
| **A cada 15min** | Pra cada cliente em `onvio_monitored_clients` ativo, enfileira `monitorar_onvio` — watcher Chrome MCP detecta PDFs novos no Onvio Documentos |

Controle via env `JOAO_CRONS_ENABLED=false` desliga.

---

## Stack

- **Backend**: Node.js 18+ / Express / SQLite (better-sqlite3)
- **Frontend**: React 18 / React Router / Axios / CSS dark theme custom
- **WhatsApp**: Z-API (não-oficial, suporta grupos)
- **IA**: Claude Sonnet 4 (loop principal) + Haiku 4.5 (router + grounding)
- **SERPRO**: OAuth2 + mTLS via certificado A1 Marçal + procuração coletiva
- **Domínio API**: OAuth2 + upload de XML fiscal
- **Daemon João**: Python 3.9 + launchd no Mac do Thiago
- **Deploy**: Docker / Render Starter / auto-deploy `main`

---

## Setup local

### Backend
```bash
cd backend
cp .env.example .env  # preencher SERPRO_*, MARCAL_*, ZAPI_*, JOAO_DAEMON_SECRET
npm install
npm run dev           # porta 3001
```

### Frontend
```bash
cd frontend
npm install
npm start             # porta 3000
```

### Daemon João (no Mac do Thiago)
```bash
# Já instalado via launchd (~/Library/LaunchAgents/com.marcal.joao.daemon.plist)
# Pra atualizar após git pull:
bash ~/Library/Application\ Support/JoaoDaemon/update-from-repo.sh
```

---

## Variáveis de ambiente principais

```bash
# Auth + Banco
JWT_SECRET=...
DB_PATH=./data/emissor.db

# NFS-e Nacional
NFSE_AMBIENTE=producao
NFSE_SIMULACAO=false

# WhatsApp Z-API
WHATSAPP_PROVIDER=zapi
ZAPI_INSTANCE_ID=...
ZAPI_TOKEN=...
ZAPI_CLIENT_TOKEN=...

# Ana
ANTHROPIC_API_KEY=sk-ant-...
ANA_ADMIN_WHATSAPP=5541999999999
ANA_OPERADORES=Janaina Alves,Lucas Silva,Thiago Borges
ANA_STAFF_GROUP_IDS=120363...

# SERPRO Integra Contador
SERPRO_CONSUMER_KEY=...
SERPRO_CONSUMER_SECRET=...
MARCAL_CNPJ=00000000000000
MARCAL_CERT_SENHA_ENCRYPTED=...

# SIEG (worker XML)
SIEG_API_KEY=...
SIEG_SYNC_ENABLED=false

# João Daemon (segredo HMAC entre Render e daemon no Mac)
JOAO_DAEMON_SECRET=<openssl rand -hex 32>
JOAO_CRONS_ENABLED=true

# OneDrive Marçal (descoberta A1)
ONEDRIVE_CLIENT_ID=...
ONEDRIVE_CLIENT_SECRET=...
```

Lista completa: `backend/.env.example`.

---

## Estrutura do repo

```
emissor-nfs/
├── backend/
│   ├── src/
│   │   ├── server.js                  # Express + cron wires
│   │   ├── database/
│   │   │   ├── schema.sql             # Schema completo (~600 linhas)
│   │   │   └── init.js                # Migrations idempotentes
│   │   ├── middleware/auth.js         # JWT + RBAC
│   │   ├── routes/                    # auth, clientes, notasFiscais, integraContador,
│   │   │                              # whatsapp, joao, dominio, onedrive, sieg, ...
│   │   └── services/
│   │       ├── agenteIAService.js     # Ana — loop principal (~2500 linhas)
│   │       ├── anaRouterService.js    # Sprint 1.1
│   │       ├── anaGroundingValidator.js  # Sprint 1.3
│   │       ├── joaoService.js         # Fila joao_jobs
│   │       ├── joaoCronService.js     # Crons recorrentes
│   │       ├── pgdasdFechamentoService.js     # PGDAS-D v1+v2
│   │       ├── pgdasdAutoFillService.js       # PGDAS-D v2 (anexo/RBT12/reconciliação)
│   │       ├── clienteSyncService.js  # Sync Domínio→Emissor
│   │       ├── clienteCadastroAuditor.js  # Tool CONSULTAR_CADASTRO_CLIENTE
│   │       ├── integraContadorService.js  # SERPRO OAuth2 + mTLS
│   │       ├── nfseNacionalService.js     # NFS-e Nacional API
│   │       ├── dominioService.js          # Domínio API (Thomson Reuters)
│   │       ├── zapiService.js, oneDriveService.js, siegService.js, ...
│   └── package.json
├── frontend/
│   └── src/
│       ├── pages/escritorio/
│       │   ├── OperacoesHoje.js       # Home (tiles + chips de status)
│       │   ├── FilaAprovacaoAna.js    # Aprovação ações ANA
│       │   ├── PainelJoao.js          # Status daemon + fila de jobs
│       │   ├── FechamentoSimples.js   # PGDAS-D
│       │   └── ... (NF, clientes, certificados, etc)
│       └── styles/global.css          # Design system Cockpit Dark (~3000 linhas)
└── README.md
```

---

## Fluxos principais

### Cliente final pede NF pelo WhatsApp
```
Cliente: "emite 3.000 pra CNPJ X como consultoria"
   ↓
Ana → Router (intent=acao_emitir_nf, conf=92)
    → Sonnet com tools
    → Plano-antes-de-executar (confirma)
Cliente: "sim"
    → EMITIR_NF → NFS-e Nacional API → SEFIN → NF emitida
    → DANFSe PDF via Puppeteer → WhatsApp pro cliente
```

### Equipe pede consulta SERPRO
```
Janaina (modo equipe via prefixo "Janaina:"):
"qual a última PGDAS da Uplay?"
   ↓
Ana → CONSULTAR_PGDASD_ULTIMA(cnpj_Uplay)
    → SERPRO mTLS → resposta
    → Formata + responde no WhatsApp
```

### Fechamento PGDAS-D automatizado
```
Equipe pelo painel ou WhatsApp:
"fecha o PGDAS-D do Estudio Soma de abril"
   ↓
Ana → CALCULAR_PGDASD(cnpj, 202604)  [só 2 campos]
    → Auto-fill v2:
       • Anexo via cTribNac do cadastro
       • RBT12 via SERPRO CONSDECLARACAO13 (12 últimos)
       • Receita reconciliada SERPRO + Emissor (avisa se divergir)
    → Cálculo DAS via LC 123/2006
    → Persiste como draft #N → resposta WhatsApp
   ↓ (equipe revisa no painel)
   ↓ Botão Aprovar → status pending_approval
   ↓ Botão Transmitir (confirmação dupla, IRREVERSÍVEL)
   ↓ SERPRO TRANSDECLARACAO11 → recibo → DAS gerado
```

### Cliente sobe extrato no Onvio (automático)
```
[Cron 15min] Cron Emissor → enfileira job `monitorar_onvio` pra
   cada cliente em onvio_monitored_clients ativo
   ↓
Daemon João (Mac) puxa job → invoca Claude Code subagent
   → skill onvio-doc-watcher → Chrome MCP em sessão logada
   → detecta PDFs novos por nome (extrato, bb, itau, ...)
   → enfileira `classificar_extrato` pra cada PDF
   ↓
Daemon puxa próximo → skill dominio-extrato-bancario-itau
   → parser PDF → classifica → entradas.txt CP1252
   → enfileira `importar_txt`
   ↓
Daemon → skill dominio-importar-txt → computer-use GO-Global
   → F8 → valida CNPJ → Utilitários → Importação → Importador
   → captura erros/advertências
   → WhatsApp pra equipe: "Cliente X: 12 lançamentos importados"
```

---

## Equipe

| Pessoa | Papel |
|---|---|
| Thiago Borges | Sócio, owner técnico do projeto |
| Janaina Alves | Operadora Domínio + painel |
| Lucas Silva | Operador Domínio + painel |

**Whitelist Ana modo equipe** (`ANA_OPERADORES`): mensagens prefixadas com qualquer um desses nomes seguidas de `:` viram modo equipe.

---

## Observações operacionais

- **Push em `main` auto-deploya em ~2min** no Render. Cuidado.
- **NFs em produção desde abr/2026**: zero ambiente de teste.
- **Daemon João depende do Mac do Thiago ligado** (launchd só roda em sessão Aqua).
- **Sessão GO-Global expira em 30min** de inatividade — skills do João devem operar rápido.
- **Domínio API e SIEG**: ver `INTEGRA_CONTADOR_SETUP.md`, `SIEG_SETUP.md`, `GUIA-INTEGRACAO-NFSE.md`.

---

## Documentos relacionados

- [`CLAUDE.md`](CLAUDE.md) — contexto técnico pra Claude Code da equipe (Janaina/Lucas)
- [`CLAUDE_EQUIPE.md`](CLAUDE_EQUIPE.md) — onboarding
- [`ONBOARDING_EQUIPE.md`](ONBOARDING_EQUIPE.md) — setup pra novos membros

---

## Licença

Uso interno do escritório Marçal Contabilidade. Não comercializado.
