import { nanoid } from 'nanoid'
import type { Page, PageNode, SiteDocument } from './schemas'
import { getParent, isAncestor } from './selectors'
import { normalizePageSlug } from './slugs'

/**
 * Pure Immer-compatible mutation helpers for the page tree.
 *
 * These are called inside Zustand's Immer middleware — they mutate a draft Page/SiteDocument directly.
 * Every function here is also safe to call as a pure function when given a structuredClone'd object.
 *
 * Naming convention: functions that mutate pages take a `Page` draft as first arg.
 * Functions that mutate the site take a `SiteDocument` draft.
 */

// ---------------------------------------------------------------------------
// Node creation helpers
// ---------------------------------------------------------------------------

export function createNode(
  moduleId: string,
  defaults: Record<string, unknown> = {}
): PageNode {
  return {
    id: nanoid(),
    moduleId,
    props: { ...defaults },
    breakpointOverrides: {},
    children: [],
    classIds: [],
  }
}

// ---------------------------------------------------------------------------
// Node insertion
// ---------------------------------------------------------------------------

/**
 * Insert a new node as a child of parentId at the given index.
 * If index is omitted, appends to the end.
 */
export function insertNode(
  page: Page,
  node: PageNode,
  parentId: string,
  index?: number
): void {
  if (page.nodes[node.id]) {
    throw new Error(`[PageTree] Node "${node.id}" already exists in page "${page.id}"`)
  }
  const parent = page.nodes[parentId]
  if (!parent) {
    throw new Error(`[PageTree] Parent node "${parentId}" not found`)
  }
  page.nodes[node.id] = node
  if (index === undefined || index >= parent.children.length) {
    parent.children.push(node.id)
  } else {
    parent.children.splice(Math.max(0, index), 0, node.id)
  }
}

// ---------------------------------------------------------------------------
// Node deletion
// ---------------------------------------------------------------------------

/**
 * Remove a node and ALL its descendants from the page.
 * Also removes the node's ID from its parent's children array.
 */
export function deleteNode(page: Page, nodeId: string): void {
  if (nodeId === page.rootNodeId) {
    throw new Error(`[PageTree] Cannot delete the root node of a page.`)
  }
  // Collect all descendant IDs to delete
  const toDelete = new Set<string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = page.nodes[id]
    if (!node) continue
    toDelete.add(id)
    stack.push(...node.children)
  }
  // Remove from parent's children array
  const parent = getParent(page, nodeId)
  if (parent) {
    parent.children = parent.children.filter((id) => id !== nodeId)
  }
  // Remove all collected nodes
  for (const id of toDelete) {
    delete page.nodes[id]
  }
}

// ---------------------------------------------------------------------------
// Node props update
// ---------------------------------------------------------------------------

/** Update one or more props on a node (shallow merge). */
export function updateNodeProps(
  page: Page,
  nodeId: string,
  patch: Partial<Record<string, unknown>>
): void {
  const node = page.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  Object.assign(node.props, patch)
}

/** Set a breakpoint override for one or more props. */
export function setBreakpointOverride(
  page: Page,
  nodeId: string,
  breakpointId: string,
  patch: Partial<Record<string, unknown>>
): void {
  const node = page.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  if (!node.breakpointOverrides[breakpointId]) {
    node.breakpointOverrides[breakpointId] = {}
  }
  Object.assign(node.breakpointOverrides[breakpointId], patch)
}

/** Clear all breakpoint overrides for a specific breakpoint on a node. */
export function clearBreakpointOverride(
  page: Page,
  nodeId: string,
  breakpointId: string
): void {
  const node = page.nodes[nodeId]
  if (!node) return
  delete node.breakpointOverrides[breakpointId]
}

// ---------------------------------------------------------------------------
// Node metadata
// ---------------------------------------------------------------------------

export function renameNode(page: Page, nodeId: string, label: string): void {
  const node = page.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  node.label = label.trim() || undefined
}

export function toggleNodeLocked(page: Page, nodeId: string): void {
  const node = page.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  node.locked = !node.locked
}

export function toggleNodeHidden(page: Page, nodeId: string): void {
  const node = page.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  node.hidden = !node.hidden
}

// ---------------------------------------------------------------------------
// Node reorder / move
// ---------------------------------------------------------------------------

/**
 * Move a node to a new position within its current parent, or to a new parent.
 *
 * @param newParentId  - Target parent node ID
 * @param newIndex     - Insertion index within the new parent's children
 */
