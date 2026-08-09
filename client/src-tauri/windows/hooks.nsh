!macro NSIS_HOOK_PREUNINSTALL
  ; Offline payloads are copied by the Rust wrapper after the NSIS install.
  RMDir /r "$INSTDIR\offline-vendor"
!macroend
