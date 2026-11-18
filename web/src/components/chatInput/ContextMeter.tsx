import { loadFile } from '../../services/chat/db.js'
import { buildContextMessages, contextFileId, contextFiles, selectedContextFiles } from '../../services/chat/contextPlan.js'
import { validRecap } from '../../services/chat/recapPlan.js'
import { resolveChatProfile, useChatParameters } from '../../services/chatParameters.js'
import { memo, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProviders } from '../../services/providers.js'
import { useSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { previewContextUsage, type ContextUsage } from '../../services/chat/contextPlan.js'
import { getDraft, useDrafts } from '../../services/chat/drafts.js'
import { createLatestReminder } from '../../services/chat/latestReminder.js'
import { customContextLength, reportedContextLength } from '../../services/api/contextLimits.js'
import { attachmentTokenReserve, estimateTokens } from '../../services/api/tokenBudget.js'
import { useUploads } from '../../services/attachments.js'
import type { UserMessage } from '../../services/chat/types.js'
import { formatTokenSize } from '../../utils/tokenSize.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import './ContextMeter.css'

/** Read-only, throttled context estimate; the meter never calls a model or starts compression. */
export const ContextMeter = memo(function ContextMeter({ sessionId, onOpenSettings }: { sessionId: string | null; onOpenSettings: () => void }) {
  const base = useProviders((state) => state.rows.find((row) => row.id === state.activeId)!)
  const sessionSettings = useChatStore((s) => sessionId ? s.sessionCache[sessionId]?.chatSettings : undefined)
  const defaults = useChatParameters((s) => s.defaults), presets = useChatParameters((s) => s.presets)
  const importing = useChatStore((state) => state.importingHistory)
  const tasks = useUploads((state) => state.tasks)
  const settings = useSettings()
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(open, { side: 'top', align: 'center', offset: 8, measureKey: usage })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  useEffect(() => {
    let generation = 0, disposed = false
    const update = async () => {
      const token = ++generation
      const profile = resolveChatProfile(base, sessionSettings, sessionId !== null)
      const session = sessionId ? useChatStore.getState().sessionCache[sessionId] : undefined
      const path = session ? getVisibleMessages(session) : []
      const current = getDraft(sessionId), latest = path.at(-1), user = path.at(-2)
      const active = latest?.role === 'assistant' && (latest.status === 'pending' || latest.status === 'streaming') && user?.role === 'user'
      const files = current.attachments.map((attachment) => {
        const task = tasks[attachment.id]
        return { id: attachment.id, serverId: task?.status === 'done' ? task.serverId : `sourcefile:${profile.id}:${attachment.id}`, name: attachment.file.name, size: attachment.file.size, isImage: attachment.isImage, mimeType: attachment.file.type }
      })
      const question: UserMessage = active ? user : { id: 'context-meter-draft', role: 'user', content: current.text.trim(), files, createdAt: Date.now() }
      const history = active ? path.slice(0, -2) : path
      const selected = selectedContextFiles(buildContextMessages(history, validRecap(history, session?.contextSummaries ?? []), question, undefined, false))
      const fileTokens = new Map<string, number>()
      for (const [id, file] of contextFiles(history, question)) {
        if (file.isImage || !selected.has(id)) continue
        try {
          const blob = current.attachments.find((a) => contextFileId({ ...file, id: a.id }) === id)?.file ?? await loadFile(file.id)
          if (blob) fileTokens.set(id, estimateTokens(await blob.text()))
        } catch { /* Missing originals are not represented as read content. */ }
      }
      const next = previewContextUsage({ profile, history: active ? path.slice(0, -2) : path, question, prefix: undefined, thinking: false, latestReminder: createLatestReminder(settings), checkpoints: session?.contextSummaries ?? [], search: settings.search, fileTokens })
      // While a reply streams, also account for a newly edited draft without altering that request.
      if (active) next.inputTokens += estimateTokens(current.text) + files.reduce((sum, file) => sum + attachmentTokenReserve(file), 0)
      if (!disposed && token === generation) setUsage(next)
    }
    // Coalesce token deltas and typing; do not scan a large history for every rendered delta.
    const unsubscribeChat = useChatStore.subscribe((state, previous) => {
      if (sessionId && state.sessionCache[sessionId] !== previous.sessionCache[sessionId]) schedule()
    })
    const unsubscribeDrafts = useDrafts.subscribe((state, previous) => {
      if (state.drafts.get(sessionId) !== previous.drafts.get(sessionId)) schedule()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    schedule()
    function schedule() {
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void update() }, 250)
    }
    return () => { disposed = true; generation++; unsubscribeChat(); unsubscribeDrafts(); if (timer !== undefined) clearTimeout(timer) }
  // Session/draft contents are read on demand above; switching IDs, profiles or checkpoints resets immediately.
  }, [sessionId, base, sessionSettings, defaults, presets, tasks, settings])

  const valid = !importing && usage !== null && usage.inputBudget > 0
  const raw = valid ? usage.inputTokens / usage.inputBudget * 100 : 0
  const percent = Math.max(0, Math.round(raw))
  const label = valid ? percent >= 1000 ? '>999%' : `${percent}%` : '—'
  const color = !valid || raw >= 95 ? 'danger' : raw >= 80 ? 'warning' : 'normal'
  const description = valid ? `上下文占用约 ${percent}%，${formatTokenSize(usage.inputTokens)} / ${formatTokenSize(usage.inputBudget)}` : '上下文预算不足或正在载入'
  return <>
    <button ref={anchorRef} type="button" className={`source-context-meter source-context-meter-${color}`} aria-label={description} title={description} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((value) => !value)}>
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><circle className="source-context-meter-track" cx="18" cy="18" r="15" /><circle className="source-context-meter-fill" cx="18" cy="18" r="15" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - Math.max(0, Math.min(100, raw))} /></svg>
      <span>{label}</span>
    </button>
    {open ? createPortal(<div ref={floatingRef} id={panelId} className="source-context-meter-panel" role="dialog" aria-label="上下文占用" style={position ?? { top: 0, left: 0, visibility: 'hidden' }}>
      <strong>上下文 {label}</strong>
      <dl><dt>已用（估算）</dt><dd>{formatTokenSize(usage?.inputTokens ?? 0)}</dd><dt>上下文长度</dt><dd>{formatTokenSize(Math.max(0, usage?.inputBudget ?? 0))}</dd>{usage?.summaryTokens ? <><dt>摘要</dt><dd>{formatTokenSize(usage.summaryTokens)} · {usage.coveredMessages} 条消息</dd></> : null}</dl>
      <p>{valid ? '含草稿和本地附件，实际用量以接口为准。' : '正在载入…'}{usage?.hasAttachments ? `附件 ${usage.attachmentCount} 个。` : ''}</p>
      <p>{customContextLength(resolveChatProfile(base, sessionSettings, sessionId !== null)) !== undefined ? '自定义长度' : '模型默认长度'}{reportedContextLength(resolveChatProfile(base, sessionSettings, sessionId !== null)) ? ` · 接口曾报上限 ${formatTokenSize(reportedContextLength(resolveChatProfile(base, sessionSettings, sessionId !== null))!)}` : ''}</p>
      <button type="button" onClick={() => { setOpen(false); onOpenSettings() }}>会话设置</button>
    </div>, document.body) : null}
  </>
})