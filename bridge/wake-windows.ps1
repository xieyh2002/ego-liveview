# Un-hide ego top-level windows so the compositor starts submitting frames.
#
# ego.exe launches with --startup-ego-browser-service, which creates its window
# hidden (rect -7,-7 and IsWindowVisible=false). A hidden window never produces
# Page.screencastFrame events and Page.captureScreenshot times out, so the live
# view needs one nudge. SW_SHOWMINNOACTIVE (7) reveals the window minimized
# without stealing focus or covering the user's screen.
#
# Prints "shown=<n> total=<m>" on stdout. Safe to run repeatedly: it only
# touches windows that are currently hidden.

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class EgoLiveWake {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);
}
'@

$script:total = 0
$script:shown = 0
$script:handles = New-Object System.Collections.ArrayList

$callback = [EgoLiveWake+EnumProc] {
  param([IntPtr]$hWnd, [IntPtr]$lParam)

  $class = New-Object System.Text.StringBuilder 256
  [void][EgoLiveWake]::GetClassName($hWnd, $class, 256)
  if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }

  $script:total++
  if (-not [EgoLiveWake]::IsWindowVisible($hWnd)) {
    [void]$script:handles.Add($hWnd)
  }
  return $true
}

[void][EgoLiveWake]::EnumWindows($callback, [IntPtr]::Zero)

foreach ($h in $script:handles) {
  # 7 = SW_SHOWMINNOACTIVE
  if ([EgoLiveWake]::ShowWindow($h, 7)) { $script:shown++ }
}

Write-Output ("shown={0} total={1}" -f $script:shown, $script:total)
