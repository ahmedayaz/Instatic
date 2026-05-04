import type { Page } from '@core/page-tree/schemas'
import { getParent, isAncestor } from '@core/page-tree/selectors'

type DomDropPosition = 'before' | 'after' | 'inside'
type DomDropZone = DomDropPosition

export interface DomDropTarget {
  draggedId: string
  parentId: string
  index: number
  position: DomDropPosition
  slot: 'default'
  overId: string
}

interface DomDropRowRect {
  top: number
  bottom: number
  height: number
}

export interface DomDropRowMeta {
  nodeId: string
  rect: DomDropRowRect
}

interface ResolveDomDropTargetInput {
  page: Page
  draggedId: string
  overId: string
  zone: DomDropZone
  canHaveChildren: (moduleId: string) => boolean
}

const MIN_EDGE_HIT_ZONE = 8
const MAX_EDGE_HIT_ZONE = 12
const EDGE_ZONE_RATIO = 0.3

export function getDomDropZone(rect: DomDropRowRect, pointerY: number): DomDropZone {
  const edgeBand = Math.max(
    MIN_EDGE_HIT_ZONE,
    Math.min(MAX_EDGE_HIT_ZONE, rect.height * EDGE_ZONE_RATIO),
  )
  const offset = pointerY - rect.top

  if (offset <= edgeBand) return 'before'
  if (offset >= rect.height - edgeBand) return 'after'
  return 'inside'
}

export function findDomDropRow(rows: DomDropRowMeta[], pointerY: number): DomDropRowMeta | null {
  for (const row of rows) {
    if (pointerY >= row.rect.top && pointerY <= row.rect.bottom) return row
  }
  return null
}

export function resolveDomDropTarget({
  page,
  draggedId,
  overId,
  zone,
  canHaveChildren,
}: ResolveDomDropTargetInput): DomDropTarget | null {
  const dragged = page.nodes[draggedId]
  const over = page.nodes[overId]
  if (!dragged || !over) return null
  if (draggedId === page.rootNodeId) return null
  if (dragged.locked) return null
  if (draggedId === overId) return null

  if (zone === 'inside') {
    if (!canHaveChildren(over.moduleId)) return null
    if (over.locked) return null
    if (isAncestor(page, draggedId, overId)) return null

    const index = normalizeIndexAfterRemoval(page, draggedId, overId, over.children.length)
    return noOpTarget(page, draggedId, overId, index)
      ? null
      : {
          draggedId,
          parentId: overId,
          index,
          position: 'inside',
          slot: 'default',
          overId,
        }
  }

  if (overId === page.rootNodeId) return null
  const parent = getParent(page, overId)
  if (!parent) return null
  if (parent.locked) return null
  if (isAncestor(page, draggedId, parent.id)) return null

  const overIndex = parent.children.indexOf(overId)
  if (overIndex === -1) return null

  const rawIndex = zone === 'before' ? overIndex : overIndex + 1
  const index = normalizeIndexAfterRemoval(page, draggedId, parent.id, rawIndex)

  return noOpTarget(page, draggedId, parent.id, index)
    ? null
    : {
        draggedId,
        parentId: parent.id,
        index,
        position: zone,
        slot: 'default',
        overId,
      }
}

function normalizeIndexAfterRemoval(
  page: Page,
  draggedId: string,
  parentId: string,
  rawIndex: number,
): number {
  const currentParent = getParent(page, draggedId)
  if (!currentParent || currentParent.id !== parentId) return rawIndex

  const currentIndex = currentParent.children.indexOf(draggedId)
  if (currentIndex === -1 || currentIndex >= rawIndex) return rawIndex
  return rawIndex - 1
}

function noOpTarget(page: Page, draggedId: string, parentId: string, index: number): boolean {
  const currentParent = getParent(page, draggedId)
  if (!currentParent || currentParent.id !== parentId) return false
  return currentParent.children.indexOf(draggedId) === index
}
