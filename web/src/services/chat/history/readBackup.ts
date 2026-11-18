import { BackupError } from './errors.js'

const READ_STALL_MS = 30_000

export class BackupReadError extends BackupError {
  constructor(key: 'historyImportFileTimeout' | 'historyImportFileUnreadable') {
    super(key)
  }
}

/** Read a single slice with an idle deadline; a slow provider can keep going while bytes arrive. */
export const readBackupBuffer = async (
  blob: Blob,
  signal?: AbortSignal,
  progress?: (bytes: number) => void
): Promise<ArrayBuffer> => {
  signal?.throwIfAborted()
  if (typeof FileReader === 'undefined') {
    const result = await blob.arrayBuffer()
    signal?.throwIfAborted()
    progress?.(result.byteLength)
    return result
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let timer: ReturnType<typeof setTimeout>
    let loaded = 0
    const clean = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: unknown) => {
      clean()
      reject(error)
      if (reader.readyState === FileReader.LOADING) reader.abort()
    }
    const abort = () => fail(signal?.reason)
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new BackupReadError('historyImportFileTimeout')), READ_STALL_MS)
    }
    reader.onprogress = (event) => {
      if (event.loaded <= loaded) return
      loaded = event.loaded
      arm()
      progress?.(loaded)
    }
    reader.onload = () => {
      clean()
      resolve(reader.result as ArrayBuffer)
    }
    reader.onerror = () => fail(new BackupReadError('historyImportFileUnreadable'))
    reader.onabort = () => fail(signal?.aborted ? signal.reason : new BackupReadError('historyImportFileUnreadable'))
    signal?.addEventListener('abort', abort, { once: true })
    arm()
    try { reader.readAsArrayBuffer(blob) } catch { fail(new BackupReadError('historyImportFileUnreadable')) }
  })
}
