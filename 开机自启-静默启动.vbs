' ============================================================
'  Smart Inventory System - silent launcher
'  Starts: mock data service (:4100) + main app (:3000)
'  Manual:  double-click this file
'  Autostart: copy into shell:startup folder
'  Stop:    run "停止全部系统.bat" in project root
' ============================================================
Option Explicit

Dim sh, fso, root, nodeExe, scriptDir

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Locate project root:
'   1) script sits inside the project -> use its own folder
'   2) script sits in the Startup folder -> fall back to fixed path
If fso.FileExists(scriptDir & "\server\index.js") Then
    root = scriptDir
ElseIf fso.FileExists("D:\dianshang\server\index.js") Then
    root = "D:\dianshang"
Else
    MsgBox "Project files not found." & vbCrLf & vbCrLf & _
           "Script folder: " & scriptDir & vbCrLf & _
           "Default path : D:\dianshang", 48, "Launch failed"
    WScript.Quit 1
End If

nodeExe = "D:\node\node.exe"
If Not fso.FileExists(nodeExe) Then
    nodeExe = "node.exe"
End If

' 1) mock data service  (cwd must be mock-data-service)
sh.CurrentDirectory = root & "\mock-data-service"
' 0 = hidden window, False = do not wait
sh.Run """" & nodeExe & """ --no-warnings src\server.js", 0, False

' give it a moment so the main app sees it online on first load
WScript.Sleep 2500

' 2) main app
sh.CurrentDirectory = root
sh.Run """" & nodeExe & """ --no-warnings server\index.js", 0, False

WScript.Sleep 2000

' 3) open browser
sh.Run "http://localhost:3000", 1, False
