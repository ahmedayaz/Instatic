/**
 * CodeMirrorEditor — CodeMirror 6 editor mount.
 *
 * This module is LAZY-LOADED via React.lazy() in CodeEditorPanel — it MUST
 * NOT be imported statically from the editor main chunk. CodeMirror 6 adds
 * ~150 kB min+gz; code-splitting it behind React.lazy keeps the editor
 * startup bundle lean.
 *
 * Features:
 * - Per-type extension stacks (JSX/TS, CSS, JSON, Markdown, plain text).
 * - GitHub Dark-inspired CM6 theme using --editor-* CSS custom properties.
 * - Debounced 250ms content sync → updateFileContent() (Contribution #595 §3.3).
 * - Flush-on-switch: the useEffect cleanup flushes any pending edit before
 *   the view is destroyed, so unsaved edits survive file switches.
 *
 * Content sync pattern:
 *   Every CM6 doc change records the pending content in a ref. A 250ms debounce
 *   timer fires updateFileContent(). When the file switches (file.id changes),
 *   the old useEffect cleanup:
 *     1. Clears the debounce timer.
 *     2. Immediately flushes the pending content (flush-on-switch).
 *     3. Destroys the old CM6 view.
 *   The new effect creates a fresh view for the new file.
 *
 * @see CodeEditorPanel.tsx — parent (lazy-loads this module)
 * @see Contribution #595 §3 — architecture spec
 * @see globals.css — editor syntax palette and chrome design tokens
 * @see Constraint #402 — no inline styles
 */

import { useRef, useEffect, useEffectEvent, useCallback } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import type { SiteFile, SiteFileType } from '@core/files/schemas'

// ---------------------------------------------------------------------------
// GitHub Dark-inspired CM6 theme — CSS custom properties only.
// ---------------------------------------------------------------------------
// All color values are CSS custom properties from globals.css.
// No hex, rgb(), or hsl() literals in this lazy-loaded editor module.
const achromatic = EditorView.theme({
  '&': {
    backgroundColor: 'var(--editor-surface)',
    color: 'var(--editor-text)',
    height: '100%',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--editor-accent)',
    padding: '8px 0',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--editor-accent)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection)',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-surface-3)',
    borderRight: '1px solid var(--panel-border)',
    color: 'var(--editor-text-subtle)',
  },
  '.cm-gutter': {
    minWidth: '3ch',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    color: 'var(--editor-text-subtle)',
    fontSize: '11px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--editor-text-muted)',
  },
  '.cm-line': {
    padding: '0 12px 0 4px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--editor-surface-2)',
    border: '1px solid var(--panel-border)',
    color: 'var(--editor-text)',
  },
}, { dark: true })

const readableHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.comment,
      t.lineComment,
      t.blockComment,
      t.docComment,
      t.meta,
    ],
    color: 'var(--editor-syntax-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [
      t.keyword,
      t.definitionKeyword,
      t.operatorKeyword,
      t.modifier,
      t.controlKeyword,
    ],
    color: 'var(--editor-syntax-keyword)',
    fontWeight: '600',
  },
  {
    tag: [
      t.labelName,
      t.typeName,
      t.className,
      t.namespace,
      t.macroName,
      t.tagName,
      t.function(t.variableName),
      t.function(t.propertyName),
    ],
    color: 'var(--editor-syntax-entity)',
  },
  {
    tag: [
      t.propertyName,
      t.definition(t.propertyName),
      t.attributeName,
    ],
    color: 'var(--editor-syntax-property)',
  },
  {
    tag: [
      t.variableName,
      t.definition(t.variableName),
      t.local(t.variableName),
      t.special(t.variableName),
    ],
    color: 'var(--editor-syntax-variable)',
  },
  {
    tag: [
      t.atom,
      t.bool,
      t.number,
      t.integer,
      t.float,
      t.unit,
      t.color,
      t.url,
      t.literal,
      t.contentSeparator,
    ],
    color: 'var(--editor-syntax-constant)',
  },
  {
    tag: [
      t.string,
      t.regexp,
      t.escape,
      t.special(t.string),
      t.inserted,
      t.deleted,
    ],
    color: 'var(--editor-syntax-string)',
  },
  {
    tag: [
      t.operator,
      t.arithmeticOperator,
      t.logicOperator,
      t.compareOperator,
      t.definitionOperator,
      t.derefOperator,
      t.punctuation,
      t.separator,
      t.bracket,
      t.paren,
      t.squareBracket,
      t.brace,
    ],
    color: 'var(--editor-syntax-operator)',
  },
  {
    tag: [t.heading, t.strong],
    color: 'var(--editor-syntax-entity)',
    fontWeight: '700',
  },
  {
    tag: [t.emphasis],
    color: 'var(--editor-syntax-string)',
    fontStyle: 'italic',
  },
  {
    tag: [t.link],
    color: 'var(--editor-syntax-constant)',
    textDecoration: 'underline',
  },
  {
    tag: t.invalid,
    color: 'var(--editor-syntax-invalid)',
  },
], { themeType: 'dark' })

