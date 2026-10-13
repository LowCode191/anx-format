import { createHash } from 'node:crypto'
import type { AndocAsset } from './types.js'

const editableImageExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

export interface ImageAssetInput {
  mediaType: string
  originalName?: string
  description?: string
}

export function createImageAsset(bytes: Uint8Array, input: ImageAssetInput): AndocAsset {
  if (!bytes.length) throw new Error('Image asset cannot be empty')
  const mediaType = input.mediaType.toLowerCase().split(';', 1)[0]!.trim()
  const extension = editableImageExtensions[mediaType]
  if (!extension) throw new Error(`Unsupported editable image type: ${mediaType || 'unknown'}; use image/png or image/jpeg`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const id = `asset-${sha256.slice(0, 24)}`
  return {
    id,
    packagePath: `assets/${id}.${extension}`,
    mediaType,
    sha256,
    size: bytes.length,
    ...(input.originalName ? { originalName: input.originalName } : {}),
    ...(input.description ? { description: input.description } : {}),
  }
}
