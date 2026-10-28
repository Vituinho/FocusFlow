import { useEffect, useMemo, useState } from 'react'
import {
  Activity as ActivityIcon, ArrowRight, Bell, Check, CheckCircle2, ChevronDown, CircleHelp,
  Clock3, Coffee, Code2, Command, Flame, Focus, Languages, Layers3, Keyboard, Lightbulb,
  ListChecks, Minus, Moon, MoreHorizontal, Pause, Play, Plus, RotateCcw, Settings2,
  SkipForward, Sparkles, Sun, Sunset, Timer, Utensils, X, Maximize2, Volume2, VolumeX,
  PanelTop, CalendarDays, type LucideIcon,
} from 'lucide-react'
import type { Activity, AppSettings, RuntimeCommand, Snapshot } from '../../electron/shared'
import { DEFAULT_SCHEDULE, DEFAULT_SETTINGS } from '../../electron/shared'
import { formatClock, getScheduleView, parseTime, progressPercent } from '../domain/schedule'

const iconMap: Record<string, LucideIcon> = {
  calendar: CalendarDays, layers: Layers3, code: Code2, utensils: Utensils,
  sparkles: Sparkles, languages: Languages, coffee: Coffee, keyboard: Keyboard,
  lightbulb: Lightbulb, check: CheckCircle2, sunset: Sunset,
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let alive = true
    void window.focusFlow.getSnapshot().then(value => { if (alive && value) setSnapshot(value) })
    const unsubscribe = window.focusFlow.onSnapshot(value => setSnapshot(value))
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; unsubscribe(); window.clearInterval(timer) }
  }, [])
  return { snapshot, setSnapshot, now }
}

function useAnnouncements(enabled: boolean) {
  useEffect(() => window.focusFlow.onTransition(payload => {
    if (!enabled || payload.warning) return
    window.focusFlow.getSnapshot().then(({ data }) => {
      if (data.settings.sound) {
        try {
          const context = sharedAudioContext ?? new AudioContext()
          sharedAudioContext = context
          if (context.state === 'suspended') void context.resume()
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          oscillator.type = 'sine'; oscillator.frequency.value = 660
          gain.gain.setValueAtTime(0.0001, context.currentTime)
          gain.gain.exponentialRampToValueAtTime(0.065, context.currentTime + 0.025)
          gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.38)
          oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.4)
          window.setTimeout(() => void context.close(), 500)
        } catch { /* Áudio opcional e condicionado pelo navegador. */ }
      }
      if (data.settings.speech && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(`Agora: ${payload.name}. Próxima atividade: ${payload.nextName || 'fim da rotina'}.`)
        utterance.lang = 'pt-BR'; utterance.rate = 0.96
        window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance)
      }
    }).catch(() => undefined)
  }), [enabled])
}

let sharedAudioContext: AudioContext | null = null

function App() {
  const { snapshot, now } = useSnapshot()
  const isWidget = new URLSearchParams(location.search).get('window') === 'widget'
  useAnnouncements(!isWidget)
  useEffect(() => { if (snapshot) document.documentElement.dataset.theme = snapshot.data.settings.theme }, [snapshot?.data.settings.theme])
  if (!snapshot) return <div className={`loading-screen ${isWidget ? 'widget-loading' : ''}`}><span className="brand-mark"><Clock3 size={18} /></span><span>FocusFlow</span></div>
  return isWidget ? <Widget snapshot={snapshot} now={now} /> : <Dashboard snapshot={snapshot} now={now} />
}

function TimerText({ endAt, now, paused, frozenRemainingMs = 0 }: { endAt: number | null; now: number; paused: boolean; frozenRemainingMs?: number }) {
  const remaining = paused ? frozenRemainingMs : Math.max(0, (endAt ?? now) - now)
  return <span>{formatCountdown(remaining)}</span>
}

function activityIcon(item?: Activity | null) {
  return item ? iconMap[item.icon] ?? ActivityIcon : Sun
}

