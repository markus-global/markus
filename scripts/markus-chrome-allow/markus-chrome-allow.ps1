param(
    [int]$Timeout = 5,
    [switch]$Check
)

if ($Check) {
    $chromeRunning = $null -ne (Get-Process -Name "chrome" -ErrorAction SilentlyContinue)
    Write-Output "{`"accessibilityPermission`":true,`"chromeRunning`":$($chromeRunning.ToString().ToLower()),`"platform`":`"win32`"}"
    exit 0
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Find-AllowButton {
    param([System.Windows.Automation.AutomationElement]$Element, [int]$Depth = 0)
    if ($Depth -gt 12) { return $null }

    try {
        $name = $Element.Current.Name
        $controlType = $Element.Current.ControlType

        if ($controlType -eq [System.Windows.Automation.ControlType]::Button) {
            $lower = $name.ToLower()
            if ($lower -eq "allow" -or $lower -eq "允许" -or $lower -eq "allow debugging") {
                return $Element
            }
        }

        $children = $Element.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($child in $children) {
            $found = Find-AllowButton -Element $child -Depth ($Depth + 1)
            if ($null -ne $found) { return $found }
        }
    } catch {}
    return $null
}

$deadline = (Get-Date).AddSeconds($Timeout)
$clicked = $false

while ((Get-Date) -lt $deadline) {
    $chromeProcesses = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
    if ($null -eq $chromeProcesses) {
        Write-Output '{"error":"Chrome is not running","clicked":false}'
        exit 1
    }

    $rootElement = [System.Windows.Automation.AutomationElement]::RootElement
    $chromeCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "Chrome_WidgetWin_1"
    )
    $chromeWindows = $rootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $chromeCondition
    )

    foreach ($win in $chromeWindows) {
        $button = Find-AllowButton -Element $win
        if ($null -ne $button) {
            try {
                $invokePattern = $button.GetCurrentPattern(
                    [System.Windows.Automation.InvokePattern]::Pattern
                )
                $invokePattern.Invoke()
                $clicked = $true
                break
            } catch {
                try {
                    $clickablePoint = $button.GetClickablePoint()
                    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MouseHelper {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
    public const uint MOUSEEVENTF_LEFTUP = 0x04;
}
"@ -ErrorAction SilentlyContinue
                    [MouseHelper]::SetCursorPos([int]$clickablePoint.X, [int]$clickablePoint.Y)
                    [MouseHelper]::mouse_event([MouseHelper]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
                    [MouseHelper]::mouse_event([MouseHelper]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
                    $clicked = $true
                    break
                } catch {}
            }
        }
    }

    if ($clicked) { break }
    Start-Sleep -Milliseconds 200
}

if ($clicked) {
    Write-Output '{"clicked":true}'
    exit 0
} else {
    Write-Output '{"error":"Allow button not found within timeout","clicked":false}'
    exit 1
}
