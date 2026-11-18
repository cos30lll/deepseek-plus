import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import { LocalDatabaseError, type StorageReadReporter } from './storageState.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  metadata: { key: string; value: { id: string; value: unknown } }
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null
let connection: IDBPDatabase<ChatDB> | null = null
let cancelOpening: (() => void) | null = null
const pendingReads = new Set<{ abort(): void }>()
const OPEN_TIMEOUT_MS = 12000
const READ_TIMEOUT_MS = 20000

/** 仅关闭连接和取消只读事务，不删除数据库，不中止正在落盘的写事务。 */
export const reconnectDatabase = () => {
  cancelOpening?.()
  cancelOpening = null
  dbPromise = null
  connection?.close()
  connection = null
  for (const tx of pendingReads) abortTransaction(tx)
  pendingReads.clear()
}

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        (message.files ?? []).map((file) => file.id)
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 打开失败/阻塞/终止后不复用坏连接；超时的打开请求若晚到，立即关闭而不再接入新请求。
const getDB = (): Promise<IDBPDatabase<ChatDB>> => {
  if (dbPromise) return dbPromise
  let cancel = () => {}
  const opening = new Promise<IDBPDatabase<ChatDB>>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    cancel = () => fail(new LocalDatabaseError('localDatabaseReconnected'))
    timer = setTimeout(() => fail(new LocalDatabaseError('localDatabaseOpenTimeout')), OPEN_TIMEOUT_MS)
    const request = openDB<ChatDB>('chat-demo', DB_VERSION, {
      upgrade(db, _oldVersion, _newVersion, tx) {
        for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging', 'metadata'] as const) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
        }
        const summaries = db.objectStoreNames.contains('sessionSummaries')
          ? tx.objectStore('sessionSummaries')
          : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
        if (!summaries.indexNames.contains('fileIds')) {
          summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
        }
      },
      blocked() { fail(new LocalDatabaseError('localDatabaseBlocked')) },
      blocking() {
        if (dbPromise !== opening) return
        connection?.close()
        connection = null
        dbPromise = null
      },
      terminated() {
        if (dbPromise !== opening) return
        connection = null
        dbPromise = null
      },
    })
    void request.then((db) => {
      if (settled) { db.close(); return }
      settled = true
      clearTimeout(timer)
      connection = db
      resolve(db)
    }, fail)
  })
  dbPromise = opening
  cancelOpening = cancel
  void opening.then(() => {
    if (dbPromise === opening) cancelOpening = null
  }, () => {
    if (dbPromise === opening) { dbPromise = null; cancelOpening = null }
  })
  return opening
}

/** 只给读取事务加可取消的等待上限；绝不对写事务做 Promise.race 伪取消。 */
const boundedRead = async <T>(
  db: IDBPDatabase<ChatDB>,
  store: 'sessions' | 'sessionSummaries',
  read: (tx: IDBPTransaction<ChatDB, ['sessions' | 'sessionSummaries'], 'readonly'>) => Promise<T>
): Promise<T> => {
  const tx = db.transaction(store, 'readonly')
  pendingReads.add(tx)
  let timer: ReturnType<typeof setTimeout> | undefined
  // 先监听 done，防同步异常或超时中止产生未处理的 rejection。
  const done = tx.done
  void done.catch(() => {})
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LocalDatabaseError('localDatabaseReadTimeout'))
        abortTransaction(tx)
      }, READ_TIMEOUT_MS)
    })
    const operation = Promise.all([read(tx), done]).then(([value]) => value)
    const value = await Promise.race([operation, timeout])
    return value
  } catch (error) {
    abortTransaction(tx)
    throw error
  } finally {
    clearTimeout(timer)
    pendingReads.delete(tx)
  }
}

export const loadSessionSummaries = async (report?: StorageReadReporter): Promise<SessionSummary[]> => {
  report?.('opening')
  const db = await getDB()
  report?.('list')
  const stored = await boundedRead(db, 'sessionSummaries', (tx) => tx.objectStore('sessionSummaries').getAll())
  return stored.map(toSessionSummary)
}

export const loadSession = async (id: string, report?: StorageReadReporter): Promise<Session | undefined> => {
  report?.('opening')
  const db = await getDB()
  report?.('detail')
  return boundedRead(db, 'sessions', (tx) => tx.objectStore('sessions').get(id))
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (
  types: ReadonlyMap<string, string>,
  onProgress?: (completed: number, total: number) => void
): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      const total = onProgress ? await tx.store.count() : 0
      let completed = 0
      onProgress?.(0, total)
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
        onProgress?.(++completed, total)
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ summaries: SessionSummary[]; firstSession: Session | undefined }> => {
  const summaries: SessionSummary[] = []
  let firstSession: Session | undefined
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  let completed = 0
  let total = 0
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
          // 只保留列表首项的原对象，导入完成后查看它无需立即二次读库。
          const session = cursor.value as Session
          if (!firstSession || session.updatedAt > firstSession.updatedAt) firstSession = session
        }
        onProgress?.(++completed, total)
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([
    (async () => {
      try {
        if (onProgress) {
          const counts = await Promise.all([
            tx.objectStore('sessionsStaging').count(), tx.objectStore('filesStaging').count(),
          ])
          total = counts[0] + counts[1]
          onProgress(0, total)
        }
        await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files')])
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return { summaries, firstSession }
}

/** 保留持久化失败诊断；界面反馈由调用方处理。 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/** One imported conversation and its originals commit together; failed replacement preserves the old row. */
export const commitImportedSession = async (session: Session, files: StoredFile[], replaceId?: string, report?: unknown): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files', 'metadata'], 'readwrite')
  const done = tx.done
  void done.catch(() => {})
  try {
    const summaries = tx.objectStore('sessionSummaries')
    const previous = replaceId ? await summaries.get(replaceId) : undefined
    if (replaceId && replaceId !== session.id) {
      await tx.objectStore('sessions').delete(replaceId)
      await summaries.delete(replaceId)
    }
    for (const file of files) await tx.objectStore('files').put(file)
    await tx.objectStore('sessions').put(session)
    await summaries.put(storedSummary(session))
    for (const id of previous?.fileIds ?? []) if (await summaries.index('fileIds').count(id) === 0) await tx.objectStore('files').delete(id)
    if (report !== undefined) await tx.objectStore('metadata').put({ id: 'last-import-report', value: report })
    await done
  } catch (error) { abortTransaction(tx); await done.catch(() => {}); throw error }
}
export const saveImportReport = async (value: unknown): Promise<void> => { await (await getDB()).put('metadata', { id: 'last-import-report', value }) }
export const loadImportReport = async (): Promise<unknown> => (await (await getDB()).get('metadata', 'last-import-report'))?.value
