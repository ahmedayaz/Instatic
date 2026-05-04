import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Page } from '@core/page-tree/schemas'
import {
  createUniquePageSlug,
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
} from '@core/page-tree/slugs'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import type { SiteCreateKind } from './siteItemNames'
import styles from './SiteCreateDialog.module.css'

export type { SiteCreateKind } from './siteItemNames'

export interface SiteCreatePayload {
  name: string
  slug?: string
}

interface SiteCreateDialogProps {
  kind: SiteCreateKind
  pages?: Page[]
  onCancel: () => void
  onCreate: (payload: SiteCreatePayload) => void
}

const COPY: Record<SiteCreateKind, { title: string; placeholder: string }> = {
  page: { title: 'New page', placeholder: 'About' },
  component: { title: 'New component', placeholder: 'Hero card' },
  style: { title: 'New stylesheet', placeholder: 'theme' },
  script: { title: 'New script', placeholder: 'analytics' },
}

export const SiteCreateDialog = memo(function SiteCreateDialog({
  kind,
  pages = [],
  onCancel,
  onCreate,
}: SiteCreateDialogProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const copy = COPY[kind]
  const trimmedName = name.trim()
  const isPage = kind === 'page'
  const generatedSlug = isPage && trimmedName ? createUniquePageSlug(trimmedName, pages) : ''
  const pageSlug = slugTouched ? slug : generatedSlug
  const slugError = isPage && trimmedName
    ? pageSlugError(pageSlug) || pageSlugDuplicateError(pageSlug, pages)
    : null

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedName) return
    if (slugError) return
    onCreate(isPage ? { name: trimmedName, slug: pageSlug } : { name: trimmedName })
  }

  return createPortal(
    <div
      className={styles.backdrop}
      data-testid="site-create-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-create-dialog-title"
        className={styles.dialog}
        data-testid="site-create-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="site-create-dialog-title" className={styles.title}>
            {copy.title}
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
            <span className={styles.label}>Name</span>
            <Input
              ref={inputRef}
              fieldSize="sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={copy.placeholder}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          {isPage && (
            <label className={styles.field}>
              <span className={styles.label}>Slug</span>
              <Input
                fieldSize="sm"
                value={pageSlug}
                onChange={(event) => {
                  setSlugTouched(true)
                  setSlug(normalizePageSlug(event.target.value))
                }}
                placeholder="about"
                autoComplete="off"
                spellCheck={false}
                invalid={Boolean(slugError)}
                aria-describedby={slugError ? 'site-create-slug-error' : undefined}
              />
              {slugError && (
                <p id="site-create-slug-error" role="alert" className={styles.errorText}>
                  {slugError}
                </p>
              )}
            </label>
          )}

          <div className={styles.actions}>
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!trimmedName || Boolean(slugError)}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
})
