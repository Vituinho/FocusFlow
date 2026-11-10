# Helper for scripts/bench.mjs: window control and per-process CPU readings for a FocusFlow process tree.
#   -Mode tree     -MainPid N            -> "pid|type|cpuSeconds|workingSetMB" per process of the tree
#   -Mode topmost  -MainPid N            -> keep the app's windows above others (so the benchmark is not skewed by occlusion throttling)
#   -Mode show|hide -MainPid N -Which dashboard|widget
param([string]$Mode, [int]$MainPid, [string]$Which = '')
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class BW {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Windows(uint pid) { var l = new List<IntPtr>(); EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); var t = new StringBuilder(100); GetWindowText(h, t, 100); if (p == pid && t.Length > 0 && !t.ToString().Contains("IME")) l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static bool IsWidget(IntPtr h) { RECT r; GetWindowRect(h, out r); int w = r.R - r.L; return w > 200 && w < 400; }
  public static void Topmost(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); }
  public static void Show(IntPtr h, bool on) { ShowWindow(h, on ? 4 : 0); if (on) Topmost(h); }
}
'@
$wins = [BW]::Windows([uint32]$MainPid)
switch ($Mode) {
  'tree' {
    $all = Get-CimInstance Win32_Process
    $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($MainPid)
    do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
    foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) {
      $type = if ($p.ProcessId -eq $MainPid) { 'main' } elseif ($p.CommandLine -match '--type=([\w-]+)') { $Matches[1] } elseif ($p.Name -eq 'powershell.exe') { 'sampler' } else { 'other' }
      $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
      if ($proc) { '{0}|{1}|{2}|{3}' -f $p.ProcessId, $type, $proc.TotalProcessorTime.TotalSeconds, [int]($proc.WorkingSet64 / 1MB) } } }
  }
  'topmost' { foreach ($h in $wins) { [BW]::Topmost($h) } }
  { $_ -in 'show', 'hide' } { foreach ($h in $wins) { $isWidget = [BW]::IsWidget($h); if (($Which -eq 'widget') -eq $isWidget) { [BW]::Show($h, $Mode -eq 'show') } } }
}
