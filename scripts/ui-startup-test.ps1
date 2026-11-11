# Startup behaviour on a real desktop with a maximized window already covering the screen:
#   * interactive launch  -> the widget must come to the front (temporary top-most pulse)
#   * launch with --hidden (the Windows-login start) -> the widget appears quietly: no top-most pulse and no foreground steal
#     (a brand-new window is placed on top of the z-order by Windows, so 'quiet' is judged by the pulse flag and the foreground owner)
# The always-on-top preference stays off in both cases and must still be off after the pulse.
#   powershell -File scripts/ui-startup-test.ps1 [-Exe path\to\FocusFlow.exe]
param([string]$Exe = '')
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Idle { [StructLayout(LayoutKind.Sequential)] public struct LI { public uint cb; public uint t; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LI p); public static uint Ms() { var i = new LI(); i.cb = 8; GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.t; } }'
# These tests move the mouse and cover the screen: wait (up to 10 minutes) until the user has left the machine alone for 20 s.
function Wait-UserIdle { $end = (Get-Date).AddMinutes(10); while ([Idle]::Ms() -lt 20000) { if ((Get-Date) -gt $end) { Write-Host 'ABORT: the user is active at the machine; try again later'; exit 3 }; Start-Sleep 2 } }
Wait-UserIdle
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Us {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static uint ForegroundPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static uint PidAt(int x, int y) { var h = WindowFromPoint(new POINT { X = x, Y = y }); if (h == IntPtr.Zero) return 0; uint p; GetWindowThreadProcessId(GetAncestor(h, 2), out p); return p; }
  public static List<string> Windows(uint pid) { var l = new List<string>(); EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) { var t = new StringBuilder(100); GetWindowText(h, t, 100); if (t.Length > 0 && !t.ToString().Contains("IME")) { RECT r; GetWindowRect(h, out r); l.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}", r.R - r.L, r.B - r.T, r.L, r.T, IsWindowVisible(h), (GetWindowLong(h, -20) & 8) != 0)); } } return true; }, IntPtr.Zero); return l; }
}
'@
[void][Us]::SetProcessDPIAware()
$results = New-Object System.Collections.Generic.List[object]
function Check($name, $ok, $detail = '') { $script:results.Add([pscustomobject]@{ Result = $(if ($ok) { 'PASS' } else { 'FAIL' }) }); Write-Host ("{0}  {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail) }
function Get-Widget($appPid) { foreach ($line in [Us]::Windows($appPid)) { $f = $line -split '\|'; if ([int]$f[0] -gt 200 -and [int]$f[0] -lt 400) { return [pscustomobject]@{ W = [int]$f[0]; H = [int]$f[1]; X = [int]$f[2]; Y = [int]$f[3]; Visible = ($f[4] -eq 'True'); Topmost = ($f[5] -eq 'True') } } } }
function InFront($appPid) { $w = Get-Widget $appPid; if (-not $w -or -not $w.Visible) { return $false }; return ([Us]::PidAt($w.X + [int]($w.W / 2), $w.Y + [int]($w.H / 2)) -eq $appPid) }

function Run-Case($label, $extraArgs, $expectPulse) {
  $work = Join-Path $env:TEMP ("focusflow-uistart-" + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory -Force "$work\userdata" | Out-Null
  '{"settings":{"alwaysOnTop":false},"widgetVisible":true}' | Set-Content "$work\userdata\focusflow.json" -Encoding ascii
  $code = "Add-Type -AssemblyName System.Windows.Forms; `$f = New-Object System.Windows.Forms.Form; `$f.Text = 'FF-UI-COVER'; `$f.FormBorderStyle = 'None'; `$f.WindowState = 'Maximized'; `$f.BackColor = [System.Drawing.Color]::Magenta; [System.Windows.Forms.Application]::Run(`$f)"
  $cover = Start-Process powershell -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $code -PassThru; Start-Sleep -Milliseconds 2500
  $env:FOCUSFLOW_USER_DATA = "$work\userdata"
  if ($Exe) { if ($extraArgs.Count) { $app = Start-Process $Exe -ArgumentList $extraArgs -PassThru } else { $app = Start-Process $Exe -PassThru } } else { $electron = (& node -e "console.log(require('electron'))" | Select -Last 1); $app = Start-Process $electron -ArgumentList (@($root) + $extraArgs) -PassThru }
  Remove-Item Env:\FOCUSFLOW_USER_DATA
  try {
    $end = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $end -and -not (Get-Widget $app.Id)) { Start-Sleep -Milliseconds 400 }
    Start-Sleep -Milliseconds 1500
    $w = Get-Widget $app.Id
    Check "${label}: the widget window exists and is visible" ($w -and $w.Visible)
    Check "${label}: widget is above the covering window" (InFront $app.Id)
    Check "${label}: temporary top-most pulse active at startup = $expectPulse" ((Get-Widget $app.Id).Topmost -eq $expectPulse) "(actual $((Get-Widget $app.Id).Topmost))"
    if (-not $expectPulse) { Check "${label}: the app did not steal the foreground" ([Us]::ForegroundPid() -ne [uint32]$app.Id) }
    Start-Sleep 4  # pulse over
    Check "${label}: always-on-top preference (off) restored after the pulse" (-not (Get-Widget $app.Id).Topmost)
  } finally {
    Stop-Process -Id $cover.Id -Force -ErrorAction SilentlyContinue; & taskkill /PID $app.Id /T /F 2>$null | Out-Null; Start-Sleep 1; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Run-Case 'interactive launch' @() $true
Run-Case 'login (--hidden) launch' @('--hidden') $false
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host ("`nSUMMARY: {0} passed, {1} failed" -f @($results | Where-Object { $_.Result -eq 'PASS' }).Count, $failed)
exit $(if ($failed) { 1 } else { 0 })