function Widget({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { data, view } = snapshot
  const { runtime, settings } = data
  const [menu, setMenu] = useState(false)
  const [expanded, setExpanded] = useState(!settings.compactWidget)
  const active = view.activity
  const remaining = runtime.paused ? (runtime.frozenRemainingMs ?? 0) : Math.max(0, (view.endAt ?? (view.kind === 'before' ? view.nextAt : now) ?? now) - now)
  const progress = runtime.paused ? progressPercent(view.startAt, view.endAt, view.endAt ?? now) : progressPercent(view.startAt, view.endAt, now)
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
        : view.kind === 'finished' ? <div className="widget-rest"><Sunset size={18} /><div><strong>Dia concluído</strong><span>Você fez o seu trabalho. Até amanhã.</span></div></div>
          : <>
            <div className="widget-main">
              <span className="widget-icon" style={{ color: active?.color ?? 'var(--accent)', background: `${active?.color ?? 'var(--accent)'}1c` }}><Icon size={17} /></span>
              <div className="widget-activity"><span className="eyebrow">{runtime.paused ? 'PAUSADO' : view.kind === 'before' ? 'PRÓXIMO BLOCO' : 'EM ANDAMENTO'}</span><strong>{active?.name ?? (view.kind === 'before' && view.dayStart !== null && now >= view.dayStart ? 'Intervalo livre' : view.kind === 'before' ? 'Sua rotina começa em breve' : 'Foco do dia')}</strong><span>{view.startAt ? `${formatClock(view.startAt)} — ${formatClock(view.endAt ?? now)}` : `Começa às ${view.nextAt ? formatClock(view.nextAt) : '08:00'}`}</span></div>
            </div>
            <div className="widget-clock-row"><strong className="widget-countdown">{formatCountdown(remaining)}</strong><span className={`widget-status ${remaining <= 5 * 60_000 && remaining > 0 ? 'status-warning' : ''}`}>{runtime.paused ? 'Sessão pausada' : remaining <= 5 * 60_000 && remaining > 0 ? 'Quase lá' : 'Tempo restante'}</span></div>
            <div className="progress-track widget-progress"><span style={{ width: `${progress}%`, background: active?.color ?? 'var(--accent)' }} /></div>
            {expanded && <div className="widget-foot"><div className="next-copy"><span>PRÓXIMA</span><strong>{view.next?.name ?? 'Fim da rotina'}</strong></div><div className="widget-control no-drag">
              {runtime.paused ? <button className="round-control" onClick={() => fire({ type: 'resume' })} title="Retomar foco"><Play size={13} fill="currentColor" /></button> : <button className="round-control" disabled={!active} onClick={() => fire({ type: 'pause' })} title="Pausar foco"><Pause size={13} fill="currentColor" /></button>}
              <button className="round-control subtle" onClick={() => setMenu(!menu)} title="Mais opções"><MoreHorizontal size={15} /></button>
              {menu && <div className="widget-menu"><button onClick={() => { fire({ type: 'skip' }); setMenu(false) }}><SkipForward size={14} /> Pular atividade</button><button onClick={() => { fire({ type: 'automatic' }); setMenu(false) }}><RotateCcw size={14} /> Voltar à agenda</button><button onClick={() => { fire({ type: 'focus-mode', enabled: !runtime.focusMode }); setMenu(false) }}><Focus size={14} /> {runtime.focusMode ? 'Sair do modo foco' : 'Modo sem distrações'}</button></div>}
            </div></div>}
          </>}
    </main>
  )
}