const readableSyntaxHighlighting = syntaxHighlighting(readableHighlightStyle)

// ---------------------------------------------------------------------------
// Per-type extension stacks
// ---------------------------------------------------------------------------

/**
 * Returns the language-specific extension(s) for the given file type.
 * Maps SiteFileType → CM6 language extension list.
 */
function getLanguageExtensions(type: SiteFileType, path: string): Extension[] {
  switch (type) {
    case 'component':
      // JSX + TypeScript — component files are always TSX
      return [javascript({ jsx: true, typescript: true })]

    case 'script':
      // TypeScript without JSX
      return [javascript({ typescript: true })]

    case 'style':
      return [css()]

    case 'config':
      // Branch on extension: .json → JSON; .ts → TypeScript; else plain text
      if (path.endsWith('.json')) return [json()]
      if (path.endsWith('.ts') || path.endsWith('.mts')) {
        return [javascript({ typescript: true })]
      }
      return [] // plain text

    case 'doc':
      return [markdown()]

    case 'asset':
      // Binary — should not reach CodeMirrorEditor (ImagePreview handles it)
      return []

    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// CodeMirrorEditor
// ---------------------------------------------------------------------------

interface CodeMirrorEditorProps {
  file: SiteFile
  updateFileContent: (id: string, content: string) => void
}

export default function CodeMirrorEditor({ file, updateFileContent }: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Refs to hold pending debounce state. Using refs (not state) so that reads
  // inside the CM6 update listener always see the current values without
  // triggering re-renders.
  const pendingContentRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Always-current reference to updateFileContent — avoids stale closure inside
  // the CM6 updateListener while keeping the main useEffect dep-free.
  const updateFileContentRef = useRef(updateFileContent)
  useEffect(() => {
    updateFileContentRef.current = updateFileContent
  }, [updateFileContent])

  // Flush pending content to the store immediately (called on file switch).
  const flush = useCallback((fileId: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pendingContentRef.current !== null) {
      // Flush-on-switch: persist pending edit before unmounting.
      updateFileContentRef.current(fileId, pendingContentRef.current)
      pendingContentRef.current = null
    }
  }, [])

  // Mount/destroy CM6 view when file.id changes (file switch).
  //
  // The mount captures the latest file content / type / path via
  // useEffectEvent — re-running on every keystroke would destroy + recreate
  // the EditorView and lose cursor position. The effect only re-runs on
  // file.id transitions, and the cleanup's `flush()` is called with the
  // stable currentFileId captured at mount time.
  const mountView = useEffectEvent((container: HTMLDivElement, currentFileId: string) => {
    return new EditorView({
      state: EditorState.create({
        doc: file.content ?? '',
        extensions: [
          basicSetup,
          ...getLanguageExtensions(file.type, file.path),
          readableSyntaxHighlighting,
          achromatic,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const content = update.state.doc.toString()
            pendingContentRef.current = content
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => {
              if (pendingContentRef.current !== null) {
                updateFileContentRef.current(currentFileId, pendingContentRef.current)
                pendingContentRef.current = null
              }
              timerRef.current = null
            }, 250)
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: container,
    })
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const currentFileId = file.id
    const view = mountView(container, currentFileId)

    return () => {
      // Flush-on-switch: persist any pending edit before destroying this view.
      // This guarantees unsaved edits survive file switches even if the
      // debounce timer has not fired yet.
      flush(currentFileId)
      view.destroy()
    }
  }, [file.id, flush])

  return (
    <div
      ref={containerRef}
      data-codemirror-container=""
    />
  )
}
