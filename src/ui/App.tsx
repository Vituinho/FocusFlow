import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity as ActivityIcon, AlertTriangle, ArrowRight, Bell, Check, CheckCircle2, ChevronDown, CircleHelp,
  Clock3, Coffee, Code2, Cpu, FolderOpen, Flame, Focus, Languages, Layers3, Keyboard, Lightbulb,
  ListChecks, Minus, Moon, MoreHorizontal, Pause, Play, Plus, RotateCcw, Settings2,
  SkipForward, Sparkles, Sun, Sunset, Utensils, X, Maximize2, Volume2, VolumeX,
  PanelTop, CalendarDays, type LucideIcon,
} from 'lucide-react'
import type { Activity, AppSettings, AppStatus, RuntimeCommand, ScheduleKind, Snapshot } from '../../electron/shared'
import { DEFAULT_SETTINGS } from '../../electron/shared'
import { effectiveView } from '../domain/engine'
import { formatClock, getDayTotals, isBreakActivity, parseTime, progressPercent, scheduleKindForDay, totalFocusMs, validateSchedule } from '../domain/schedule'
import { playChime } from './audio'
import { barStyle } from './bar'
import { HardwarePanel, useHardware, WidgetHardware } from './hardware'

const iconMap: Record<string, LucideIcon> = {
  calendar: CalendarDays, layers: Layers3, code: Code2, utensils: Utensils,
  sparkles: Sparkles, languages: Languages, coffee: Coffee, keyboard: Keyboard,
  lightbulb: Lightbulb, check: CheckCircle2, sunset: Sunset,
}

const pad = (value: number) => String(value).padStart(2, '0')

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`
}

/** mm:ss for short spans, h:mm:ss once an hour or more is left (e.g. the wait until Monday). */
function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}

const formatHours = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`
}

/** Wall-clock `now`, updated once a second only while the window is visible (no wasted renders when hidden in the tray). */
function useClock() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let timer: number | undefined
    const stop = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined }
    const sync = () => {
      stop()
      if (document.visibilityState === 'visible') { setNow(Date.now()); timer = window.setInterval(() => setNow(Date.now()), 1000) }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { stop(); document.removeEventListener('visibilitychange', sync) }
  }, [])
  return now
}

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const now = useClock()
  const load = useCallback(() => {
    window.focusFlow.getSnapshot().then(value => { if (value) { setSnapshot(value); setFailed(false) } else setFailed(true) }).catch(() => setFailed(true))
  }, [])
  useEffect(() => {
    load()
    const unsubscribe = window.focusFlow.onSnapshot(value => { setSnapshot(value); setFailed(false) })
    // Resynchronise after the window was hidden or the computer slept: pushed updates may have been missed.
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])
  // While nothing has loaded yet keep retrying quietly.
  useEffect(() => {
    if (snapshot) return
    const timer = window.setInterval(load, 2000)
    return () => window.clearInterval(timer)
  }, [snapshot, load])
  return { snapshot, now, failed, retry: load }
}

function useAnnouncements(enabled: boolean) {
  useEffect(() => window.focusFlow.onTransition(payload => {
    if (!enabled || payload.warning) return
    if (payload.sound) void playChime()
    if (payload.speech && 'speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(`Agora: ${payload.name}. Próxima atividade: ${payload.nextName || 'fim da rotina'}.`)
      utterance.lang = 'pt-BR'; utterance.rate = 0.96
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance)
    }
  }), [enabled])
}

function App() {
  const { snapshot, now, failed, retry } = useSnapshot()
  const isWidget = new URLSearchParams(location.search).get('window') === 'widget'
  useAnnouncements(!isWidget)
  useEffect(() => { if (snapshot) document.documentElement.dataset.theme = snapshot.data.settings.theme }, [snapshot?.data.settings.theme])
  if (!snapshot) {
    return <div className={`loading-screen ${isWidget ? 'widget-loading' : ''}`}>
      <span className="brand-mark"><Clock3 size={18} /></span><span>FocusFlow</span>
      {failed && <button className="button secondary" onClick={retry}>Tentar novamente</button>}
    </div>
  }
  return isWidget ? <Widget snapshot={snapshot} now={now} /> : <Dashboard snapshot={snapshot} now={now} />
}

function activityIcon(item?: Activity | null) {
  return item ? iconMap[item.icon] ?? ActivityIcon : Sun
}

/** Progress that freezes at the moment of the pause instead of jumping to 100 %. */
function shownProgress(startAt: number | null, endAt: number | null, now: number, paused: boolean, pausedAt?: number) {
  return progressPercent(startAt, endAt, paused ? (pausedAt ?? now) : now)
}

