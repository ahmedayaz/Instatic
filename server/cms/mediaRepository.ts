import type { DbClient } from './db/client'

interface MediaAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  publicPath: string
  createdAt: string
}

interface CreateMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
}

interface MediaAssetRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  public_path: string
  created_at: Date | string
}

interface DeletedMediaAssetRow {
  storage_path: string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    publicPath: row.public_path,
    createdAt: toIsoString(row.created_at),
  }
}

export async function createMediaAsset(
  db: DbClient,
  input: CreateMediaAssetInput,
): Promise<MediaAsset> {
  const { rows } = await db<MediaAssetRow>`
    insert into media_assets (id, filename, mime_type, size_bytes, storage_path, public_path)
    values (${input.id}, ${input.filename}, ${input.mimeType}, ${input.sizeBytes}, ${input.storagePath}, ${input.publicPath})
    returning id, filename, mime_type, size_bytes, public_path, created_at
  `
  return mapMediaAsset(rows[0])
}

export async function listMediaAssets(db: DbClient): Promise<MediaAsset[]> {
  const { rows } = await db<MediaAssetRow>`
    select id, filename, mime_type, size_bytes, public_path, created_at
    from media_assets
    order by created_at desc
  `
  return rows.map(mapMediaAsset)
}

export async function renameMediaAsset(
  db: DbClient,
  id: string,
  filename: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set filename = ${filename}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, created_at
  `
  return rows[0] ? mapMediaAsset(rows[0]) : null
}

export async function deleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<{ storagePath: string } | null> {
  const { rows } = await db<DeletedMediaAssetRow>`
    delete from media_assets
    where id = ${id}
    returning storage_path
  `
  const row = rows[0]
  return row ? { storagePath: row.storage_path } : null
}
