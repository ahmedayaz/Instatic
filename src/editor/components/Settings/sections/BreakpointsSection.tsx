/**
 * BreakpointsSection — add / edit / remove canvas breakpoints.
 *
 * Changes reflect on the canvas immediately because CanvasRoot reads
 * `site.breakpoints` from the store.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { SmartphoneIcon } from 'pixel-art-icons/icons/smartphone'
import { TabletIcon } from 'pixel-art-icons/icons/tablet'
import { MonitorIcon } from 'pixel-art-icons/icons/monitor'
import { LaptopIcon } from 'pixel-art-icons/icons/laptop'
import { TvIcon } from 'pixel-art-icons/icons/tv'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import type { Breakpoint } from '@core/page-tree/schemas'
import s from '../Settings.module.css'

const ICON_OPTIONS = [
  { value: 'smartphone', label: 'Smartphone', icon: <SmartphoneIcon size={13} /> },
  { value: 'tablet', label: 'Tablet', icon: <TabletIcon size={13} /> },
  { value: 'monitor', label: 'Monitor', icon: <MonitorIcon size={13} /> },
  { value: 'laptop', label: 'Laptop', icon: <LaptopIcon size={13} /> },
  { value: 'tv', label: 'TV', icon: <TvIcon size={13} /> },
]

export function BreakpointsSection() {
  const site = useEditorStore((state) => state.site)
  const addBreakpoint = useEditorStore((state) => state.addBreakpoint)
  const updateBreakpoint = useEditorStore((state) => state.updateBreakpoint)
  const removeBreakpoint = useEditorStore((state) => state.removeBreakpoint)
  const setActiveBreakpoint = useEditorStore((state) => state.setActiveBreakpoint)
  const activeBreakpointId = useEditorStore((state) => state.activeBreakpointId)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editWidth, setEditWidth] = useState(0)
  const [editIcon, setEditIcon] = useState('monitor')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmRemoveId) confirmBtnRef.current?.focus()
  }, [confirmRemoveId])

  const [newLabel, setNewLabel] = useState('')
  const [newWidth, setNewWidth] = useState(375)
  const [newIcon, setNewIcon] = useState('smartphone')

  const handleStartEdit = (bp: Breakpoint) => {
    setEditingId(bp.id)
    setEditLabel(bp.label)
    setEditWidth(bp.width)
    setEditIcon(bp.icon)
  }

  const handleSaveEdit = useCallback(() => {
    if (!editingId) return
    if (editLabel.trim() && editWidth > 0) {
      updateBreakpoint(editingId, { label: editLabel.trim(), width: editWidth, icon: editIcon })
    }
    setEditingId(null)
  }, [editingId, editLabel, editWidth, editIcon, updateBreakpoint])

  const handleAdd = useCallback(() => {
    const label = newLabel.trim()
    if (!label || newWidth <= 0) return
    addBreakpoint({ label, width: newWidth, icon: newIcon })
    setNewLabel('')
    setNewWidth(375)
    setNewIcon('smartphone')
  }, [newLabel, newWidth, newIcon, addBreakpoint])

  const handleRemove = (id: string) => {
    removeBreakpoint(id)
    setConfirmRemoveId(null)
  }

  if (!site) {
    return <div className={s.noSite}>Loading site...</div>
  }

  return (
    <div>
      <h3 className={s.sectionHeading}>Breakpoints</h3>
      <p className={s.sectionDescription}>
        Define viewport widths for responsive design. The active breakpoint shows a coloured
        frame on the canvas and can have per-breakpoint prop overrides.
      </p>

      <ul role="list" className={s.list}>
        {site.breakpoints.map((bp) => (
          <li key={bp.id}>
            {editingId === bp.id ? (
              <div className={s.bpEditForm}>
                <div className={s.bpEditRow}>
                  <Input
                    type="text"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder="Label (e.g. Mobile)"
                    autoFocus
                    aria-label="Breakpoint label"
                    className={s.fieldFlex}
                  />
                  <Input
                    type="number"
                    value={editWidth}
                    onChange={(e) => setEditWidth(Number(e.target.value))}
                    min={320}
                    max={3840}
                    aria-label="Width in pixels"
                  />
                </div>
                <Select
                  value={editIcon}
                  onChange={(e) => setEditIcon(e.target.value)}
                  aria-label="Icon"
                  options={ICON_OPTIONS}
                />
                <div className={s.bpEditActions}>
                  <Button variant="primary" size="md" onClick={handleSaveEdit}>Save</Button>
                  <Button variant="secondary" size="md" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className={s.listItem}>
                <div className={s.row}>
                  <BreakpointIcon
                    name={bp.icon}
                    color={bp.id === activeBreakpointId ? 'var(--editor-text)' : 'var(--editor-text-subtle)'}
                  />
                  <div className={s.listItemContent}>
                    <div className={s.listItemTitle}>
                      {bp.label}
                      {bp.id === activeBreakpointId && (
                        <span className={s.activeBadge}>active</span>
                      )}
                    </div>
                    <div className={s.listItemSubtitle}>{bp.width}px</div>
                  </div>
                </div>

                <div
                  className={s.listItemActions}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirmRemoveId(null) } }}
                >
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={bp.id === activeBreakpointId ? undefined : () => setActiveBreakpoint(bp.id)}
                    aria-disabled={bp.id === activeBreakpointId ? 'true' : undefined}
                    aria-label={`Set ${bp.label} as active breakpoint`}
                    tooltip={bp.id === activeBreakpointId ? 'Already the active breakpoint' : undefined}
                  >
                    Activate
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => handleStartEdit(bp)}
                    aria-label={`Edit ${bp.label} breakpoint`}
                  >
                    Edit
                  </Button>
                  {confirmRemoveId === bp.id ? (
                    <>
                      <Button
                        ref={confirmBtnRef}
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRemove(bp.id)}
                        aria-label={`Confirm remove ${bp.label} breakpoint`}
                      >
                        Delete
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirmRemoveId(null)}
                        aria-label="Cancel remove"
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="destructive"
                      size="md"
                      onClick={site.breakpoints.length <= 1 ? undefined : () => setConfirmRemoveId(bp.id)}
                      aria-disabled={site.breakpoints.length <= 1 ? 'true' : undefined}
                      aria-label={`Remove ${bp.label} breakpoint`}
                      tooltip={site.breakpoints.length <= 1 ? 'Cannot remove the last breakpoint' : undefined}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Add new breakpoint */}
      <div className={s.bpAddForm}>
        <h4 className={s.subHeading}>Add Breakpoint</h4>
        <div className={s.bpEditRow}>
          <Input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label"
            aria-label="New breakpoint label"
            className={s.fieldFlex}
          />
          <Input
            type="number"
            value={newWidth}
            onChange={(e) => setNewWidth(Number(e.target.value))}
            min={320}
            max={3840}
            aria-label="Width in pixels"
          />
        </div>
        <div className={s.row}>
          <Select
            value={newIcon}
            onChange={(e) => setNewIcon(e.target.value)}
            aria-label="Breakpoint icon"
            className={s.fieldFlex}
            options={ICON_OPTIONS}
          />
          <Button
            variant="primary"
            size="md"
            onClick={handleAdd}
            disabled={!newLabel.trim() || newWidth <= 0}
          >
            <PlusIcon size={13} aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}

function BreakpointIcon({ name, color }: { name: string; color: string }) {
  switch (name) {
    case 'smartphone':
      return <SmartphoneIcon size={14} color={color} />
    case 'tablet':
      return <TabletIcon size={14} color={color} />
    case 'laptop':
      return <LaptopIcon size={14} color={color} />
    case 'tv':
      return <TvIcon size={14} color={color} />
    case 'monitor':
    default:
      return <MonitorIcon size={14} color={color} />
  }
}
