/**
 * SelectorHeader — global class selector name (e.g. `.button-primary`) with
 * inline rename, rendered inside the Properties panel header when the user
 * has selected a class via the Selectors panel.
 *
 * Renaming a class is a style edit — the pencil button is hidden for callers
 * without `site.style.edit`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import type { CSSClass } from '@core/page-tree/schemas'
import styles from './PropertiesPanel.module.css'

interface SelectorHeaderProps {
  cls: CSSClass
  onRename: (name: string) => void
}

export function SelectorHeader({ cls, onRename }: SelectorHeaderProps) {
  const [isEditing, setIsEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectorLabel = `.${cls.name}`
  // Renaming a class is a style edit — gate on `site.style.edit`.
  const canRename = useEditorPermissions().canEditStyle

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.value = selectorLabel
    }
  }, [cls.id, selectorLabel, isEditing])

  useEffect(() => {
    if (!isEditing) return
    requestAnimationFrame(() => inputRef.current?.select())
  }, [isEditing])

  const commitRename = useCallback((input: HTMLInputElement) => {
    const rawName = input.value.trim()
    const nextName = (rawName.startsWith('.') ? rawName.slice(1) : rawName).trim()
    if (nextName && nextName !== cls.name) {
      try {
        onRename(nextName)
      } catch {
        input.value = selectorLabel
      }
    } else {
      input.value = selectorLabel
    }
    setIsEditing(false)
  }, [cls.name, onRename, selectorLabel])

  const cancelRename = useCallback((input: HTMLInputElement) => {
    input.value = selectorLabel
    setIsEditing(false)
  }, [selectorLabel])

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        type="text"
        fieldSize="xs"
        emphasis="strong"
        defaultValue={selectorLabel}
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
        aria-label="Class name"
        className={styles.headerNameInput}
      />
    )
  }

  return (
    <div className={styles.headerNodeTitle}>
      <span className={styles.headerNodeLabel} title={selectorLabel} role="heading" aria-level={2}>{selectorLabel}</span>
      {canRename && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => setIsEditing(true)}
          aria-label={`Rename selector ${selectorLabel}`}
          tooltip="Rename selector"
        >
          <EditSolidIcon size={12} aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
