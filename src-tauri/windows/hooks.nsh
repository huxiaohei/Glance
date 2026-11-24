; Glance 安装器钩子：注册“打开方式”与目录右键菜单。
; 只写 OpenWithProgids，不写扩展名键的默认值，不碰用户已选的默认程序。
; 根键一律 SHCTX：当前用户安装写 HKCU，所有用户安装写 HKLM。

!macro NSIS_HOOK_POSTINSTALL
  ; 菜单文字随安装语言：简体中文 2052，其余英文
  Push $0
  StrCmp $LANGUAGE 2052 0 +3
  StrCpy $0 "用 Glance 打开"
  Goto +2
  StrCpy $0 "Open with Glance"

  WriteRegStr SHCTX "Software\Classes\Glance.Image" "" "Image"
  WriteRegStr SHCTX "Software\Classes\Glance.Image\DefaultIcon" "" '$INSTDIR\${MAINBINARYNAME}.exe,0'
  WriteRegStr SHCTX "Software\Classes\Glance.Image\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  WriteRegStr SHCTX "Software\Classes\.png\OpenWithProgids" "Glance.Image" ""
  WriteRegStr SHCTX "Software\Classes\.jpg\OpenWithProgids" "Glance.Image" ""
  WriteRegStr SHCTX "Software\Classes\.jpeg\OpenWithProgids" "Glance.Image" ""
  WriteRegStr SHCTX "Software\Classes\.webp\OpenWithProgids" "Glance.Image" ""
  WriteRegStr SHCTX "Software\Classes\.gif\OpenWithProgids" "Glance.Image" ""
  WriteRegStr SHCTX "Software\Classes\.bmp\OpenWithProgids" "Glance.Image" ""

  WriteRegStr SHCTX "Software\Classes\Directory\shell\Glance" "" $0
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Glance" "Icon" '$INSTDIR\${MAINBINARYNAME}.exe,0'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Glance\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Glance" "" $0
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Glance" "Icon" '$INSTDIR\${MAINBINARYNAME}.exe,0'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Glance\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'

  Pop $0
  ; 通知资源管理器刷新关联
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Glance.Image"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Glance"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Glance"
  DeleteRegValue SHCTX "Software\Classes\.png\OpenWithProgids" "Glance.Image"
  DeleteRegValue SHCTX "Software\Classes\.jpg\OpenWithProgids" "Glance.Image"
  DeleteRegValue SHCTX "Software\Classes\.jpeg\OpenWithProgids" "Glance.Image"
  DeleteRegValue SHCTX "Software\Classes\.webp\OpenWithProgids" "Glance.Image"
  DeleteRegValue SHCTX "Software\Classes\.gif\OpenWithProgids" "Glance.Image"
  DeleteRegValue SHCTX "Software\Classes\.bmp\OpenWithProgids" "Glance.Image"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
