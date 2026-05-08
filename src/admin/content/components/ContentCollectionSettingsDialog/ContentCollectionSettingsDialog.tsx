import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { normalizeContentCollectionFields } from '@core/content/fields'
import type { ContentCollection, UpdateContentCollectionInput } from '@core/content/schemas'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Input } from '@ui/components/Input'
import { useDialogEscape } from '@ui/lib/useDialogEscape'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import dialogStyles from '@editor/components/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from '../../ContentPage.module.css'
import { slugFromTitle } from '@core/utils/slug'

interface ContentCollectionSettingsDialogProps {
  collection: ContentCollection
  onCancel: () => void
  onSave: (input: UpdateContentCollectionInput) => void | Promise<void>
}

function normalizeRouteBase(value: string): string {
  const slug = slugFromTitle(value)
  return `/${slug}`
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message.replace(/^\[[^\]]+\]\s*/, '') : 'Could not update collection'
}

export const ContentCollectionSettingsDialog = memo(function ContentCollectionSettingsDialog({
  collection,
  onCancel,
  onSave,
}: ContentCollectionSettingsDialogProps) {
  const fields = normalizeContentCollectionFields(collection.fields)
  const [name, setName] = useState(collection.name)
  const [slug, setSlug] = useState(collection.slug)
  const [routeBase, setRouteBase] = useState(collection.routeBase)
  const [singularLabel, setSingularLabel] = useState(collection.singularLabel)
  const [pluralLabel, setPluralLabel] = useState(collection.pluralLabel)
  const [bodyField, setBodyField] = useState(fields.builtIn.body)
  const [featuredMediaField, setFeaturedMediaField] = useState(fields.builtIn.featuredMedia)
  const [seoField, setSeoField] = useState(fields.builtIn.seo)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmedName = name.trim()
  const trimmedSingular = singularLabel.trim()
  const trimmedPlural = pluralLabel.trim()
  const normalizedSlug = slugFromTitle(slug || trimmedName)
  const normalizedRouteBase = normalizeRouteBase(routeBase || normalizedSlug)
  const canSave = Boolean(trimmedName && trimmedSingular && trimmedPlural)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  useDialogEscape(onCancel)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return

    try {
      await onSave({
        name: trimmedName,
        slug: normalizedSlug,
        routeBase: normalizedRouteBase,
        singularLabel: trimmedSingular,
        pluralLabel: trimmedPlural,
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
      data-testid="content-collection-settings-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-collection-settings-dialog-title"
        className={dialogStyles.dialog}
        data-testid="content-collection-settings-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={dialogStyles.header}>
          <h2 id="content-collection-settings-dialog-title" className={dialogStyles.title}>
            Collection settings
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

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>URL path</span>
            <Input
              fieldSize="sm"
              value={routeBase}
              onChange={(event) => {
                setRouteBase(event.target.value)
                setSubmitError(null)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Singular label</span>
            <Input
              fieldSize="sm"
              value={singularLabel}
              onChange={(event) => {
                setSingularLabel(event.target.value)
                setSubmitError(null)
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Plural label</span>
            <Input
              fieldSize="sm"
              value={pluralLabel}
              onChange={(event) => {
                setPluralLabel(event.target.value)
                setSubmitError(null)
              }}
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
            <Button variant="primary" size="sm" type="submit" disabled={!canSave}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
})
