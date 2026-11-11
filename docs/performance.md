# Performance notes (1.1.1)

All numbers below were measured on one development PC (Windows 11, 16 logical cores, 16 GB RAM) that was **under constant memory and disk
pressure** (free RAM typically 0.4-3 GB, the D: drive at ~100 % activity, other applications running). Absolute values will differ on
other machines; the before/after comparison uses the same machine, the same build pipeline and the same procedure, one after the other.

## How it was measured

`node scripts/bench.mjs <exe> --seconds=25` starts an isolated copy of the app (own data folder), keeps its windows above other windows so
occlusion throttling does not hide the cost, and measures three conditions for 25 s each after a 4 s settle time:

- CPU per process type from OS process times (kernel + user), as % of one core, summed over the whole FocusFlow process tree;
- per page, Chrome DevTools `Performance.getMetrics` deltas: style recalculations, layouts, task/script time, JS heap.

Nothing is estimated: every value is read from Windows or from Chromium.

## The problem (found by profiling, not assumed)

In the real installed 1.1.0 the dashboard cost ~25 % of one core. DevTools metrics showed **~44 style recalculations and 44 layouts per
second** on the dashboard (35/s on the widget) although the page changes once per second. Every progress bar had a 0.4-0.5 s `width`
transition, so a bar was animating (and forcing layout) for roughly 40 % of each second, on top of the GPU process repainting.
A runtime experiment confirmed the cause: injecting `transition: none` into the pages dropped the total from 40.5 % to 7.4 % of one core
(renderers 20.9 % -> 3.0 %, GPU process 12.3 % -> 1.1 %) with no other change.

## The fix

Bars are drawn with a compositor-only `transform: scaleX()` (`src/ui/bar.ts`) instead of animating `width`. A unit test fails if any
stylesheet rule transitions `width` again.

## Results on the packaged (installed, isolated-identity) builds

| Condition | 1.1.0 | 1.1.1 run 1 | 1.1.1 run 2 |
|---|---|---|---|
| Dashboard + widget visible, total CPU | 28.4 % | 4.6 % | 4.5 % |
| - renderers / GPU process / main / sampler | 14.8 / 10.2 / 1.1 / 2.2 % | 0.7 / 2.2 / 0.2 / 1.5 % | 0.5 / 1.4 / 0.5 / 2.1 % |
| - dashboard style / layout per second | 25.6 / 25.5 | 0.04 / 0.08 | 0.08 / 0.12 |
| - widget style / layout per second | 21.4 / 21.3 | 0.08 / 0.08 | 0.08 / 0.08 |
| Widget only, total CPU | 9.4 % | 2.2 % | 2.8 % |
| Both hidden, total CPU | 2.0 % | 1.7 % | 1.6 % |

What remains is dominated by the hardware sampler (one hidden PowerShell process, about 1.2-2.3 % of one core, ~120 MB working set) and
the GPU process while windows are visible.

## Limitations

- One machine, one session per condition, two runs after the fix; no confidence intervals. Differences of a few tenths of a percent are noise.
- The machine's memory pressure inflates working-set and start-up numbers; CPU percentages are less affected but not immune.
- The benchmark forces windows to stay on top and uses a remote-debugging port, which no normal run does.
- "Both hidden" is simulated with `ShowWindow` from outside, so Electron still believes the windows are visible and keeps the hardware sampler
  running (it is therefore included in that row). With windows hidden through the app itself the sampler is stopped.
