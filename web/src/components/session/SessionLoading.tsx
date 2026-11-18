import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { newChat, retrySessionLoading, useChatStore } from '../../services/chat/store.js'
import type { StorageReadStage } from '../../services/chat/storageState.js'
import { Button } from '../base/Button.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { MobileHeader } from './MobileHeader.js'
import styles from '../../app/App.module.css'

const labels: Record<StorageReadStage, TranslationKey> = {
  opening: 'sessionLoadOpening',
  list: 'sessionLoadList',
  detail: 'sessionLoadDetail',
  normalizing: 'sessionLoadNormalizing',
}

export const SessionLoading = ({ isMobile }: { isMobile: boolean }) => {
  const t = useTranslate()
  const ready = useChatStore((state) => state.ready)
  const activeId = useChatStore((state) => state.activeId)
  const importing = useChatStore((state) => state.importingHistory)
  const status = useChatStore((state) => ready ? state.detailRead : state.listRead)
  const failed = useChatStore((state) => ready
    ? state.activeId !== null && state.sessionLoadErrors[state.activeId] === true
    : state.initError)
  const [now, setNow] = useState(Date.now)
  const [mountedAt, setMountedAt] = useState(Date.now)
  useEffect(() => {
    const start = Date.now()
    setMountedAt(start)
    setNow(start)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [activeId, ready])
  const elapsed = Math.max(0, Math.floor((now - (status?.startedAt ?? mountedAt)) / 1000))
  const slow = elapsed >= 8
  const showActions = (failed || slow) && !importing

  return (
    <div className={styles.loadingView}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.loadingState} role="status">
        <span aria-live="polite">{failed ? t(ready ? 'sessionLoadFailed' : 'sessionListLoadFailed') : t('sessionLoading')}</span>
        {status ? <span className={styles.loadingNote}>{t(labels[status.stage])}</span> : null}
        <span className={styles.loadingNote}>{t('sessionLoadElapsed', { seconds: elapsed })}</span>
        {status?.error ? <span className={styles.loadingError} role="alert">{t(status.error.key, status.error.params)}</span> : slow ? <span className={styles.loadingNote}>{t('sessionLoadSlow')}</span> : null}
        {showActions ? (
          <div className={styles.loadingActions}>
            <Button variant="outlined" size="m" onClick={retrySessionLoading}>{t('sessionLoadReconnect')}</Button>
            {ready ? <Button variant="outlined" size="m" onClick={newChat}>{t('sessionLoadNewChat')}</Button> : null}
            <Button variant="outlined" size="m" onClick={() => openSettings('data')}>{t('sessionLoadSettings')}</Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}