function Widget({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { data } = snapshot
  const { runtime, settings } = data
  const view = effectiveView(now, data.schedules, settings.workingDays, runtime)
  const hardware = useHardware(now)
  const [menu, setMenu] = useState(false)
  const [expanded, setExpanded] = useState(!settings.compactWidget)
  const active = view.activity
  const remaining = runtime.paused ? (runtime.frozenRemainingMs ?? 0) : Math.max(0, (view.endAt ?? view.nextAt ?? now) - now)
  const progress = shownProgress(view.startAt, view.endAt, now, runtime.paused, runtime.pausedAt)
  const Icon = activityIcon(active)
  const fire = (command: RuntimeCommand) => void window.focusFlow.command(command)
  const compact = async () => { const next = !expanded; setExpanded(next); await window.focusFlow.setCompact(!next) }
  return (
    <main className={`widget-shell ${settings.transparency ? 'widget-transparent' : ''} ${runtime.focusMode ? 'widget-focus' : ''} ${expanded ? '' : 'widget-compact'}`}>
      <header className="widget-head drag-region">
        <span className="widget-brand"><span className="mini-brand"><Clock3 size={12} /></span> focusflow <span className="live-dot" /></span>
        <div className="widget-actions no-drag">
          <button className={`icon-button tiny ${settings.alwaysOnTop ? 'is-active' : ''}`} title="Manter acima das janelas" onClick={() => void window.focusFlow.toggleAlwaysOnTop()}><PanelTop size={14} /></button>
          <button className="icon-button tiny" title={expanded ? 'Modo compacto' : 'Expandir widget'} onClick={() => void compact()}>{expanded ? <Minus size={14} /> : <Maximize2 size={14} />}</button>
          <button className="icon-button tiny" title="Abrir painel" onClick={() => void window.focusFlow.showDashboard()}><Maximize2 size={13} /></button>
        </div>
      </header>
      {view.kind === 'rest' ? <div className="widget-rest"><Moon size={17} /><div><strong>Dia de descanso</strong><span>Desconecte e recarregue.</span></div></div>
        : view.kind === 'finished' ? <div className="widget-rest"><Sunset size={18} /><div><strong>Dia concluído</strong><span>{view.nextAt ? `Próximo início: ${new Date(view.nextAt).toLocaleDateString('pt-BR', { weekday: 'long' })}, ${formatClock(view.nextAt)}` : 'Você fez o seu trabalho.'}</span></div></div>
          : <>
            <div className="widget-main">
              <span className="widget-icon" style={{ color: active?.color ?? 'var(--accent)', background: `${active?.color ?? 'var(--accent)'}1c` }}><Icon size={17} /></span>
              <div className="widget-activity"><span className="eyebrow">{runtime.paused ? 'PAUSADO' : view.kind === 'before' ? 'PRÓXIMO BLOCO' : 'EM ANDAMENTO'}</span><strong>{active?.name ?? (view.kind === 'before' && view.dayStart !== null && now >= view.dayStart ? 'Intervalo livre' : view.kind === 'before' ? 'Sua rotina começa em breve' : 'Foco do dia')}</strong><span>{view.startAt ? `${formatClock(view.startAt)} — ${formatClock(view.endAt ?? now)}` : `Começa às ${view.nextAt ? formatClock(view.nextAt) : '08:00'}`}</span></div>
            </div>
            <div className="widget-clock-row"><strong className="widget-countdown">{formatCountdown(remaining)}</strong><span className={`widget-status ${remaining <= 5 * 60_000 && remaining > 0 ? 'status-warning' : ''}`}>{runtime.paused ? 'Sessão pausada' : remaining <= 5 * 60_000 && remaining > 0 ? 'Quase lá' : 'Tempo restante'}</span></div>
            <div className="progress-track widget-progress"><span style={{ ...barStyle(progress), background: active?.color ?? 'var(--accent)' }} /></div>
            {expanded && <div className="widget-foot"><div className="next-copy"><span>PRÓXIMA</span><strong>{view.next?.name ?? 'Fim da rotina'}</strong></div><div className="widget-control no-drag">
              {runtime.paused ? <button className="round-control" onClick={() => fire({ type: 'resume' })} title="Retomar foco"><Play size={13} fill="currentColor" /></button> : <button className="round-control" disabled={!active} onClick={() => fire({ type: 'pause' })} title="Pausar foco"><Pause size={13} fill="currentColor" /></button>}
              <button className="round-control subtle" onClick={() => setMenu(!menu)} title="Mais opções"><MoreHorizontal size={15} /></button>
              {menu && <div className="widget-menu"><button onClick={() => { fire({ type: 'skip' }); setMenu(false) }}><SkipForward size={14} /> Pular atividade</button><button onClick={() => { fire({ type: 'automatic' }); setMenu(false) }}><RotateCcw size={14} /> Voltar à agenda</button><button onClick={() => { fire({ type: 'focus-mode', enabled: !runtime.focusMode }); setMenu(false) }}><Focus size={14} /> {runtime.focusMode ? 'Sair do modo foco' : 'Modo sem distrações'}</button></div>}
            </div></div>}
          </>}
      {settings.hardwareMonitor && <WidgetHardware snapshot={hardware} />}
    </main>
  )
}

function Dashboard({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { data } = snapshot
  const { settings, schedules, runtime } = data
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [tab, setTab] = useState<'hoje' | 'agenda'>('hoje')
  const [toast, setToast] = useState('')
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const hardware = useHardware(now)
  const today = new Date(now)
  const todayKind = scheduleKindForDay(today.getDay())
  const workingToday = settings.workingDays.includes(today.getDay())
  const daySchedule = workingToday ? schedules[todayKind] : []
  const effective = effectiveView(now, schedules, settings.workingDays, runtime)
  const current = effective.activity
  const waitTarget = effective.endAt ?? effective.nextAt
  const remaining = runtime.paused ? (runtime.frozenRemainingMs ?? 0) : Math.max(0, (waitTarget ?? now) - now)
  const totals = getDayTotals(daySchedule, now)
  const blockProgress = shownProgress(effective.startAt, effective.endAt, now, runtime.paused, runtime.pausedAt)
  const Icon = activityIcon(current)
  const fire = (command: RuntimeCommand) => void window.focusFlow.command(command)
  const agendaName = todayKind === 'saturday' ? 'sábado' : 'hoje'
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])
  useEffect(() => window.focusFlow.onTransition(payload => {
    if (!payload.warning) setToast(`Agora em foco: ${payload.name}`)
  }), [])
  useEffect(() => { window.focusFlow.getStatus().then(value => setStatus(value)).catch(() => undefined) }, [settingsOpen])
  const showWidget = async () => {
    try {
      const result = await window.focusFlow.showWidget()
      setToast(result?.ok ? 'Widget exibido.' : 'Não foi possível exibir o widget. Use “Recarregar janelas” na bandeja ou abra os logs em Configurações.')
    } catch { setToast('Não foi possível exibir o widget. Tente novamente.') }
  }
  const setHardwareEnabled = (enabled: boolean) => void window.focusFlow.saveSettings({ ...settings, hardwareMonitor: enabled })
  const todayLabel = today.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  const startLabel = effective.dayStart !== null ? formatClock(effective.dayStart) : '08:00'
  const waitLabel = runtime.paused ? 'TEMPO PAUSADO' : effective.kind === 'before' ? 'ATÉ O PRÓXIMO BLOCO' : effective.kind === 'rest' || effective.kind === 'finished' ? 'ATÉ O PRÓXIMO DIA ÚTIL' : 'TEMPO RESTANTE'
  const nextDayLabel = effective.nextAt ? `${new Date(effective.nextAt).toLocaleDateString('pt-BR', { weekday: 'long' })}, ${formatClock(effective.nextAt)}` : 'sem dias ativos'
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Clock3 size={18} strokeWidth={2.4} /></span><span>focusflow</span><span className="brand-beta">DESKTOP</span></div>
        <div className="sidebar-caption">ESPAÇO DE TRABALHO</div>
        <button className={`nav-item ${tab === 'hoje' ? 'selected' : ''}`} onClick={() => setTab('hoje')}><Sun size={17} /> Meu dia <span className="nav-dot" /></button>
        <button className={`nav-item ${tab === 'agenda' ? 'selected' : ''}`} onClick={() => setTab('agenda')}><ListChecks size={17} /> Agenda</button>
        <div className="sidebar-bottom">
          <div className="offline-note"><span className="offline-indicator"/><div><strong>Privado e local</strong><small>Seus dados ficam neste PC</small></div></div>
          <button className="nav-item settings-link" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> Configurações</button>
          <div className="version-note">FOCUSFLOW {__APP_VERSION__} <span>·</span> SEM CONTA</div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar drag-region">
          <div className="breadcrumbs"><span>Meu espaço</span><span className="crumb-sep">/</span><strong>{tab === 'hoje' ? 'Meu dia' : 'Agenda'}</strong></div>
          <div className="topbar-right no-drag"><div className="current-clock"><span className="clock-pip" />{formatClock(now)}</div><button className="icon-button" title="Configurações" onClick={() => setSettingsOpen(true)}><Settings2 size={18}/></button><button className="window-control" title="Minimizar para a bandeja" onClick={() => void window.focusFlow.minimize()}><Minus size={15}/></button><button className="window-control close-window" title="Fechar para a bandeja" onClick={() => void window.focusFlow.close()}><X size={15}/></button></div>
        </header>
        <div className="page-content">
          {status?.previousSessionEndedUnexpectedly && !noticeDismissed && <div className="notice" role="status"><AlertTriangle size={16}/><span>O FocusFlow foi reaberto após um encerramento inesperado. Seus dados estão intactos; detalhes em Configurações › Sistema.</span><button className="text-button" onClick={() => setNoticeDismissed(true)}>Dispensar</button></div>}
          <div className="page-heading"><div><div className="date-line"><CalendarDays size={14}/>{todayLabel}{workingToday && <span className="day-chip">{todayKind === 'saturday' ? 'Agenda de sábado' : 'Agenda de dias úteis'}</span>}</div><h1>{tab === 'hoje' ? 'No seu ritmo.' : 'Sua agenda.'}</h1><p>{tab === 'hoje' ? 'Um bloco de cada vez. Seu dia, com mais intenção.' : 'Uma rotina consistente abre espaço para um trabalho melhor.'}</p></div><button className="button secondary open-widget" onClick={() => void showWidget()}><PanelTop size={16}/> Mostrar widget</button></div>
          {tab === 'agenda' ? <SchedulePage snapshot={snapshot} onSaved={message => setToast(message)} onError={setToast} /> : <>
            <section className={`hero-card ${runtime.focusMode ? 'hero-focus' : ''}`} style={{ '--activity-color': current?.color ?? '#58d5bd' } as React.CSSProperties}>
              <div className="hero-glow" />
              <div className="hero-content">
                <div className="hero-topline"><div className="hero-state"><span className={`state-dot ${runtime.paused ? 'is-paused' : ''}`} />{runtime.paused ? 'PAUSADO' : effective.kind === 'rest' ? 'DIA DE DESCANSO' : effective.kind === 'finished' ? 'ROTINA CONCLUÍDA' : runtime.manual ? 'SESSÃO MANUAL' : effective.kind === 'before' && effective.dayStart !== null && now >= effective.dayStart ? 'INTERVALO LIVRE' : effective.kind === 'before' ? 'ANTES DO INÍCIO' : 'AGORA EM FOCO'}</div><button className="hero-more icon-button" title="Mais opções" onClick={() => setManualOpen(true)}><MoreHorizontal size={20}/></button></div>
                <div className="hero-middle">
                  <div className="hero-activity"><span className="hero-icon"><Icon size={23}/></span><div><span className="eyebrow">{runtime.manual ? 'MODO DE FOCO' : effective.kind === 'rest' ? 'RECARREGUE AS ENERGIAS' : effective.kind === 'finished' ? 'VOCÊ CHEGOU AO FIM' : 'BLOCO ATUAL'}</span><h2>{current?.name ?? (effective.kind === 'rest' ? 'Hoje é dia de descanso' : effective.kind === 'before' && effective.dayStart !== null && now >= effective.dayStart ? 'Intervalo livre' : effective.kind === 'before' ? `O dia começa às ${startLabel}` : 'Um ótimo trabalho por hoje')}</h2><div className="hero-time"><Clock3 size={14}/>{effective.startAt ? `${formatClock(effective.startAt)} — ${formatClock(effective.endAt ?? now)}` : effective.kind === 'before' ? `Próximo: ${effective.next ? `${effective.next.name} · ${formatClock(effective.nextAt ?? now)}` : startLabel}` : `Próximo início: ${nextDayLabel}`}</div></div></div>
                  <div className="timer-block"><div className="timer-label">{waitLabel}</div><div className={`big-timer ${remaining <= 5 * 60_000 && remaining > 0 && effective.kind === 'activity' ? 'timer-warning' : ''}`}><span>{formatCountdown(remaining)}</span></div><div className="timer-subtitle">{runtime.paused ? 'retome quando estiver pronto' : effective.kind === 'before' ? 'até a próxima atividade' : effective.kind === 'rest' || effective.kind === 'finished' ? 'para o próximo expediente' : remaining <= 5 * 60_000 && remaining > 0 ? 'reta final deste bloco' : 'na atividade atual'}</div></div>
                </div>
                <div className="hero-progress-wrap"><div className="hero-progress-label"><span>PROGRESSO DO BLOCO</span><strong>{Math.round(blockProgress)}%</strong></div><div className="progress-track hero-progress"><span style={barStyle(blockProgress)}/></div></div>
                <div className="hero-bottom"><div className="next-activity"><span className="next-icon"><ArrowRight size={15}/></span><div><span>EM SEGUIDA</span><strong>{effective.next?.name ?? 'Fim da rotina'}</strong>{effective.nextAt && effective.kind === 'activity' && effective.next && <small>às {formatClock(effective.nextAt)}</small>}</div></div><div className="focus-actions">{runtime.paused ? <button className="button primary" onClick={() => fire({ type: 'resume' })}><Play size={16} fill="currentColor"/> Retomar foco</button> : <button className="button primary" disabled={!current} onClick={() => fire({ type: 'pause' })}><Pause size={16} fill="currentColor"/> Pausar foco</button>}<button className="icon-button hero-action" title="Opções de foco" onClick={() => setManualOpen(true)}><MoreHorizontal size={18}/></button></div></div>
              </div>
            </section>
            <div className="stats-row">
              <div className="stat-card"><div className="stat-icon mint"><Flame size={17}/></div><div><span>FOCO NO DIA</span><strong>{formatDuration(totals.elapsedMs)}</strong></div><small>de {formatDuration(totals.totalMs)}</small></div>
              <div className="stat-card"><div className="stat-icon violet"><CheckCircle2 size={17}/></div><div><span>PROGRESSO</span><strong>{Math.round(totals.percent)}%</strong></div><div className="mini-progress"><span style={barStyle(totals.percent)}/></div></div>
              <div className="stat-card"><div className="stat-icon amber"><Clock3 size={17}/></div><div><span>ATIVIDADES</span><strong>{daySchedule.length}</strong></div><small>{workingToday ? `na agenda de ${agendaName}` : 'dia de descanso'}</small></div>
            </div>
            <HardwarePanel snapshot={hardware} enabled={settings.hardwareMonitor} onRetry={() => void window.focusFlow.retryHardware()} onEnable={() => setHardwareEnabled(true)} />
            <section className="timeline-section"><div className="section-heading"><div><h3>Plano de {todayKind === 'saturday' && workingToday ? 'sábado' : 'hoje'}</h3><p>{workingToday && daySchedule.length ? `${daySchedule[0].start} às ${[...daySchedule].sort((a, b) => parseTime(a.end) - parseTime(b.end)).at(-1)?.end} · ${formatHours(totalFocusMs(daySchedule))} de foco` : 'A estrutura do seu dia, no seu tempo.'}</p></div><button className="text-button" onClick={() => setTab('agenda')}>Editar agenda <ArrowRight size={14}/></button></div><Timeline schedule={daySchedule} activeId={effective.kind === 'activity' ? current?.id : undefined} now={now} resting={!workingToday}/></section>
          </>}
        </div>
      </main>
      {settingsOpen && <SettingsModal snapshot={snapshot} status={status} onClose={() => setSettingsOpen(false)} onSaved={() => setToast('Preferências atualizadas.')} />}
      {manualOpen && <FocusModal snapshot={snapshot} view={effective} onClose={() => setManualOpen(false)} />}
      {toast && <div className="toast" role="status"><Check size={16}/>{toast}</div>}
    </div>
  )
}

