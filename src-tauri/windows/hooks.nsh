;; Contour installer hooks (Tauri NSIS).
;; After the files are installed, Contour runs once in setup mode: it downloads the core models
;; (with a progress window, verified by SHA-256) and optimises them for this computer, then exits.
;; The installer waits, so Contour is ready to use offline when the installer finishes.
;; If the user skips or the download fails, the app offers the same setup on first launch.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Setting up Contour: downloading core models…"
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --setup'
!macroend
