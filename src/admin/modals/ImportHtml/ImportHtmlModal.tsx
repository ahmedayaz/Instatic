/**
 * ImportHtmlModal — paste raw HTML and insert it as page nodes.
 *
 * Reads modal state (open/parentId/prefill) from the editor store so it can
 * be opened from the Spotlight command, the canvas context menu, and the DOM
 * panel context menu via a single `openImportHtmlModal()` call.
 *
 * AdminCanvasLayout renders `{importHtmlModalOpen && <ImportHtmlModal />}` —
 * the component mounts fresh on each open. All local state is initialized
 * from store values once on mount; no reset effects are needed.
 *
 * Pipeline on "Insert":
 *   1. `importHtml(source)` — parse → harvest inline styles + <style> CSS →
 *      strip unsafe → walk and map to PageNodes
 *   2. `cssToStyleRules(styleCss)` — parse <style> blocks into registry rules
 *   3. `insertImportedNodes(parentId, fragment, { styleRules, conditions })` —
 *      nodes + <style> rules in a single undo step
 *   4. `pushToast` — success summary (added selectors + stripped-counts detail)
 *
 * The live preview debounces at 200 ms so typing feels instant.
 */

import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { importHtml, type ImportFragment, type ImportResult } from '@core/htmlImport'
import { cssToStyleRules } from '@core/siteImport'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'
import styles from './ImportHtmlModal.module.css'

// ---------------------------------------------------------------------------
// Fragment preview — small recursive presentational tree summary
// ---------------------------------------------------------------------------

interface PreviewNodeRowProps {
  nodeId: string
  nodes: Record<string, PageNode>
  depth: number
}

function PreviewNodeRow({ nodeId, nodes, depth }: PreviewNodeRowProps) {
  const node = nodes[nodeId]
  if (!node) return null

  const indent = '│  '.repeat(depth)
  const connector = depth === 0 ? '' : '├─ '
  const moduleShort = node.moduleId.replace(/^base\./, '')

  // Derive a representative prop snippet for the row label.
  const propSnippet = (() => {
    const p = node.props as Record<string, unknown>
    if (typeof p.text === 'string' && p.text.length > 0) {
      return `"${p.text.slice(0, 32)}${p.text.length > 32 ? '…' : ''}"`
    }
    if (typeof p.tag === 'string' && p.tag.length > 0 && p.tag !== 'div') {
      return `<${p.tag}>`
    }
    if (typeof p.src === 'string' && p.src.length > 0) {
      return p.src.split('/').pop() ?? p.src
    }
    return null
  })()

  return (
    <>
      <div className={styles.previewNode}>
        {depth > 0 && (
          <span className={styles.previewNodeIndent} aria-hidden="true">
            {indent}{connector}
          </span>
        )}
        <span className={styles.previewNodeModule}>{moduleShort}</span>
        {propSnippet && (
          <span className={styles.previewNodeProp}>{propSnippet}</span>
        )}
      </div>
      {node.children.map((childId) => (
        <PreviewNodeRow
          key={childId}
          nodeId={childId}
          nodes={nodes}
          depth={depth + 1}
        />
      ))}
    </>
  )
}

interface FragmentPreviewProps {
  result: ImportResult | null
}

