import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Page } from '@core/page-tree/schemas'
import {
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
} from '@core/page-tree/slugs'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { useDialogEscape } from '@ui/lib/useDialogEscape'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from '../SiteCreateDialog/SiteCreateDialog.module.css'

export interface ExplorerRenamePayload {
  value: string
  slug?: string
}

interface ExplorerRenameDialogProps {
  title: string
  fieldLabel: 'Name' | 'Path'
  initialValue: string
  pages?: Page[]
  pageId?: string
  initialSlug?: string
  onCancel: () => void
  onRename: (payload: ExplorerRenamePayload) => void | Promise<void>
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message.replace(/^\[[^\]]+\]\s*/, '') : 'Unable to rename item'
}

export const ExplorerRenameDialog = memo(function ExplorerRenameDialog({
  title,
  fieldLabel,
  initialValue,
  pages = [],
  pageId,
  initialSlug,
  onCancel,
  onRename,
}: ExplorerRenameDialogProps) {
  const [value, setValue] = useState(initialValue)
  const [slug, setSlug] = useState(initialSlug ?? '')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmedValue = value.trim()
  const isPage = initialSlug !== undefined
  const pageSlug = normalizePageSlug(slug)
  const slugValidation = isPage
    ? pageSlugError(pageSlug) || pageSlugDuplicateError(pageSlug, pages, pageId)
    : null

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  useDialogEscape(onCancel)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedValue || slugValidation) return

    try {
      await onRename(isPage ? { value: trimmedValue, slug: pageSlug } : { value: trimmedValue })
    } catch (err) {
      setSubmitError(errorMessage(err))
    }
  }

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid="explorer-rename-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="explorer-rename-dialog-title"
        className={styles.dialog}
        data-testid="explorer-rename-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="explorer-rename-dialog-title" className={styles.title}>
            {title}
          </h2>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Close dialog"
            onClick={onCancel}
          >
            <CloseIcon size={12} color="currentColor" aria-hidden="true" />
          </Button>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>{fieldLabel}</span>
            <Input
              ref={inputRef}
              fieldSize="sm"
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
                setSubmitError(null)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          {isPage && (
            <label className={styles.field}>
              <span className={styles.label}>Slug</span>
              <Input
                fieldSize="sm"
                value={slug}
                onChange={(event) => {
                  setSlug(normalizePageSlug(event.target.value))
                  setSubmitError(null)
                }}
                autoComplete="off"
                spellCheck={false}
                invalid={Boolean(slugValidation)}
                aria-describedby={slugValidation ? 'explorer-rename-slug-error' : undefined}
              />
              {slugValidation && (
                <p id="explorer-rename-slug-error" role="alert" className={styles.errorText}>
                  {slugValidation}
                </p>
              )}
            </label>
          )}

          {submitError && (
            <p role="alert" className={styles.errorText}>
              {submitError}
            </p>
          )}

          <div className={styles.actions}>
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!trimmedValue || Boolean(slugValidation)}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
})