function Dashboard({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { data, view } = snapshot
  const { settings, schedule, runtime } = data
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [tab, setTab] = useState<'hoje' | 'agenda'>('hoje')
  const [toast, setToast] = useState('')
  const dayView = getScheduleView(now, schedule, settings.workingDays)
  const effective = runtime.manual ? view : dayView
  const current = effective.activity
  const remaining = runtime.paused ? (runtime.frozenRemainingMs ?? 0) : Math.max(0, (effective.endAt ?? now) - now)
  const focusSchedule = schedule.filter(item => !['almoco', 'cafe'].includes(item.id))
  const elapsed = focusSchedule.reduce((sum, item) => {
    if (now <= (effective.startAt ?? 0) || !effective.startAt) return sum
    const start = new Date(now); const [sh, sm] = item.start.split(':').map(Number); start.setHours(sh, sm, 0, 0)
    const end = new Date(now); const [eh, em] = item.end.split(':').map(Number); end.setHours(eh, em, 0, 0)
    return sum + Math.max(0, Math.min(now, end.getTime()) - start.getTime())
  }, 0)
  const total = focusSchedule.reduce((sum, item) => sum + (parseTime(item.end) - parseTime(item.start)) * 60_000, 0)
  const dayProgress = total ? Math.min(100, elapsed / total * 100) : 0
  const Icon = activityIcon(current)
  const fire = (command: RuntimeCommand) => void window.focusFlow.command(command)
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])
  useEffect(() => window.focusFlow.onTransition(payload => {
    if (!payload.warning) setToast(`Agora em foco: ${payload.name}`)
  }), [])
  const todayLabel = new Date(now).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
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
          <div className="version-note">FOCUSFLOW 1.0 <span>·</span> SEM CONTA</div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar drag-region">
          <div className="breadcrumbs"><span>Meu espaço</span><span className="crumb-sep">/</span><strong>{tab === 'hoje' ? 'Meu dia' : 'Agenda'}</strong></div>
          <div className="topbar-right no-drag"><div className="current-clock"><span className="clock-pip" />{formatClock(now)}</div><button className="icon-button" title="Configurações" onClick={() => setSettingsOpen(true)}><Settings2 size={18}/></button><button className="window-control" title="Minimizar" onClick={() => void window.focusFlow.minimize()}><Minus size={15}/></button><button className="window-control close-window" title="Fechar para a bandeja" onClick={() => void window.focusFlow.close()}><X size={15}/></button></div>
        </header>
        <div className="page-content">
          <div className="page-heading"><div><div className="date-line"><CalendarDays size={14}/>{todayLabel}</div><h1>{tab === 'hoje' ? 'No seu ritmo.' : 'Sua agenda.'}</h1><p>{tab === 'hoje' ? 'Um bloco de cada vez. Seu dia, com mais intenção.' : 'Uma rotina consistente abre espaço para um trabalho melhor.'}</p></div><button className="button secondary open-widget" onClick={() => void window.focusFlow.showWidget()}><PanelTop size={16}/> Mostrar widget</button></div>
          {tab === 'agenda' ? <SchedulePage snapshot={snapshot} onSaved={() => setToast('Agenda salva com sucesso.')} onError={setToast} /> : <>
            <section className={`hero-card ${runtime.focusMode ? 'hero-focus' : ''}`} style={{ '--activity-color': current?.color ?? '#58d5bd' } as React.CSSProperties}>
              <div className="hero-glow" />
              <div className="hero-content">
                <div className="hero-topline"><div className="hero-state"><span className={`state-dot ${runtime.paused ? 'is-paused' : ''}`} />{runtime.paused ? 'PAUSADO' : effective.kind === 'rest' ? 'DIA DE DESCANSO' : effective.kind === 'finished' ? 'ROTINA CONCLUÍDA' : runtime.manual ? 'SESSÃO MANUAL' : effective.kind === 'before' && effective.dayStart !== null && now >= effective.dayStart ? 'INTERVALO LIVRE' : effective.kind === 'before' ? 'ANTES DO INÍCIO' : 'AGORA EM FOCO'}</div><button className="hero-more icon-button" title="Mais opções" onClick={() => setManualOpen(true)}><MoreHorizontal size={20}/></button></div>
                <div className="hero-middle">
                  <div className="hero-activity"><span className="hero-icon"><Icon size={23}/></span><div><span className="eyebrow">{runtime.manual ? 'MODO DE FOCO' : effective.kind === 'rest' ? 'RECARREGUE AS ENERGIAS' : effective.kind === 'finished' ? 'VOCÊ CHEGOU AO FIM' : 'BLOCO ATUAL'}</span><h2>{current?.name ?? (effective.kind === 'rest' ? 'Hoje é dia de descanso' : effective.kind === 'before' && effective.dayStart !== null && now >= effective.dayStart ? 'Intervalo livre' : effective.kind === 'before' ? 'O dia começa às 08:00' : 'Um ótimo trabalho por hoje')}</h2><div className="hero-time"><Clock3 size={14}/>{effective.startAt ? `${formatClock(effective.startAt)} — ${formatClock(effective.endAt ?? now)}` : effective.kind === 'before' ? `Próximo: ${effective.next ? `${effective.next.name} · ${formatClock(effective.nextAt ?? now)}` : '08:00'}` : 'Sua rotina está completa'}</div></div></div>
                  <div className="timer-block"><div className="timer-label">{runtime.paused ? 'TEMPO PAUSADO' : effective.kind === 'before' ? 'ATÉ O PRÓXIMO BLOCO' : effective.kind === 'finished' || effective.kind === 'rest' ? 'ATÉ AMANHÃ' : 'TEMPO RESTANTE'}</div><div className={`big-timer ${remaining <= 5 * 60_000 && remaining > 0 ? 'timer-warning' : ''}`}><TimerText endAt={effective.endAt ?? (effective.kind === 'before' ? effective.nextAt : null)} now={now} paused={runtime.paused} frozenRemainingMs={runtime.frozenRemainingMs}/></div><div className="timer-subtitle">{runtime.paused ? 'retome quando estiver pronto' : effective.kind === 'before' ? 'até a próxima atividade' : remaining <= 5 * 60_000 && remaining > 0 ? 'reta final deste bloco' : 'na atividade atual'}</div></div>
                </div>
                <div className="hero-progress-wrap"><div className="hero-progress-label"><span>PROGRESSO DO BLOCO</span><strong>{Math.round(runtime.paused ? progressPercent(effective.startAt, effective.endAt, effective.endAt ?? now) : progressPercent(effective.startAt, effective.endAt, now))}%</strong></div><div className="progress-track hero-progress"><span style={{ width: `${runtime.paused ? progressPercent(effective.startAt, effective.endAt, effective.endAt ?? now) : progressPercent(effective.startAt, effective.endAt, now)}%` }}/></div></div>
                <div className="hero-bottom"><div className="next-activity"><span className="next-icon"><ArrowRight size={15}/></span><div><span>EM SEGUIDA</span><strong>{effective.next?.name ?? (effective.kind === 'before' ? effective.next?.name : 'Fim da rotina')}</strong>{effective.nextAt && effective.kind !== 'before' && <small>às {formatClock(effective.nextAt)}</small>}</div></div><div className="focus-actions">{runtime.paused ? <button className="button primary" onClick={() => fire({ type: 'resume' })}><Play size={16} fill="currentColor"/> Retomar foco</button> : <button className="button primary" disabled={!current} onClick={() => fire({ type: 'pause' })}><Pause size={16} fill="currentColor"/> Pausar foco</button>}<button className="icon-button hero-action" title="Opções de foco" onClick={() => setManualOpen(true)}><MoreHorizontal size={18}/></button></div></div>
              </div>
            </section>
            <div className="stats-row">
              <div className="stat-card"><div className="stat-icon mint"><Flame size={17}/></div><div><span>FOCO NO DIA</span><strong>{formatDuration(elapsed)}</strong></div><small>de {formatDuration(total)}</small></div>
              <div className="stat-card"><div className="stat-icon violet"><CheckCircle2 size={17}/></div><div><span>PROGRESSO</span><strong>{Math.round(dayProgress)}%</strong></div><div className="mini-progress"><span style={{ width: `${dayProgress}%` }}/></div></div>
              <div className="stat-card"><div className="stat-icon amber"><Clock3 size={17}/></div><div><span>ATIVIDADES</span><strong>{schedule.length}</strong></div><small>na agenda de hoje</small></div>
            </div>
            <section className="timeline-section"><div className="section-heading"><div><h3>Plano de hoje</h3><p>A estrutura do seu dia, no seu tempo.</p></div><button className="text-button" onClick={() => setTab('agenda')}>Editar agenda <ArrowRight size={14}/></button></div><Timeline snapshot={snapshot} now={now}/></section>
          </>}
        </div>
      </main>
      {settingsOpen && <SettingsModal snapshot={snapshot} onClose={() => setSettingsOpen(false)} onSaved={() => setToast('Preferências atualizadas.')} />}
      {manualOpen && <FocusModal snapshot={snapshot} onClose={() => setManualOpen(false)} />}
      {toast && <div className="toast"><Check size={16}/>{toast}</div>}
    </div>
  )
}

