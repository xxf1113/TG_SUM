Option Explicit

Dim shell, fileSystem, projectDir, powershell, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectDir = Replace(projectDir, "'", "''")

powershell = "$ErrorActionPreference = 'SilentlyContinue'; " & _
  "$root = '" & projectDir & "'; " & _
  "$url = 'http://127.0.0.1:5173'; " & _
  "$ready = $false; " & _
  "try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; $ready = $response.StatusCode -eq 200 } catch {}; " & _
  "if (-not $ready) { " & _
    "Set-Location -LiteralPath $root; " & _
    "Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev') -WorkingDirectory $root -WindowStyle Hidden; " & _
    "for ($i = 0; $i -lt 30; $i++) { " & _
      "Start-Sleep -Milliseconds 500; " & _
      "try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { break } } catch {} " & _
    "} " & _
  "}; " & _
  "Start-Process -FilePath $url"

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command """ & powershell & """"
shell.Run command, 0, False
