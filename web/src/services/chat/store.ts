import type { HistoryImportReporter } from './history/importProgress.js'
import { describeLocalDatabaseError, type StorageReadStatus } from './storageState.js'
import { prepareContext, compressContext, contextProgress } from './context.js'
import { getProvider, type Provider } from '../providers.js'
import { resolveChatProfile, resolveParameters, updateDefaultChatParameters, type ChatParameters } from '../chatParameters.js'
import { isOfficialDeepSeek } from '../modelCatalog.js'
import { thinkingEnabled } from '../api/thinking.js'
import { validRecap } from './recapPlan.js'
import { contextFiles, selectedContextFiles } from './contextPlan.js'
import { attachmentTokenReserve, estimateTokens } from '../api/tokenBudget.js'
import { fileBelongsTo, ownedFileId } from '../api/compatible.js'
import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { useSettings } from '../settings.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  settleReply,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** Request model comes from the selected provider, not fixed UI tabs. */
export const currentChatProfile = (id: string | null = useChatStore.getState().activeId): Provider => resolveChatProfile(getProvider(), id ? useChatStore.getState().sessionCache[id]?.chatSettings : undefined, id !== null)
const currentModel = () => currentChatProfile().model
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  listRead: StorageReadStatus | null
  detailRead: StorageReadStatus | null
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  listRead: null,
  detailRead: null,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (a.pinned && b.pinned ? (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) : 0) || b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.pinned === b.pinned && a.pinnedAt === b.pinnedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const persistenceTasks = new Set<Promise<unknown>>()
