@echo off
for /f "usebackq skip=2 tokens=2,*" %%a in (`%WinDir%\System32\Reg QUERY "HKLM\System\CurrentControlSet\Control\Session Manager\Environment" /v Path`) do (
  for /f "usebackq skip=2 tokens=2,*" %%c in (`%WinDir%\System32\Reg QUERY "HKCU\Environment" /v Path`) do (
    set Path=%%b;%%d
  )
)