function Timeline({ schedule, activeId, now, resting }: { schedule: Activity[]; activeId?: string; now: number; resting: boolean }) {
  if (resting || schedule.length === 0) return <div className="timeline-card timeline-empty"><Moon size={18}/><span>{resting ? 'Hoje é dia de descanso. Ative este dia em Configurações para planejá-lo.' : 'Nenhuma atividade planejada.'}</span></div>
  const ordered = [...schedule].sort((a, b) => parseTime(a.start) - parseTime(b.start))
  return <div className="timeline-card">{ordered.map((item, index) => {
    const Icon = activityIcon(item)
    const end = new Date(now); end.setHours(Math.floor(parseTime(item.end) / 60), parseTime(item.end) % 60, 0, 0)
    const done = now >= end.getTime()
    const active = activeId === item.id
    const isBreak = isBreakActivity(item)
    return <div className={`timeline-row ${done ? 'is-done' : ''} ${active ? 'is-current' : ''} ${isBreak ? 'is-break' : ''}`} key={item.id}>
      <div className="timeline-time"><strong>{item.start}</strong><span>{item.end}</span></div>
      <div className="timeline-track"><span className="timeline-node" style={{ '--node-color': item.color } as React.CSSProperties}>{done ? <Check size={11}/> : <Icon size={12}/>}</span>{index < ordered.length - 1 && <span className="timeline-line"/>}</div>
      <div className="timeline-activity"><span className="activity-color" style={{ background: item.color }}/><span>{item.name}</span>{active && <span className="current-badge">AGORA</span>}{isBreak && <span className="break-label">PAUSA</span>}</div>
      <div className="timeline-duration">{parseTime(item.end) - parseTime(item.start)} min</div>
    </div>
  })}</div>
}

