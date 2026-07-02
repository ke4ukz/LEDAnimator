import { strToU8, zipSync } from 'fflate'

/** Trigger a browser download of raw bytes. */
export function downloadBytes(name: string, data: Uint8Array, mime = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Zip a set of files (text strings or bytes) into a single archive. */
export function zipProject(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(entries)
}
