$ErrorActionPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
$processNames = @('node.exe', 'esbuild.exe')

function Get-ProjectProcesses {
    @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $processNames -contains $_.Name -and
                $_.CommandLine -and
                $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
    )
}

$targets = Get-ProjectProcesses
if ($targets.Count -eq 0) {
    Write-Host 'Project is not running.'
    exit 0
}

$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 500
$remaining = Get-ProjectProcesses
if ($remaining.Count -gt 0) {
    Write-Error ("Could not stop {0} project process(es). Run as administrator and try again." -f $remaining.Count)
    exit 1
}

Write-Host ("Project stopped. Terminated {0} process(es)." -f $targets.Count)
