import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

// Lista de atalhos organizada por relevância
const COMMANDS = [
  // Início
  { icon: '🌅', label: 'Operações Hoje', hint: 'Home operacional', path: '/escritorio/operacoes' },
  // Apuração (destaque)
  { icon: '💰', label: 'Apuração tributária', hint: 'Simular regimes e enviar pra fila', path: '/escritorio/apuracao' },
  // ANA
  { icon: '🤖', label: 'Fila ANA', hint: 'Ações aguardando aprovação', path: '/escritorio/fila-ana' },
  { icon: '🤖', label: 'Painel ANA', hint: 'Métricas e config do agente', path: '/escritorio/ana' },
  { icon: '🧪', label: 'Testar IA', hint: 'Sandbox conversacional', path: '/escritorio/testar-agente' },
  // NFs
  { icon: '📝', label: 'Emitir NF', hint: 'Emissão manual pela equipe', path: '/escritorio/emitir' },
  { icon: '📋', label: 'Todas as NFs', hint: 'Histórico completo', path: '/escritorio/notas' },
  { icon: '✅', label: 'Aprovações NF', hint: 'NFs pendentes de aprovação', path: '/escritorio/aprovacoes' },
  // Clientes
  { icon: '🏢', label: 'Gestão de clientes', hint: 'Cadastro e dados', path: '/escritorio/clientes' },
  { icon: '🔐', label: 'Certificados A1', hint: 'e-CNPJ por cliente', path: '/escritorio/certificados' },
  // Config
  { icon: '🏛️', label: 'Certificado SERPRO', hint: 'Status Integra Contador', path: '/escritorio/certificado-serpro' },
  { icon: '💬', label: 'WhatsApp', hint: 'Configurações de envio', path: '/escritorio/whatsapp' },
  { icon: '📈', label: 'Relatórios', hint: 'Faturamento, ranking, status', path: '/escritorio/relatorios' },
  { icon: '📊', label: 'Dashboard clássico', hint: 'Visão legada', path: '/escritorio' },
];

export default function CommandPalette() {
  const [aberto, setAberto] = useState(false);
  const [query, setQuery] = useState('');
  const [selecionado, setSelecionado] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  // Atalho global Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAberto(a => !a);
        setQuery('');
        setSelecionado(0);
      } else if (e.key === 'Escape' && aberto) {
        setAberto(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [aberto]);

  useEffect(() => {
    if (aberto) setTimeout(() => inputRef.current?.focus(), 50);
  }, [aberto]);

  // Expõe função global pro botão no sidebar abrir também
  useEffect(() => {
    window.__abrirCommandPalette = () => setAberto(true);
    return () => { delete window.__abrirCommandPalette; };
  }, []);

  const q = query.trim().toLowerCase();
  const filtrados = q
    ? COMMANDS.filter(c => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
    : COMMANDS;

  const irPara = (cmd) => {
    navigate(cmd.path);
    setAberto(false);
  };

  const handleKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelecionado(s => Math.min(s + 1, filtrados.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelecionado(s => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && filtrados[selecionado]) {
      e.preventDefault();
      irPara(filtrados[selecionado]);
    }
  };

  if (!aberto) return null;

  return (
    <div className="cmdk-backdrop" onClick={() => setAberto(false)}>
      <div className="cmdk-panel" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Buscar tela ou ação…"
          value={query}
          onChange={e => { setQuery(e.target.value); setSelecionado(0); }}
          onKeyDown={handleKey}
        />
        <div className="cmdk-list" role="listbox">
          {filtrados.length === 0 ? (
            <div className="cmdk-empty">Nenhum comando para "{query}"</div>
          ) : (
            filtrados.map((cmd, i) => (
              <div
                key={cmd.path + cmd.label}
                className="cmdk-item"
                aria-selected={i === selecionado}
                onClick={() => irPara(cmd)}
                onMouseEnter={() => setSelecionado(i)}
                role="option"
              >
                <span className="cmdk-icon">{cmd.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'var(--text)', fontWeight: 500 }}>{cmd.label}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 2 }}>{cmd.hint}</div>
                </div>
                {i === selecionado && <span className="cmdk-shortcut">↵</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
