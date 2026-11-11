# Changelog

## 1.1.1

Patch release after the first real-world use of 1.1.0.

### Fixed
- **High CPU while the dashboard was open.** Profiling the real app with Chrome DevTools metrics showed ~44 style recalculations and layouts per second on the dashboard (and ~35 on the widget), caused by 0.4-0.5 s `width` transitions on every progress bar. Disabling transitions at runtime dropped the total from 40.5 % to 7.4 % of one core, which proved the cause. Bars now use compositor-only `scaleX` transforms. Measured on the installed NSIS builds, same machine and procedure (25 s per phase, total CPU of all FocusFlow processes as % of one core): dashboard + widget visible **28.4 % -> 4.5 %**, widget only 9.4 % -> 2.2-2.8 %, both hidden 2.0 % -> 1.6 %; style/layout recalculations on the dashboard 25.5/s -> 0.08/s. The remaining ~1.5-2 % is the hardware sampler. Details and limitations in `docs/performance.md`.
- **Widget on startup.** An interactive launch now lifts the widget above a maximized window for a moment (your "always on top" preference is restored afterwards); the quiet start with Windows (`--hidden`) does not grab attention.
- **Dashboard position.** The display-change handler re-applied the saved rectangle unconditionally. It now leaves any reachable window exactly where it is and only moves one that is off every display, has an unreachable title bar or no longer fits after a DPI change (also checked when opening the dashboard). Every saved position is logged with its display.

### Added
- `scripts/bench.mjs` (CPU and renderer metrics per process type), `scripts/ui-test.ps1` (real mouse clicks on the real tray menu and on the dashboard button with a maximized window covering the widget) and `scripts/ui-startup-test.ps1` (interactive versus login start).

## 1.1.0

### Added
- **Saturday agenda.** A separate, editable agenda for Saturday, 08:00 to 12:00 by default (the weekday morning structure, no lunch and no afternoon). Saturday is enabled as a working day by default; Sunday stays a rest day. The Monday-Friday agenda is unchanged.
- **Agenda editor tabs** (Monday-Friday / Saturday) with live validation, autosave, explicit save and a confirmed "restore default" for each agenda.
- **Hardware monitor.** System-wide CPU, physical RAM (used/total), GPU, disk I/O activity and per-drive capacity on the dashboard, plus a compact summary on the widget. Values that the system cannot provide show `N/D`. It can be turned off in Settings and in the tray menu, and then runs no sampler at all.
- **System status** in Settings: version, start-with-Windows state (including "disabled by Windows"), recoveries, recent warnings/errors and a button that opens the local log folder.
- Tray menu: status line, show/hide widget, notifications, hardware monitor, reload windows, open logs. Single click, double click and right click are supported.
- Local rotating log (`logs/focusflow.log` in the data folder, 3 x 512 KB) and local crash dumps. Nothing is uploaded.
- Real-app smoke check: `node scripts/smoke.mjs [exe] [--hidden|--hidden-all|--startup|--startup-keep|--crash|--offscreen|--dpi=N|--stall=S|--soak=S|--double|--real-userdata]` and `node scripts/validate-hardware.mjs` (accuracy against Windows' own counters and sampler overhead).
- `docs/crash-recovery.md`: analysis and measurements for recovering from a hard main-process crash.

### Fixed
- **Data loss:** launching a second instance made the exiting process write default data over `focusflow.json`. Only the instance that loaded the configuration can write it now.
- **Tray icon:** replaced the SVG data URL with a multi-resolution icon (16/20/24/32/48 PNGs per Windows scale factor, ICO with 16 to 256 px) shipped outside `app.asar`, with an ICO fallback and a generated bitmap as last resort, so the image is never empty.
- Tray is created once and updated in place instead of being destroyed and rebuilt on every change.
- **Notification sound** only ever played once: the shared `AudioContext` was closed after the first chime. It now has a proper lifecycle.
- Day totals and progress dropped to 0 after the last activity ended; paused progress jumped to 100 %; manual sessions always showed 0 % progress.
- Autosave in the agenda editor fired on mount and raised error toasts while a time was still being typed.
- Notifications are no longer repeated or replayed after sleep/resume, restarts or timer stalls; "5 minutes left" warnings are skipped for 5-minute blocks and when the window was missed.
- The main process no longer broadcasts a snapshot every second; renderers stop their clock while hidden in the tray.
- Closing the window during Windows logoff/shutdown no longer blocks the session end.
- Corrupt `focusflow.json` is quarantined (`focusflow.corrupt.<time>.json`) instead of being silently replaced by defaults.
- Windows are shown even when Chromium's `ready-to-show` event is late or never fires (observed on a heavily loaded machine), instead of staying hidden forever. Page load time and renderer errors are written to the local log.
- The dashboard can shrink below its 880x650 minimum on small work areas, so it no longer overflows the screen at 200-300 % scaling.
- The hardware sampler exits by itself when its parent process is gone (it now checks the parent every 5 s), so a crash cannot leave an orphaned PowerShell process.
- Validated IPC: sender frame checks, strict agenda parsing (no exceptions on hostile input) and denied web permissions.

### Reliability
- Atomic saves (temp file, fsync, rename with retry), skipped when nothing changed, coalesced for window moves, last-known-good `.bak`.
- Versioned configuration (v2) with a one-time migration from 1.0.x that keeps customised agendas and all settings, enables Saturday once, keeps a permanent `focusflow.v1.<time>.bak.json` and never re-enables Saturday afterwards.
- Window positions are restored per monitor and re-fitted after DPI, resolution or monitor changes. The dashboard size/position/maximised state is now remembered.
- Renderer crash, hang and load-failure recovery with exponential backoff and a budget (3 per 5 minutes per window), then a notification and a manual "Reload windows" action. No recovery after an intentional quit.
- Crash sentinel: the next start knows whether the previous session ended unexpectedly. After repeated main-process errors the app relaunches itself once at a time, at most 3 times in 10 minutes, only when "Automatic recovery" is on and never after Quit.
- Start with Windows launches minimized to the tray (`--hidden`), works for the portable build, restores state after sleep/resume and is removed by the uninstaller. It reuses the registry value created by 1.0.x, so an existing registration is updated in place without duplicates.

### Notes
- No OS-level watchdog (scheduled task or service) is installed: it would need elevated rights, would have to be cleaned up on uninstall and cannot distinguish a crash from a quit reliably. In-app bounded recovery is used instead. A hard native crash of the main process is only recovered at the next login (if start with Windows is on) or the next manual launch.
- Hardware metrics come from Windows performance counters read by one hidden PowerShell process (about 30 ms of CPU per sample, every 3 s, only while a window is visible). Disk activity is the busiest physical disk; GPU is the busiest adapter, aggregated per engine as in Task Manager.

## 1.0.0
- First release: floating widget, dashboard, Monday-Friday agenda, tray, notifications and local storage.
