let hklm = (^$"($env.windir)/System32/Reg" QUERY "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path | split row '    ').3
let hkcu = (^$"($env.windir)/System32/Reg" QUERY "HKCU\\Environment" /v Path | split row '    ').3
$env.Path = (^$"($env.windir)/System32/cmd /c call echo ($hklm);($hkcu)" | split row ';')
