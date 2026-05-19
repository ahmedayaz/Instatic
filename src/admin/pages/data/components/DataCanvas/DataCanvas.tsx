/**
 * DataCanvas — the central canvas region for the Data workspace.
 *
 * Either shows an empty-state placeholder when no table is selected,
 * or renders the DataGrid for the active table.
 *
 * For tables with a publish workflow (`postType`, `page`, `component`) the
 * DataGrid itself renders a chip-style status filter and groups rows by
 * status — see `DataGrid.tsx`. There is no canvas-level filter bar; the
 * grid owns its own toolbar so the visual language stays consistent across
 * all three kinds.
 */
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { EmptyState } from '@ui/components/EmptyState'
import { DataGrid } from '../DataGrid/DataGrid'
import type { DataRow, DataRowStatus, DataTable } from '@core/data/schemas'
// Reuse the site canvas surface token so the Data page matches
// Site / Content / Media visual language.
import canvasStyles from '@site/canvas/CanvasRoot.module.css'
import styles from './DataCanvas.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DataCanvasProps {
  table: DataTable | null
  tables: DataTable[]
  rows: DataRow[]
  loading: boolean
  error: string | null
  selectedRowId: string | null
  onSelectRow: (rowId: string | null) => void
  onAddRow: () => Promise<void>
  onDeleteRow: (rowId: string) => void
  onEditInContent: (row: DataRow) => void
  onOpenRow: (rowId: string) => void
  /** Set a row's status — powers the grid's bulk publish / draft actions. */
  onSetRowStatus: (rowId: string, status: DataRowStatus) => Promise<DataRow>
  canEdit: boolean
  canDelete: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataCanvas({
  table,
  tables,
  rows,
  loading,
  error,
  selectedRowId,
  onSelectRow,
  onAddRow,
  onDeleteRow,
  onEditInContent,
  onOpenRow,
  onSetRowStatus,
  canEdit,
  canDelete,
}: DataCanvasProps) {
  if (!table) {
    return (
      <section className={`${canvasStyles.canvas} ${styles.canvasEmpty}`} aria-label="Data canvas">
        <EmptyState
          variant="centered"
          icon={<DatabaseSolidIcon size={20} aria-hidden="true" />}
          title="Select a table"
          description="Choose a data table from the sidebar to view and edit its rows."
        />
      </section>
    )
  }

  return (
    <section className={`${canvasStyles.canvas} ${styles.canvas}`} aria-label={`${table.pluralLabel} data grid`}>
      <DataGrid
        table={table}
        rows={rows}
        tables={tables}
        selectedRowId={selectedRowId}
        loading={loading}
        error={error}
        readOnly={!canEdit}
        onSelectRow={onSelectRow}
        onAddRow={onAddRow}
        onEditInContent={onEditInContent}
        onOpenRow={onOpenRow}
        onDeleteRow={canDelete ? onDeleteRow : undefined}
        onSetRowStatus={canEdit ? onSetRowStatus : undefined}
      />
    </section>
  )
}
