# Templates WhatsApp Business - Marcal Contabilidade

Estes templates devem ser cadastrados no Meta Business Manager
(business.facebook.com > WhatsApp > Message Templates)

Todos os templates sao do tipo "Utility" (transacional).

---

## 1. nf_emitida — Notificacao de NF emitida

**Nome:** nf_emitida
**Categoria:** Utility
**Idioma:** pt_BR

**Header:** Nota Fiscal Emitida

**Body:**
```
Ola {{1}},

Informamos que a NFS-e *{{2}}* foi emitida com sucesso.

*Prestador:* {{3}}
*Servico:* {{4}}
*Valor:* R$ {{5}}

Acesse o documento fiscal pelo link abaixo.
```

**Variaveis:**
- {{1}} = nome do tomador (razao_social)
- {{2}} = numero da NFS-e
- {{3}} = razao social do prestador (cliente)
- {{4}} = descricao do servico
- {{5}} = valor do servico formatado

**Footer:** Marcal Contabilidade

**Botoes:**
- URL: "Ver DANFSe" -> {{url_danfse}}

---

## 2. nf_aprovada — Notificacao de NF aprovada

**Nome:** nf_aprovada
**Categoria:** Utility
**Idioma:** pt_BR

**Header:** Nota Fiscal Aprovada

**Body:**
```
Ola {{1}},

Sua solicitacao de NF no valor de *R$ {{2}}* para *{{3}}* foi *aprovada* pelo escritorio.

A emissao sera processada em seguida.
```

**Variaveis:**
- {{1}} = nome fantasia ou razao social do cliente
- {{2}} = valor do servico
- {{3}} = razao social do tomador

**Footer:** Marcal Contabilidade

---

## 3. nf_rejeitada — Notificacao de NF rejeitada

**Nome:** nf_rejeitada
**Categoria:** Utility
**Idioma:** pt_BR

**Header:** Nota Fiscal Rejeitada

**Body:**
```
Ola {{1}},

Sua solicitacao de NF no valor de *R$ {{2}}* foi *rejeitada*.

*Motivo:* {{3}}

Entre em contato com o escritorio caso tenha duvidas.
```

**Variaveis:**
- {{1}} = nome fantasia ou razao social do cliente
- {{2}} = valor do servico
- {{3}} = motivo da rejeicao

**Footer:** Marcal Contabilidade

**Botoes:**
- Quick Reply: "Falar com escritorio"

---

## 4. boas_vindas — Mensagem de boas-vindas

**Nome:** boas_vindas
**Categoria:** Utility
**Idioma:** pt_BR

**Body:**
```
Ola {{1}}! 👋

Bem-vindo ao canal de atendimento da *Marcal Contabilidade*.

Sou o assistente virtual e posso te ajudar com:
- Consultar status de notas fiscais
- Tirar duvidas sobre servicos
- Encaminhar solicitacoes ao escritorio

Como posso te ajudar?
```

**Variaveis:**
- {{1}} = nome do contato

**Footer:** Marcal Contabilidade

---

## 5. lembrete_pendencia — Lembrete de pendencia

**Nome:** lembrete_pendencia
**Categoria:** Utility
**Idioma:** pt_BR

**Body:**
```
Ola {{1}},

Voce possui *{{2}} nota(s) fiscal(is)* em status de *rascunho* que ainda nao foram enviadas para aprovacao.

Acesse o portal para revisar e enviar: {{3}}
```

**Variaveis:**
- {{1}} = nome fantasia ou razao social do cliente
- {{2}} = quantidade de NFs em rascunho
- {{3}} = link do portal

**Footer:** Marcal Contabilidade

---

## Notas importantes

1. Todos os templates precisam ser aprovados pela Meta antes de usar (24-48h)
2. Templates de "Utility" tem taxa menor que "Marketing"
3. Fora da janela de 24h, so e possivel enviar mensagens usando templates
4. Dentro da janela de 24h (apos cliente enviar mensagem), pode enviar texto livre
5. O agente IA usa texto livre (dentro da janela de 24h)
6. Notificacoes proativas (NF emitida, aprovada, etc.) usam templates
