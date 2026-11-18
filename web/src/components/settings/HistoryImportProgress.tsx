import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { saveNativeFile } from '../../services/native.js'
import { exportImportReport, stopHistoryImport, BackupError } from '../../services/chat/backup.js'
import {
  dismissHistoryImport,
  useHistoryImportState,
  type HistoryImportStage,
} from '../../services/chat/history/importProgress.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { closeSettings } from './settingsDialogState.js'
import styles from './HistoryImportProgress.module.css'

const stageLabels: Record<HistoryImportStage, TranslationKey> = {
  queued: 'historyStageQueued',
  checking: 'historyStageChecking',
  reading: 'historyStageReading',
  parsing: 'historyStageParsing',
  preparing: 'historyStagePreparing',
  directory: 'historyStageDirectory',
  sessions: 'historyStageSessions',
  images: 'historyStageImages',
  index: 'historyStageIndex',
  validating: 'historyStageValidating',
  linking: 'historyStageLinking',
  committing: 'historyStageCommitting',
}

/** 仅显示错误类型和必要原因，不记录或输出消息/账号/图片数据。 */
export const historyImportErrorMessage = (
  error: unknown,
  t: ReturnType<typeof useTranslate>
): string => {
  if (error instanceof BackupError) return t(error.key)
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (name === 'QuotaExceededError') return t('historyImportStorageFull')
  if (name === 'NotReadableError' || name === 'NotFoundError') return t('historyImportFileUnreadable')
  if (name === 'SecurityError' || name === 'InvalidStateError') return t('historyImportStorageUnavailable')
  const message = error instanceof Error || error instanceof DOMException ? error.message : String(error)
  return (name ? `${name}: ${message}` : message).slice(0, 600)
}

export const HistoryImportProgress = () => {
  const t = useTranslate()
  const { visible, busy, stopping, progress, report, failed, error } = useHistoryImportState()
  const [now, setNow] = useState(Date.now), [exportError, setExportError] = useState('')
  useEffect(() => { setExportError('') }, [progress?.startedAt])
  useEffect(() => {
    if (!visible || !busy) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible, busy])
  if (!visible || !progress) return null
  const completed = !busy && report?.completed
  const partial = !!report && (report.failed > 0 || !!report.fatal || !busy && !report.completed)
  let title: TranslationKey = 'historyImportErrorTitle'
  if (busy) title = 'historyImportRunning'
  else if (report?.cancelled) title = 'historyImportStopped'
  else if (partial && (!report?.fatal || report.imported > 0)) title = 'importWithIssues'
  else if (completed) title = 'historyImportCompleted'
  const { bytes, records, current } = progress
  const fraction = bytes ?? (records?.total != null ? { completed: records.completed, total: records.total } : null)
  const percent = fraction && fraction.total > 0 ? Math.min(100, fraction.completed * 100 / fraction.total) : undefined
  const slow = busy && now - progress.updatedAt > 15_000
  const elapsed = Math.max(0, Math.floor(((busy ? Math.max(now, progress.updatedAt) : progress.updatedAt) - progress.startedAt) / 1000))
  const viewChat = () => { const id = useChatStore.getState().sessions[0]?.id; dismissHistoryImport(); closeSettings(); if (id) selectSession(id) }
  const saveReport = async () => {
    setExportError('')
    try {
      const { name, blob } = exportImportReport()
      if (await saveNativeFile(name, blob)) return
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) { setExportError(historyImportErrorMessage(e, t)) }
  }
  const failures = report?.sessions.filter((s) => s.status === 'failed') ?? []
  return <Modal
    title={t(title)}
    closable={!busy} className={styles.dialog} onClose={dismissHistoryImport}
    footer={<div className={styles.actions}>
      {busy ? <Button variant="outlined" onClick={stopHistoryImport} disabled={stopping}>{t('historyImportStop')}</Button> : <>
        <Button variant="outlined" onClick={dismissHistoryImport}>{t('close')}</Button>
        {report ? <Button variant="outlined" onClick={() => void saveReport()}>{t('importExportReport')}</Button> : null}
        {report && report.imported > 0 ? <Button onClick={viewChat}>{t('historyImportViewChats')}</Button> : null}
      </>}
    </div>}
  >
    <div className={styles.body} aria-busy={busy}>
      {busy ? <>
        <div className={styles.heading} aria-live="polite">{t(stopping
          ? progress.stage === 'committing' ? 'historyImportAwaitCommit' : 'historyImportStopping'
          : stageLabels[progress.stage])}</div>
        {current ? <div className={styles.note}>{t(current.total === null ? 'historyImportCurrent' : 'historyImportCurrentOf', {
          position: current.position, total: current.total ?? 0,
        })}</div> : null}
        <progress className={styles.progress} max={100} value={percent} aria-label={t(stageLabels[progress.stage])} />
        {bytes ? <div className={styles.note}>{t('historyImportBytes', {
          read: (bytes.completed / 1048576).toFixed(1), total: (bytes.total / 1048576).toFixed(1),
        })}</div> : null}
        {records ? <div className={styles.note}>{t(records.total === null ? 'historyImportRecordsDone' : 'historyImportRecords', {
          done: records.completed, total: records.total ?? 0,
        })}</div> : null}
        {slow && !stopping ? <div className={styles.note}>{t(progress.stage === 'committing' ? 'historyImportAwaitCommit' : 'historyImportSlow')}</div> : null}
      </> : null}
      {report ? <>
        <div>{t('importReportCounts', { imported: report.imported, skipped: report.skipped, failed: report.failed })}</div>
        <div className={styles.note}>{t('importReportDetails', { messages: report.messages, repaired: report.repaired, missing: report.missingFiles, presets: report.presets })}</div>
        {report.source ? <div className={styles.note}>{t('importSource')}: {({ deepseek: 'DeepSeek', simplechat: 'Simple Chat', chatbox: 'Chatbox', 'deepseek-plus': 'deepseek plus' })[report.source]}</div> : null}
        {report.indexVerified !== null ? <div className={styles.note}>{t(report.indexVerified ? 'importIndexVerified' : 'importIndexUnverified')}</div> : null}
        {report.warnings.map((warning, i) => <div key={i} className={styles.warning}>{warning}</div>)}
        {report.fatal ? <div className={styles.error} role="alert">{report.fatal}</div> : null}
        {!busy && !report.completed && !report.fatal && !report.cancelled ? <div className={styles.warning}>{t('importInterrupted')}</div> : null}
        {failures.slice(0, 20).map((item, index) => <div className={styles.error} key={index}>{item.title || item.sourceId || t('importUnnamed')}: {item.reason}</div>)}
        {failures.length > 20 ? <div className={styles.note}>{t('importMoreFailures')}</div> : null}
        {!busy && report.imported > 0 ? <div className={styles.note}>{t('importSavedPartial')}</div> : null}
      </> : <div className={styles.note}>{t('historyImportWorking')}</div>}
      {failed && !report?.fatal ? <div className={styles.error} role="alert">{historyImportErrorMessage(error, t)}</div> : null}
      <div className={styles.note}>{t('historyImportElapsed', { seconds: elapsed })}</div>
      {busy ? <div className={styles.note}>{t('historyImportKeepOpen')}</div> : null}
      {exportError ? <div className={styles.error} role="alert">{exportError}</div> : null}
    </div>
  </Modal>
}
