import type { ImportReport } from './importTypes.js'
import { create } from 'zustand'

/** 读取量只衡量归档内容，不冒充总耗时；数据库提交另报实际记录数。 */
export type ArchiveReadProgress = {
  bytesRead: number
  totalBytes: number
  entriesRead: number
  totalEntries: number
}
export type HistoryImportStage =
  | 'queued'
  | 'checking'
  | 'preparing'
  | 'directory'
  | 'sessions'
  | 'images'
  | 'index'
  | 'validating'
  | 'linking'
  | 'committing'
export type HistoryImportProgress = {
  stage: HistoryImportStage
  archive: ArchiveReadProgress | null
  records: { completed: number; total: number } | null
  sessions: number
  messages: number
  images: number
  startedAt: number
  updatedAt: number
}
/** 回调只同步更新内存，不在 IndexedDB 事务中等待渲染或开启额外事务。 */
export type HistoryImportReporter = (update: Partial<HistoryImportProgress>) => void

/** 不随设置弹窗卸载；不持久化归档、账号、消息、图片或错误到日志。 */
export const useHistoryImportState = create<{
  busy: boolean
  visible: boolean
  progress: HistoryImportProgress | null
  report: ImportReport | null
  result: number | null
  failed: boolean
  error: unknown
}>(() => ({ busy: false, visible: false, progress: null, result: null, report: null, failed: false, error: null }))

export const dismissHistoryImport = () => {
  if (!useHistoryImportState.getState().busy) {
    useHistoryImportState.setState({ visible: false })
  }
}
