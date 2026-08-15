; electron-builder's default CHECK_APP_RUNNING probes the running app via
; PowerShell + Get-CimInstance (WMI) through a blocking nsExec::Exec with no
; timeout. A wedged WMI stack (Win32_Process enumeration returning
; 0x80041032 for every client — observed 2026-08-15) freezes the installer on
; the "Installing" page at ~25% with no error and no files written. The
; template's tasklist/taskkill fallback is equally unsafe: on the same
; machine the 32-bit tasklist (SysWOW64, used by the 32-bit installer) and
; taskkill both hung indefinitely. This override scans the process list with
; native Toolhelp calls and terminates with TerminateProcess — no child
; process, no WMI, no tasklist, bounded by construction.
;
; Deliberately raw NSIS only (no LogicLib): this file is included before the
; template's common.nsh, and function bodies are compiled at their definition
; position.

; scan: $0 = "1" if ${APP_EXECUTABLE_FILENAME} is running, $1 = its pid
!macro findAppProcessBody
  StrCpy $0 "0"
  StrCpy $1 "0"
  System::Call 'Kernel32::CreateToolhelp32Snapshot(i 2, i 0) i .R0'
  IntCmp $R0 -1 scan_done 0 scan_done ; INVALID_HANDLE_VALUE
  System::Alloc 1024
  Pop $R9
  System::Call '*$R9(i 556)' ; PROCESSENTRY32W dwSize
  System::Call 'Kernel32::Process32FirstW(i R0, i $R9) i .R1'
  IntCmp $R1 0 scan_free 0 scan_loop
  scan_loop:
    ; szExeFile sits after the 9 leading DWORDs of PROCESSENTRY32W
    System::Call '*$R9(i,i,i.r2,i,i,i,i,i,i,&w256.R3)'
    StrCmp $R3 "${PRODUCT_FILENAME}.exe" 0 scan_next
    StrCpy $0 "1"
    StrCpy $1 $R2
    Goto scan_free
    scan_next:
    System::Call 'Kernel32::Process32NextW(i R0, i $R9) i .R1'
    IntCmp $R1 0 scan_free 0 scan_loop
  scan_free:
    System::Free $R9
    System::Call 'Kernel32::CloseHandle(i R0)'
  scan_done:
!macroend

; terminate the process in $1
!macro killAppProcessBody
  IntCmp $1 0 kill_done 0 kill_open
  kill_open:
    System::Call 'Kernel32::OpenProcess(i 0x0001, i 0, i $1) i .R4' ; PROCESS_TERMINATE
    IntCmp $R4 0 kill_done 0 kill_term
    kill_term:
      System::Call 'Kernel32::TerminateProcess(i R4, i 1)'
      System::Call 'Kernel32::CloseHandle(i R4)'
  kill_done:
!macroend

!ifndef BUILD_UNINSTALLER
Function findAppProcess
  !insertmacro findAppProcessBody
FunctionEnd
Function killAppProcess
  !insertmacro killAppProcessBody
FunctionEnd
!else
Function un.findAppProcess
  !insertmacro findAppProcessBody
FunctionEnd
Function un.killAppProcess
  !insertmacro killAppProcessBody
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
  !define TRACE_FIND_APP "un.findAppProcess"
  !define TRACE_KILL_APP "un.killAppProcess"
!else
  !define TRACE_FIND_APP "findAppProcess"
  !define TRACE_KILL_APP "killAppProcess"
!endif

!macro customCheckAppRunning
  Call ${TRACE_FIND_APP}
  StrCmp $0 "1" 0 check_done
    ${StdUtils.TestParameter} $R5 "updated"
    StrCmp $R5 "true" 0 check_not_updated
    Sleep 1000
    Goto doStopProcess
    check_not_updated:
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
    Quit

    doStopProcess:
    DetailPrint "$(appClosing)"
    Call ${TRACE_KILL_APP}
    Sleep 300

    StrCpy $R1 0
    kill_loop:
      IntOp $R1 $R1 + 1
      Call ${TRACE_FIND_APP}
      StrCmp $0 "1" 0 not_running
      Sleep 1000
      Call ${TRACE_KILL_APP}
      Call ${TRACE_FIND_APP}
      StrCmp $0 "1" 0 not_running
      DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
      Sleep 2000
      IntCmp $R1 1 kill_loop ask_retry ask_retry
      ask_retry:
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY kill_loop
      Quit
    not_running:
  check_done:
!macroend