const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

function SettingsModal({ snapshot, status, onClose, onSaved }: { snapshot: Snapshot; status: AppStatus | null; onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<AppSettings>(snapshot.data.settings)
  const [saving, setSaving] = useState(false)
  const toggle = (key: keyof AppSettings, value: boolean) => setSettings(current => ({ ...current, [key]: value }))
  const save = async () => {
    if (!settings.workingDays.length) { setSettings({ ...settings, workingDays: DEFAULT_SETTINGS.workingDays }); return }
    setSaving(true)
    try { await window.focusFlow.saveSettings(settings); onSaved(); onClose() } catch { setSaving(false) }
  }
  const settingRow = (icon: LucideIcon, title: string, description: string, key: keyof AppSettings) => {
    const Icon = icon
    return <div className="setting-row" key={key}><span className="setting-icon"><Icon size={16}/></span><div className="setting-copy"><strong>{title}</strong><small>{description}</small></div><button role="switch" aria-label={title} aria-checked={Boolean(settings[key])} className={`toggle ${settings[key] ? 'on' : ''}`} onClick={() => toggle(key, !settings[key] as boolean)}><span/></button></div>
  }
  const startup = status?.startup
  const startupText = !startup ? 'Verificando…' : !startup.supported ? 'Disponível apenas no aplicativo instalado (não em desenvolvimento).' : !settings.launchAtStartup ? 'O FocusFlow não abre com o Windows.' : startup.enabled && !startup.willLaunch ? 'Ativado aqui, mas o Windows o desativou em Configurações › Aplicativos › Inicialização.' : startup.enabled ? 'Abre minimizado na bandeja ao entrar no Windows.' : 'Será registrado ao salvar.'
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal"><header className="modal-header"><div><span className="eyebrow">PREFERÊNCIAS</span><h2>Configurações</h2><p>Adapte o FocusFlow ao seu jeito de trabalhar.</p></div><button className="icon-button" aria-label="Fechar" onClick={onClose}><X size={18}/></button></header><div className="settings-content">
    <div className="settings-group"><div className="settings-group-title">APARÊNCIA</div><div className="theme-choice"><button className={settings.theme === 'dark' ? 'chosen' : ''} onClick={() => setSettings({ ...settings, theme: 'dark' })}><Moon size={16}/> Escuro</button><button className={settings.theme === 'light' ? 'chosen' : ''} onClick={() => setSettings({ ...settings, theme: 'light' })}><Sun size={16}/> Claro</button></div>{settingRow(PanelTop, 'Widget sempre visível', 'Mantenha o timer acima das outras janelas.', 'alwaysOnTop')}{settingRow(PanelTop, 'Widget translúcido', 'Deixe o widget menos presente na tela.', 'transparency')}</div>
    <div className="settings-group"><div className="settings-group-title">LEMBRETES</div>{settingRow(Bell, 'Notificações do Windows', 'Avisos nativos a cada transição.', 'notifications')}{settingRow(settings.sound ? Volume2 : VolumeX, 'Som suave', 'Um toque discreto ao iniciar a atividade.', 'sound')}{settingRow(Languages, 'Anúncio por voz', 'Fala em português brasileiro.', 'speech')}{settingRow(Clock3, 'Avisar com antecedência', 'Lembrete cinco minutos antes da troca.', 'warnings')}</div>
    <div className="settings-group"><div className="settings-group-title">DIAS DE TRABALHO</div><div className="weekday-picker">{['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((label, day) => <button key={day} aria-pressed={settings.workingDays.includes(day)} className={settings.workingDays.includes(day) ? 'selected' : ''} onClick={() => setSettings({ ...settings, workingDays: settings.workingDays.includes(day) ? settings.workingDays.filter(value => value !== day) : [...settings.workingDays, day].sort() })} title={WEEKDAY_NAMES[day]}>{label}</button>)}</div><small className="settings-hint">Deixe pelo menos um dia selecionado. O sábado usa a própria agenda (aba “Sábado”); o domingo, se ativado, usa a agenda de segunda a sexta. Dias sem expediente exibem descanso.</small></div>
    <div className="settings-group"><div className="settings-group-title">SISTEMA</div>{settingRow(Cpu, 'Monitor de hardware', 'CPU, RAM, GPU e disco ao vivo. Desativar interrompe as leituras.', 'hardwareMonitor')}{settingRow(Sparkles, 'Abrir junto com o Windows', startupText, 'launchAtStartup')}{settingRow(RotateCcw, 'Recuperação automática', 'Recarrega janelas travadas e reinicia uma vez após erro grave (com limite).', 'crashRecovery')}
      <div className="status-box"><div><strong>FocusFlow {status?.version ?? __APP_VERSION__}</strong><small>{status ? (status.recoveries ? `${status.recoveries} recuperação(ões) de janela nesta sessão.` : 'Nenhuma falha nesta sessão.') : '…'}</small></div><button className="button secondary" onClick={() => void window.focusFlow.openLogs()}><FolderOpen size={14}/> Abrir logs</button></div>
      {status && status.recentIssues.length > 0 && <ul className="issue-list" aria-label="Ocorrências recentes">{status.recentIssues.slice().reverse().map((issue, index) => <li key={`${issue.time}-${index}`} className={issue.level}><time>{new Date(issue.time).toLocaleTimeString('pt-BR')}</time><span>{issue.message}</span></li>)}</ul>}
    </div>
  </div><footer className="modal-footer"><button className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" disabled={saving} onClick={() => void save()}>Salvar preferências</button></footer></section></div>
}

function FocusModal({ snapshot, view, onClose }: { snapshot: Snapshot; view: ReturnType<typeof effectiveView>; onClose: () => void }) {
  const [name, setName] = useState('Sessão de foco')
  const [minutes, setMinutes] = useState(25)
  const fire = (command: RuntimeCommand) => { void window.focusFlow.command(command); onClose() }
  const current = view.activity
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="focus-modal"><header className="modal-header"><div><span className="eyebrow">MODO DE FOCO</span><h2>Como quer seguir?</h2><p>Sua agenda continua salva enquanto você ajusta a sessão.</p></div><button className="icon-button" aria-label="Fechar" onClick={onClose}><X size={18}/></button></header><div className="focus-options"><button className="focus-option" onClick={() => fire({ type: 'focus-mode', enabled: !snapshot.data.runtime.focusMode })}><span className="focus-option-icon"><Focus size={18}/></span><span><strong>{snapshot.data.runtime.focusMode ? 'Desativar modo sem distrações' : 'Modo sem distrações'}</strong><small>Oculta a linha do tempo durante o foco.</small></span><ChevronDown size={16}/></button><button className="focus-option" onClick={() => fire({ type: 'skip' })}><span className="focus-option-icon"><SkipForward size={18}/></span><span><strong>Pular esta atividade</strong><small>Avança para {view.next?.name ?? 'a próxima etapa'}.</small></span><ArrowRight size={16}/></button><button className="focus-option" onClick={() => fire({ type: 'automatic' })}><span className="focus-option-icon"><RotateCcw size={18}/></span><span><strong>Voltar à agenda automática</strong><small>Retoma o bloco previsto para este horário.</small></span><ArrowRight size={16}/></button></div><div className="manual-session"><div className="settings-group-title">CRIAR SESSÃO MANUAL</div><label className="field-label">Nome da sessão<input value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Ex.: concluir apresentação" /></label><label className="field-label">Duração<select value={minutes} onChange={event => setMinutes(Number(event.target.value))}>{[15, 25, 30, 45, 60, 90, 120].map(value => <option key={value} value={value}>{value} minutos</option>)}</select></label><button className="button primary full-button" disabled={!name.trim()} onClick={() => fire({ type: 'manual', name: name.trim(), minutes })}><Play size={15} fill="currentColor"/> Iniciar sessão manual</button>{current && <button className="extend-link" onClick={() => fire({ type: 'extend', minutes: 10 })}>Estender “{current.name}” em 10 minutos</button>}</div></section></div>
}

const TAB_INFO: Record<ScheduleKind, { label: string; title: string; description: string }> = {
  weekday: { label: 'Segunda a sexta', title: 'Rotina de segunda a sexta', description: 'Também vale para o domingo, caso você o ative em Configurações.' },
  saturday: { label: 'Sábado', title: 'Rotina de sábado', description: 'Por padrão, das 08:00 às 12:00, sem almoço nem tarde. O domingo é descanso.' },
}

function SchedulePage({ snapshot, onSaved, onError }: { snapshot: Snapshot; onSaved: (message: string) => void; onError: (message: string) => void }) {
  const [kind, setKind] = useState<ScheduleKind>(new Date().getDay() === 6 ? 'saturday' : 'weekday')
  const enabled = kind === 'saturday' ? snapshot.data.settings.workingDays.includes(6) : snapshot.data.settings.workingDays.some(day => day >= 1 && day <= 5)
  return <section className="editor-section">
    <div className="schedule-tabs" role="tablist" aria-label="Agenda por tipo de dia">
      {(Object.keys(TAB_INFO) as ScheduleKind[]).map(item => <button key={item} role="tab" aria-selected={kind === item} className={kind === item ? 'selected' : ''} onClick={() => setKind(item)}>{TAB_INFO[item].label}</button>)}
    </div>
    {!enabled && <div className="notice" role="status"><AlertTriangle size={16}/><span>{kind === 'saturday' ? 'O sábado está desativado em Configurações › Dias de trabalho' : 'Nenhum dia útil está ativo'}; esta agenda só será usada quando o dia estiver ativo.</span></div>}
    <ScheduleEditor key={kind} kind={kind} stored={snapshot.data.schedules[kind]} onSaved={onSaved} onError={onError} />
  </section>
}

const timeLabel = (value: number) => `${pad(Math.floor(value / 60))}:${pad(value % 60)}`
const sameItems = (a: Activity[], b: Activity[]) => JSON.stringify(a) === JSON.stringify(b)

function ScheduleEditor({ kind, stored, onSaved, onError }: { kind: ScheduleKind; stored: Activity[]; onSaved: (message: string) => void; onError: (message: string) => void }) {
  const [items, setItems] = useState<Activity[]>(() => stored.map(item => ({ ...item })))
  const [savedItems, setSavedItems] = useState<Activity[]>(stored)
  const [saving, setSaving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const latest = useRef({ items, savedItems })
  latest.current = { items, savedItems }
  const dirty = !sameItems(items, savedItems)
  const error = (() => { try { return validateSchedule(items) } catch { return 'Agenda inválida.' } })()
  const info = TAB_INFO[kind]

  // Follow external changes (for instance another window) while there are no local edits.
  useEffect(() => { if (!sameItems(latest.current.items, latest.current.savedItems)) return; if (!sameItems(stored, latest.current.savedItems)) { setItems(stored.map(item => ({ ...item }))); setSavedItems(stored) } }, [stored])

  const persist = useCallback(async (list: Activity[], announce: boolean) => {
    setSaving(true)
    try {
      const result = await window.focusFlow.saveSchedule(kind, list)
      if (result?.error) { if (announce) onError(result.error); return false }
      setSavedItems(list.map(item => ({ ...item })))
      if (announce) onSaved(`Agenda de ${kind === 'saturday' ? 'sábado' : 'segunda a sexta'} salva com sucesso.`)
      return true
    } catch { onError('Não foi possível salvar a agenda. Tente novamente.'); return false } finally { setSaving(false) }
  }, [kind, onError, onSaved])

  // Autosave valid edits after a short pause. Invalid in-progress edits are explained inline instead of raising error toasts.
  useEffect(() => {
    if (!dirty || error) return
    const timer = window.setTimeout(() => { void persist(items, false) }, 900)
    return () => window.clearTimeout(timer)
  }, [items, dirty, error, persist])
  // Leaving the tab (or page) with a valid pending edit must not drop it.
  useEffect(() => () => {
    const { items: pending, savedItems: base } = latest.current
    if (!sameItems(pending, base)) { try { if (!validateSchedule(pending)) void window.focusFlow.saveSchedule(kind, pending) } catch { /* ignore */ } }
  }, [kind])

  const update = (index: number, patch: Partial<Activity>) => setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  const sortItems = () => setItems(current => [...current].sort((a, b) => a.start.localeCompare(b.start)))
  const add = () => {
    const lastEnd = items.reduce((max, item) => Math.max(max, Number.isFinite(parseTime(item.end)) ? parseTime(item.end) : 0), 8 * 60)
    const startMinute = Math.min(lastEnd, 23 * 60 + 29)
    setItems([...items, { id: `atividade-${crypto.randomUUID()}`, name: 'Nova atividade', start: timeLabel(startMinute), end: timeLabel(Math.min(startMinute + 30, 23 * 60 + 59)), color: '#58d5bd', icon: 'sparkles' }])
  }
  const reset = async () => {
    if (!confirmReset) { setConfirmReset(true); window.setTimeout(() => setConfirmReset(false), 4000); return }
    setConfirmReset(false)
    try {
      const result = await window.focusFlow.resetSchedule(kind)
      if (result?.error || !result?.schedule) { onError(result?.error ?? 'Não foi possível restaurar a agenda.'); return }
      setItems(result.schedule.map(item => ({ ...item }))); setSavedItems(result.schedule)
      onSaved('Agenda padrão restaurada.')
    } catch { onError('Não foi possível restaurar a agenda.') }
  }
  const valid = !error && items.length > 0
  const times = items.map(item => parseTime(item.start)).filter(Number.isFinite), ends = items.map(item => parseTime(item.end)).filter(Number.isFinite)
  const summary = valid ? `${items.length} atividades · ${timeLabel(Math.min(...times))} → ${timeLabel(Math.max(...ends))} · ${formatHours(totalFocusMs(items))} de foco` : ''
  return <>
    <div className="editor-intro"><div className="editor-intro-icon"><Settings2 size={19}/></div><div><h3>{info.title}</h3><p>{info.description} As alterações são salvas automaticamente neste computador.</p>{summary && <p className="editor-summary">{summary}</p>}</div><button className={`button secondary reset-button ${confirmReset ? 'danger' : ''}`} onClick={() => void reset()}><RotateCcw size={14}/> {confirmReset ? 'Confirmar restauração' : 'Restaurar padrão'}</button></div>
    <div className="schedule-editor">{items.map((item, index) => <div className="editor-row" key={item.id}><span className="editor-index">{pad(index + 1)}</span><input className="editor-name" aria-label="Nome da atividade" maxLength={80} value={item.name} onChange={event => update(index, { name: event.target.value })}/><input type="time" aria-label="Início" value={item.start} onBlur={sortItems} onChange={event => update(index, { start: event.target.value })}/><span className="time-separator">até</span><input type="time" aria-label="Fim" value={item.end} onBlur={sortItems} onChange={event => update(index, { end: event.target.value })}/><select aria-label="Ícone" className="icon-select" value={item.icon} onChange={event => update(index, { icon: event.target.value })}>{Object.keys(iconMap).map(icon => <option key={icon} value={icon}>{({ calendar:'Agenda', layers:'Camadas', code:'Código', utensils:'Almoço', sparkles:'Projeto', languages:'Idiomas', coffee:'Café', keyboard:'Teclado', lightbulb:'Ideia', check:'Revisão', sunset:'Encerrar' } as Record<string,string>)[icon]}</option>)}</select><input className="color-input" type="color" aria-label="Cor" value={item.color} onChange={event => update(index, { color: event.target.value })}/><button className="icon-button delete-activity" aria-label="Remover atividade" title="Remover atividade" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))}><X size={15}/></button></div>)}<button className="add-activity" onClick={add}><Plus size={15}/> Adicionar atividade</button></div>
    <div className="editor-footer"><span className={error ? 'editor-error' : ''} role={error ? 'alert' : undefined}>{error ? <AlertTriangle size={14}/> : <CircleHelp size={14}/>} {error ?? 'Horários não podem se sobrepor. Intervalos são permitidos.'} {!error && <span className="save-state">{saving ? 'Salvando…' : dirty ? 'Alterações pendentes…' : 'Salvo automaticamente'}</span>}</span><button className="button primary" onClick={() => void persist(items, true)} disabled={saving || !valid}>{saving ? 'Salvando…' : 'Salvar agenda'}</button></div>
  </>
}

export default App
