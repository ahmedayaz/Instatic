/**
 * FontsSection — site fonts library shown at the top of the Typography panel.
 *
 * Lists every font installed on the site and lets the user add another from
 * Google's directory (custom uploads are a planned next step). All file work
 * happens on the server: this component only mutates `site.settings.fonts`
 * via the `addFont` / `removeFont` zustand actions and triggers the install /
 * uninstall HTTP endpoints.
 *
 * The section embeds into `FrameworkScalePanel` via the `extraSections` slot;
 * see `TypographyPanel.tsx` for the wiring.
 */

import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { useEditorStore } from '@core/editor-store/store'
import type { FontEntry } from '@core/page-tree/schemas'
import { compareVariants } from '@core/fonts/variants'
import { deleteCmsFontFamily } from '@core/persistence/cmsFonts'
import { DeleteIcon } from 'pixel-art-icons/icons/delete'
import { AddGoogleFontDialog } from './AddGoogleFontDialog'
import styles from './FontsSection.module.css'

const EMPTY_FONTS: FontEntry[] = []

export function FontsSection() {
  const fonts = useEditorStore((s) => s.site?.settings.fonts?.items ?? EMPTY_FONTS)
  const addFont = useEditorStore((s) => s.addFont)
  const removeFont = useEditorStore((s) => s.removeFont)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const installedFamiliesLower = useMemo(
    () => new Set(fonts.map((f) => f.family.toLowerCase())),
    [fonts],
  )

  async function handleRemove(entry: FontEntry) {
    setActionError(null)
    // Optimistically drop the entry from the library — the on-disk woff2 files
    // are best-effort to delete; a stale folder is harmless and gets pruned on
    // the next install of the same family.
    removeFont(entry.id)
    if (entry.source === 'google') {
      try {
        await deleteCmsFontFamily(entry.family)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not delete font files')
      }
    }
  }

  return (
    <div className={styles.section}>
      {fonts.length === 0 ? (
        <p className={styles.empty}>
          No fonts installed yet. Add a Google font to use it in the canvas and
          published pages.
        </p>
      ) : (
        <ul className={styles.list} role="list" aria-label="Installed fonts">
          {fonts.map((entry) => (
            <FontRow
              key={entry.id}
              entry={entry}
              onRemove={() => { void handleRemove(entry) }}
            />
          ))}
        </ul>
      )}

      <div className={styles.addRow}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => setDialogOpen(true)}
        >
          Add Google font
        </Button>
      </div>

      {actionError && (
        <p role="alert" className={styles.errorAlert}>{actionError}</p>
      )}

      {dialogOpen && (
        <AddGoogleFontDialog
          installedFamilies={installedFamiliesLower}
          onCancel={() => setDialogOpen(false)}
          onInstalled={(entry) => {
            addFont(entry)
            setDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

interface FontRowProps {
  entry: FontEntry
  onRemove: () => void
}

function FontRow({ entry, onRemove }: FontRowProps) {
  const variantSummary = useMemo(() => {
    const variants = [...entry.variants].sort(compareVariants)
    if (variants.length === 0) return ''
    if (variants.length <= 3) return variants.join(', ')
    return `${variants.slice(0, 3).join(', ')}, +${variants.length - 3}`
  }, [entry.variants])

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span
          className={styles.rowFamily}
          style={{ fontFamily: `"${entry.family}", system-ui, sans-serif` } as CSSProperties}
        >
          {entry.family}
        </span>
        <span className={styles.rowMeta}>
          {entry.source === 'google' ? 'Google' : 'Custom'}
          {variantSummary && ` · ${variantSummary}`}
          {entry.subsets.length > 0 && ` · ${entry.subsets.length} subset${entry.subsets.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className={styles.rowActions}>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Remove ${entry.family}`}
          tooltip={`Remove ${entry.family}`}
          onClick={onRemove}
        >
          <DeleteIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}
