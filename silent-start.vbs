Set FSO = CreateObject("Scripting.FileSystemObject")
currentDir = FSO.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & currentDir & """ && pnpm tools-dev run web --daemon-port 7457 --web-port 5175", 0, False
