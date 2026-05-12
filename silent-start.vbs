Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""S:\Open Design"" && pnpm tools-dev run web --daemon-port 7457 --web-port 5175", 0, False
