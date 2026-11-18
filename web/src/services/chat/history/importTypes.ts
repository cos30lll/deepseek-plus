import { translate } from '../../../i18n/index.js'
import { LocalDatabaseError } from '../storageState.js'
import type { ChatParameters, PromptPreset } from '../../chatParameters.js'
import type { Session } from '../types.js'
import type { StoredFile } from '../db.js'
export type ImportMode = 'merge' | 'replace_same' | 'rename'
export type ImportSource = 'deepseek' | 'simplechat' | 'chatbox' | 'deepseek-plus'
export type ImportOptions = { mode: ImportMode; repair: boolean; settings: boolean }
export type ImportAudit = { sourceId: string; title: string; targetId?: string; status: 'imported' | 'skipped' | 'failed'; messages: number; repaired: number; missingFiles: number; reason?: string }
export type ImportReport = {
  version: 1; source: ImportSource | null; mode: ImportMode; startedAt: number; updatedAt: number
  completed: boolean; cancelled?: boolean; imported: number; messages: number; skipped: number; failed: number
  repaired: number; missingFiles: number; presets: number; indexVerified: boolean | null
  sessions: ImportAudit[]; warnings: string[]; fatal?: string
}
export type ImportCandidate = { session: Session; files: StoredFile[]; repaired: number; missingFiles: number }
export type BackupSettings = { defaults?: Partial<ChatParameters>; presets: PromptPreset[] }
export const newImportReport = (options: ImportOptions): ImportReport => ({ version: 1, source: null, mode: options.mode, startedAt: Date.now(), updatedAt: Date.now(), completed: false, imported: 0, messages: 0, skipped: 0, failed: 0, repaired: 0, missingFiles: 0, presets: 0, indexVerified: null, sessions: [], warnings: [] })

export const errorText = (error: unknown): string => {
  if (error instanceof Error && error.name === 'ArchiveError') return 'ZIP 文件损坏或使用了不支持的压缩格式'
  if (error instanceof SyntaxError) return 'JSON 无法解析'
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (error instanceof LocalDatabaseError) return translate(error.key)
  if (name === 'QuotaExceededError') return translate('historyImportStorageFull')
  if (name === 'NotReadableError' || name === 'NotFoundError') return translate('historyImportFileUnreadable')
  return (error instanceof Error ? error.message : String(error)).slice(0, 400)
}
