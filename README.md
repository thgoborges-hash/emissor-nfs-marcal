# Emissor NFS-e - Marçal Contabilidade

Aplicativo web para emissão de Notas Fiscais de Serviço Eletrônicas (NFS-e) para clientes do escritório de contabilidade.

## Funcionalidades

### Portal do Cliente
- Emissão de NFS-e com formulário intuitivo
- Cadastro de tomadores (reutilizáveis)
- Histórico completo de notas emitidas
- Dashboard com resumo do mês

### Painel do Escritório
- Gestão de clientes (cadastro, certificados, permissões)
- Fila de aprovação de NFs
- Emissão de NFs em nome dos clientes
- Visão geral de todas as notas

## Setup Rápido

### Backend
```bash
cd backend
cp .env.example .env
npm install
npm run db:init    # Inicializa o banco com dados de exemplo
npm run dev        # Inicia em modo desenvolvimento (porta 3001)
```

### Frontend
```bash
cd frontend
npm install
npm start          # Inicia em modo desenvolvimento (porta 3000)
```

## Acessos de Teste

**Escritório:**
- Email: thgo.borges@gmail.com
- Senha: admin123

**Cliente (Tech Solutions):**
- CNPJ: 12.345.678/0001-90
- Senha: cliente123

## Stack Técnica
- **Frontend:** React 18, React Router, Axios
- **Backend:** Node.js, Express, SQLite (better-sqlite3)
- **Autenticação:** JWT
- **API:** REST, preparado para integração com NFS-e Nacional

## Estrutura do Projeto
```
emissor-nfs/
├── backend/
│   ├── src/
│   │   ├── database/     # Schema SQL e inicialização
│   │   ├── middleware/    # Autenticação JWT
│   │   ├── routes/        # Rotas da API
│   │   └── server.js      # Servidor Express
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/    # Layout, componentes reutilizáveis
│   │   ├── contexts/      # AuthContext
│   │   ├── pages/         # Páginas (cliente/ e escritorio/)
│   │   ├── services/      # API client (axios)
│   │   └── styles/        # CSS global
│   └── package.json
└── prototipo.html          # Protótipo visual (abre direto no navegador)
```

## Próximos Passos
1. Integração real com API NFS-e Nacional (certificado A1)
2. Interpretação de mensagens WhatsApp via IA
3. Envio automático de PDF ao cliente
4. Deploy (Vercel/Railway ou similar)
