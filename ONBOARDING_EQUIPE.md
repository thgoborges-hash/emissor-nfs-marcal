# Onboarding — Janaina e Lucas

Guia passo a passo pra você configurar seu Claude Desktop pra colaborar no projeto da Marçal Contabilidade. Leva uns 30-45 minutos no total.

> Topologia: tudo concentrado no GitHub do Thiago (`thgoborges-hash`). Você puxa e empurra direto pra origin dele — não tem fork, não tem cópia paralela. Você tem permissão de push direto.

---

## 0. Pré-requisitos

Antes de começar, confirma que você tem:

- ✅ Claude Desktop instalado com a sua licença individual ([download aqui](https://claude.ai/download))
- ✅ Conta GitHub (pessoal ou de trabalho — me passa o username pro Thiago te adicionar)
- ✅ `git` instalado (no terminal: `git --version`)
- ✅ Node.js 20+ se você for rodar o Emissor localmente (`node -v`)
- ✅ Acesso ao grupo do escritório no WhatsApp (pra perguntas e avisos)

Se faltar algum, instala antes de continuar.

---

## 1. Aceitar convite no GitHub e clonar o repositório principal

1. O Thiago vai te enviar um convite por e-mail pra ser **Collaborator** em `thgoborges-hash/emissor-nfs-marcal`. Aceita o convite.
2. No terminal, escolhe a pasta onde os projetos do escritório vão viver (sugestão: `~/Documents/Claude/Projects/`).
3. Cria a pasta-pai do workspace e entra nela:
   ```bash
   mkdir -p ~/Documents/Claude/Projects/"Emissor NFs - Marçal"
   cd ~/Documents/Claude/Projects/"Emissor NFs - Marçal"
   ```
4. Clona o repo de código dentro dela:
   ```bash
   git clone https://github.com/thgoborges-hash/emissor-nfs-marcal.git emissor-nfs
   ```
5. Configura seu nome e e-mail do git (se ainda não fez):
   ```bash
   git config --global user.name "Janaina Alves"   # ou Lucas Silva
   git config --global user.email "seu-email@..."
   ```

A primeira vez que você fizer `git push`, o GitHub vai pedir autenticação. Use **Personal Access Token (PAT)** com scope `repo` — o token fica salvo no keychain do macOS depois da primeira vez.

> **Como criar um PAT:** github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token → Repository access: `emissor-nfs-marcal` e `marcal-skills-marketplace` → Permissions: Contents = Read and write.

---

## 2. Apontar o Cowork do Claude Desktop pra esse workspace

1. Abre o Claude Desktop.
2. Entra em **Cowork mode**.
3. Quando o Claude pedir/oferecer pra escolher uma pasta de trabalho, seleciona:
   ```
   ~/Documents/Claude/Projects/Emissor NFs - Marçal
   ```
4. Pronto — o Claude vai ler automaticamente o `CLAUDE.md` da raiz e o `emissor-nfs/CLAUDE.md` quando você trabalhar com o código.

> A pasta-pai (`Emissor NFs - Marçal/`) é o workspace porque ela contém: o repo de código (`emissor-nfs/`), o marketplace de skills (`marcal-skills-marketplace/`), além de docs auxiliares (roadmap, visão de solução).

---

## 3. Instalar o marketplace de skills

O Thiago também vai te adicionar como Collaborator em `thgoborges-hash/marcal-skills-marketplace`. Esse repo contém as skills financeiras que o Claude vai usar pra atualizar dashboards, classificar extratos, etc.

No Claude Desktop, com o workspace já selecionado, digite no chat:

```
/plugin marketplace add github.com/thgoborges-hash/marcal-skills-marketplace
/plugin install marcal-financeiro@marcal-skills-marketplace
```

Reinicia o Claude Desktop. As 4 skills (`dashboard-dre`, `portal-dre`, `dre-extrato`, `fluxo-racco`) devem aparecer ativas.

**Como confirmar que instalou:** pergunta pro Claude `que skills eu tenho instaladas?` e ele lista. Tem que aparecer as quatro acima.

**Como atualizar quando o Thiago publicar mudanças:**
```
/plugin marketplace update marcal-skills-marketplace
```

Você também pode contribuir com as skills — clona o `marcal-skills-marketplace`, edita o `SKILL.md` da skill que quer melhorar, atualiza a versão no `marketplace.json`, e dá push.

---

## 4. Credenciais externas (cada um tem as suas)

Algumas integrações exigem credenciais que **não dá pra compartilhar** — cada pessoa precisa das suas. Pede pro Thiago:

| Sistema | Pra que serve | O que você precisa |
|---|---|---|
| **GitHub PAT** | Push de código | Token fine-grained com escopo nos 2 repos |
| **Render dashboard** | Ver logs de produção, env vars | Convite pra organização Render do Thiago (read-only é suficiente) |
| **SERPRO Integra Contador** | Consultas DCTFWeb, PGDASD, etc | Não precisa — produção usa o cert da Marçal (procuração coletiva) |
| **Domínio (Thomson Reuters)** | Listar clientes | Login do escritório (já é o mesmo que você usa hoje) |
| **OneDrive Marçal (Graph API)** | Ler certificados A1 dos clientes | Acesso é via app registration — automático em produção |
| **Z-API (WhatsApp)** | Logs e configuração da ANA | Pede ao Thiago se precisar |

**Importante:** nunca commitar credencial em arquivo do git. Tudo via env do Render (em produção) ou via `.env` local (não versionado, está no `.gitignore`).

---

## 5. Rodar o Emissor localmente (opcional)

Se você quiser testar mudanças no backend antes de fazer push:

```bash
cd ~/Documents/Claude/Projects/"Emissor NFs - Marçal"/emissor-nfs/backend
npm install
npm start
```

O backend sobe em `http://localhost:3000`. O frontend (em `frontend/`) é separado — instruções no `emissor-nfs/README.md` e no `emissor-nfs/CLAUDE.md`.

> Se for só mexer em ANA / prompts, geralmente não precisa rodar local — push em `main` deploya em ~2min no Render e dá pra testar com WhatsApp diretamente.

---

## 6. Convenções importantes

Já estão detalhadas no `CLAUDE.md` da raiz do workspace, mas resumindo:

- **Branch principal:** `main`. Push direto em main é OK, **mas** sempre `git pull --rebase origin main` antes de começar pra evitar conflito.
- **Commits em português:** `feat(ana): ...`, `fix(emissor): ...`, `chore: ...`
- **Mudanças sensíveis na ANA** (qualquer arquivo em `backend/src/services/agente*` ou `backend/src/services/ana*`): avisa no grupo do escritório antes de pushar em horário comercial.
- **Push do GitHub via Cowork pode falhar** (proxy bloqueia tráfego git em algumas máquinas). Se acontecer, faz o push de um terminal nativo (Terminal.app no Mac), fora do Cowork. Token fica salvo no keychain depois da primeira vez.
- **NF emitida em produção é real** — desde 07/04/2026. Não é ambiente de teste. Cuidado em rotas de emissão.

---

## 7. Cadastro como operador da ANA

Pra que a ANA reconheça suas mensagens de WhatsApp como **modo equipe** (e não como cliente), seu nome precisa estar na env `ANA_OPERADORES` do Render. O Thiago configura — passa pra ele exatamente como você quer ser identificado:

```
ANA_OPERADORES=Janaina Alves,Lucas Silva,Thiago Borges
```

Quando você mandar mensagem pra ANA, **comece sempre com `Seu Nome:`** (igual ao cadastro). Exemplo:

```
Janaina: emite nota de R$ 1500 pro cliente XYZ Ltda, descrição: consultoria contábil mês 04/2026
```

Sem o prefixo, a ANA assume que você é cliente final e **pode emitir NF da Marçal** acidentalmente. Esse é um bug fiscal silencioso conhecido — está documentado em memória.

---

## 8. Checklist final

Antes de declarar setup completo, confirma:

- [ ] Aceitei convite GitHub nos 2 repos (`emissor-nfs-marcal` e `marcal-skills-marketplace`)
- [ ] Clonei `emissor-nfs` em `~/Documents/Claude/Projects/Emissor NFs - Marçal/emissor-nfs/`
- [ ] Selecionei a pasta-pai como workspace do Cowork
- [ ] Vejo o `CLAUDE.md` da equipe carregando quando converso com o Claude
- [ ] Instalei o marketplace e o plugin `marcal-financeiro`
- [ ] As 4 skills aparecem ativas (perguntei pro Claude e ele confirmou)
- [ ] Fiz um `git pull` de teste — funcionou
- [ ] Fiz um commit pequeno (ex: este checklist marcado) e pushei — funcionou
- [ ] Meu nome está na `ANA_OPERADORES` (Thiago confirmou)

Tudo marcado? Pronto. Já pode trabalhar normalmente.

---

## Dúvidas frequentes

**"O Claude não está vendo o `CLAUDE.md`."**
Confere que o workspace selecionado é a pasta-pai (`Emissor NFs - Marçal/`), não o `emissor-nfs/` interno. O Cowork lê o `CLAUDE.md` da raiz do workspace.

**"As skills não aparecem mesmo depois de instalar."**
Reinicia o Claude Desktop completamente (Cmd+Q e abre de novo, no Mac). Plugins novos só carregam no boot.

**"Push deu erro `gnutls_handshake() failed` ou parecido."**
É o proxy do Cowork. Faz o push de um Terminal nativo (fora do Cowork).

**"Posso testar localmente antes de pushar?"**
Sim — `cd emissor-nfs/backend && npm start`. Mas pra mudanças em prompt da ANA, o ciclo `push → Render deploy → WhatsApp` é mais rápido que rodar local.

**"Posso pushar direto em `main` sem PR?"**
Sim, você tem permissão. Mas em mudança em ANA / rotas de emissão, é boa prática fazer rebase + revisão visual antes (`git diff`) e avisar no grupo.

**"Como pego os logs da ANA pra debugar?"**
Tem um endpoint que exporta as conversas: ver `emissor-nfs/CLAUDE.md` seção "Próximos passos pra Claude Code → Pegar logs reais da ANA".

---

Qualquer coisa que travar, pergunta no grupo do escritório ou direto pro Thiago.

Bem-vindas, bem-vindos! 🚀
