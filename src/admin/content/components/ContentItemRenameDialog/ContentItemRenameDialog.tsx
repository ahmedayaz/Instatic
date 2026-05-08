import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { useDialogEscape } from '@ui/lib/useDialogEscape'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import dialogStyles from '@editor/components/SiteCreateDialog/SiteCreateDialog.module.css'
import { slugFromTitle } from '@core/utils/slug'

export interface ContentItemRenamePayload {
  title: string
  slug: string
}

interface ContentItemRenameDialogProps {
  title: string
  titleLabel: string
  initialTitle: string
  initialSlug: string
  onCancel: () => void
  onRename: (payload: ContentItemRenamePayload) => void | Promise<void>
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message.replace(/^\[[^\]]+\]\s*/, '') : 'Unable to rename item'
}

export const ContentItemRenameDialog = memo(function ContentItemRenameDialog({
  title,
  titleLabel,
  initialTitle,
  initialSlug,
  onCancel,
  onRename,
}: ContentItemRenameDialogProps) {
  const [value, setValue] = useState(initialTitle)
  const [slug, setSlug] = useState(initialSlug)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmedValue = value.trim()
  const normalizedSlug = slugFromTitle(slug || trimmedValue)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  useDialogEscape(onCancel)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedValue) return

    try {
      await onRename({ title: trimmedValue, slug: normalizedSlug })
    } catch (err) {
      setSubmitError(errorMessage(err))
    }
  }

  return createPortal(
    <div
      className={dialogStyles.backdrop}
      data-testid="content-item-rename-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-item-rename-dialog-title"
        className={dialogStyles.dialog}
        data-testid="content-item-rename-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={dialogStyles.header}>
          <h2 id="content-item-rename-dialog-title" className={dialogStyles.title}>
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

        <form className={dialogStyles.form} onSubmit={handleSubmit}>
          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>{titleLabel}</span>
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

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Slug</span>
            <Input
              fieldSize="sm"
              value={slug}
              onChange={(event) => {
                setSlug(slugFromTitle(event.target.value))
                setSubmitError(null)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          {submitError && (
            <p role="alert" className={dialogStyles.errorText}>
              {submitError}
            </p>
          )}

          <div className={dialogStyles.actions}>
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!trimmedValue}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
})
