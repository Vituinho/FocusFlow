export type Activity = {
  id: string
  name: string
  start: string
  end: string
  color: string
  icon: string
}

export type AppSettings = {
  theme: 'dark' | 'light'
  notifications: boolean
  sound: boolean
  speech: boolean
  warnings: boolean
  alwaysOnTop: boolean
  transparency: boolean
  launchAtStartup: boolean
  workingDays: number[]
  compactWidget: boolean
}

export type RuntimeState = {
  paused: boolean
  pausedAt?: number
  frozenRemainingMs?: number
  pausedActivityName?: string
  focusMode: boolean
  manual?: { name: string; endAt: number }
  extendedUntil?: number
  skippedKeys: string[]
}

export type AppData = { schedule: Activity[]; settings: AppSettings; runtime: RuntimeState; widgetBounds?: { x: number; y: number; width: number; height: number } }

export type ScheduleView = {
  kind: 'activity' | 'before' | 'finished' | 'rest'
  activity: Activity | null
  next: Activity | null
  startAt: number | null
  endAt: number | null
  nextAt: number | null
  totalFocusMs: number
  dayStart: number | null
  dayEnd: number | null
}

export type Snapshot = { data: AppData; view: ScheduleView; now: number }

export type RuntimeCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'manual'; name: string; minutes: number }
  | { type: 'extend'; minutes: number }
  | { type: 'skip' }
  | { type: 'automatic' }
  | { type: 'focus-mode'; enabled: boolean }

export const DEFAULT_SCHEDULE: Activity[] = [
  { id: 'planejamento', name: 'Planejamento diário', start: '08:00', end: '08:15', color: '#a78bfa', icon: 'calendar' },
  { id: 'projetos-manha-1', name: 'Projetos em andamento', start: '08:15', end: '09:45', color: '#58d5bd', icon: 'layers' },
  { id: 'dsa', name: 'LeetCode / DSA', start: '09:45', end: '10:25', color: '#7da8ff', icon: 'code' },
  { id: 'projetos-manha-2', name: 'Projetos em andamento', start: '10:25', end: '12:00', color: '#58d5bd', icon: 'layers' },
  { id: 'almoco', name: 'Pausa para almoço', start: '12:00', end: '13:45', color: '#f6ad70', icon: 'utensils' },
  { id: 'novo-projeto', name: 'Novo projeto', start: '13:45', end: '14:45', color: '#a78bfa', icon: 'sparkles' },
  { id: 'ingles', name: 'Estudo de inglês', start: '14:45', end: '15:15', color: '#7da8ff', icon: 'languages' },
  { id: 'cafe', name: 'Pausa para café', start: '15:15', end: '15:30', color: '#f6ad70', icon: 'coffee' },
  { id: 'projetos-tarde', name: 'Projetos em andamento', start: '15:30', end: '16:20', color: '#58d5bd', icon: 'layers' },
  { id: 'digitacao', name: 'Prática de digitação', start: '16:20', end: '16:40', color: '#7da8ff', icon: 'keyboard' },
  { id: 'projetos-pessoais', name: 'Projetos pessoais', start: '16:40', end: '17:10', color: '#a78bfa', icon: 'lightbulb' },
  { id: 'frances', name: 'Estudo de francês', start: '17:10', end: '17:40', color: '#7da8ff', icon: 'languages' },
  { id: 'revisao', name: 'Revisão de código e testes', start: '17:40', end: '17:55', color: '#58d5bd', icon: 'check' },
  { id: 'encerramento', name: 'Encerramento do dia', start: '17:55', end: '18:00', color: '#f6ad70', icon: 'sunset' },
]

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark', notifications: true, sound: true, speech: false, warnings: false,
  alwaysOnTop: true, transparency: false, launchAtStartup: false,
  workingDays: [1, 2, 3, 4, 5], compactWidget: false,
}

export const DEFAULT_RUNTIME: RuntimeState = { paused: false, focusMode: false, skippedKeys: [] }
