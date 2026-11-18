import { formatDate } from '../../utils/format.js'
import { restoreParameterSettings, useChatParameters } from '../chatParameters.js'
import * as db from './db.js'
import { initChat, replaceHistory, withHistoryImport, useChatStore } from './store.js'
import type { Session } from './types.js'
import { useHistoryImportState } from './history/importProgress.js'
import { errorText, type ImportOptions, type ImportReport } from './history/importTypes.js'
export { BackupError } from './history/errors.js'
let backupQueue: Promise<unknown> = Promise.resolve()
const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => { const task = backupQueue.then(run); backupQueue = task.catch(() => {}); return task }
const readSessions = async function* (): AsyncGenerator<Session> {
  const { sessions, sessionCache } = useChatStore.getState()
  for (const summary of sessions) {
    const session = Object.hasOwn(sessionCache, summary.id) ? sessionCache[summary.id] : await db.loadSession(summary.id)
    if (!session) throw new Error('导出时无法读取会话')
    yield { ...session, ...summary }
  }
}
export const exportHistory = (format: 'complete' | 'deepseek' = 'complete'): Promise<{ name: string; blob: Blob }> => enqueueBackup(async () => withHistoryImport(async () => {
  const date = formatDate(new Date())
  if (format === 'deepseek') { const { exportArchive } = await import('./history/exportArchive.js'); return { name: `deepseek_data-${date}.zip`, blob: await exportArchive(readSessions()) } }
  const { exportCompleteArchive } = await import('./history/completeArchive.js')
  return { name: `deepseek-plus-backup-${date}.zip`, blob: await exportCompleteArchive(readSessions(), useChatParameters.getState(), db.loadFile) }
}))
const publishReport = (report: ImportReport) => {
  const state = useHistoryImportState.getState(), progress = state.progress
  useHistoryImportState.setState({ report, ...(progress ? { progress: { ...progress, stage: 'sessions', sessions: report.imported, messages: report.messages, updatedAt: report.updatedAt } } : {}) })
}
export const importHistory = (file: File, options: ImportOptions = { mode: 'merge', repair: true, settings: true }): Promise<ImportReport> => {
  if (useHistoryImportState.getState().busy) return Promise.reject(new Error('已有导入正在进行'))
  const now = Date.now()
  useHistoryImportState.setState({ busy: true, visible: true, result: null, report: null, failed: false, error: null, progress: { stage: 'queued', archive: null, records: null, sessions: 0, messages: 0, images: 0, startedAt: now, updatedAt: now } })
  return enqueueBackup(async () => {
    const { newImportReport, runImport } = await import('./history/importer.js')
    let report = newImportReport(options)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      useHistoryImportState.setState((s) => ({ progress: s.progress ? { ...s.progress, stage: 'checking' } : null }))
      const { readImportInput } = await import('./history/input.js'), input = await readImportInput(file, options.repair)
      await initChat()
      report = await withHistoryImport(async (committed) => runImport(input, options, { summaries: () => useChatStore.getState().sessions, settings: () => useChatParameters.getState(), saveSettings: restoreParameterSettings, commit: (s, f, id, r) => db.commitImportedSession(s, f, id, r), committed, saveReport: db.saveImportReport }, report, publishReport))
    } catch (error) {
      report = { ...report, fatal: errorText(error), updatedAt: Date.now() }
      try { await db.saveImportReport(report) } catch { report.warnings.push('报告未能保存到本机，可在关闭窗口前导出。') }
    }
    publishReport(report)
    useHistoryImportState.setState({ busy: false, result: report.imported, failed: !!report.fatal, error: report.fatal ?? null })
    return report
  })
}
export const showLastImportReport = async (): Promise<void> => {
  if (useHistoryImportState.getState().busy) { useHistoryImportState.setState({ visible: true }); return }
  const value = await db.loadImportReport(), report = value as ImportReport | undefined
  if (!report || report.version !== 1 || !Array.isArray(report.sessions)) throw new Error('暂无导入报告')
  useHistoryImportState.setState({ visible: true, busy: false, report, result: report.imported, failed: !!report.fatal, error: report.fatal ?? null, progress: { stage: 'sessions', archive: null, records: null, sessions: report.imported, messages: report.messages, images: 0, startedAt: report.startedAt, updatedAt: report.updatedAt } })
}
export const exportImportReport = (): { name: string; blob: Blob } => {
  const report = useHistoryImportState.getState().report
  if (!report) throw new Error('暂无导入报告')
  return { name: 'last-import-report.json', blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }) }
}
export const clearHistory = (): Promise<void> => enqueueBackup(async () => { await replaceHistory(async () => {}) })