function Timeline({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { data, view } = snapshot
  const activeId = view.activity?.id
  return <div className="timeline-card">{data.schedule.map((item, index) => {
    const Icon = activityIcon(item)
    const start = new Date(now); const [sh, sm] = item.start.split(':').map(Number); start.setHours(sh, sm, 0, 0)
    const end = new Date(now); const [eh, em] = item.end.split(':').map(Number); end.setHours(eh, em, 0, 0)
    const done = now >= end.getTime()
    const active = activeId === item.id && view.kind === 'activity'
    const isLunch = item.id === 'almoco' || item.id === 'cafe'
    return <div className={`timeline-row ${done ? 'is-done' : ''} ${active ? 'is-current' : ''} ${isLunch ? 'is-break' : ''}`} key={item.id}>
      <div className="timeline-time"><strong>{item.start}</strong><span>{item.end}</span></div>
      <div className="timeline-track"><span className="timeline-node" style={{ '--node-color': item.color } as React.CSSProperties}>{done ? <Check size={11}/> : <Icon size={12}/>}</span>{index < data.schedule.length - 1 && <span className="timeline-line"/>}</div>
      <div className="timeline-activity"><span className="activity-color" style={{ background: item.color }}/><span>{item.name}</span>{active && <span className="current-badge">AGORA</span>}{isLunch && <span className="break-label">PAUSA</span>}</div>
      <div className="timeline-duration">{parseTime(item.end) - parseTime(item.start)} min</div>
    </div>
  })}</div>
}

function SettingsModal({ snapshot, onClose, onSaved }: { snapshot: Snapshot; onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<AppSettings>(snapshot.data.settings)
  const toggle = (key: keyof AppSettings, value: boolean) => setSettings(current => ({ ...current, [key]: value }))
  const save = async () => { await window.focusFlow.saveSettings(settings); onSaved(); onClose() }
  const settingRow = (icon: LucideIcon, title: string, description: string, key: keyof AppSettings) => {
    const Icon = icon
    return <div className="setting-row" key={key}><span className="setting-icon"><Icon size={16}/></span><div className="setting-copy"><strong>{title}</strong><small>{description}</small></div><button role="switch" aria-checked={Boolean(settings[key])} className={`toggle ${settings[key] ? 'on' : ''}`} onClick={() => toggle(key, !settings[key] as boolean)}><span/></button></div>
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal"><header className="modal-header"><div><span className="eyebrow">PREFERÊNCIAS</span><h2>Configurações</h2><p>Adapte o FocusFlow ao seu jeito de trabalhar.</p></div><button className="icon-button" onClick={onClose}><X size={18}/></button></header><div className="settings-content">
    <div className="settings-group"><div className="settings-group-title">APARÊNCIA</div><div className="theme-choice"><button className={settings.theme === 'dark' ? 'chosen' : ''} onClick={() => setSettings({ ...settings, theme: 'dark' })}><Moon size={16}/> Escuro</button><button className={settings.theme === 'light' ? 'chosen' : ''} onClick={() => setSettings({ ...settings, theme: 'light' })}><Sun size={16}/> Claro</button></div>{settingRow(PanelTop, 'Widget sempre visível', 'Mantenha o timer acima das outras janelas.', 'alwaysOnTop')}{settingRow(PanelTop, 'Widget translúcido', 'Deixe o widget menos presente na tela.', 'transparency')}</div>
    <div className="settings-group"><div className="settings-group-title">LEMBRETES</div>{settingRow(Bell, 'Notificações do Windows', 'Avisos nativos a cada transição.', 'notifications')}{settingRow(settings.sound ? Volume2 : VolumeX, 'Som suave', 'Um toque discreto ao iniciar a atividade.', 'sound')}{settingRow(Languages, 'Anúncio por voz', 'Fala em português brasileiro.', 'speech')}{settingRow(Clock3, 'Avisar com antecedência', 'Lembrete cinco minutos antes da troca.', 'warnings')}</div>
    <div className="settings-group"><div className="settings-group-title">DIAS DE TRABALHO</div><div className="weekday-picker">{['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((label, day) => <button key={day} className={settings.workingDays.includes(day) ? 'selected' : ''} onClick={() => setSettings({ ...settings, workingDays: settings.workingDays.includes(day) ? settings.workingDays.filter(value => value !== day) : [...settings.workingDays, day].sort() })} title={['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'][day]}>{label}</button>)}</div><small className="settings-hint">Deixe pelo menos um dia selecionado. Fins de semana sem expediente exibem descanso.</small></div>
    <div className="settings-group">{settingRow(Sparkles, 'Abrir junto com o Windows', 'Inicie o FocusFlow ao entrar no computador.', 'launchAtStartup')}</div>
  </div><footer className="modal-footer"><button className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary" onClick={() => { if (!settings.workingDays.length) { setSettings({ ...settings, workingDays: DEFAULT_SETTINGS.workingDays }); return } void save() }}>Salvar preferências</button></footer></section></div>
}

function FocusModal({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [name, setName] = useState('Sessão de foco')
  const [minutes, setMinutes] = useState(25)
  const fire = (command: RuntimeCommand) => { void window.focusFlow.command(command); onClose() }
  const current = snapshot.view.activity
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="focus-modal"><header className="modal-header"><div><span className="eyebrow">MODO DE FOCO</span><h2>Como quer seguir?</h2><p>Sua agenda continua salva enquanto você ajusta a sessão.</p></div><button className="icon-button" onClick={onClose}><X size={18}/></button></header><div className="focus-options"><button className="focus-option" onClick={() => fire({ type: 'focus-mode', enabled: !snapshot.data.runtime.focusMode })}><span className="focus-option-icon"><Focus size={18}/></span><span><strong>{snapshot.data.runtime.focusMode ? 'Desativar modo sem distrações' : 'Modo sem distrações'}</strong><small>Oculta a linha do tempo durante o foco.</small></span><ChevronDown size={16}/></button><button className="focus-option" onClick={() => fire({ type: 'skip' })}><span className="focus-option-icon"><SkipForward size={18}/></span><span><strong>Pular esta atividade</strong><small>Avança para {snapshot.view.next?.name ?? 'a próxima etapa'}.</small></span><ArrowRight size={16}/></button><button className="focus-option" onClick={() => fire({ type: 'automatic' })}><span className="focus-option-icon"><RotateCcw size={18}/></span><span><strong>Voltar à agenda automática</strong><small>Retoma o bloco previsto para este horário.</small></span><ArrowRight size={16}/></button></div><div className="manual-session"><div className="settings-group-title">CRIAR SESSÃO MANUAL</div><label className="field-label">Nome da sessão<input value={name} maxLength={80} onChange={event => setName(event.target.value)} placeholder="Ex.: concluir apresentação" /></label><label className="field-label">Duração<select value={minutes} onChange={event => setMinutes(Number(event.target.value))}>{[15, 25, 30, 45, 60, 90, 120].map(value => <option key={value} value={value}>{value} minutos</option>)}</select></label><button className="button primary full-button" disabled={!name.trim()} onClick={() => fire({ type: 'manual', name: name.trim(), minutes })}><Play size={15} fill="currentColor"/> Iniciar sessão manual</button>{current && <button className="extend-link" onClick={() => fire({ type: 'extend', minutes: 10 })}>Estender “{current.name}” em 10 minutos</button>}</div></section></div>
}

function SchedulePage({ snapshot, onSaved, onError }: { snapshot: Snapshot; onSaved: () => void; onError: (message: string) => void }) {
  const [items, setItems] = useState<Activity[]>(snapshot.data.schedule.map(item => ({ ...item })))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
  const update = (index: number, patch: Partial<Activity>) => setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item).sort((a, b) => a.start.localeCompare(b.start)))
  useEffect(() => {
    setSaved(false)
    const timer = window.setTimeout(async () => {
      setSaving(true)
      const result = await window.focusFlow.saveSchedule(items)
      setSaving(false)
      if (result.error) onError(result.error)
      else setSaved(true)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [items])
  const save = async () => {
    setSaving(true)
    const result = await window.focusFlow.saveSchedule(items)
    setSaving(false)
    if (result.error) onError(result.error); else { setSaved(true); onSaved() }
  }
  const add = () => {
    const lastEnd = items.length ? items[items.length - 1].end : '08:00'
    const [hour, minute] = lastEnd.split(':').map(Number)
    const startMinute = hour * 60 + minute
    const endMinute = Math.min(startMinute + 30, 23 * 60 + 59)
    const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    setItems([...items, { id: `atividade-${crypto.randomUUID()}`, name: 'Nova atividade', start: time(startMinute), end: time(endMinute), color: '#58d5bd', icon: 'sparkles' }])
  }
  return <section className="editor-section"><div className="editor-intro"><div className="editor-intro-icon"><Settings2 size={19}/></div><div><h3>Rotina de segunda a sexta</h3><p>Edite os blocos. As alterações são salvas automaticamente neste computador.</p></div><button className="button secondary reset-button" onClick={() => setItems(DEFAULT_SCHEDULE.map(item => ({ ...item })))}><RotateCcw size={14}/> Restaurar padrão</button></div><div className="schedule-editor">{items.map((item, index) => <div className="editor-row" key={item.id}><span className="editor-index">{String(index + 1).padStart(2, '0')}</span><input className="editor-name" aria-label="Nome da atividade" value={item.name} onChange={event => update(index, { name: event.target.value })}/><input type="time" aria-label="Início" value={item.start} onChange={event => update(index, { start: event.target.value })}/><span className="time-separator">até</span><input type="time" aria-label="Fim" value={item.end} onChange={event => update(index, { end: event.target.value })}/><select aria-label="Ícone" className="icon-select" value={item.icon} onChange={event => update(index, { icon: event.target.value })}>{Object.keys(iconMap).map(icon => <option key={icon} value={icon}>{({ calendar:'Agenda', layers:'Camadas', code:'Código', utensils:'Almoço', sparkles:'Projeto', languages:'Idiomas', coffee:'Café', keyboard:'Teclado', lightbulb:'Ideia', check:'Revisão', sunset:'Encerrar' } as Record<string,string>)[icon]}</option>)}</select><input className="color-input" type="color" aria-label="Cor" value={item.color} onChange={event => update(index, { color: event.target.value })}/><button className="icon-button delete-activity" title="Remover atividade" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))}><X size={15}/></button></div>)}<button className="add-activity" onClick={add}><Plus size={15}/> Adicionar atividade</button></div><div className="editor-footer"><span><CircleHelp size={14}/> Horários não podem se sobrepor. Intervalos são permitidos. <span className="save-state">{saving ? 'Salvando…' : saved ? 'Salvo automaticamente' : ''}</span></span><button className="button primary" onClick={() => void save()} disabled={saving || !items.length}>{saving ? 'Salvando…' : 'Salvar agenda'}</button></div></section>
}

export default App