export function moveNode(
  page: Page,
  nodeId: string,
  newParentId: string,
  newIndex: number
): void {
  if (nodeId === page.rootNodeId) {
    throw new Error(`[PageTree] Cannot move the root node.`)
  }
  if (isAncestor(page, nodeId, newParentId)) {
    throw new Error(
      `[PageTree] Cannot move node "${nodeId}" into its own descendant "${newParentId}".`
    )
  }
  const newParent = page.nodes[newParentId]
  if (!newParent) throw new Error(`[PageTree] New parent "${newParentId}" not found`)

  // Remove from old parent
  const oldParent = getParent(page, nodeId)
  if (oldParent) {
    oldParent.children = oldParent.children.filter((id) => id !== nodeId)
  }

  // Insert at new location
  const clampedIndex = Math.max(0, Math.min(newIndex, newParent.children.length))
  newParent.children.splice(clampedIndex, 0, nodeId)
}

// ---------------------------------------------------------------------------
// Node duplication
// ---------------------------------------------------------------------------

/**
 * Deep-clone a node subtree, assigning new IDs to all cloned nodes.
 * Inserts the clone immediately after the source node in the same parent.
 * Returns the ID of the new root clone node.
 */
export function duplicateNode(page: Page, nodeId: string): string {
  const idMap = new Map<string, string>() // old ID → new ID

  // Build id mapping for entire subtree
  const stack = [nodeId]
  const toClone: string[] = []
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = page.nodes[id]
    if (!node) continue
    toClone.push(id)
    idMap.set(id, nanoid())
    stack.push(...node.children)
  }

  // Clone all nodes with remapped IDs and children
  for (const id of toClone) {
    const original = page.nodes[id]
    const newId = idMap.get(id)!
    page.nodes[newId] = {
      ...original,
      id: newId,
      props: { ...original.props },
      breakpointOverrides: Object.fromEntries(
        Object.entries(original.breakpointOverrides).map(([k, v]) => [k, { ...v }])
      ),
      children: original.children.map((childId) => idMap.get(childId) ?? childId),
    }
  }

  // Insert the new root clone after the original in its parent
  const newRootId = idMap.get(nodeId)!
  const parent = getParent(page, nodeId)
  if (parent) {
    const idx = parent.children.indexOf(nodeId)
    parent.children.splice(idx + 1, 0, newRootId)
  }

  return newRootId
}

// ---------------------------------------------------------------------------
// Wrap / unwrap
// ---------------------------------------------------------------------------

/**
 * Wrap a node (and its position in the parent) inside a new container module.
 * The new container takes the node's position; the node becomes the container's first child.
 */
export function wrapNode(
  page: Page,
  nodeId: string,
  containerModuleId: string,
  containerDefaults: Record<string, unknown> = {}
): string {
  if (nodeId === page.rootNodeId) {
    throw new Error(`[PageTree] Cannot wrap the root node.`)
  }
  const parent = getParent(page, nodeId)
  if (!parent) throw new Error(`[PageTree] Node "${nodeId}" has no parent and cannot be wrapped.`)

  const wrapper = createNode(containerModuleId, containerDefaults)
  const idx = parent.children.indexOf(nodeId)

  // Insert wrapper at the node's position
  page.nodes[wrapper.id] = wrapper
  parent.children[idx] = wrapper.id

  // Make the original node the wrapper's first child
  wrapper.children.push(nodeId)

  return wrapper.id
}

// ---------------------------------------------------------------------------
// Page-level mutations (called on SiteDocument draft)
// ---------------------------------------------------------------------------

export function addPage(site: SiteDocument, title: string, slug: string): Page {
  const rootNode = createNode('base.root')
  const page: Page = {
    id: nanoid(),
    title,
    slug: normalizePageSlug(slug),
    rootNodeId: rootNode.id,
    nodes: { [rootNode.id]: rootNode },
  }
  site.pages.push(page)
  return page
}

export function deletePage(site: SiteDocument, pageId: string): void {
  if (site.pages.length <= 1) {
    throw new Error(`[PageTree] Cannot delete the last page in a site.`)
  }
  site.pages = site.pages.filter((p) => p.id !== pageId)
}

export function renamePage(site: SiteDocument, pageId: string, title: string, slug?: string): void {
  const page = site.pages.find((p) => p.id === pageId)
  if (!page) throw new Error(`[PageTree] Page "${pageId}" not found`)
  page.title = title
  if (slug !== undefined) page.slug = normalizePageSlug(slug)
}

export function reorderPages(site: SiteDocument, fromIndex: number, toIndex: number): void {
  const pages = site.pages
  const [moved] = pages.splice(fromIndex, 1)
  pages.splice(toIndex, 0, moved)
}
