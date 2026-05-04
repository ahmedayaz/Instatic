/**
 * removeParamWithCleanup.test.ts — Phase 3 data-layer tests
 *
 * Tests for the removeParamWithCleanup slice action.
 * Architecture source: Contribution #619 §2 §10
 *
 * Gates:
 *   RP-1 — bindings cleared from VC tree
 *   RP-2 — overrides cleared from all instances on all pages
 *   RP-3 — slot content cleared when type === 'slot'
 *   RP-4 — slot content NOT touched when type !== 'slot'
 *   RP-5 — param itself is removed from vc.params
 *   RP-6 — no-op when paramId doesn't exist
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { produce } from 'immer'
import { useEditorStore } from '@core/editor-store/store'
import type { SiteDocument } from '@core/page-tree/schemas'
import type { VisualComponent, VCNode } from '@core/visualComponents/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    hoveredNodeId: null,
    hasUnsavedChanges: false,
    activeDocument: null,
    activePageId: null,
  })
  return useEditorStore.getState()
}

function setupSite() {
  const s = freshStore()
  s.createSite('RP Test Site')
  return useEditorStore.getState()
}

function callAction<T>(name: string, ...args: unknown[]): T {
  const s = useEditorStore.getState() as Record<string, unknown>
  return (s[name] as (...a: unknown[]) => T)(...args)
}

function getSite() {
  return useEditorStore.getState().site as SiteDocument & {
    visualComponents: VisualComponent[]
  }
}

function getVC(vcId: string): VisualComponent {
  const site = getSite()
  return site.visualComponents.find((v) => v.id === vcId)!
}

function getActivePage() {
  const s = useEditorStore.getState()
  return s.site!.pages.find((p) => p.id === s.activePageId)!
}

/**
 * Add a base.visual-component-ref node to a page.
 * Returns the ref node id.
 */
function addRefNodeToPage(
  pageId: string,
  vcId: string,
  propOverrides: Record<string, unknown> = {},
  slotContent: Record<string, unknown[]> = {},
): string {
  const refNodeId = `ref-${vcId}-${pageId}-${Math.random().toString(36).slice(2)}`

  const state = useEditorStore.getState()
  useEditorStore.setState(
    produce(state, (draft) => {
      const page = draft.site!.pages.find((p) => p.id === pageId)!
      const rootNode = page.nodes[page.rootNodeId]
      rootNode.children.push(refNodeId)
      page.nodes[refNodeId] = {
        id: refNodeId,
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: vcId,
          propOverrides: { ...propOverrides },
          slotContent: { ...slotContent },
        },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      }
    }),
  )

  return refNodeId
}

/**
 * Set propBindings on a VC tree node (adds directly to state via Immer).
 */
function setVCNodeBindings(
  vcId: string,
  nodeId: string,
  propBindings: Record<string, { paramId: string }>,
) {
  const state = useEditorStore.getState()
  useEditorStore.setState(
    produce(state, (draft) => {
      const vc = draft.site!.visualComponents.find((v) => v.id === vcId)!
      const node = findVCNodeById(vc.rootNode, nodeId)
      if (node) {
        node.propBindings = { ...node.propBindings, ...propBindings }
      }
    }),
  )
}

