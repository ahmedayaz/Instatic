import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Input } from '@ui/components/Input'
import { useDialogEscape } from '@ui/lib/useDialogEscape'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import type { CreateContentCollectionInput } from '@core/content/schemas'
import dialogStyles from '@editor/components/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from '../../ContentPage.module.css'
import { slugFromTitle } from '@core/utils/slug'

interface ContentCollectionCreateDialogProps {
  onCancel: () => void
  onCreate: (input: CreateContentCollectionInput) => void | Promise<void>
}

function singularFromPlural(value: string): string {
  return value.replace(/s$/i, '') || value
}

function normalizeRouteBase(value: string): string {
  const slug = slugFromTitle(value)
  return `/${slug}`
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message.replace(/^\[[^\]]+\]\s*/, '') : 'Could not create collection'
}

export const ContentCollectionCreateDialog = memo(function ContentCollectionCreateDialog({
  onCancel,
  onCreate,
}: ContentCollectionCreateDialogProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [routeBase, setRouteBase] = useState('')
  const [routeTouched, setRouteTouched] = useState(false)
  const [singularLabel, setSingularLabel] = useState('')
  const [singularTouched, setSingularTouched] = useState(false)
  const [pluralLabel, setPluralLabel] = useState('')
  const [pluralTouched, setPluralTouched] = useState(false)
  const [bodyField, setBodyField] = useState(true)
  const [featuredMediaField, setFeaturedMediaField] = useState(true)
  const [seoField, setSeoField] = useState(true)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmedName = name.trim()
  const displayedPluralLabel = pluralTouched ? pluralLabel : trimmedName
  const trimmedPluralLabel = displayedPluralLabel.trim()
  const displayedSingularLabel = singularTouched
    ? singularLabel
    : singularFromPlural(trimmedPluralLabel)
  const trimmedSingularLabel = displayedSingularLabel.trim()
  const displayedSlug = slugTouched ? slug : (trimmedName ? slugFromTitle(trimmedName) : '')
  const normalizedSlug = slugFromTitle(displayedSlug || trimmedName)
  const effectiveRouteBase = routeTouched ? normalizeRouteBase(routeBase) : normalizeRouteBase(normalizedSlug)
  const canCreate = Boolean(trimmedName && trimmedSingularLabel && trimmedPluralLabel)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useDialogEscape(onCancel)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canCreate) return

    try {
      await onCreate({
        name: trimmedName,
        slug: normalizedSlug,
        routeBase: effectiveRouteBase,
        singularLabel: trimmedSingularLabel,
        pluralLabel: trimmedPluralLabel,
        fields: {
          builtIn: {
            body: bodyField,
            featuredMedia: featuredMediaField,
            seo: seoField,
          },
          custom: [],
        },
      })
    } catch (err) {
      setSubmitError(errorMessage(err))
    }
  }

  return createPortal(
    <div
      className={dialogStyles.backdrop}
      data-testid="content-collection-create-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-collection-create-dialog-title"
        className={dialogStyles.dialog}
        data-testid="content-collection-create-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={dialogStyles.header}>
          <h2 id="content-collection-create-dialog-title" className={dialogStyles.title}>
            New collection
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
            <span className={dialogStyles.label}>Name</span>
            <Input
              ref={inputRef}
              fieldSize="sm"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setSubmitError(null)
              }}
              placeholder="Products"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Slug</span>
            <Input
              fieldSize="sm"
              value={displayedSlug}
              onChange={(event) => {
                setSlugTouched(true)
                setSlug(slugFromTitle(event.target.value))
                setSubmitError(null)
              }}
              placeholder="products"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>URL path</span>
            <Input
              fieldSize="sm"
              value={effectiveRouteBase}
              onChange={(event) => {
                setRouteTouched(true)
                setRouteBase(event.target.value)
                setSubmitError(null)
              }}
              placeholder="/products"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Singular label</span>
            <Input
              fieldSize="sm"
              value={displayedSingularLabel}
              onChange={(event) => {
                setSingularTouched(true)
                setSingularLabel(event.target.value)
                setSubmitError(null)
              }}
              placeholder="Product"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Plural label</span>
            <Input
              fieldSize="sm"
              value={displayedPluralLabel}
              onChange={(event) => {
                setPluralTouched(true)
                setPluralLabel(event.target.value)
                setSubmitError(null)
              }}
              placeholder="Products"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <fieldset className={styles.collectionFields}>
            <legend>Fields</legend>
            <label>
              <Checkbox
                checked={bodyField}
                onCheckedChange={setBodyField}
              />
              <span>Body</span>
            </label>
            <label>
              <Checkbox
                checked={featuredMediaField}
                onCheckedChange={setFeaturedMediaField}
              />
              <span>Featured media</span>
            </label>
            <label>
              <Checkbox
                checked={seoField}
                onCheckedChange={setSeoField}
              />
              <span>SEO fields</span>
            </label>
          </fieldset>

          {submitError && (
            <p role="alert" className={dialogStyles.errorText}>
              {submitError}
            </p>
          )}

          <div className={dialogStyles.actions}>
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!canCreate}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
})
