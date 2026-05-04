import type { CSSClass } from './schemas'

function isNodeScopedClass(cls: CSSClass | null | undefined, nodeId?: string): boolean {
  if (cls?.scope?.type !== 'node') return false
  return nodeId ? cls.scope.nodeId === nodeId : true
}

export function isUserVisibleClass(cls: CSSClass | null | undefined): boolean {
  return !isNodeScopedClass(cls)
}

export function isGeneratedClass(cls: CSSClass | null | undefined): boolean {
  return cls?.generated?.origin === 'framework'
}

export function isGeneratedClassLocked(cls: CSSClass | null | undefined): boolean {
  return cls?.generated?.locked === true
}

export function generatedClassKindLabel(cls: CSSClass | null | undefined): string | null {
  if (!isGeneratedClass(cls)) return null
  return 'Utility'
}
