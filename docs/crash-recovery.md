# Hard main-process crash: options and trade-offs

What FocusFlow 1.1.0 already does:

- Renderer crashes, hangs and failed loads are recovered in-process with a restart budget (3 per 5 minutes per window).
- Repeated uncaught errors in the main process trigger one bounded self-relaunch (max 3 in 10 minutes, never after Quit).
- A crash sentinel (`session.json`) tells the next start that the previous session ended unexpectedly.
- "Start with Windows" brings the app back at the next login.
- The sampler (PowerShell) exits by itself when its parent disappears, so a crash leaves no orphan process.

What it cannot do: if the **main process dies abruptly** (native crash, `taskkill /F`, out of memory kill), nothing is alive to
restart it until the next login or manual launch.

## Experiment (user level, no administrator rights)

A throw-away supervisor was prototyped and measured on this machine (it is **not** part of the release):

```powershell
Wait-Process -Id <app pid>                      # zero polling
# then: read session.json -> if "clean": false -> Start-Process <FocusFlow.exe> --hidden --recovered
```

| Scenario | Result |
|---|---|
| `taskkill /F` on the main process | Relaunched in about 2.4 s |
| Normal quit (clean marker written) | Supervisor exits by itself, no relaunch |
| Cost | One extra `powershell.exe` of about 74 MB working set, ~0 % CPU |

## Options

| Option | Admin? | Survives logoff/reboot | Cost | Verdict |
|---|---|---|---|---|
| **A. In-app only (current)** | no | n/a | none | Safe default. Leaves the hard-crash gap until next login. |
| **B. Supervisor process started by the app** (prototype above) | no | no (dies with the session; the app restarts it) | +1 process (~70 MB as PowerShell; ~35-45 MB if Electron-as-node), must be killed on Quit, upgrade and uninstall | Feasible and reliable for crashes while logged in. Needs an opt-in switch and installer handling (the NSIS "app is running" check would see a second process). |
| C. Windows `RegisterApplicationRestart` (Restart Manager / WER) | no | n/a | needs a native call from inside the app | Not possible from plain Node/Electron without a native addon. |
| D. Scheduled task that relaunches on failure | no for per-user tasks | yes | persistent system change, cleanup on uninstall, cannot tell crash from Quit without the same marker | **Not implemented. Needs explicit approval.** |
| E. Windows service (e.g. via NSSM/WinSW) | yes | yes | elevation, GUI app cannot run in session 0 | Not appropriate for a tray/widget app. |

## Recommendation

Keep A for 1.1.0. If hard-crash recovery matters to you, add B as an **off-by-default** setting ("Restart FocusFlow if it
crashes"): the app spawns the supervisor only when the setting is on, the supervisor honours the same restart budget as
`session.json`, exits on a clean quit, and the uninstaller/upgrader terminates it. This creates a background process but no
scheduled task, service or registry change. D should only be added with your explicit approval.
