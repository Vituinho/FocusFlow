# Real Windows UI test for the widget: real mouse clicks on the real tray menu and on the dashboard's "Mostrar widget" button, with a
# maximized window covering the widget. Nothing here calls app internals: the app is driven like a user would, and the outcome is read
# from the OS window stack (which window is on top at the widget's centre).
#
#   powershell -File scripts/ui-test.ps1 [-Exe path\to\FocusFlow.exe] [-Cycles 3] [-Shots dir]
#
# Safety: the app runs with an isolated data folder and a unique tray tooltip tag, and only that tray icon is ever clicked, so a real
# FocusFlow running on the same machine is never touched. Needs an interactive desktop (it moves the mouse and creates a covering window).
param([string]$Exe = '', [int]$Cycles = 3, [string]$Shots = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Ut {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static uint PidAt(int x, int y) { var h = WindowFromPoint(new POINT { X = x, Y = y }); return h == IntPtr.Zero ? 0 : PidOf(GetAncestor(h, 2)); }
  // "WxH@X,Y,visible" of each titled window of the process
  public static List<string> Windows(uint pid) { var l = new List<string>(); EnumWindows((h, x) => { if (PidOf(h) == pid) { var t = new StringBuilder(100); GetWindowText(h, t, 100); if (t.Length > 0 && !t.ToString().Contains("IME")) { RECT r; GetWindowRect(h, out r); l.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}", r.R - r.L, r.B - r.T, r.L, r.T, IsWindowVisible(h), h)); } } return true; }, IntPtr.Zero); return l; }
}
'@
[void][Ut]::SetProcessDPIAware()
$AE = [System.Windows.Automation.AutomationElement]; $uiRoot = $AE::RootElement; $scope = [System.Windows.Automation.TreeScope]
$results = New-Object System.Collections.Generic.List[object]
function Check($name, $ok, $detail = '') { $script:results.Add([pscustomobject]@{ Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Check = $name; Detail = $detail }); Write-Host ("{0}  {1} {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail) }

# ---- launch the app (isolated) ---------------------------------------------------------------------------------------------------
$tag = 'uitest' + (Get-Random -Maximum 9999)
$work = Join-Path $env:TEMP ("focusflow-uitest-" + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory -Force "$work\userdata" | Out-Null
# alwaysOnTop=false is the real-world setting that lets other windows cover the widget
'{"settings":{"alwaysOnTop":false},"widgetVisible":true}' | Set-Content "$work\userdata\focusflow.json" -Encoding ascii
$port = Get-Random -Minimum 9500 -Maximum 9900
$env:FOCUSFLOW_USER_DATA = "$work\userdata"; $env:FOCUSFLOW_TRAY_TAG = $tag
if ($Exe) { $app = Start-Process $Exe -ArgumentList "--remote-debugging-port=$port" -PassThru }
else { $electron = (& node -e "console.log(require('electron'))" 2>$null | Select -Last 1); $app = Start-Process $electron -ArgumentList $root, "--remote-debugging-port=$port" -PassThru }
Remove-Item Env:\FOCUSFLOW_USER_DATA, Env:\FOCUSFLOW_TRAY_TAG
$appPid = [uint32]$app.Id
Start-Sleep 16

function Get-Widget { foreach ($line in [Ut]::Windows($appPid)) { $f = $line -split '\|'; if ([int]$f[0] -gt 200 -and [int]$f[0] -lt 400) { return [pscustomobject]@{ W = [int]$f[0]; H = [int]$f[1]; X = [int]$f[2]; Y = [int]$f[3]; Visible = ($f[4] -eq 'True') } } } }
function Get-Dashboard { foreach ($line in [Ut]::Windows($appPid)) { $f = $line -split '\|'; if ([int]$f[0] -gt 800) { return [pscustomobject]@{ W = [int]$f[0]; H = [int]$f[1]; X = [int]$f[2]; Y = [int]$f[3]; Visible = ($f[4] -eq 'True') } } } }
function Widget-InFront { $w = Get-Widget; if (-not $w -or -not $w.Visible) { return $false }; return ([Ut]::PidAt($w.X + [int]($w.W / 2), $w.Y + [int]($w.H / 2)) -eq $appPid) }
function Wait-Until($cond, $ms = 4000) { $end = (Get-Date).AddMilliseconds($ms); while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 150 }; return $false }

$script:cover = $null
function Cover-Up {
  Cover-Down
  $code = "Add-Type -AssemblyName System.Windows.Forms; `$f = New-Object System.Windows.Forms.Form; `$f.Text = 'FF-UI-COVER'; `$f.FormBorderStyle = 'None'; `$f.WindowState = 'Maximized'; `$f.BackColor = [System.Drawing.Color]::Magenta; [System.Windows.Forms.Application]::Run(`$f)"
  $script:cover = Start-Process powershell -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $code -PassThru
  Start-Sleep -Milliseconds 2500
}
function Cover-Down { if ($script:cover -and -not $script:cover.HasExited) { Stop-Process -Id $script:cover.Id -Force -ErrorAction SilentlyContinue }; $script:cover = $null }

function Close-Popups { [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 400 }
function Click-At($x, $y, $right = $false) {
  [void][Ut]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 450
  if ($right) { [Ut]::mouse_event(0x08, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [Ut]::mouse_event(0x10, 0, 0, 0, [UIntPtr]::Zero) }
  else { [Ut]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [Ut]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero) }
}
function Find-Class($cls) { $uiRoot.FindFirst($scope::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $cls))) }
function Open-Overflow {
  for ($try = 0; $try -lt 4; $try++) {
    $fly = Find-Class 'TopLevelWindowForOverflowXamlIsland'
    if ($fly -and -not $fly.Current.IsOffscreen) { $script:overflow = $fly; return }
    $tray = Find-Class 'Shell_TrayWnd'; $chev = $null
    foreach ($e in $tray.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($e.Current.Name -match 'idden|ocult' -and $e.Current.ControlType.ProgrammaticName -match 'Button') { $chev = $e; break } }
    if ($chev) { $chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    Start-Sleep -Milliseconds 1400
  }
  $script:overflow = Find-Class 'TopLevelWindowForOverflowXamlIsland'
}
# Opens the tray menu of THIS test instance only (its tooltip carries the unique tag).
function Open-TrayMenu {
  $script:menu = $null
  for ($attempt = 1; $attempt -le 3 -and -not $script:menu; $attempt++) {
    Close-Popups
    Open-Overflow; $fly = $script:overflow; $icon = $null
    if ($fly) { foreach ($e in $fly.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($e.Current.Name -like "*[[]$tag]*" -and $e.Current.ControlType.ProgrammaticName -match 'Button') { $icon = $e; break } } }
    if (-not $icon) { continue }
    $b = $icon.Current.BoundingRectangle; Click-At ($b.X + $b.Width / 2) ($b.Y + $b.Height / 2) $true
    for ($i = 0; $i -lt 16 -and -not $script:menu; $i++) { Start-Sleep -Milliseconds 250
      foreach ($w in $uiRoot.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) { $r = $w.Current.BoundingRectangle
        if ($w.Current.ClassName -eq 'Chrome_WidgetWin_1' -and $w.Current.Name -eq '' -and $r.Width -gt 200 -and $r.Height -gt 250 -and $r.Width -lt 500) { $script:menu = $w; break } } }
  }
}
function Tray-Click($pattern) {
  Open-TrayMenu; $menu = $script:menu
  if (-not $menu) { return 'menu did not open' }
  foreach ($e in $menu.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -match 'MenuItem' -and $e.Current.Name -match $pattern) { $b = $e.Current.BoundingRectangle; $name = $e.Current.Name; Click-At ($b.X + $b.Width / 2) ($b.Y + $b.Height / 2); Start-Sleep -Milliseconds 1200; return "clicked '$name'" } }
  Close-Popups; return "no menu item matching $pattern"
}
function Save-WidgetShot($name) {
  if (-not $Shots) { return }; New-Item -ItemType Directory -Force $Shots | Out-Null; $w = Get-Widget
  $bmp = New-Object System.Drawing.Bitmap $w.W, $w.H; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($w.X, $w.Y, 0, 0, $bmp.Size); $bmp.Save("$Shots\$name.png")
}

try {
  Check 'app started and its widget is visible' ((Get-Widget).Visible) ("pid $appPid")
  $cdpOk = $true
  for ($cycle = 1; $cycle -le $Cycles; $cycle++) {
    Write-Host "--- cycle $cycle"
    # 1. tray menu "Trazer widget para frente" while a maximized window buries the widget
    Cover-Up
    Check "[$cycle] precondition: a maximized window covers the widget" (-not (Widget-InFront))
    $r = Tray-Click 'Trazer widget para frente|Mostrar widget'
    Check "[$cycle] tray menu: Bring to front brings the buried widget to the front" (Wait-Until { Widget-InFront }) $r
    if ($cycle -eq 1) { Save-WidgetShot 'tray-bring-to-front' }

    # 2. real click on the dashboard's "Mostrar widget" button (let the temporary top-most pulse of step 1 end first)
    Start-Sleep 3
    Cover-Up
    Check "[$cycle] precondition: widget buried again" (-not (Widget-InFront))
    $r = Tray-Click 'Abrir painel'
    $dashOnTop = Wait-Until { $d = Get-Dashboard; $d -and $d.Visible -and ([Ut]::PidAt($d.X + 600, $d.Y + 400) -eq $appPid) }
    Check "[$cycle] tray menu: Abrir painel puts the dashboard above the covering window" $dashOnTop $r
    $json = & node (Join-Path $root 'scripts\ui-cdp.mjs') $port 'Mostrar widget' | Select -Last 1
    $pt = $json | ConvertFrom-Json
    if ($pt.x) {
      $owner = [Ut]::PidAt([int]$pt.x, [int]$pt.y)
      Check "[$cycle] the mouse target is the FocusFlow dashboard button" ($owner -eq $appPid) "at $($pt.x),$($pt.y)"
      if ($owner -eq $appPid) { Click-At $pt.x $pt.y; Check "[$cycle] real click on 'Mostrar widget' brings the buried widget to the front" (Wait-Until { Widget-InFront } 5000) }
    } else { Check "[$cycle] located the dashboard button" $false $json }
    if ($cycle -eq 1) { Save-WidgetShot 'dashboard-button' }

    # 3. hide through the tray, bury, then show through the tray
    $r = Tray-Click 'Ocultar widget'
    Check "[$cycle] tray menu: Ocultar widget hides the widget" (Wait-Until { -not (Get-Widget).Visible }) $r
    Cover-Up
    $r = Tray-Click 'Mostrar widget|Trazer widget para frente'
    Check "[$cycle] tray menu: Mostrar widget shows it above the covering window" (Wait-Until { Widget-InFront } 5000) $r
    Cover-Down; Start-Sleep -Milliseconds 800
  }
  Check 'still exactly one app instance, and it never crashed' ((Get-Process -Id $appPid -ErrorAction SilentlyContinue) -ne $null)
  $log = Get-Content "$work\userdata\logs\focusflow.log" -ErrorAction SilentlyContinue
  Check 'no errors in the app log' (@($log | Select-String ' ERROR ').Count -eq 0)
  if (@($results | Where-Object { $_.Result -eq 'FAIL' }).Count) { Write-Host '--- widget lines of the app log (for diagnosis)'; $log | Select-String 'Widget|dashboard-button|tray-menu' | Select -Last 14 | ForEach-Object { Write-Host ($_.Line.Substring(0, [Math]::Min(190, $_.Line.Length))) } }
  Check 'each click is in the log (dashboard-button and tray-menu requests)' ((@($log | Select-String 'dashboard-button').Count -ge $Cycles) -and (@($log | Select-String 'tray-menu').Count -ge $Cycles))
}
finally {
  Close-Popups; Cover-Down
  & taskkill /PID $appPid /T /F 2>$null | Out-Null
  Start-Sleep 1; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host ("`nSUMMARY: {0} passed, {1} failed" -f @($results | Where-Object { $_.Result -eq 'PASS' }).Count, $failed)
exit $(if ($failed) { 1 } else { 0 })
