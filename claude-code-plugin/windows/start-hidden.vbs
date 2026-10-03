' start-hidden.vbs - launch the TDAI memory gateway with ZERO visible window.
' wscript.exe has no console of its own, and WshShell.Run with intWindowStyle=0
' runs the child completely hidden. This replaces the scheduled task's direct
' "powershell.exe ..." action, which flashed a console window even with
' -WindowStyle Hidden (a known Windows behaviour for interactive scheduled tasks).
'
' bWaitOnReturn=True: wait for start-gateway.ps1 and propagate its exit code, so
' the scheduled task / watchdog sees a failed start as a failed run instead of a
' success that hid the error (2026-10-03). start-gateway.ps1 itself appends
' failures to <DataDir>\watchdog.log.
'
' start-gateway.ps1 is resolved next to this file, so the same script works from
' the repo (claude-code-plugin\windows) and from the installed copy.
Dim fso, shell, here, ps1, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\start-gateway.ps1"
rc = shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, True)
WScript.Quit rc