function FragmentPreview({ result }: FragmentPreviewProps) {
  if (!result || result.rootIds.length === 0) {
    return (
      <div className={styles.previewTree}>
        <p className={styles.previewEmpty}>No nodes — paste some HTML above.</p>
      </div>
    )
  }

  const total = Object.keys(result.nodes).length
  return (
    <>
      <p className={styles.previewHeader}>
        Preview ({total} {total === 1 ? 'node' : 'nodes'})
      </p>
      <div className={styles.previewTree} aria-label="Import preview">
        {result.rootIds.map((id) => (
          <PreviewNodeRow key={id} nodeId={id} nodes={result.nodes} depth={0} />
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * ImportHtmlModal is mounted conditionally:
 *   `{importHtmlModalOpen && <ImportHtmlModal />}`
 *
 * This means the component is always freshly mounted each time the modal
 * opens — no reset effects are needed. Local state is initialized once
 * from the store's snapshot at mount time.
 */
export function ImportHtmlModal() {
  const storeParentId = useEditorStore((s) => s.importHtmlModalParentId)
  const storePrefill = useEditorStore((s) => s.importHtmlModalPrefill)
  const closeModal = useEditorStore((s) => s.closeImportHtmlModal)
  const insertImportedNodes = useEditorStore((s) => s.insertImportedNodes)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints)
  const canvasPage = useEditorStore(selectActiveCanvasPage)

  // Initialize from store values — fresh on every mount.
  const rootId = canvasPage?.rootNodeId ?? ''
  const [html, setHtml] = useState(storePrefill)
  const [selectedParentId, setSelectedParentId] = useState(storeParentId ?? rootId)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Live preview — debounced 200 ms. All setState calls inside the timer
  // callback (not synchronously in the effect body).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (!html.trim()) {
        setResult(null)
        return
      }
      try {
        setResult(importHtml(html))
      } catch (_err) {
        setResult(null)
      }
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [html])

  // Parent picker options: page root + all container nodes.
  const parentOptions = (() => {
    if (!canvasPage) return []
    const options: Array<{ value: string; label: string; textValue: string }> = []
    for (const node of Object.values(canvasPage.nodes)) {
      const isRoot = node.id === canvasPage.rootNodeId
      const def = registry.get(node.moduleId)
      const acceptsChildren = isRoot || def?.canHaveChildren === true
      if (!acceptsChildren) continue
      const displayName = getNodeDisplayName(node, def, undefined)
      options.push({
        value: node.id,
        label: isRoot ? `${displayName} (root)` : displayName,
        textValue: displayName,
      })
    }
    return options
  })()

  const nodeCount = result ? Object.keys(result.nodes).length : 0
  const canInsert = nodeCount > 0

  const handleInsert = () => {
    if (!canInsert || !result) return
    const parentId = selectedParentId || canvasPage?.rootNodeId
    if (!parentId) return

    try {
      // Parse any <style> CSS into registry rules using the site's breakpoints
      // so @media folds into the matching breakpoint's contextStyles.
      const bpHints = (breakpoints ?? []).map((b) => ({ id: b.id, width: b.width }))
      const { rules, conditions } = result.styleCss.trim()
        ? cssToStyleRules(result.styleCss, { breakpoints: bpHints })
        : { rules: [], conditions: [] }

      const fragment: ImportFragment = { nodes: result.nodes, rootIds: result.rootIds }
      const inserted = insertImportedNodes(parentId, fragment, {
        styleRules: rules,
        conditions,
      })
      if (inserted.length === 0) {
        setErrorMsg('The selected parent does not accept children.')
        return
      }

      // Build toast body: node count + added-selector / stripped detail.
      const toastTitle = `Imported ${inserted.length} ${inserted.length === 1 ? 'node' : 'nodes'}`
      const detailParts: string[] = []
      if (rules.length) {
        detailParts.push(`${rules.length} CSS selector${rules.length > 1 ? 's' : ''}`)
      }
      const { stripped } = result
      if (stripped.scripts) detailParts.push(`stripped ${stripped.scripts} <script>`)
      if (stripped.inlineHandlers) {
        detailParts.push(`stripped ${stripped.inlineHandlers} inline handler${stripped.inlineHandlers > 1 ? 's' : ''}`)
      }
      const toastBody = detailParts.length > 0 ? detailParts.join(', ') : undefined

      pushToast({ kind: 'success', title: toastTitle, body: toastBody })
      closeModal()
    } catch (err) {
      console.error('[ImportHtmlModal] insert failed:', err)
      setErrorMsg(err instanceof Error ? err.message : 'Unknown import error')
    }
  }

  return (
    <Dialog
      open={true}
      onClose={closeModal}
      title="Import HTML"
      eyebrow="Instatic"
      size="lg"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleInsert}
            disabled={!canInsert}
          >
            Insert
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {/* HTML input */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="import-html-textarea">
            HTML
          </label>
          <textarea
            id="import-html-textarea"
            className={styles.textarea}
            value={html}
            onChange={(e) => { setHtml(e.target.value); setErrorMsg(null) }}
            placeholder={'<section>\n  <h1>Hello world</h1>\n</section>'}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Parent picker */}
        {parentOptions.length > 0 && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="import-html-parent">
              Insert inside
            </label>
            <Select
              id="import-html-parent"
              value={selectedParentId}
              onChange={(e) => setSelectedParentId(e.target.value)}
              options={parentOptions}
              aria-label="Choose a parent node for the imported content"
            />
          </div>
        )}

        {/* Error alert */}
        {errorMsg && (
          <div className={styles.errorAlert} role="alert">
            {errorMsg}
          </div>
        )}

        {/* Live preview */}
        <div className={styles.field}>
          <FragmentPreview result={result} />
        </div>
      </div>
    </Dialog>
  )
}