function findVCNodeById(root: VCNode, id: string): VCNode | null {
  if (root.id === id) return root
  if (root.childNodes) {
    for (const child of root.childNodes) {
      const found = findVCNodeById(child, id)
      if (found) return found
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Gate RP-1 — bindings cleared from VC tree
// ---------------------------------------------------------------------------

describe('Gate RP-1 — bindings cleared from VC tree', () => {
  beforeEach(() => { setupSite() })

  it('removes propBindings entry from every node in the VC tree that references the param', () => {
    const vcId = callAction<string>('createVisualComponent', 'Card')
    const paramId = callAction<string>('addParam', vcId, 'title', 'string')

    const vc = getVC(vcId)
    const rootNodeId = vc.rootNode.id

    // Add a propBinding to the root node
    setVCNodeBindings(vcId, rootNodeId, { text: { paramId } })

    // Verify the binding is present before cleanup
    expect(getVC(vcId).rootNode.propBindings?.text?.paramId).toBe(paramId)

    callAction<void>('removeParamWithCleanup', vcId, paramId)

    // Binding must be gone
    expect(getVC(vcId).rootNode.propBindings?.text).toBeUndefined()
    // Param must be removed
    expect(getVC(vcId).params.find((p) => p.id === paramId)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Gate RP-2 — overrides cleared from all instances on all pages
// ---------------------------------------------------------------------------

describe('Gate RP-2 — overrides cleared from all ref instances on all pages', () => {
  beforeEach(() => { setupSite() })

  it('removes propOverrides[paramId] from all ref nodes on all pages', () => {
    const vcId = callAction<string>('createVisualComponent', 'Banner')
    const paramId = callAction<string>('addParam', vcId, 'headline', 'string')

    const pageA = getActivePage()

    // Add a second page
    const pageB = callAction<{ id: string }>('addPage', 'Page B', 'page-b')

    // Add ref instances with propOverrides on both pages
    const refIdA = addRefNodeToPage(pageA.id, vcId, { [paramId]: 'override-A' })
    const refIdB = addRefNodeToPage(pageB.id, vcId, { [paramId]: 'override-B' })

    // Verify overrides are present
    const siteA = getSite()
    const refNodeA = siteA.pages.find((p) => p.id === pageA.id)!.nodes[refIdA]
    const refNodeB = siteA.pages.find((p) => p.id === pageB.id)!.nodes[refIdB]
    expect((refNodeA.props.propOverrides as Record<string, unknown>)[paramId]).toBe('override-A')
    expect((refNodeB.props.propOverrides as Record<string, unknown>)[paramId]).toBe('override-B')

    callAction<void>('removeParamWithCleanup', vcId, paramId)

    const siteAfter = getSite()
    const refNodeAAfter = siteAfter.pages.find((p) => p.id === pageA.id)!.nodes[refIdA]
    const refNodeBAfter = siteAfter.pages.find((p) => p.id === pageB.id)!.nodes[refIdB]

    // Both overrides must be gone
    expect((refNodeAAfter.props.propOverrides as Record<string, unknown>)[paramId]).toBeUndefined()
    expect((refNodeBAfter.props.propOverrides as Record<string, unknown>)[paramId]).toBeUndefined()
  })

  it('preserves unrelated propOverrides keys on the same ref node', () => {
    const vcId = callAction<string>('createVisualComponent', 'Widget')
    const paramId = callAction<string>('addParam', vcId, 'title', 'string')
    const otherParamId = callAction<string>('addParam', vcId, 'subtitle', 'string')

    const pageA = getActivePage()
    const refId = addRefNodeToPage(pageA.id, vcId, {
      [paramId]: 'to-be-removed',
      [otherParamId]: 'keep-me',
    })

    callAction<void>('removeParamWithCleanup', vcId, paramId)

    const site = getSite()
    const refNode = site.pages.find((p) => p.id === pageA.id)!.nodes[refId]
    const overrides = refNode.props.propOverrides as Record<string, unknown>
    expect(overrides[paramId]).toBeUndefined()
    expect(overrides[otherParamId]).toBe('keep-me')
  })
})

// ---------------------------------------------------------------------------
// Gate RP-3 — slot content cleared when type === 'slot'
// ---------------------------------------------------------------------------

describe('Gate RP-3 — slot content cleared for slot params', () => {
  beforeEach(() => { setupSite() })

  it('removes slotContent[param.name] from all ref instances when param.type === "slot"', () => {
    const vcId = callAction<string>('createVisualComponent', 'Layout')
    const slotParamId = callAction<string>('addParam', vcId, 'children', 'slot', [])

    const pageId = getActivePage().id

    // A mock VCNode to use as slot content
    const slotContentNode = {
      id: 'content-node',
      moduleId: 'base.text',
      props: { text: 'content' },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    }

    const refId = addRefNodeToPage(
      pageId,
      vcId,
      {},
      { children: [slotContentNode] },
    )

    // Verify slotContent is present
    const siteBefore = getSite()
    const refBefore = siteBefore.pages.find((p) => p.id === pageId)!.nodes[refId]
    expect(
      (refBefore.props.slotContent as Record<string, unknown[]>).children,
    ).toBeDefined()

    callAction<void>('removeParamWithCleanup', vcId, slotParamId)

    const siteAfter = getSite()
    const refAfter = siteAfter.pages.find((p) => p.id === pageId)!.nodes[refId]
    expect(
      (refAfter.props.slotContent as Record<string, unknown> | undefined)?.children,
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Gate RP-4 — slot content NOT touched when type !== 'slot'
// ---------------------------------------------------------------------------

describe('Gate RP-4 — slot content NOT touched when param type is not slot', () => {
  beforeEach(() => { setupSite() })

  it('slotContent remains untouched when a string param is removed', () => {
    const vcId = callAction<string>('createVisualComponent', 'Card')
    const stringParamId = callAction<string>('addParam', vcId, 'title', 'string')

    const pageId = getActivePage().id

    const slotContentNode = {
      id: 'slot-node',
      moduleId: 'base.text',
      props: {},
      breakpointOverrides: {},
      children: [],
      classIds: [],
    }

    // Set up ref with both a propOverride for the string param AND some slotContent
    const refId = addRefNodeToPage(
      pageId,
      vcId,
      { [stringParamId]: 'some override' },
      { children: [slotContentNode] },
    )

    callAction<void>('removeParamWithCleanup', vcId, stringParamId)

    const site = getSite()
    const refNode = site.pages.find((p) => p.id === pageId)!.nodes[refId]

    // String param override removed
    expect((refNode.props.propOverrides as Record<string, unknown>)[stringParamId]).toBeUndefined()

    // slotContent untouched
    const slotContent = refNode.props.slotContent as Record<string, unknown[]>
    expect(slotContent.children).toBeDefined()
    expect(slotContent.children.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Gate RP-5 — param itself is removed from vc.params
// ---------------------------------------------------------------------------

describe('Gate RP-5 — param removed from vc.params', () => {
  beforeEach(() => { setupSite() })

  it('vc.params does not contain the param after removeParamWithCleanup', () => {
    const vcId = callAction<string>('createVisualComponent', 'ActionBtn')
    const paramId = callAction<string>('addParam', vcId, 'label', 'string')

    expect(getVC(vcId).params.find((p) => p.id === paramId)).toBeDefined()

    callAction<void>('removeParamWithCleanup', vcId, paramId)

    expect(getVC(vcId).params.find((p) => p.id === paramId)).toBeUndefined()
    expect(getVC(vcId).params).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate RP-6 — no-op when paramId doesn't exist
// ---------------------------------------------------------------------------

describe('Gate RP-6 — no-op when paramId does not exist', () => {
  beforeEach(() => { setupSite() })

  it('does not throw and does not change state when paramId is bogus', () => {
    const vcId = callAction<string>('createVisualComponent', 'Ghost')
    const realParamId = callAction<string>('addParam', vcId, 'text', 'string')

    const updatedAtBefore = getSite().updatedAt
    const paramCountBefore = getVC(vcId).params.length

    expect(() =>
      callAction<void>('removeParamWithCleanup', vcId, 'nonexistent-param-id'),
    ).not.toThrow()

    // State unchanged
    expect(getVC(vcId).params.length).toBe(paramCountBefore)
    expect(getVC(vcId).params[0].id).toBe(realParamId)
    // updatedAt must NOT be bumped (no-op exits early before timestamp update)
    expect(getSite().updatedAt).toBe(updatedAtBefore)
  })
})
