/**
 * NodeHeader — selected element name with inline rename, rendered inside the
 * Properties panel header (Guideline #221).
 *
 * Renaming a node mutates `node.label`, which is a structural change — the
 * pencil button is hidden for callers without `site.structure.edit`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import styles from './PropertiesPanel.module.css'

interface NodeHeaderProps {
  nodeId: string
  label: string | undefined
  moduleName: string
  onRename: (label: string) => void
}

export function NodeHeader({ nodeId, label, moduleName, onRename }: NodeHeaderProps) {
  const [isEditing, setIsEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const displayName = label ?? moduleName
  // Renaming a node mutates `node.label` — a structural change, not content.
  const canRename = useEditorPermissions().canEditStructure

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.value = displayName
    }
  }, [nodeId, displayName, isEditing])

  useEffect(() => {
    if (!isEditing) return
    requestAnimationFrame(() => inputRef.current?.select())
  }, [isEditing])

  const commitRename = useCallback((input: HTMLInputElement) => {
    const nextLabel = input.value.trim()
    if (nextLabel && nextLabel !== displayName) {
      onRename(nextLabel)
    } else {
      input.value = displayName
    }
    setIsEditing(false)
  }, [displayName, onRename])

  const cancelRename = useCallback((input: HTMLInputElement) => {
    input.value = displayName
    setIsEditing(false)
  }, [displayName])

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        type="text"
        fieldSize="xs"
        emphasis="strong"
        defaultValue={displayName}
        onBlur={(e) => commitRename(e.target)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            cancelRename(e.target as HTMLInputElement)
          }
        }}
        aria-label="Element name"
        className={styles.headerNameInput}
      />
    )
  }

  return (
    <div className={styles.headerNodeTitle}>
      <span className={styles.headerNodeLabel} title={displayName}>{displayName}</span>
      {canRename && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => setIsEditing(true)}
          aria-label={`Rename ${displayName}`}
          tooltip="Rename element"
        >
          <EditSolidIcon size={12} aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
