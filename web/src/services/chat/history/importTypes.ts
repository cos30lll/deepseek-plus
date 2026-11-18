import type { ChatParameters, PromptPreset } from '../../chatParameters.js'
import type { Session } from '../types.js'
import type { StoredFile } from '../db.js'
export type ImportMode = 'merge' | 'replace_same' | 'rename'
export type ImportSource = 'deepseek' | 'simplechat' | 'chatbox' | 'deepseek-plus'
export type ImportOptions = { mode: ImportMode; repair: boolean; settings: boolean }
export type ImportAudit = { sourceId: string; title: string; targetId?: string; status: 'imported' | 'skipped' | 'failed'; messages: number; repaired: number; missingFiles: number; reason?: string }
export type ImportReport = {
  version: 1; source: ImportSource | null; mode: ImportMode; startedAt: number; updatedAt: number
  completed: boolean; imported: number; messages: number; skipped: number; failed: number
  repaired: number; missingFiles: number; presets: number; indexVerified: boolean | null
  sessions: ImportAudit[]; warnings: string[]; fatal?: string
}
export type ImportCandidate = { session: Session; files: StoredFile[]; repaired: number; missingFiles: number }
export type BackupSettings = { defaults?: Partial<ChatParameters>; presets: PromptPreset[] }
export const errorText = (error: unknown): string => {
  if (error instanceof Error && error.name === 'ArchiveError') return 'ZIP 文件损坏或使用了不支持的压缩格式'
  if (error instanceof SyntaxError) return 'JSON 无法解析'
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (name === 'QuotaExceededError') return '存储空间不足'
  return (error instanceof Error ? error.message : String(error)).slice(0, 400)
}
