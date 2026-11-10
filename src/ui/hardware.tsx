import { useEffect, useState } from 'react'
import { Cpu, HardDrive, MemoryStick, MonitorCog, RefreshCw } from 'lucide-react'
import { barStyle } from './bar'
import { EMPTY_HARDWARE, formatBytes, formatPercent, freshHardware, HardwareSnapshot, validateHardwareSnapshot } from '../../electron/hardwareTypes'

/** Latest validated hardware snapshot. Values older than 20 s are downgraded to N/D instead of being shown as if live. */
export function useHardware(now: number): HardwareSnapshot {
  const [value, setValue] = useState<HardwareSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    window.focusFlow.getHardware().then(raw => { const safe = validateHardwareSnapshot(raw); if (alive && safe) setValue(safe) }).catch(() => undefined)
    const unsubscribe = window.focusFlow.onHardware(raw => { const safe = validateHardwareSnapshot(raw); if (safe) setValue(safe) })
    return () => { alive = false; unsubscribe() }
  }, [])
  return freshHardware(value, now) ?? EMPTY_HARDWARE
}

const level = (value: number | null) => value === null ? 'na' : value >= 90 ? 'high' : value >= 70 ? 'mid' : 'low'

function Meter({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: number | null; detail: string }) {
  return <div className={`hw-card hw-${level(value)}`} title={`${label}: ${formatPercent(value)}`}>
    <div className="hw-card-head"><span className="hw-icon"><Icon size={15} /></span><span className="hw-label">{label}</span><strong className="hw-value">{formatPercent(value)}</strong></div>
    <div className="hw-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-valuetext={formatPercent(value)}><span style={barStyle(value ?? 0)} /></div>
    <small className="hw-detail">{detail}</small>
  </div>
}

function gpuDetail(snapshot: HardwareSnapshot): string {
  if (snapshot.gpu.percent === null) return snapshot.status === 'off' || snapshot.status === 'starting' ? 'Aguardando leitura' : 'Contadores de GPU indisponíveis neste PC'
  if (snapshot.gpu.adapters.length > 1) return snapshot.gpu.adapters.map(adapter => `${adapter.id} ${Math.round(adapter.percent)}%`).join(' · ')
  return 'Placa de vídeo mais ativa'
}

export function HardwarePanel({ snapshot, enabled, onRetry, onEnable }: { snapshot: HardwareSnapshot; enabled: boolean; onRetry: () => void; onEnable: () => void }) {
  if (!enabled) {
    return <section className="hardware-section"><div className="section-heading"><div><h3>Desempenho do sistema</h3><p>O monitor está desativado e não consome recursos.</p></div><button className="button secondary" onClick={onEnable}>Ativar monitor</button></div></section>
  }
  const problem = snapshot.status === 'degraded' || snapshot.status === 'unavailable'
  return <section className="hardware-section" aria-label="Desempenho do sistema">
    <div className="section-heading">
      <div><h3>Desempenho do sistema</h3><p>Uso total do computador, atualizado a cada poucos segundos.</p></div>
      {problem && <button className="button secondary" onClick={onRetry}><RefreshCw size={14} /> Tentar novamente</button>}
    </div>
    <div className="hw-grid">
      <Meter icon={Cpu} label="CPU DO SISTEMA" value={snapshot.cpu} detail="Todos os núcleos, não apenas o FocusFlow" />
      <Meter icon={MemoryStick} label="RAM FÍSICA" value={snapshot.ram.percent} detail={snapshot.ram.totalBytes !== null ? `${formatBytes(snapshot.ram.usedBytes)} de ${formatBytes(snapshot.ram.totalBytes)} em uso` : 'N/D'} />
      <Meter icon={MonitorCog} label="GPU" value={snapshot.gpu.percent} detail={gpuDetail(snapshot)} />
      <Meter icon={HardDrive} label="DISCO (E/S)" value={snapshot.disk.activityPercent} detail="Atividade: tempo ocupado do disco mais ativo" />
    </div>
    <div className="hw-storage" aria-label="Armazenamento">
      <span className="eyebrow">ARMAZENAMENTO · CAPACIDADE USADA</span>
      {snapshot.disk.volumes.length === 0 ? <small className="hw-detail">N/D</small> : <ul>{snapshot.disk.volumes.map(volume => {
        const percent = volume.totalBytes ? Math.round((volume.usedBytes ?? 0) / volume.totalBytes * 100) : null
        return <li key={volume.id} className={volume.totalBytes === null ? 'is-missing' : ''}>
          <strong>{volume.id}</strong>
          <span className="hw-volume-label">{volume.label || 'Disco local'}</span>
          <div className="hw-bar thin"><span style={barStyle(percent ?? 0)} /></div>
          <small>{volume.totalBytes === null ? 'N/D (desconectado ou ilegível)' : `${formatBytes(volume.usedBytes)} de ${formatBytes(volume.totalBytes)} (${percent}%)`}</small>
        </li>
      })}</ul>}
    </div>
    {problem && <p className="hw-note" role="status">{snapshot.status === 'unavailable' ? 'Leituras de disco e GPU indisponíveis no momento. ' : 'Algumas leituras estão indisponíveis. '}{snapshot.notes.join(' · ')}</p>}
  </section>
}

/** Four-cell compact summary for the floating widget. */
export function WidgetHardware({ snapshot }: { snapshot: HardwareSnapshot }) {
  const cell = (label: string, value: number | null, title: string) => <span className={`whw-cell hw-${level(value)}`} title={`${title}: ${formatPercent(value)}`}><small>{label}</small><strong>{formatPercent(value)}</strong></span>
  return <div className="widget-hw" aria-label="Resumo do sistema">
    {cell('CPU', snapshot.cpu, 'CPU do sistema')}
    {cell('RAM', snapshot.ram.percent, 'RAM física')}
    {cell('GPU', snapshot.gpu.percent, 'GPU')}
    {cell('DISCO', snapshot.disk.activityPercent, 'Atividade do disco')}
  </div>
}
