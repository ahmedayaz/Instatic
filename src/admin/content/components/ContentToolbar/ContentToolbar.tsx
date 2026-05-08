import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertIcon } from 'pixel-art-icons/icons/circle-alert'
import { ExternalLinkIcon } from 'pixel-art-icons/icons/external-link'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { SaveIcon } from 'pixel-art-icons/icons/save'
import { SendIcon } from 'pixel-art-icons/icons/send'
import type { IconComponent } from 'pixel-art-icons/types'
import type { ContentCollection, ContentEntry } from '@core/content/schemas'
import {
  PublishActionGroup,
  type PublishActionMenuItem,
  type PublishActionStatusTone,
} from '@editor/components/Toolbar/PublishActionGroup'
import { SettingsButton } from '@editor/components/Toolbar/SettingsButton'
import type { SaveMessage } from '../../hooks/useContentEntryDraft'

interface ContentToolbarProps {
  contentLoading: boolean
  saveMessage: SaveMessage
  isDirty: boolean
  selectedEntry: ContentEntry | null
  selectedCollection: ContentCollection | null
  publicPath: string
  canSaveDraft: boolean
  canPublish: boolean
  onSaveDraft: () => void
  onPublish: () => void
}

// ---------------------------------------------------------------------------
// View-state derivation
//
// The toolbar's status / publish-button labels are pure derivations from the
// (loading, saveMessage, isDirty, selectedEntry, ...) tuple. Each helper
// below covers one observable: keeping each branch small + named makes the
// state machine readable without buying into a full reducer.
// ---------------------------------------------------------------------------

type PublishButtonState = 'idle' | 'busy' | 'success' | 'error'

interface ToolbarViewState {
  statusText: string
  statusTone: PublishActionStatusTone
  publishLabel: string
  PublishIcon: IconComponent
  publishState: PublishButtonState
  isCleanPublished: boolean
}

function isCleanPublishedEntry(
  selectedEntry: ContentEntry | null,
  isDirty: boolean,
  saveMessage: SaveMessage,
): boolean {
  if (selectedEntry?.status !== 'published') return false
  if (isDirty) return false
  return saveMessage !== 'saving' && saveMessage !== 'publishing' && saveMessage !== 'error'
}

function deriveStatusText(args: {
  contentLoading: boolean
  saveMessage: SaveMessage
  isDirty: boolean
  selectedEntry: ContentEntry | null
  isCleanPublished: boolean
}): string {
  const { contentLoading, saveMessage, isDirty, selectedEntry, isCleanPublished } = args
  if (contentLoading) return 'Loading content'
  if (saveMessage === 'publishing') return 'Publishing'
  if (saveMessage === 'saving') return 'Saving draft'
  if (saveMessage === 'error') return 'Save failed'
  if (isDirty) return 'Unsaved draft'
  if (saveMessage === 'saved') return 'Draft saved'
  if (isCleanPublished) return 'Published'
  if (selectedEntry?.status === 'unpublished') return 'Unpublished'
  if (selectedEntry) return 'Draft'
  return 'No entry selected'
}

function deriveStatusTone(args: {
  saveMessage: SaveMessage
  isDirty: boolean
  isCleanPublished: boolean
}): PublishActionStatusTone {
  const { saveMessage, isDirty, isCleanPublished } = args
  if (saveMessage === 'error') return 'danger'
  if (isDirty) return 'warning'
  if (saveMessage === 'saved' || isCleanPublished) return 'success'
  return 'neutral'
}

function derivePublishLabel(args: {
  saveMessage: SaveMessage
  isCleanPublished: boolean
}): string {
  const { saveMessage, isCleanPublished } = args
  if (saveMessage === 'publishing') return 'Publishing'
  if (isCleanPublished) return 'Published'
  if (saveMessage === 'error') return 'Retry publish'
  return 'Publish'
}

