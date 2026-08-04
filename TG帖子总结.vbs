Set shell = CreateObject("WScript.Shell")

shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""Set-Location 'D:\APP\Codex Desktop'; Start-Process npm.cmd -ArgumentList 'run','dev' -WindowStyle Hidden""", 0, False

WScript.Sleep 3000
shell.Run "http://127.0.0.1:5173", 1, False