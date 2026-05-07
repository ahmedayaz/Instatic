/**
 * Media library endpoints (gated by `media.manage`).
 *
 *   GET    /admin/api/cms/media       — list every uploaded asset
 *   POST   /admin/api/cms/media       — upload a new image/video file
 *                                        (multipart `file=`, max 50MB)
 *   PATCH  /admin/api/cms/media/:id   — rename a stored asset
 *   DELETE /admin/api/cms/media/:id   — delete the row + remove the file
 *
 * The upload writes the bytes to `<uploadsDir>/<nanoid>-<safeName>` and
 * stores both the storage path and the public URL on the row. We accept
 * `image/*` and `video/*` types only; everything else is rejected at the
 * boundary so corrupt payloads never hit disk.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { DbClient } from '../../cms/db/client'
import { requireCapability } from '../../cms/authz'
import {
  createMediaAsset,
  deleteMediaAsset,
  listMediaAssets,
  renameMediaAsset,
} from '../../cms/mediaRepository'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { readString, type CmsHandlerOptions } from './shared'

const MAX_MEDIA_BYTES = 50 * 1024 * 1024

function isAcceptedMediaType(mimeType: string): boolean {
  return /^image\/|^video\//.test(mimeType)
}

function safeStorageName(filename: string): string {
  const normalized = filename.replace(/\\/g, '/')
  const safe = basename(normalized).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '')
  return safe || 'upload.bin'
}

async function readUploadedFile(req: Request): Promise<File | null> {
  const body = await req.formData()
  const file = body.get('file')
  return file instanceof File ? file : null
}

export async function handleMediaRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/media') {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    if (req.method === 'GET') {
      return jsonResponse({ assets: await listMediaAssets(db) })
    }

    if (req.method === 'POST') {
      if (!options.uploadsDir) {
        return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
      }

      const file = await readUploadedFile(req)
      if (!file) return badRequest('Missing file')
      if (file.size <= 0) return badRequest('File is empty')
      if (file.size > MAX_MEDIA_BYTES) return badRequest('File exceeds the 50 MB hard limit')

      const mimeType = file.type || 'application/octet-stream'
      if (!isAcceptedMediaType(mimeType)) {
        return badRequest('Only image and video files can be uploaded')
      }

      const storagePath = `${nanoid()}-${safeStorageName(file.name)}`
      const publicPath = `/uploads/${storagePath}`
      await mkdir(options.uploadsDir, { recursive: true })
      await writeFile(join(options.uploadsDir, storagePath), new Uint8Array(await file.arrayBuffer()))

      const asset = await createMediaAsset(db, {
        id: nanoid(),
        filename: file.name || storagePath,
        mimeType,
        sizeBytes: file.size,
        storagePath,
        publicPath,
        uploadedByUserId: user.id,
      })
      return jsonResponse({ asset }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const mediaItemMatch = url.pathname.match(/^\/admin\/api\/cms\/media\/([^/]+)$/)
  if (mediaItemMatch) {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    const assetId = decodeURIComponent(mediaItemMatch[1])

    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      const filename = readString(body, 'filename')
      if (!filename) return badRequest('Filename is required')

      const asset = await renameMediaAsset(db, assetId, filename)
      if (!asset) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
      return jsonResponse({ asset })
    }

    if (req.method === 'DELETE') {
      if (!options.uploadsDir) {
        return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
      }

      const deleted = await deleteMediaAsset(db, assetId)
      if (!deleted) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })

      await rm(join(options.uploadsDir, deleted.storagePath), { force: true })
      return jsonResponse({ ok: true })
    }

    return methodNotAllowed()
  }

  return null
}
