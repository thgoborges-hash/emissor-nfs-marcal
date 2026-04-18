import React, { useState, useEffect } from 'react';
import { apuracaoApi } from '../../services/api';

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

export default function Apuracao() {
  const [metadados, setMetadados] = useState(null);

  // Formulário
  const [receitaMes, setReceitaMes] = useState('');
  const [rbt12, setRbt12] = useState('');
  const [setor, setSetor] = useState('servicos_gerais');
  const [issMunicipal, setIssMunicipal] = useState(5);
  const [margemLucro, setMargemLucro] = useState(15);
  const [clienteNome, setClienteNome] = useState('');
  const [mesApuracao, setMesApuracao] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Resultado
  const [resultado, setResultado] = useState(null);
  const [simulando, setSimulando] = useState(false);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    apuracaoApi.metadados().then(({ data }) => setMetadados(data)).catch(() => {});
  }, []);

  const simular = async (e) => {
    e?.preventDefault();
    setErro(null);
    setSimulando(true);
    try {
      const payload = {
        receitaMes: parseFloat(String(receitaMes).replace(',', '.')) || 0,
        setor,
        issMunicipal: (parseFloat(issMunicipal) || 5) / 100,
        margemLucroReal: (parseFloat(margemLucro) || 15) / 100,
      };
      if (rbt12) payload.rbt12 = parseFloat(String(rbt12).replace(',', '.'));
      const { data } = await apuracaoApi.simular(payload);
      setResultado(data);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setSimulando(false);
    }
  };

  const enviarParaFila = async (regimeKey) => {
    try {
      const { data } = await apuracaoApi.enviarFila({
        clienteNome,
        mes: `${MESES[parseInt(mesApuracao.split('-')[1]) - 1]}/${mesApuracao.split('-')[0]}`,
        simulacao: resultado,
        regimeEscolhido: regimeKey,
      });
      alert(`✅ Pendência #${data.id} criada na fila da ANA. Um humano da equipe precisa aprovar pra transmitir.`);
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    }
  };

  const brl = (v) => v == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
  const pct = (v) => v == null ? '—' : (v * 100).toFixed(2) + '%';

  const ordemRegimes = ['mei', 'simples', 'presumido', 'real'];

  return (
    <div>
      <h1 className="page-title">Apuração Tributária</h1>
      <p className="page-subtitle">
        Simula os 4 regimes simultaneamente pra mesma receita e destaca qual é o mais vantajoso.
        Envie pra fila da ANA quando decidir transmitir.
      </p>

      {/* Formulário */}
      <form onSubmit={simular} className="section-card">
        <h3 className="section-title">📋 Parâmetros</h3>
        <div className="form-row-3">
          <div className="form-group">
            <label>Cliente (opcional)</label>
            <input value={clienteNome} onChange={e => setClienteNome(e.target.value)} placeholder="Ex: Uplay Fitness SJP" />
          </div>
          <div className="form-group">
            <label>Mês de apuração</label>
            <input type="month" value={mesApuracao} onChange={e => setMesApuracao(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Setor / Anexo do Simples</label>
            <select value={setor} onChange={e => setSetor(e.target.value)}>
              {metadados?.setores.map(s => (
                <option key={s.codigo} value={s.codigo}>{s.nome}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row-3">
          <div className="form-group">
            <label>Receita do mês (R$) *</label>
            <input required type="text" inputMode="decimal" value={receitaMes}
              onChange={e => setReceitaMes(e.target.value)} placeholder="Ex: 28500" />
          </div>
          <div className="form-group">
            <label>RBT12 (últimos 12 meses — opcional)</label>
            <input type="text" inputMode="decimal" value={rbt12}
              onChange={e => setRbt12(e.target.value)} placeholder="Default: 12× receita" />
          </div>
          <div className="form-group">
            <label>ISS municipal (%)</label>
            <input type="number" min="0" max="10" step="0.1" value={issMunicipal}
              onChange={e => setIssMunicipal(e.target.value)} />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Margem de lucro estimada pra Lucro Real (%)</label>
            <input type="number" min="0" max="100" step="1" value={margemLucro}
              onChange={e => setMargemLucro(e.target.value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button type="submit" className="btn btn-primary" disabled={simulando || !receitaMes}>
              {simulando ? '⏳ Calculando…' : '⚡ Simular regimes'}
            </button>
          </div>
        </div>
      </form>

      {erro && <div className="alert alert-danger mt-3">{erro}</div>}

      {resultado && (
        <>
          {/* Resumo destaque */}
          <div className="alert alert-success mt-3" style={{ fontSize: 15 }}>
            <strong>✨ Mais vantajoso:</strong> {resultado.resumo}
          </div>

          {/* Grid de regimes */}
          <div className="regimes-grid mt-3">
            {ordemRegimes.map(key => {
              const r = resultado.regimes[key];
              if (!r) return null;
              return (
                <div
                  key={key}
                  className={`regime-card ${r.eMelhor ? 'melhor' : ''} ${!r.elegivel ? 'inelegivel' : ''}`}
                >
                  {r.eMelhor && <div className="regime-badge">⭐ Mais vantajoso</div>}
                  <div className="regime-head">
                    <h3>{r.nome}</h3>
                    {r.elegivel ? (
                      <span className="badge badge-aprovado">Elegível</span>
                    ) : (
                      <span className="badge badge-neutro">Inelegível</span>
                    )}
                  </div>

                  {r.elegivel ? (
                    <>
                      <div className="regime-valor">{brl(r.totalMes)}</div>
                      <div className="regime-valor-sub">por mês</div>
                      <div className="regime-aliq">
                        <span className="text-light text-sm">Alíquota efetiva</span>
                        <span style={{ fontWeight: 600 }}>{pct(r.aliquotaEfetiva)}</span>
                      </div>

                      {r.diferencaVsMelhor > 0 && (
                        <div className="regime-delta">
                          +{brl(r.diferencaVsMelhor)} vs. melhor
                        </div>
                      )}

                      <div className="regime-detalhes">
                        {Object.entries(r.detalhes || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                          <div key={k} className="regime-detalhe-linha">
                            <span className="text-muted text-sm">{formatarChave(k)}</span>
                            <span className="text-sm">{formatarValor(v)}</span>
                          </div>
                        ))}
                      </div>

                      {clienteNome && (
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => enviarParaFila(key)}
                          style={{ marginTop: 14, width: '100%' }}
                        >
                          📤 Enviar pra Fila ANA
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="regime-inelegivel">
                      <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.5 }}>🚫</div>
                      <div className="text-muted text-sm">{r.motivoInelegivel}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-muted text-sm mt-3" style={{ padding: '0 4px' }}>
            ⚠️ Cálculos simplificados pra comparação. Casos reais podem ter nuances (substituição tributária, regime misto, créditos PIS/COFINS não-cumulativos, adicional IRPJ trimestral). O Lucro Real aqui é uma <strong>estimativa</strong> — o cálculo preciso exige DRE completa.
          </p>
        </>
      )}
    </div>
  );
}

function formatarChave(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function formatarValor(v) {
  if (typeof v === 'number') {
    if (v >= 1 && v < 100 && (v * 100) % 1 !== 0 || (v > 0 && v < 1)) {
      // parece alíquota
      return v < 1 ? (v * 100).toFixed(2) + '%' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  return String(v);
}