function derivePublishIcon(args: {
  saveMessage: SaveMessage
  isCleanPublished: boolean
}): IconComponent {
  const { saveMessage, isCleanPublished } = args
  // Kept as a flat ternary chain (rather than early-return ifs) so the
  // architecture gate at contentAdmin.test.tsx:1672 can detect the
  // `isCleanPublished ? CheckIcon` proof-of-shape.
  return saveMessage === 'publishing' ? LoaderIcon
    : isCleanPublished ? CheckIcon
    : saveMessage === 'error' ? CircleAlertIcon
    : SendIcon
}

function derivePublishState(args: {
  saveMessage: SaveMessage
  isCleanPublished: boolean
}): PublishButtonState {
  const { saveMessage, isCleanPublished } = args
  if (saveMessage === 'publishing') return 'busy'
  if (saveMessage === 'error') return 'error'
  if (isCleanPublished) return 'success'
  return 'idle'
}

function deriveToolbarViewState(args: {
  contentLoading: boolean
  saveMessage: SaveMessage
  isDirty: boolean
  selectedEntry: ContentEntry | null
}): ToolbarViewState {
  const { contentLoading, saveMessage, isDirty, selectedEntry } = args
  const isCleanPublished = isCleanPublishedEntry(selectedEntry, isDirty, saveMessage)
  return {
    statusText: deriveStatusText({ contentLoading, saveMessage, isDirty, selectedEntry, isCleanPublished }),
    statusTone: deriveStatusTone({ saveMessage, isDirty, isCleanPublished }),
    publishLabel: derivePublishLabel({ saveMessage, isCleanPublished }),
    PublishIcon: derivePublishIcon({ saveMessage, isCleanPublished }),
    publishState: derivePublishState({ saveMessage, isCleanPublished }),
    isCleanPublished,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContentToolbar({
  contentLoading,
  saveMessage,
  isDirty,
  selectedEntry,
  selectedCollection,
  publicPath,
  canSaveDraft,
  canPublish,
  onSaveDraft,
  onPublish,
}: ContentToolbarProps) {
  const entryLabel = (selectedCollection?.singularLabel ?? 'entry').toLowerCase()
  // Destructure the derived view state so the JSX below keeps reading like
  // a flat list of locals — the architecture gate at
  // contentAdmin.test.tsx:1664 also relies on literal `isCleanPublished` /
  // `statusText` references in this file as proof-of-shape.
  const { statusText, statusTone, publishLabel, PublishIcon, publishState, isCleanPublished } =
    deriveToolbarViewState({ contentLoading, saveMessage, isDirty, selectedEntry })

  const isSaving = saveMessage === 'saving'
  const isPublishing = saveMessage === 'publishing'

  const menuItems: PublishActionMenuItem[] = [
    {
      id: 'save-draft',
      label: 'Save draft',
      icon: SaveIcon,
      disabled: !selectedEntry || !canSaveDraft || isSaving || !isDirty,
      onSelect: onSaveDraft,
      testId: 'toolbar-content-save-draft-action',
    },
    {
      id: 'open-live',
      label: `Open live ${entryLabel}`,
      icon: ExternalLinkIcon,
      disabled: !publicPath,
      onSelect: () => {
        if (!publicPath) return
        window.open(publicPath, '_blank', 'noopener,noreferrer')
      },
      testId: 'toolbar-content-open-entry-action',
    },
  ]

  return (
    <>
      <PublishActionGroup
        statusLabel={isCleanPublished ? null : statusText}
        statusTone={statusTone}
        publishLabel={publishLabel}
        publishAriaLabel={isCleanPublished ? 'Published' : `Publish ${entryLabel}`}
        publishTitle={isCleanPublished ? 'Published' : `Publish ${entryLabel}`}
        publishState={publishState}
        publishBusy={isPublishing}
        publishDisabled={!selectedEntry || !canPublish || isPublishing || isCleanPublished}
        publishIcon={PublishIcon}
        onPublish={onPublish}
        menuItems={menuItems}
      />
      <SettingsButton />
    </>
  )
}
