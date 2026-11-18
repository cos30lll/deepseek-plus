import type { StoredFile } from '../db.js'
import type { Session, SessionSummary } from '../types.js'
import { errorText, type BackupSettings, type ImportOptions, type ImportReport } from './importTypes.js'
import { isolateFiles, type ImportInput } from './input.js'
import { planImport } from './portable.js'
export type ImportDependencies = {
  summaries(): SessionSummary[]
  settings(): BackupSettings
  saveSettings(settings: BackupSettings): void
  commit(session: Session, files: StoredFile[], replaceId: string | undefined, report: ImportReport): Promise<void>
  committed(session: Session, replaceId?: string): void
  saveReport(report: ImportReport): Promise<void>
}
export const newImportReport = (options: ImportOptions): ImportReport => ({ version: 1, source: null, mode: options.mode, startedAt: Date.now(), updatedAt: Date.now(), completed: false, imported: 0, messages: 0, skipped: 0, failed: 0, repaired: 0, missingFiles: 0, presets: 0, indexVerified: null, sessions: [], warnings: [] })
const preparePresets = (incoming: BackupSettings, current: BackupSettings, enabled: boolean) => {
  const presets = [...current.presets], mapping = new Map<string, string>()
  let added = 0
  for (const p of incoming.presets) {
    const identical = presets.find((v) => v.name === p.name && v.body === p.body)
    if (identical) { mapping.set(p.id, identical.id); continue }
    if (!enabled) continue
    const id = presets.some((v) => v.id === p.id) ? `import-preset:${crypto.randomUUID()}` : p.id
    presets.push({ ...p, id }); mapping.set(p.id, id); added++
  }
  const remap = (ids: string[]) => ids.flatMap((id) => mapping.has(id) ? [mapping.get(id)!] : [])
  return { presets, remap, added, defaults: enabled && incoming.defaults ? { ...current.defaults, ...incoming.defaults, enabledPresetIds: remap(incoming.defaults.enabledPresetIds ?? []) } : current.defaults }
}
export const runImport = async (input: ImportInput, options: ImportOptions, deps: ImportDependencies, initial: ImportReport, publish: (report: ImportReport) => void): Promise<ImportReport> => {
  let report: ImportReport = { ...initial, source: input.source, indexVerified: input.indexVerified, warnings: [...input.warnings] }
  const show = () => { report = { ...report, updatedAt: Date.now() }; publish(report) }
  try {
    const settings = preparePresets(input.settings, deps.settings(), options.settings)
    if (options.settings) { deps.saveSettings({ presets: settings.presets, defaults: settings.defaults }); report.presets = settings.added }
    else if (input.settings.presets.length || input.settings.defaults) report.warnings.push('未恢复默认参数；仅沿用内容相同的本地预设。')
    show(); await deps.saveReport(report)
    const sourceIds = new Set<string>()
    for await (const task of input.tasks) {
      const audit = { sourceId: task.id, title: task.title, messages: 0, repaired: 0, missingFiles: 0 }
      let committed = false
      try {
        if (task.id && sourceIds.has(task.id)) throw new Error('备份内的会话 ID 重复')
        if (options.mode === 'merge' && task.id && deps.summaries().some((s) => s.id === task.id)) {
          sourceIds.add(task.id)
          report = { ...report, skipped: report.skipped + 1, sessions: [...report.sessions, { ...audit, status: 'skipped' }] }
        } else {
          const candidate = await task.load()
          Object.assign(audit, { sourceId: candidate.session.id, title: candidate.session.title })
          if (sourceIds.has(candidate.session.id)) throw new Error('备份内的会话 ID 重复')
          sourceIds.add(candidate.session.id)
          const plan = planImport(candidate.session, deps.summaries(), options.mode)
          if (plan.skipped) {
            report = { ...report, skipped: report.skipped + 1, sessions: [...report.sessions, { ...audit, status: 'skipped' }] }
          } else {
            const scoped = isolateFiles({ ...candidate, session: plan.session }), session = scoped.session
            if (session.chatSettings?.enabledPresetIds) session.chatSettings = { ...session.chatSettings, enabledPresetIds: settings.remap(session.chatSettings.enabledPresetIds) }
            const next: ImportReport = { ...report, updatedAt: Date.now(), imported: report.imported + 1, messages: report.messages + session.messages.length, repaired: report.repaired + candidate.repaired, missingFiles: report.missingFiles + candidate.missingFiles, sessions: [...report.sessions, { ...audit, status: 'imported', targetId: session.id, messages: session.messages.length, repaired: candidate.repaired, missingFiles: candidate.missingFiles }] }
            await deps.commit(session, scoped.files, plan.replaceId, next)
            report = next; committed = true; deps.committed(session, plan.replaceId)
          }
        }
      } catch (error) {
        if (committed) throw error
        report = { ...report, failed: report.failed + 1, sessions: [...report.sessions, { ...audit, status: 'failed', reason: errorText(error) }] }
      }
      show()
      if (!committed) await deps.saveReport(report)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    report = { ...report, completed: true }
  } catch (error) { report = { ...report, fatal: errorText(error), completed: false } }
  show()
  try { await deps.saveReport(report) } catch { report = { ...report, warnings: [...report.warnings, '报告未能保存到本机，可在关闭窗口前导出。'] }; show() }
  return report
}
