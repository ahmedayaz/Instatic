/**
 * DataGrid — read-only spreadsheet-style grid for the Data admin page.
 *
 * Cells render as presentational chips / thumbnails / formatted values via
 * `CellDisplayRenderer`. Editing happens in the row inspector (opened when
 * the user clicks a row).
 *
 * Surface features:
 *   - Two-row toolbar — title + count + search + Add row (top); status
 *     filter chips with sort indicator (bottom).
 *   - Bulk-select gutter (sticky checkbox column).
 *   - Frozen primary column with optional /slug subtitle for post-types.
 *   - Status grouping with collapsible group headers (postType, "All" view).
 *   - Floating bulk action bar (Publish / Draft / Delete) at the bottom.
 *   - Click any column header to toggle asc / desc / unsorted.
 */
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import type {
  DataField,
  DataRow,
  DataRowStatus,
  DataTable,
} from '@core/data/schemas'
import { DataGridHeaderCell } from './DataGridHeaderCell'
import { DataGridRow } from './DataGridRow'
import { usePrimaryColumnWidth } from './usePrimaryColumnWidth'
import styles from './DataGrid.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DataGridProps {
  table: DataTable
  rows: DataRow[]
  /** Full tables list — for resolving relation target metadata. */
  tables: DataTable[]
  selectedRowId: string | null
  loading?: boolean
  error?: string | null
  readOnly?: boolean
  /** Click on a row — typically opens the inspector. */
  onSelectRow: (rowId: string | null) => void
  onAddRow: () => Promise<void> | void
  /** Delete a row by id. Omit to hide per-row + bulk delete. */
  onDeleteRow?: (rowId: string) => void
  /** 'Edit in Content' — only meaningful for `kind='postType'` tables. */
  onEditInContent?: (row: DataRow) => void
  /** 'Open' — selects and opens the row inspector for `kind='data'` tables. */
  onOpenRow?: (rowId: string) => void
  /** Set a row's status. PostType only — enables bulk publish / unpublish. */
  onSetRowStatus?: (rowId: string, status: DataRowStatus) => Promise<DataRow>
}

// ---------------------------------------------------------------------------
// Column width helper
// ---------------------------------------------------------------------------

function getColumnWidth(field: DataField, isPrimary: boolean, primaryWidth: number): string {
  if (isPrimary) return `${primaryWidth}px`
  switch (field.type) {
    case 'number':
    case 'boolean':
    case 'date':
    case 'dateTime':
      return '140px'
    case 'media':
    case 'relation':
      return '220px'
    case 'select':
      return '160px'
    case 'multiSelect':
      return '220px'
    case 'longText':
    case 'richText':
      return '260px'
    default:
      return '200px'
  }
}

// ---------------------------------------------------------------------------
// Sort + view state
// ---------------------------------------------------------------------------

interface SortState {
  fieldId: string
  dir: 'asc' | 'desc'
}

type StatusFilter = 'all' | DataRowStatus

interface RowGroup {
  key: string
  label: string | null
  status: DataRowStatus | null
  rows: DataRow[]
}

const STATUS_VIEW_ORDER: { key: StatusFilter; label: string }[] = [
  { key: 'all',         label: 'All' },
  { key: 'published',   label: 'Published' },
  { key: 'draft',       label: 'Drafts' },
  { key: 'unpublished', label: 'Archived' },
]

// ---------------------------------------------------------------------------
// DataGrid
// ---------------------------------------------------------------------------

