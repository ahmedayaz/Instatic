import { useEffect } from 'react'

/**
 * Register a global Escape-key handler that calls `onCancel` while the
 * caller's dialog is mounted. Used by every modal dialog in the editor and
 * admin so the keyboard contract stays uniform.
 *
 * The handler is window-scoped (not dialog-scoped) because many of our
 * dialogs render via `createPortal` outside the React tree where focus may
 * sit, so a `keydown` handler on the dialog DOM node would miss most events.
 */
export function useDialogEscape(onCancel: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // `stopPropagation` keeps the press from bubbling into the editor's
        // global keybinding handler — Escape inside a dialog should close
        // the dialog, never trigger an editor command.
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])
}
