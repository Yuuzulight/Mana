# Issue #343: reads the Windows UI Automation tree of the focused window's
# top-level ancestor as plain text, for use as fast screen context instead
# of the screenshot+OCR path. Output shape (parsed by accessibility-tree.js's
# parseAccessibilityTreeOutput):
#   PID:<owning process id>
#   ---
#   <one Name/Value per line, breadth-first, depth- and char-capped>
#
# Depth/element caps are deliberately hardcoded here, not exposed as
# parameters -- they're fixed safety limits, not a feature. Only the char
# budget varies by caller (MANA_ACCESSIBILITY_TREE_MAX_CHARS).

param(
    [int]$MaxChars = 1200,
    # Issue #648: start from the element at physical screen point
    # (-PointX, -PointY) -- the caller's mouse cursor, for "this"/"here"
    # requests -- instead of the focused one. The caller passes the point
    # because it's DPI-aware and this powershell.exe may not be. Falls back
    # to the focused element when nothing is there or it belongs to
    # -IgnorePointPid (the caller's own windows).
    [switch]$AtPoint,
    [int]$PointX,
    [int]$PointY,
    [int]$IgnorePointPid = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$MaxDepth = 6
$MaxElements = 200

function Write-EmptyResult {
    Write-Output "PID:0"
    Write-Output "---"
}

$pointed = $null
if ($AtPoint) {
    try {
        Add-Type -AssemblyName WindowsBase
        $pointed = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($PointX, $PointY)))
        if ($pointed.Current.ProcessId -eq $IgnorePointPid) {
            $pointed = $null
        }
    } catch {
        $pointed = $null
    }
}

$start = $pointed
if ($null -eq $start) {
    try {
        $start = [System.Windows.Automation.AutomationElement]::FocusedElement
    } catch {
        $start = $null
    }
}

if ($null -eq $start) {
    Write-EmptyResult
    exit 0
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$windowType = [System.Windows.Automation.ControlType]::Window
$topLevel = $start
$current = $start
while ($null -ne $current) {
    $isWindow = $false
    try {
        $isWindow = ($current.Current.ControlType -eq $windowType)
    } catch {
        $isWindow = $false
    }
    $topLevel = $current
    if ($isWindow) {
        break
    }
    try {
        $current = $walker.GetParent($current)
    } catch {
        $current = $null
    }
}

$ownerPid = 0
try {
    $ownerPid = $topLevel.Current.ProcessId
} catch {
    $ownerPid = 0
}

Write-Output "PID:$ownerPid"
Write-Output "---"

$sb = New-Object System.Text.StringBuilder

function Add-Line([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) {
        return
    }
    $remaining = $MaxChars - $sb.Length
    if ($remaining -le 0) {
        return
    }
    $line = $value
    if ($line.Length -gt $remaining) {
        $line = $line.Substring(0, $remaining)
    }
    [void]$sb.AppendLine($line)
}

# Issue #648: what the cursor is on leads the text, so "this" has an
# obvious referent; the rest of its window follows as context.
if ($null -ne $pointed) {
    $pointedText = ""
    try {
        $pointedText = $pointed.Current.Name
    } catch {
    }
    try {
        $valuePattern = $null
        if ($pointed.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
            $pointedText = "$pointedText $($valuePattern.Current.Value)"
        }
    } catch {
    }
    if (-not [string]::IsNullOrWhiteSpace($pointedText)) {
        Add-Line "Under the cursor: $($pointedText.Trim())"
    }
}

$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@{ Element = $topLevel; Depth = 0 })
$visited = 0

while ($queue.Count -gt 0 -and $visited -lt $MaxElements -and $sb.Length -lt $MaxChars) {
    $item = $queue.Dequeue()
    $element = $item.Element
    $depth = $item.Depth
    $visited++

    try {
        Add-Line $element.Current.Name
    } catch {
    }

    try {
        $valuePattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
            Add-Line $valuePattern.Current.Value
        }
    } catch {
    }

    if ($depth -lt $MaxDepth -and $sb.Length -lt $MaxChars) {
        try {
            $child = $walker.GetFirstChild($element)
            while ($null -ne $child) {
                $queue.Enqueue(@{ Element = $child; Depth = $depth + 1 })
                try {
                    $child = $walker.GetNextSibling($child)
                } catch {
                    $child = $null
                }
            }
        } catch {
        }
    }
}

Write-Output $sb.ToString()
