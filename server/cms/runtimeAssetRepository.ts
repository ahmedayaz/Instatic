import { nanoid } from 'nanoid'
import type { BuiltRuntimeAssetFile } from './runtime/bundleScripts'
import type { DbClient } from './db/client'

export interface PublishedRuntimeAssetRecord {
  publicPath: string
  contentType: string
  bytes: Uint8Array
}

interface RuntimeAssetRow {
  public_path: string
  content_type: string
  content_bytes: Uint8Array
}

export async function savePublishedRuntimeAssets(
  db: DbClient,
  pageVersionId: string,
  files: BuiltRuntimeAssetFile[],
): Promise<void> {
  for (const file of files) {
    await db`
      insert into published_runtime_assets
        (id, page_version_id, asset_path, public_path, content_type, content_bytes)
      values (${nanoid()}, ${pageVersionId}, ${file.path}, ${file.publicPath}, ${file.contentType}, ${Buffer.from(file.bytes)})
    `
  }
}

export async function getPublishedRuntimeAsset(
  db: DbClient,
  publicPath: string,
): Promise<PublishedRuntimeAssetRecord | null> {
  const { rows } = await db<RuntimeAssetRow>`
    select public_path, content_type, content_bytes
    from published_runtime_assets
    where public_path = ${publicPath}
    limit 1
  `
  const row = rows[0]
  if (!row) return null

  return {
    publicPath: row.public_path,
    contentType: row.content_type,
    bytes: row.content_bytes,
  }
}
