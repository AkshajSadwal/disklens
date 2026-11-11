Option Explicit
Dim shell, fso, installerDir, projectRoot, stopper, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
installerDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(installerDir))
stopper = fso.BuildPath(projectRoot, "scripts\windows\stop.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & stopper & """"
shell.Run command, 0, False
