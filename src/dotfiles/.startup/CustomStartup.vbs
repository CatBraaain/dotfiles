filePath = Replace(WScript.ScriptFullName,"vbs","ps1")
curPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(filePath)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = curPath
shell.Run "powershell " & filePath, 0, False
