import type { Page, PageNode } from './schemas'

/**
 * Pure selector functions for the page tree.
 * No side effects — safe to call in Zustand selectors, unit tests, and React renders.
 * All lookups are O(1) because the flat map structure is Page.nodes: Record<string, PageNode>.
 */

// ---------------------------------------------------------------------------
// Node access
// ---------------------------------------------------------------------------

/** Get a node by ID — O(1). Returns undefined if not found. */
export function getNode(page: Page, id: string): PageNode | undefined {
  return page.nodes[id]
}

/** Get a node by ID, throwing if not found. */
export function getNodeOrThrow(page: Page, id: string): PageNode {
  const node = page.nodes[id]
  if (!node) throw new Error(`[PageTree] Node "${id}" not found in page "${page.id}"`)
  return node
}

/** Get all direct children of a node as PageNode objects. */
export function getChildren(page: Page, nodeId: string): PageNode[] {
  const node = page.nodes[nodeId]
  if (!node) return []
  return node.children
    .map((id) => page.nodes[id])
    .filter((n): n is PageNode => n !== undefined)
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Find the parent of a node.
 * O(n) — use sparingly on hot paths (prefer caching or denormalising parentId if needed).
 */
export function getParent(page: Page, nodeId: string): PageNode | undefined {
  for (const node of Object.values(page.nodes)) {
    if (node.children.includes(nodeId)) return node
  }
  return undefined
}

/** Get ordered ancestor chain from root down to (but not including) nodeId. */
export function getAncestors(page: Page, nodeId: string): PageNode[] {
  const ancestors: PageNode[] = []
  let current = nodeId
  const visited = new Set<string>()

  while (true) {
    if (visited.has(current)) break // cycle guard
    visited.add(current)
    const parent = getParent(page, current)
    if (!parent) break
    ancestors.unshift(parent)
    current = parent.id
  }
  return ancestors
}

/**
 * Return all node IDs in depth-first pre-order starting at nodeId.
 * Useful for virtual-scroll flattening in the DOM tree panel.
 */
export function flattenSubtree(page: Page, nodeId: string): string[] {
  const result: string[] = []
  const stack: string[] = [nodeId]
  const visited = new Set<string>()

  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = page.nodes[id]
    if (!node) continue
    result.push(id)
    // Push children in reverse so leftmost child is processed first (stack is LIFO)
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i])
    }
  }
  return result
}

/**
 * Check whether ancestorId is an ancestor of nodeId.
 * Used to prevent illegal moves in drag-to-reorder (cannot drop a node inside itself).
 */
export function isAncestor(page: Page, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true
  let current = nodeId
  const visited = new Set<string>()
  while (true) {
    if (visited.has(current)) return false
    visited.add(current)
    const parent = getParent(page, current)
    if (!parent) return false
    if (parent.id === ancestorId) return true
    current = parent.id
  }
}

// ---------------------------------------------------------------------------
// Props resolution
// ---------------------------------------------------------------------------

/**
 * Resolve props for a node at a given breakpoint.
 * Breakpoint overrides shallow-merge on top of base props.
 * Returns base props unchanged if no breakpointId is provided.
 */
export function resolveProps(
  node: PageNode,
  breakpointId?: string
): Record<string, unknown> {
  if (!breakpointId) return node.props
  const override = node.breakpointOverrides[breakpointId]
  if (!override || Object.keys(override).length === 0) return node.props
  return { ...node.props, ...override }
}

// ---------------------------------------------------------------------------
// Property condition evaluation
// ---------------------------------------------------------------------------

import type { PropertyCondition } from '../module-engine/types'

/**
 * Evaluate a declarative PropertyCondition against a props object.
 * Used by the Properties Panel to show/hide controls.
 * Constraint #212: conditions are declarative objects, never functions.
 */
export function evaluateCondition(
  condition: PropertyCondition,
  props: Record<string, unknown>
): boolean {
  if ('and' in condition) {
    return condition.and.every((c) => evaluateCondition(c, props))
  }
  if ('or' in condition) {
    return condition.or.some((c) => evaluateCondition(c, props))
  }
  if ('eq' in condition) {
    return props[condition.field] === condition.eq
  }
  if ('notEq' in condition) {
    return props[condition.field] !== condition.notEq
  }
  if ('in' in condition) {
    return (condition as { field: string; in: unknown[] }).in.includes(props[condition.field])
  }
  if ('notIn' in condition) {
    return !(condition as { field: string; notIn: unknown[] }).notIn.includes(props[condition.field])
  }
  return true
}
