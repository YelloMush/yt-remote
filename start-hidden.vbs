' Starts the yt-remote server with no console window (for auto-start at login).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName) & "\server"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "node server.js", 0, False