const trackPersistence = <T>(task: Promise<T>): Promise<T> => {
  persistenceTasks.add(task)
  void task.then(() => persistenceTasks.delete(task), () => persistenceTasks.delete(task))
  return task
}
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: { promise: Promise<void> } | undefined
const sessionLoads = new Map<string, { promise: Promise<void>; status: StorageReadStatus }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void trackPersistence(db.saveSession(session, files))
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (sessionId: string): AssistantMessage => {
  const { search } = useSettings.getState()
  const thinking = thinkingEnabled(currentChatProfile(sessionId))
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: currentChatProfile(sessionId).model,
    providerId: getProvider().id,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready || get().importingHistory) return Promise.resolve()
  if (initTask) return initTask.promise
  const epoch = historyEpoch
  const task = { promise: Promise.resolve() }
  // 先登记 token 再启动异步任务；所有结果/清理都按 token 检查，旧读不覆盖新重试。
  initTask = task
  set({ initError: false, listRead: { stage: 'opening', startedAt: Date.now(), error: null } })
  task.promise = (async () => {
    try {
      const summaries = await db.loadSessionSummaries((stage) => {
        if (epoch === historyEpoch && initTask === task) {
          set((state) => ({ listRead: { stage, startedAt: state.listRead?.startedAt ?? Date.now(), error: null } }))
        }
      })
      if (epoch === historyEpoch && initTask === task) {
        set({ ready: true, initError: false, listRead: null, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch && initTask === task) {
        set((state) => ({
          initError: true,
          listRead: { stage: state.listRead?.stage ?? 'opening', startedAt: state.listRead?.startedAt ?? Date.now(), error: describeLocalDatabaseError(error) },
        }))
      }
    } finally {
      if (initTask === task) initTask = undefined
    }
  })()
  return task.promise
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    if (get().activeId === id) set({ detailRead: pending.status })
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({
    sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false },
    ...(state.activeId === id ? { detailRead: { stage: 'opening', startedAt: Date.now(), error: null } as StorageReadStatus } : {}),
  }))
  const load = { promise: Promise.resolve(), status: { stage: 'opening', startedAt: Date.now(), error: null } as StorageReadStatus }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id, (stage) => {
        load.status = { ...load.status, stage }
        if (epoch === historyEpoch && sessionLoads.get(id) === load && get().activeId === id) {
          set((state) => ({ detailRead: { stage, startedAt: state.detailRead?.startedAt ?? Date.now(), error: null } }))
        }
      })
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        if (get().activeId === id) set({ activeId: null, detailRead: null })
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      if (get().activeId === id) {
        set((state) => ({ detailRead: { stage: 'normalizing', startedAt: state.detailRead?.startedAt ?? Date.now(), error: null } }))
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const loaded = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      const session = loaded.chatSettings ? loaded : { ...loaded, chatSettings: resolveParameters(getProvider(), undefined, true) }
      touchSession(id)
      set((state) => ({
        sessionCache: { ...state.sessionCache, [id]: session },
        ...(state.activeId === id ? { detailRead: null } : {}),
      }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({
          sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true },
          ...(state.activeId === id ? { detailRead: { stage: state.detailRead?.stage ?? 'detail', startedAt: state.detailRead?.startedAt ?? Date.now(), error: describeLocalDatabaseError(error) } } : {}),
        }))
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (
  write: () => Promise<void>,
  report?: HistoryImportReporter
): Promise<number> => {
  report?.({ stage: 'preparing', records: null })
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await Promise.allSettled([...persistenceTasks])
    await db.clearStaging()
    let committed: Awaited<ReturnType<typeof db.commitStaging>>
    try {
      await write()
      report?.({ stage: 'committing', records: null })
      committed = await db.commitStaging(report ? (completed, total) => report({ records: { completed, total } }) : undefined)
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    const { summaries, firstSession } = committed
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      // 该对象就是正式事务已提交的数据，不以暂存写入或掩盖读库失败冒充成功。
      sessionCache: firstSession ? { [firstSession.id]: firstSession } : {},
      listRead: null,
      detailRead: null,
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

/** Lock imports and flush live edits before allowing replacement of individual conversations. */
export const withHistoryImport = async <T>(run: (committed: (session: Session, replaceId?: string) => void) => Promise<T>): Promise<T> => {
  if (get().importingHistory) throw new Error('已有数据操作正在进行')
  await initChat()
  if (!get().ready) throw new Error('请先重试加载本地对话')
  if (get().importingHistory) throw new Error('已有数据操作正在进行')
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) controller.abort()
    await Promise.all(deletionTasks)
    await waitForIdle()
    historyEpoch++; initTask = undefined; sessionLoads.clear()
    await Promise.allSettled([...persistenceTasks])
    for (const id of [...unsavedSessions]) {
      const session = getSession(id)
      if (!session) continue
      await db.saveSession(session, pendingFiles.get(id))
      unsavedSessions.delete(id); pendingFiles.delete(id)
    }
    return await run((session, replaced) => {
      if (replaced) { clearDraft(replaced); sessionAccess.delete(replaced); unsavedSessions.delete(replaced); pendingFiles.delete(replaced) }
      set((state) => ({
        sessions: sortSessions([...state.sessions.filter((s) => s.id !== session.id && s.id !== replaced), toSessionSummary(session)]),
        sessionCache: Object.fromEntries(Object.entries(state.sessionCache).filter(([id]) => id !== session.id && id !== replaced)),
        sessionLoadErrors: Object.fromEntries(Object.entries(state.sessionLoadErrors).filter(([id]) => id !== session.id && id !== replaced)),
        sessionSaveErrors: Object.fromEntries(Object.entries(state.sessionSaveErrors).filter(([id]) => id !== session.id && id !== replaced)),
        activeId: state.activeId === replaced || state.activeId === session.id ? null : state.activeId,
      }))
    })
  } finally {
    set({ importingHistory: false, detailRead: null })
    retrySaveSessions()
    const id = get().activeId
    if (id) void ensureSessionLoaded(id)
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null, detailRead: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** 重连只读加载，不清理正式/暂存数据、不改变 Key 或上下文配置。 */
export const retrySessionLoading = () => {
  if (get().importingHistory) return
  initTask = undefined
  sessionLoads.clear()
  db.reconnectDatabase()
  if (!get().ready) {
    void initChat()
  } else if (get().activeId !== null) {
    void ensureSessionLoaded(get().activeId!)
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void trackPersistence(db.renameSession(id, title)).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

/** Conversation parameters are independent of other conversations. New-chat edits become defaults. */
export const updateCurrentChatParameters = (patch: Partial<ChatParameters>) => {
  if (get().importingHistory || Object.keys(get().streaming).length) throw new Error('任务进行中')
  const id = get().activeId, session = id ? getSession(id) : undefined
  if (!id || !session) { updateDefaultChatParameters(patch); return }
  updateSession(id, (value) => ({ ...value, chatSettings: { ...resolveParameters(getProvider(), value.chatSettings, true), ...patch } }))
  persist(id)
}
/** Await successful persistence before exposing a new recap. No originals are rewritten/deleted. */
const saveRecap = async (sessionId: string, rows: import('./types.js').ContextSummary[]) => {
  const session = getSession(sessionId), epoch = historyEpoch
  if (!session || deletingSessions.has(sessionId) || get().importingHistory) throw new Error('会话已变更')
  const next = { ...session, contextSummaries: rows }
  const ownsLock = !getStreamController(sessionId), lock = new AbortController()
  if (ownsLock) set((s) => ({ streaming: { ...s.streaming, [sessionId]: lock } }))
  try {
    await db.saveSession(next, pendingFiles.get(sessionId) ?? [])
    if (epoch !== historyEpoch || deletingSessions.has(sessionId) || !getSession(sessionId)) return
    const current = getSession(sessionId)
    updateSession(sessionId, (value) => ({ ...value, contextSummaries: rows }))
    if (current !== session) persist(sessionId)
  } catch (error) {
    throw new Error(`前情提要保存失败，原提要保留：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (ownsLock) set((s) => ({ streaming: Object.fromEntries(Object.entries(s.streaming).filter(([id, token]) => id !== sessionId || token !== lock)) }))
  }
}
export const compressCurrentContext = async (): Promise<void> => {
  const sessionId = get().activeId, session = sessionId ? getSession(sessionId) : undefined
  if (!sessionId || !session) throw new Error('请先打开一段对话')
  if (get().importingHistory || Object.keys(get().streaming).length) throw new Error('任务进行中')
  const profile = { ...currentChatProfile(sessionId) }, apiKey = useSettings.getState().apiKey ?? ''
  if (!apiKey || !profile.model.trim()) throw new Error('请先填写 API Key 和模型 ID')
  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  try {
    const recap = await compressContext({ sessionId, profile, apiKey, path: getVisibleMessages(session), checkpoints: session.contextSummaries ?? [], locale: useSettings.getState().locale, signal: controller.signal })
    controller.signal.throwIfAborted()
    await saveRecap(sessionId, [recap])
    contextProgress(sessionId, { status: '前情提要已保存', text: '', error: undefined })
  } catch (error) {
    contextProgress(sessionId, { status: controller.signal.aborted ? '压缩已停止，原提要保留' : '压缩失败，原提要保留', error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error) })
    if (!controller.signal.aborted) throw error
  } finally {
    contextProgress(sessionId, { running: false })
    set((state) => ({ streaming: Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== sessionId)) }))
  }
}
export const editCurrentContextSummary = async (text: string): Promise<void> => {
  const id = get().activeId, session = id ? getSession(id) : undefined
  if (!id || !session) return
  if (get().importingHistory || Object.keys(get().streaming).length) throw new Error('任务进行中')
  const recap = validRecap(getVisibleMessages(session), session.contextSummaries ?? [])
  if (!recap) throw new Error('当前分支没有可编辑的前情提要')
  if (!text.trim()) throw new Error('前情提要不能为空；如需恢复完整上下文，请使用丢弃')
  await saveRecap(id, [{ ...recap, text: text.trim(), updatedAt: Date.now() }])
  contextProgress(id, { status: '前情提要已保存', text: '', error: undefined })
}
export const clearCurrentContextSummary = async (): Promise<void> => {
  const id = get().activeId
  if (!id || !getSession(id)) return
  if (get().importingHistory || Object.keys(get().streaming).length) throw new Error('任务进行中')
  await saveRecap(id, [])
  contextProgress(id, { running: false, status: '已丢弃前情提要，恢复完整上下文', text: '', error: undefined, summaryTokens: 0 })
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      chatSettings: { ...resolveParameters(getProvider()) },
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  if (!current.chatSettings) updateSession(sessionId, (value) => ({ ...value, chatSettings: resolveParameters(getProvider(), undefined, true) }))
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply(sessionId)
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply(sessionId)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply(sessionId)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息，思考开关取当前设置，新流追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { search } = useSettings.getState()
  const thinking = thinkingEnabled(currentChatProfile(sessionId))
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? currentModel(),
    thinking,
    search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment, profile: Provider): Promise<string | null> => {
  if (getProvider().id !== profile.id) throw new Error('服务商已切换，请停止后重试')
  if (profile.protocol === 'openai' || !isOfficialDeepSeek(profile)) return await db.loadFile(file.id) ? ownedFileId(profile, file.id) : null
  if (file.serverId && fileBelongsTo(profile, file.serverId)) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done' && fileBelongsTo(profile, task.serverId)) {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/** Resolve only references after the saved recap boundary, never the covered prefix. */
const prepareFiles = async (sessionId: string, request: Request, messages: MessageParam[], signal: AbortSignal, profile: Provider) => {
  signal.throwIfAborted()
  const epoch = historyEpoch, source = refreshRequest(sessionId, request), files = contextFiles(source.history, source.question)
  const selected = selectedContextFiles(messages), serverIds = new Map<string, string>(), resolved = new Map<string, string | null>(), fileTokens = new Map<string, number>()
  const currentFiles = new Set(request.question.files.map((file) => file.id))
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }) })
  const uploads = Promise.allSettled([...selected].map(async (id) => {
    const file = files.get(id)
    if (!file) throw new Error('请求中的附件引用无本地记录，请重新添加')
    const serverId = await ensureServerId(useSettings.getState().apiKey ?? '', file, profile)
    if (!serverId && currentFiles.has(file.id)) throw new Error('本轮附件原件不可用，请重新添加')
    resolved.set(id, serverId)
    if (serverId) {
      serverIds.set(file.id, serverId)
      const blob = !file.isImage ? await db.loadFile(file.id) : undefined
      const reserve = blob ? estimateTokens(await blob.text()) : attachmentTokenReserve(file)
      fileTokens.set(serverId, reserve)
      fileTokens.set(serverId.slice(`sourcefile:${profile.id}:`.length), reserve)
    }
  }))
  // Shared uploads may finish after cancellation; save only within the same history epoch.
  void uploads.then(() => { if (epoch === historyEpoch) saveServerIds(sessionId, serverIds) })
  try {
    const results = await Promise.race([uploads, aborted])
    signal.throwIfAborted()
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  } finally { signal.removeEventListener('abort', onAbort) }
  const ready = messages.map((message): MessageParam => {
    if (typeof message.content === 'string' || message.role !== 'user') return message
    return { ...message, content: message.content.map((part) => {
      if (part.type !== 'image' && part.type !== 'document') return part
      const id = part.source.file_id, serverId = resolved.get(id)
      return serverId ? { ...part, source: { type: 'file' as const, file_id: serverId } } : { type: 'text' as const, text: `【历史附件原件不可用：${files.get(id)?.name ?? '附件'}；本轮未读取，请勿据此推断内容】` }
    }) }
  })
  return { messages: ready, fileTokens, sentFileIds: new Set(serverIds.values()) }
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, error: unknown, sentFileIds: Set<string>): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : sentFileIds
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId) && !targets.has(file.serverId.slice(`sourcefile:${getProvider().id}:`.length))) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先规划/压缩，再只补齐所选附件，最后检查实际 payload；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  if (initial.providerId && initial.providerId !== getProvider().id) { updateReply(sessionId, settleReply(initial, 'error', Date.now(), { kind: 'protocol', message: '请切回此回答所属的服务商后再继续生成' })); persist(sessionId); return }
  const controller = new AbortController()
  const profile = { ...currentChatProfile(sessionId), model: initial.model ?? currentModel() }, apiKey = useSettings.getState().apiKey ?? ''
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 规划/压缩错误与附件上传错误分开，避免把预算问题伪装成上传失败。 */
      let preparing = false
      let sentFileIds = new Set<string>()
      let receivedContent = false
      try {
        const source = refreshRequest(sessionId, request)
        const latestReminder = profile.protocol === 'deepseek' && isOfficialDeepSeek(profile) ? source.prefix ? source.prefix.latestReminder : createLatestReminder(useSettings.getState()) : undefined
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const plan = prepareContext({ sessionId, profile, history: source.history, question: source.question, prefix: source.prefix, thinking: initial.thinking ?? false, latestReminder, checkpoints: getSession(sessionId)?.contextSummaries ?? [], locale: useSettings.getState().locale })
        preparing = true
        const prepared = await prepareFiles(sessionId, source, plan.messages, controller.signal, profile)
        sentFileIds = prepared.sentFileIds
        preparing = false
        const messages = prepared.messages
        const events = streamMessage(
          apiKey,
          {
            model: initial.model ?? currentModel(),
            system: plan.system,
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false),
            ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
          },
          controller.signal,
          profile,
          prepared.fileTokens
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        if (!getSession(sessionId)?.title) { const title = request.question.content.trim().slice(0, 40) || '附件对话'; updateSession(sessionId, (session) => ({ ...session, title })) }
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: error instanceof Error ? error.message : String(error),
            localMessage: error instanceof ApiError ? describeUploadError(error) : undefined,
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, error, sentFileIds)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    contextProgress(sessionId, { running: false })
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
