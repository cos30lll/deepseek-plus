import type { TranslationMessage } from '../../i18n/index.js'

export type StorageReadStage = 'opening' | 'list' | 'detail' | 'normalizing'
export type StorageReadStatus = {
  stage: StorageReadStage
  startedAt: number
  error: TranslationMessage | null
}
export type StorageReadReporter = (stage: StorageReadStage) => void

export class LocalDatabaseError extends Error {
  constructor(readonly key: TranslationMessage['key']) {
    super(key)
    this.name = 'LocalDatabaseError'
  }
}

/** 界面显示必要的错误类型，不输出原始消息或记录 ID。 */
export const describeLocalDatabaseError = (error: unknown): TranslationMessage => {
  if (error instanceof LocalDatabaseError) return { key: error.key }
  const name = error instanceof Error || error instanceof DOMException ? error.name : 'UnknownError'
  if (name === 'QuotaExceededError') return { key: 'historyImportStorageFull' }
  if (name === 'SecurityError') return { key: 'historyImportStorageUnavailable' }
  return { key: 'localDatabaseReadError', params: { name: name.slice(0, 80) } }
}

