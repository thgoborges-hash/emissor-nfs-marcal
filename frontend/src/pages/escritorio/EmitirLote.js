import React, { useState, useRef } from 'react';
import api from '../../services/api';

const HEADER_CSV = 'cnpj_emitente,valor,cnpj_tomador,razao_tomador,descricao,codigo_servico,competencia';
const EXEMPLO_CSV = `${HEADER_CSV}
27998575000100,890.00,04406995927,Maysa Bittencourt,Atendimentos e Consultas medicas,123012200,2026-04
61503692000185,1500.00,12345678000190,Cliente Exemplo,Consultoria empresarial,,2026-04`;

function EmitirLote() {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const [loteAtivo, setLoteAtivo] = useState(null); // {loteId, itens, errosParse}
  const [statusLote, setStatusLote] = useState(null);
  const [processando, setProcessando] = useState(false);

  const lerArquivo = async (acao) => {
    const file = fileRef.current?.files?.[0];
    if (\!file) { setMensagem({ tipo: 'erro', texto: 'Selecione um arquivo CSV.' }); return; }
    const fd = new FormData();
    fd.append('arquivo', file);
    setMensagem(null);
    try {
      const resp = await api.post(`/notas-fiscais/lote/${acao}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return resp.data;
    } catch (err) {
      const body = err.response?.data;
      setMensagem({ tipo: 'erro', texto: body?.erro || err.message, detalhes: body?.erros });
      return null;
    }
  };

  const onValidar = async () => {
    setPreview(null); setLoteAtivo(null); setStatusLote(null);
    const r = await lerArquivo('preview');
    if (r) setPreview(r);
  };

  const onEmitir = async () => {
    const fd = new FormData();
    fd.append('arquivo', fileRef.current.files[0]);
    fd.append('ignorarErros', 'true');
    setProcessando(true);
    try {
      const resp = await api.post('/notas-fiscais/lote/emitir', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setLoteAtivo(resp.data);
      setMensagem({ tipo: 'sucesso', texto: `Lote ${resp.data.loteId} iniciado. ${resp.data.itens.length} NFs em processamento.` });
      pollStatus(resp.data.loteId);
    } catch (err) {
      setMensagem({ tipo: 'erro', texto: err.response?.data?.erro || err.message });
    } finally {
      setProcessando(false);
    }
  };

  const pollStatus = async (loteId) => {
    const tick = async () => {
      try {
        const r = await api.get(`/notas-fiscais/lote/${loteId}`);
        setStatusLote(r.data);
        if (r.data.pendentes > 0) setTimeout(tick, 3000);
      } catch {
        setTimeout(tick, 5000);
      }
    };
    tick();
  };

  const baixarTemplate = () => {
    const blob = new Blob([EXEMPLO_CSV], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'template_emissao_lote.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <h2 style={{ color: '#1a237e', margin: 0 }}>Emissão em Lote</h2>
      <p style={{ color: '#555', marginTop: 4 }}>
        Envie um CSV com uma NF por linha. Cada linha deve ter o CNPJ do cliente emitente — cada cliente precisa ter certificado A1 cadastrado.
      </p>

      <div style={{ backgroundColor: '#f5f7fb', padding: 16, borderRadius: 10, marginTop: 16 }}>
        <div style={{ fontSize: 13, color: '#374151', marginBottom: 8 }}>
          <strong>Colunas esperadas (header da primeira linha):</strong>
        </div>
        <code style={{ display: 'block', fontSize: 12, padding: 8, backgroundColor: '#fff', borderRadius: 6, color: '#111' }}>
          {HEADER_CSV}
        </code>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
          • <code>codigo_servico</code> e <code>competencia</code> são opcionais (usa do cadastro do cliente / mês atual).
          • Separador aceito: vírgula ou ponto-e-vírgula. Encoding: UTF-8.
        </div>
        <button onClick={baixarTemplate} style={btnSecondary}>⬇ Baixar template</button>
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="file" accept=".csv,text/csv" ref={fileRef} style={{ flex: 1 }} />
        <button onClick={onValidar} style={btnSecondary}>Validar</button>
        <button onClick={onEmitir} style={btnPrimary} disabled={processando || \!preview}>
          {processando ? 'Enviando…' : 'Emitir em lote'}
        </button>
      </div>

      {mensagem && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 8,
          backgroundColor: mensagem.tipo === 'erro' ? '#ffebee' : '#e8f5e9',
          color: mensagem.tipo === 'erro' ? '#c62828' : '#2e7d32',
        }}>
          <strong>{mensagem.texto}</strong>
          {mensagem.detalhes && (
            <ul style={{ marginTop: 8, fontSize: 13 }}>
              {mensagem.detalhes.slice(0, 20).map((e, i) => (
                <li key={i}>Linha {e.linha}: {e.erro}</li>
              ))}
              {mensagem.detalhes.length > 20 && <li>…e mais {mensagem.detalhes.length - 20} erros</li>}
            </ul>
          )}
        </div>
      )}

      {preview && \!loteAtivo && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ color: '#374151' }}>Prévia do CSV</h3>
          <div style={{ fontSize: 14, color: '#4b5563' }}>
            {preview.total} linha(s) detectadas — {preview.total - preview.erros.length} válidas, {preview.erros.length} com erro.
          </div>
          {preview.erros.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, backgroundColor: '#fff3e0', borderRadius: 8, fontSize: 13 }}>
              ⚠️ Linhas com erro (serão IGNORADAS ao emitir):
              <ul>{preview.erros.slice(0, 15).map((e, i) => <li key={i}>Linha {e.linha}: {e.erro}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {statusLote && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ color: '#374151' }}>Progresso do lote {statusLote.loteId}</h3>
          <div style={{ fontSize: 14, color: '#4b5563' }}>
            {statusLote.emitidas} emitidas · {statusLote.pendentes} pendentes · {statusLote.erros} com erro · {statusLote.total} no total
          </div>
          <div style={{ marginTop: 8, height: 12, backgroundColor: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{
              width: `${Math.round(((statusLote.emitidas + statusLote.erros) / Math.max(statusLote.total, 1)) * 100)}%`,
              height: '100%', backgroundColor: '#1a237e', transition: 'width 0.5s',
            }} />
          </div>
          <table style={{ marginTop: 14, width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ backgroundColor: '#f3f4f6' }}>
              <th style={th}>ID</th><th style={th}>Status</th><th style={th}>nNFSe</th><th style={th}>Valor</th><th style={th}>Observações</th>
            </tr></thead>
            <tbody>
              {statusLote.itens.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <td style={td}>{it.id}</td>
                  <td style={{ ...td, color: it.status === 'emitida' ? '#2e7d32' : it.status === 'erro_emissao' ? '#c62828' : '#6b7280', fontWeight: 600 }}>{it.status}</td>
                  <td style={td}>{it.numero_nfse || '—'}</td>
                  <td style={td}>R$ {Number(it.valor_servico || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                  <td style={{ ...td, fontSize: 11, color: '#6b7280' }}>{String(it.observacoes || '').substring(0, 200)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const btnPrimary = { padding: '8px 18px', borderRadius: 8, border: 'none', backgroundColor: '#1a237e', color: '#fff', fontWeight: 600, cursor: 'pointer' };
const btnSecondary = { padding: '8px 14px', borderRadius: 8, border: '1px solid #c7d2fe', backgroundColor: '#fff', color: '#1a237e', fontWeight: 600, cursor: 'pointer' };
const th = { padding: '8px 10px', textAlign: 'left', fontSize: 12, color: '#374151' };
const td = { padding: '8px 10px', color: '#111' };

export default EmitirLote;
