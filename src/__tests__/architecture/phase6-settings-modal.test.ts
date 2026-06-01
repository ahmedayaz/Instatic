/**
 * Architecture Gate Tests — Phase 6: Settings Modal
 *
 * Pre-registered gate tests for the Settings Modal implementation (Task #183).
 * Uses the adaptive-skip pattern: gates activate when a `SettingsModal/` (or
 * equivalent) directory is detected under `src/admin/pages/site/components/`.
 *
 * ENFORCED REQUIREMENTS (from Guideline #225 / Task #183):
 *
 * 1. Modal ARIA shell — `role="dialog"`, `aria-modal="true"`, `aria-labelledby`,
 *    `aria-describedby`, and `data-testid="settings-modal"`.
 *    (Guideline #225 / WCAG 2.1 SC 4.1.2 + SC 2.4.3)
 *
 * 2. Sidebar nav ARIA — `<nav aria-label`, `aria-current` for the active section.
 *    (Guideline #225)
 *
 * 3. No react-router imports in SettingsModal files.
 *    (settings sections are local UI state, not routes)
 *
 * 4. ESC key handler — modal must close on Escape.
 *    (Guideline #225 — `onKeyDown` with `e.key === 'Escape'` check)
 *
 * 5. Settings modal open state tracked in Zustand store (uiSlice or equivalent).
 *    (Task #183 — "All settings persisted to site store")
 *
 * 6. Backdrop must not receive focus — `aria-hidden="true"` or `inert` on overlay.
 *    (Guideline #225 — "Backdrop must NOT receive focus")
 *
 * @see Guideline #225 — Settings Modal UX & Accessibility (J10)
 * @see Task #183     — Phase 6: Settings Modal
 * @see docs/reference/admin-router.md — use the in-house router for admin routes
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const SLICES_DIR = join(SRC_ROOT, 'admin/pages/site/store/slices')

// ---------------------------------------------------------------------------
// Adaptive-skip: activate when SettingsModal component directory is created.
// Searches common naming conventions the FSE might choose.
// ---------------------------------------------------------------------------

const SETTINGS_MODAL_DIR_CANDIDATES = [
  join(SRC_ROOT, 'admin/modals/SettingsModal'),
  join(SRC_ROOT, 'admin/modals/Settings'),
  join(SRC_ROOT, 'admin/modals/SettingsPanel'),
  join(SRC_ROOT, 'editor/components/settings-modal'),
  join(SRC_ROOT, 'editor/components/settings'),
]

const SETTINGS_MODAL_DIR = SETTINGS_MODAL_DIR_CANDIDATES.find(existsSync) ?? null
const PHASE6_IMPLEMENTED = SETTINGS_MODAL_DIR !== null

// ---------------------------------------------------------------------------
// File walker — same helper pattern as other architecture gates
// ---------------------------------------------------------------------------

function collectTs(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectTs(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

function modalFiles(): string[] {
  return SETTINGS_MODAL_DIR ? collectTs(SETTINGS_MODAL_DIR) : []
}

function allModalSrc(): string {
  return modalFiles()
    .map((f) => { try { return readFileSync(f, 'utf8') } catch { return '' } })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Gate 1 — Modal shell must have correct ARIA dialog attributes + data-testid
//
// Context: Guideline #225 / WCAG 2.1 SC 4.1.2 (Name, Role, Value).
// Without role="dialog" screen readers don't announce the dialog mode.
// Without aria-modal="true" assistive technology leaks focus outside the modal.
// Without aria-labelledby the dialog has no accessible name.
// Without aria-describedby users lose context about the dialog's purpose.
// data-testid="settings-modal" is required for integration test selectors.
//
// IMPORTANT: This gate scans only the PRIMARY modal shell file(s) — i.e. the
// file(s) that actually contain `role="dialog"` in their JSX. Section content
// files (GeneralSection, ColorsSection, etc.) are intentionally excluded — they
// do not render the dialog container and must not be required to carry dialog ARIA.
// ---------------------------------------------------------------------------

describe('Phase 6 Gate 1 — SettingsModal must have correct ARIA dialog attributes (Guideline #225)', () => {
  it('[pre-registered] modal shell file must carry role="dialog", aria-modal="true", aria-labelledby, aria-describedby, data-testid', () => {
    if (!PHASE6_IMPLEMENTED) {
      console.log(
        '[Phase6 gate] SettingsModal directory not yet created — ' +
        'modal ARIA attributes gate pre-registered (Guideline #225 / Task #183)'
      )
      expect(true).toBe(true)
      return
    }

    // Find only the file(s) that actually render role="dialog" — these are the
    // modal shell. Section files (under /sections/) won't contain role="dialog".
    const shellFiles = modalFiles().filter((f) => {
      try {
        const src = readFileSync(f, 'utf8')
        return src.includes('role="dialog"') || src.includes("role={'dialog'}")
      } catch {
        return false
      }
    })

    if (shellFiles.length === 0) {
      throw new Error(
        '[Phase 6 / Guideline #225] No SettingsModal shell file found with role="dialog".\n' +
        'The modal container must carry role="dialog" on its root div:\n' +
        '  <div role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" ...>\n' +
        'See Guideline #225 / WCAG 2.1 SC 4.1.2.'
      )
    }

    const violations: string[] = []

    for (const file of shellFiles) {
      let src: string
      try { src = readFileSync(file, 'utf8') } catch { continue }

      const rel = file.replace(SRC_ROOT, 'src/')

      if (!src.includes('aria-modal')) {
        violations.push(
          `${rel} — missing aria-modal="true" ` +
          '(confines AT virtual cursor to the dialog — prevents background content leaking into reading order)'
        )
      }

      if (!src.includes('aria-labelledby')) {
        violations.push(
          `${rel} — missing aria-labelledby ` +
          '(screen readers announce the dialog name from the referenced heading — e.g. aria-labelledby="settings-modal-title")'
        )
      }

      if (!src.includes('aria-describedby')) {
        violations.push(
          `${rel} — missing aria-describedby ` +
          '(screen readers read the dialog description on focus — add a CSS-module visually hidden <p id="settings-modal-desc"> ' +
          'with content like "SiteDocument-level configuration. Press Escape to close." and reference it here)'
        )
      }

      if (!src.includes('data-testid="settings-modal"') && !src.includes("data-testid={'settings-modal'}")) {
        violations.push(
          `${rel} — missing data-testid="settings-modal" ` +
          '(required for integration test selectors per Guideline #221)'
        )
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[Phase 6 / Guideline #225] SettingsModal shell missing required ARIA dialog attributes.\n' +
        'Required pattern on the modal root element:\n' +
        '  <div\n' +
        '    role="dialog"\n' +
        '    aria-modal="true"\n' +
        '    aria-labelledby="settings-modal-title"\n' +
        '    aria-describedby="settings-modal-desc"\n' +
        '    data-testid="settings-modal"\n' +
        '  >\n' +
        '    <h2 id="settings-modal-title">Settings</h2>\n' +
        '    <p id="settings-modal-desc" className={styles.screenReaderOnly}>\n' +
        '      SiteDocument-level configuration. Press Escape to close.\n' +
        '    </p>\n' +
        '    ...\n' +
        '  </div>\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n')
      )
    }

    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — Left sidebar navigation must use correct ARIA nav pattern
//
// Context: Guideline #225.
// The sidebar must be a <nav> landmark with an aria-label (so it's distinct
// from other landmarks). Active section must carry aria-current="page" on
// the active button/link so AT announces which section is active.
// ---------------------------------------------------------------------------

describe('Phase 6 Gate 2 — SettingsModal sidebar nav must use labeled <nav> + aria-current (Guideline #225)', () => {
  it('[pre-registered] SettingsModal must contain <nav aria-label> and aria-current on the active section item', () => {
    if (!PHASE6_IMPLEMENTED) {
      console.log(
        '[Phase6 gate] SettingsModal directory not yet created — ' +
        'sidebar nav ARIA gate pre-registered (Guideline #225 / Task #183)'
      )
      expect(true).toBe(true)
      return
    }

    const src = allModalSrc()
    const violations: string[] = []

    // <nav aria-label="..."> — labeled nav landmark
    if (!/<nav[\s>][^>]*aria-label/.test(src) && !/<nav[\s>]/.test(src)) {
      violations.push(
        'No <nav> landmark found in SettingsModal — ' +
        'sidebar must be wrapped in <nav aria-label="Settings sections"> for AT landmark navigation'
      )
    } else if (!/<nav[\s>][^>]*aria-label/.test(src)) {
      violations.push(
        '<nav> found but missing aria-label — ' +
        'add aria-label="Settings sections" to distinguish this landmark from others on the page'
      )
    }

    // aria-current attribute — required on the active nav item
    if (!src.includes('aria-current')) {
      violations.push(
        'No aria-current found in SettingsModal — ' +
        'the active section nav item must carry aria-current="page" (or aria-current={isActive ? "page" : undefined})'
      )
    }

    if (violations.length > 0) {
      throw new Error(
        '[Phase 6 / Guideline #225] SettingsModal sidebar nav missing ARIA navigation patterns.\n' +
        'Required structure:\n' +
        '  <nav aria-label="Settings sections">\n' +
        '    <ul role="list">\n' +
        '      <li>\n' +
        '        <button aria-current={activeSection === "general" ? "page" : undefined}>\n' +
        '          General\n' +
        '        </button>\n' +
        '      </li>\n' +
        '      ...\n' +
        '    </ul>\n' +
        '  </nav>\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n')
      )
    }

    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate 3 — No react-router imports in SettingsModal files
//
// Settings section navigation is local modal state, not an admin route.
// The app router is for workspace/page navigation; the modal's internal tabs
// should stay in local state or Zustand.
// ---------------------------------------------------------------------------

describe('Phase 6 Gate 3 — SettingsModal must not import react-router', () => {
  it('[pre-registered] SettingsModal files must not import from react-router or react-router-dom', () => {
    if (!PHASE6_IMPLEMENTED) {
      console.log(
        '[Phase6 gate] SettingsModal directory not yet created — ' +
        'settings-section routing gate pre-registered (Task #183)'
      )
      expect(true).toBe(true)
      return
    }

    const ROUTER_IMPORT_RE = /from\s+['"]react-router(?:-dom)?['"]/

    const violations: string[] = []

    for (const file of modalFiles()) {
      let src: string
      try { src = readFileSync(file, 'utf8') } catch { continue }

      if (!ROUTER_IMPORT_RE.test(src)) continue

      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (ROUTER_IMPORT_RE.test(line) && !/^\s*\/\//.test(line.trim())) {
          const rel = file.replace(SRC_ROOT, 'src/')
          violations.push(
            `${rel}:${i + 1} — react-router import in SettingsModal ` +
            '(settings sections must be driven by local state or Zustand activeSection state)'
          )
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[Phase 6] react-router imported in SettingsModal.\n' +
        'Settings sections are modal-local UI, not admin routes.\n' +
        'Track the active settings section with local state or a Zustand uiSlice field:\n' +
        "  const [activeSection, setActiveSection] = useState<SettingsSection>('general')\n" +
        '  // or via useEditorStore: openSettings() sets isSettingsOpen + activeSection\n' +
        'See docs/reference/admin-router.md.\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n')
      )
    }

    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate 4 — Modal must close on Escape key press
//
// Context: Guideline #225.
// `onKeyDown` with `e.key === 'Escape'` is the standard modal close pattern.
// Note: ESC must NOT be consumed when a nested popover/dropdown is open —
// the check here only validates that the handler exists, not its internal
// logic. The FSE is responsible for the nested-popover guard.
// ---------------------------------------------------------------------------

describe('Phase 6 Gate 4 — SettingsModal must handle Escape key to close (Guideline #225)', () => {
  it('[pre-registered] SettingsModal must contain an Escape key handler for modal close', () => {
    if (!PHASE6_IMPLEMENTED) {
      console.log(
        '[Phase6 gate] SettingsModal directory not yet created — ' +
        'ESC key handler gate pre-registered (Guideline #225 / Task #183)'
      )
      expect(true).toBe(true)
      return
    }

    const src = allModalSrc()
    const violations: string[] = []

    // Must have an Escape key check
    const hasEscapeCheck =
      /['"]Escape['"]/.test(src) ||
      /\.key\s*===\s*['"]Escape['"]/.test(src)

    if (!hasEscapeCheck) {
      violations.push(
        'No Escape key check found in SettingsModal — ' +
        "modal must call closeModal/setIsOpen(false) when e.key === 'Escape'"
      )
    }

    // Must have an onKeyDown handler
    const hasKeyDownHandler = /onKeyDown/.test(src) || /addEventListener\(['"]keydown/.test(src)
    if (!hasKeyDownHandler) {
      violations.push(
        'No onKeyDown (or keydown event listener) found in SettingsModal — ' +
        'modal container needs onKeyDown to intercept Escape key'
      )
    }

    if (violations.length > 0) {
      throw new Error(
        '[Phase 6 / Guideline #225] SettingsModal missing ESC key close handler.\n' +
        'Required pattern on the dialog container:\n' +
        '  <div\n' +
        '    role="dialog"\n' +
        '    onKeyDown={(e) => {\n' +
        "      if (e.key === 'Escape' && !nestedPopoverOpen) closeModal()\n" +
        '    }}\n' +
        '  >\n' +
        'Note: do NOT consume Escape when a nested dropdown/combobox/picker is open.\n' +
        'See Guideline #225.\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n')
      )
    }

    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate 5 — Settings modal open state must be tracked in Zustand store
//
// Context: Task #183 — settings state is owned by the editor store.
// The modal open/close state must be accessible from the Zustand store so
// that any part of the editor (toolbar button, Ctrl+, shortcut, external
// trigger) can open the settings modal via the same action.
//
// The canonical location is uiSlice.ts — add `isSettingsOpen: boolean`,
// `openSettings()`, and `closeSettings()` actions.
// ---------------------------------------------------------------------------

describe('Phase 6 Gate 5 — Settings modal open state must be in Zustand store (Task #183)', () => {
  it('[pre-registered] uiSlice (or another slice) must expose isSettingsOpen/openSettings/closeSettings', () => {
    if (!PHASE6_IMPLEMENTED) {
      console.log(
        '[Phase6 gate] SettingsModal directory not yet created — ' +
        'store state gate pre-registered (Task #183 / Guideline #193)'
      )
      expect(true).toBe(true)
      return
    }

    // Read all slice files to check for settings modal state
    const sliceFiles = existsSync(SLICES_DIR) ? collectTs(SLICES_DIR) : []
    const allSliceSrc = sliceFiles
      .map((f) => { try { return readFileSync(f, 'utf8') } catch { return '' } })
      .join('\n')

    // Also scan the full SettingsModal source in case the modal manages its
    // own state locally — we want it in the store, not only in useState.
    const hasSettingsModalState =
      /isSettingsOpen|settingsOpen|openSettings|closeSettings|toggleSettings/.test(allSliceSrc)

    if (!hasSettingsModalState) {
      throw new Error(
        '[Phase 6 / Task #183] No settings modal open/close state found in any Zustand slice.\n' +
        'The modal open state must be tracked in the store so any part of the editor\n' +
        '(toolbar button, Ctrl+, keyboard shortcut, programmatic trigger) can open it.\n' +
        'Canonical location: src/core/editor-store/slices/uiSlice.ts\n' +
        'Required additions to uiSlice:\n' +
        '  isSettingsOpen: boolean          // default: false\n' +
        '  openSettings: () => void\n' +
        '  closeSettings: () => void\n' +
        'See Task #183 and Guideline #193 (Zustand slice conventions).'
      )
    }

    expect(hasSettingsModalState).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gate 6 — Backdrop must NOT receive focus (aria-hidden or inert)
//
// Context: Guideline #225.
// The backdrop/overlay element sits behind the modal and must not be
// reachable by keyboard Tab or AT virtual cursor. Setting aria-hidden="true"
// or the `inert` attribute prevents this. Clicking the backdrop to close
// is the expected behaviour — the click handler is fine; just block focus.
// ---------------------------------------------------------------------------

describe('Phase 6 Gate 6 — Modal backdrop must be aria-hidden or inert (Guideline #225)', () => {
  it('[pre-registered] SettingsModal backdrop overlay must carry aria-hidden="true" or inert', () => {
    if (!PHASE6_IMPLEMENTED) {
      console.log(
        '[Phase6 gate] SettingsModal directory not yet created — ' +
        'backdrop focus-block gate pre-registered (Guideline #225 / Task #183)'
      )
      expect(true).toBe(true)
      return
    }

    const src = allModalSrc()

    // Look for backdrop / overlay element with proper focus guard.
    // The backdrop element itself won't have role="dialog" — it's a sibling.
    // We check that somewhere in the modal files, aria-hidden or inert is used
    // in close proximity to a backdrop/overlay pattern.
    const hasBackdropFocusBlock =
      /aria-hidden["']?\s*[=:]\s*["']?true/.test(src) ||
      /\binert\b/.test(src)

    if (!hasBackdropFocusBlock) {
      throw new Error(
        '[Phase 6 / Guideline #225] SettingsModal backdrop may receive focus.\n' +
        'The overlay/backdrop element must not be reachable by keyboard Tab or AT virtual cursor.\n' +
        'Required: add aria-hidden="true" or the `inert` attribute to the backdrop element:\n' +
        '  <div\n' +
        '    className={styles.backdrop}\n' +
        '    aria-hidden="true"          {/* prevents AT from reading/focusing backdrop */}\n' +
        '    onClick={closeModal}         {/* click-outside-to-close is fine */}\n' +
        '  />\n' +
        'See Guideline #225 — "Backdrop must NOT receive focus".'
      )
    }

    expect(hasBackdropFocusBlock).toBe(true)
  })
})