export function DataGrid({
  table,
  rows,
  tables,
  selectedRowId,
  loading = false,
  error = null,
  readOnly = false,
  onSelectRow,
  onAddRow,
  onDeleteRow,
  onEditInContent,
  onOpenRow,
  onSetRowStatus,
}: DataGridProps): ReactElement {
  const isPostType = table.kind === 'postType'

  // ── Primary column width (per-table, persisted to localStorage) ───────────
  const [primaryWidth, setPrimaryWidth] = usePrimaryColumnWidth(table.id)

  // ── Toolbar state ─────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortState | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<DataRowStatus>>(
    () => new Set(),
  )

  // ── Field ordering ────────────────────────────────────────────────────────
  // Primary field first; subtitle field (slug, when present and distinct from
  // the primary) is collapsed into the primary cell as a subtitle.
  const subtitleFieldId = useMemo<string | null>(() => {
    if (table.primaryFieldId === 'slug') return null
    return table.fields.some((f) => f.id === 'slug') ? 'slug' : null
  }, [table.fields, table.primaryFieldId])

  const orderedFields = useMemo<DataField[]>(() => {
    const primary = table.fields.find((f) => f.id === table.primaryFieldId)
    const rest = table.fields.filter(
      (f) => f.id !== table.primaryFieldId && f.id !== subtitleFieldId,
    )
    return primary == null ? rest : [primary, ...rest]
  }, [table.fields, table.primaryFieldId, subtitleFieldId])

  // ── Filtered + sorted rows ────────────────────────────────────────────────
  const visibleRows = useMemo<DataRow[]>(() => {
    let r = rows

    if (isPostType && statusFilter !== 'all') {
      r = r.filter((row) => row.status === statusFilter)
    }

    const q = query.trim().toLowerCase()
    if (q.length > 0) {
      r = r.filter((row) => {
        for (const field of table.fields) {
          const v = row.cells[field.id]
          if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
        }
        return false
      })
    }

    if (sort != null) {
      r = [...r].sort((a, b) => {
        const av = a.cells[sort.fieldId]
        const bv = b.cells[sort.fieldId]
        const cmp = compareCellValues(av, bv)
        return sort.dir === 'asc' ? cmp : -cmp
      })
    }

    return r
  }, [rows, isPostType, statusFilter, query, sort, table.fields])

  // ── Group rows by status (postType only, when no status filter active) ───
  const groups = useMemo<RowGroup[]>(() => {
    if (!isPostType || statusFilter !== 'all') {
      return [{ key: 'all', label: null, status: null, rows: visibleRows }]
    }
    const buckets: Record<DataRowStatus, DataRow[]> = {
      published: [],
      draft: [],
      unpublished: [],
    }
    for (const row of visibleRows) buckets[row.status].push(row)
    const out: RowGroup[] = []
    if (buckets.published.length > 0)
      out.push({ key: 'published', label: 'Published', status: 'published', rows: buckets.published })
    if (buckets.draft.length > 0)
      out.push({ key: 'draft', label: 'Drafts', status: 'draft', rows: buckets.draft })
    if (buckets.unpublished.length > 0)
      out.push({ key: 'unpublished', label: 'Archived', status: 'unpublished', rows: buckets.unpublished })
    return out
  }, [visibleRows, isPostType, statusFilter])

  // ── Status counts for view chips ──────────────────────────────────────────
  const statusCounts = useMemo(() => {
    const counts = { all: rows.length, published: 0, draft: 0, unpublished: 0 }
    for (const r of rows) counts[r.status] += 1
    return counts
  }, [rows])

  // ── Selection helpers ─────────────────────────────────────────────────────
  const visibleIdSet = useMemo(() => new Set(visibleRows.map((r) => r.id)), [visibleRows])
  const checkedVisibleCount = useMemo(() => {
    let n = 0
    for (const id of checkedIds) if (visibleIdSet.has(id)) n += 1
    return n
  }, [checkedIds, visibleIdSet])
  const allChecked = checkedVisibleCount > 0 && checkedVisibleCount === visibleRows.length
  const someChecked = checkedVisibleCount > 0 && checkedVisibleCount < visibleRows.length
  // The Checkbox primitive doesn't style `:indeterminate`, so we render the
  // header checkbox as "checked" whenever ANY visible row is selected. Click
  // semantics: if none-or-some are checked, select all visible; if all are
  // checked, clear the selection. Matches Gmail / Linear behaviour.
  const headerChecked = allChecked || someChecked

  function toggleRow(rowId: string, next: boolean): void {
    setCheckedIds((prev) => {
      const out = new Set(prev)
      if (next) out.add(rowId)
      else out.delete(rowId)
      return out
    })
  }

  function toggleAll(next: boolean): void {
    setCheckedIds((prev) => {
      const out = new Set(prev)
      for (const r of visibleRows) {
        if (next) out.add(r.id)
        else out.delete(r.id)
      }
      return out
    })
  }

  function clearSelection(): void {
    setCheckedIds(new Set())
  }

  function toggleGroupCollapsed(status: DataRowStatus): void {
    setCollapsedGroups((prev) => {
      const out = new Set(prev)
      if (out.has(status)) out.delete(status)
      else out.add(status)
      return out
    })
  }

  // ── Header sort click ─────────────────────────────────────────────────────
  function handleSort(fieldId: string): void {
    setSort((prev) => {
      if (prev == null || prev.fieldId !== fieldId) return { fieldId, dir: 'asc' }
      if (prev.dir === 'asc') return { fieldId, dir: 'desc' }
      return null
    })
  }

  function clearSort(): void {
    setSort(null)
  }

  // ── Bulk action handlers ──────────────────────────────────────────────────
  function handleBulkDelete(): void {
    if (onDeleteRow == null) return
    for (const id of checkedIds) onDeleteRow(id)
    clearSelection()
  }

  async function handleBulkSetStatus(status: DataRowStatus): Promise<void> {
    if (onSetRowStatus == null) return
    const ids = Array.from(checkedIds)
    await Promise.all(ids.map((id) => onSetRowStatus(id, status)))
    clearSelection()
  }

  // ── Per-row primary action ────────────────────────────────────────────────
  function getPrimaryAction(row: DataRow): (() => void) | undefined {
    if (isPostType && onEditInContent != null) return () => onEditInContent(row)
    if (!isPostType && onOpenRow != null) return () => onOpenRow(row.id)
    return undefined
  }

  // ── Primary column resize ─────────────────────────────────────────────────
  //
  // State-driven so all side effects (window listeners + document.body cursor)
  // live in a single useEffect with deterministic cleanup. The mousedown
  // handler captures the starting clientX + width into `resizing`; the effect
  // attaches the move/up listeners and the body-cursor lock while `resizing`
  // is non-null, and the cleanup tears all of it down when `resizing` is set
  // back to null (or the component unmounts mid-drag).
  //
  // React Compiler requires this shape — direct `document.body.style.cursor`
  // writes from a function declared in the component body would be flagged
  // as render-time side effects (Rules of React: components must be pure).
  const [resizing, setResizing] = useState<{ startX: number; startWidth: number } | null>(null)

  function handlePrimaryResizeStart(e: ReactMouseEvent): void {
    setResizing({ startX: e.clientX, startWidth: primaryWidth })
  }

  useEffect(() => {
    if (resizing == null) return
    const { startX, startWidth } = resizing

    function onMove(ev: MouseEvent): void {
      setPrimaryWidth(startWidth + (ev.clientX - startX))
    }
    function onUp(): void {
      setResizing(null)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    // Prevent accidental text selection during the drag.
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing, setPrimaryWidth])

  // ── Grid template ─────────────────────────────────────────────────────────
  // [ checkbox 36px ] [ ...fields ] [ trailing actions minmax(min-content, 1fr) ]
  //
  // The trailing actions column flexes so the grid always fills at least
  // 100% of the scroll container (see `.grid` rule in DataGrid.module.css).
  // The actions cell itself is `justify-content: flex-end`, so the action
  // buttons stay pinned to the right edge as the column expands.
  const columnWidths = [
    '36px',
    ...orderedFields.map((f) =>
      getColumnWidth(f, f.id === table.primaryFieldId, primaryWidth),
    ),
    'minmax(min-content, 1fr)',
  ]
  const gridStyle = {
    '--data-grid-columns': columnWidths.join(' '),
  } as CSSProperties

  // Sticky-left offset for primary column = width of checkbox col (36px).
  const primaryStickyLeft: CSSProperties = { left: '36px' }
  const checkboxStickyLeft: CSSProperties = { left: '0' }

  // ── Toolbar / subtitle text ───────────────────────────────────────────────
  const rowCount = visibleRows.length
  const totalCount = rows.length
  const totalNoun = totalCount === 1 ? table.singularLabel : table.pluralLabel
  const selectedCount = checkedIds.size

  const subtitleParts: string[] = []
  if (loading) {
    subtitleParts.push(`Loading ${table.pluralLabel.toLowerCase()}…`)
  } else {
    subtitleParts.push(`${totalCount} ${totalNoun.toLowerCase()}`)
  }
  if (isPostType && statusFilter === 'all' && totalCount > 0) {
    subtitleParts.push('grouped by status')
  }
  const subtitleText = subtitleParts.join(' · ')

  // Active sort indicator (right of toolbarBottom).
  const sortField = sort != null ? table.fields.find((f) => f.id === sort.fieldId) : null
  const sortLabel = sortField?.label ?? null

  // ── Render helpers ────────────────────────────────────────────────────────
  function renderGroupHeader(group: RowGroup): ReactElement | null {
    if (group.status == null) return null
    const collapsed = collapsedGroups.has(group.status)
    return (
      <button
        key={`group-${group.key}`}
        type="button"
        className={styles.groupHeader}
        data-collapsed={collapsed ? 'true' : undefined}
        onClick={() => group.status != null && toggleGroupCollapsed(group.status)}
      >
        {/*
          * Inner wrapper is `position: sticky; left: 14px;` so the label
          * cluster stays visible while the user scrolls the table
          * horizontally. The outer <button> keeps the full grid-spanning
          * background; the inner span carries the visible content and
          * pins to the left edge of the scroll container.
          */}
        <span className={styles.groupHeaderInner}>
          <span className={styles.groupChev}>
            <ChevronDownIcon size={10} aria-hidden="true" />
          </span>
          <span className={styles.groupTitle}>
            <span className={styles.groupDot} data-status={group.status} aria-hidden="true" />
            {group.label}
            <span className={styles.groupCount}>{group.rows.length}</span>
          </span>
        </span>
      </button>
    )
  }

  function renderRow(row: DataRow): ReactElement {
    return (
      <DataGridRow
        key={row.id}
        row={row}
        fields={orderedFields}
        primaryFieldId={table.primaryFieldId}
        subtitleFieldId={subtitleFieldId}
        table={table}
        tables={tables}
        rows={rows}
        selected={row.id === selectedRowId}
        checked={checkedIds.has(row.id)}
        readOnly={readOnly}
        showStatusDot={isPostType}
        onSelect={() => onSelectRow(row.id)}
        onCheckedChange={(next) => toggleRow(row.id, next)}
        onPrimaryAction={getPrimaryAction(row)}
        onDelete={onDeleteRow != null ? () => onDeleteRow(row.id) : undefined}
        primaryStickyLeft={primaryStickyLeft}
        checkboxStickyLeft={checkboxStickyLeft}
      />
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.gridWrapper}>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarTop}>
          <div className={styles.titleBlock}>
            <span className={styles.title}>{table.pluralLabel}</span>
            <span className={styles.subtitle}>{subtitleText}</span>
          </div>

          <span className={styles.spacer} />

          <div className={styles.searchWrap}>
            <SearchBar
              value={query}
              onValueChange={setQuery}
              placeholder={`Search ${table.pluralLabel.toLowerCase()}…`}
              aria-label={`Search ${table.pluralLabel.toLowerCase()}`}
            />
          </div>

          {!readOnly && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => { void onAddRow() }}
            >
              <PlusIcon size={12} aria-hidden="true" />
              Add row
            </Button>
          )}
        </div>

        {isPostType && (
          <div className={styles.toolbarBottom}>
            <div className={styles.viewChips}>
              {STATUS_VIEW_ORDER.map((view) => {
                const active = statusFilter === view.key
                const count =
                  view.key === 'all'
                    ? statusCounts.all
                    : view.key === 'published'
                      ? statusCounts.published
                      : view.key === 'draft'
                        ? statusCounts.draft
                        : statusCounts.unpublished
                return (
                  <Button
                    key={view.key}
                    variant="ghost"
                    size="sm"
                    shape="pill"
                    pressed={active}
                    className={styles.pill}
                    onClick={() => setStatusFilter(view.key)}
                  >
                    {view.key !== 'all' && (
                      <span className={styles.pillDot} data-status={view.key} aria-hidden="true" />
                    )}
                    <span>{view.label}</span>
                    <span className={styles.pillCount}>{count}</span>
                  </Button>
                )
              })}
            </div>

            <span className={styles.toolbarSpacer} />

            {sort != null && sortLabel && (
              <Button
                variant="ghost"
                size="sm"
                shape="pill"
                className={styles.sortIndicator}
                onClick={clearSort}
                aria-label={`Sorted by ${sortLabel} ${sort.dir === 'asc' ? 'ascending' : 'descending'} — click to clear`}
                tooltip="Clear sort"
              >
                <span className={styles.sortArrow} data-dir={sort.dir} aria-hidden="true">
                  <ArrowDownIcon size={10} />
                </span>
                <span>{sortLabel}</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Error state (outside the grid — full width) ─────────────────── */}
      {error != null && (
        <div role="alert" className={styles.errorState}>
          <p className={styles.errorText}>{error}</p>
          <p className={styles.errorHint}>Check your connection and try again.</p>
        </div>
      )}

      {/* ── Scrollable grid area ────────────────────────────────────────── */}
      {error == null && (
        <div className={styles.scrollContainer}>
          <div
            role="grid"
            className={styles.grid}
            style={gridStyle}
            aria-label={`${table.pluralLabel} data grid`}
            aria-rowcount={rowCount}
            aria-busy={loading}
          >
            {/* ── Header row ─────────────────────────────────────────────── */}
            <div role="row" className={styles.headerRow}>
              {/* Leading checkbox column header */}
              <div
                role="columnheader"
                className={styles.headerCell}
                data-sticky="checkbox"
                style={checkboxStickyLeft}
                aria-label="Select all rows"
              >
                <Checkbox
                  boxSize="sm"
                  checked={headerChecked}
                  onCheckedChange={() => toggleAll(!allChecked)}
                  aria-label={allChecked ? 'Deselect all rows' : 'Select all rows'}
                />
              </div>

              {orderedFields.map((field) => {
                const isPrimary = field.id === table.primaryFieldId
                const sortDir = sort?.fieldId === field.id ? sort.dir : null
                return (
                  <DataGridHeaderCell
                    key={field.id}
                    field={field}
                    isPrimary={isPrimary}
                    sortDir={sortDir}
                    sticky={isPrimary ? 'primary' : undefined}
                    stickyStyle={isPrimary ? primaryStickyLeft : undefined}
                    onClickHeader={() => handleSort(field.id)}
                    onResizeStart={isPrimary ? handlePrimaryResizeStart : undefined}
                  />
                )
              })}

              {/* Trailing actions column header — no visible label */}
              <div
                role="columnheader"
                className={styles.headerCell}
                aria-label="Actions"
              />
            </div>

            {/* ── Loading state ──────────────────────────────────────────── */}
            {loading && (
              <div className={styles.loadingState} role="status" aria-live="polite">
                Loading rows…
              </div>
            )}

            {/* ── Empty state ────────────────────────────────────────────── */}
            {!loading && rowCount === 0 && (
              <EmptyState
                title={
                  query.trim().length > 0 || statusFilter !== 'all'
                    ? `No ${table.pluralLabel.toLowerCase()} match this view`
                    : `No ${table.pluralLabel.toLowerCase()} yet`
                }
                description={
                  readOnly
                    ? undefined
                    : query.trim().length > 0 || statusFilter !== 'all'
                      ? 'Try clearing the search or switching views.'
                      : 'Add the first row to get started.'
                }
                action={
                  !readOnly && query.trim().length === 0 && statusFilter === 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { void onAddRow() }}
                    >
                      <PlusIcon size={12} aria-hidden="true" />
                      Add row
                    </Button>
                  ) : undefined
                }
                className={styles.emptyStateSpan}
              />
            )}

            {/* ── Groups + rows ──────────────────────────────────────────── */}
            {!loading && groups.map((group) => {
              const collapsed = group.status != null && collapsedGroups.has(group.status)
              return (
                <Fragment key={group.key}>
                  {renderGroupHeader(group)}
                  {!collapsed && group.rows.map((row) => renderRow(row))}
                </Fragment>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Floating bulk action bar ─────────────────────────────────────── */}
      {selectedCount > 0 && (
        <div className={styles.bulkBar} role="toolbar" aria-label="Bulk actions">
          <span className={styles.bulkBarCount}>
            <strong>{selectedCount}</strong> selected
          </span>
          <span className={styles.bulkBarSep} aria-hidden="true" />
          <div className={styles.bulkBarActions}>
            {isPostType && onSetRowStatus != null && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  shape="pill"
                  className={styles.bulkBarBtn}
                  onClick={() => { void handleBulkSetStatus('published') }}
                >
                  Publish
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  shape="pill"
                  className={styles.bulkBarBtn}
                  onClick={() => { void handleBulkSetStatus('draft') }}
                >
                  Move to draft
                </Button>
              </>
            )}
            {onDeleteRow != null && (
              <Button
                variant="ghost"
                size="sm"
                shape="pill"
                tone="danger"
                dangerHover
                className={styles.bulkBarBtn}
                onClick={handleBulkDelete}
              >
                <TrashSolidIcon size={11} aria-hidden="true" />
                Delete
              </Button>
            )}
          </div>
          <span className={styles.bulkBarSep} aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Clear selection"
            tooltip="Clear selection"
            onClick={clearSelection}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cell comparator — numeric > date > string fallback.
// ---------------------------------------------------------------------------

function compareCellValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const sa = String(a)
  const sb = String(b)
  // Use numeric collation so '10' sorts after '2', and respect locale for dates.
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}
