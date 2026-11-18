import type { Message, Session } from '../types.js'
import type { ImportCandidate } from './importTypes.js'
import type { IndexedArchive } from './zipReader.js'
import { readSessionMetadata, readSessionMessage } from './schema.js'
import type { ImportControl } from './importProgress.js'
import { toLocalSession, toLocalMessage } from './toLocal.js'
import { JsonReader } from './jsonStream.js'
import { BackupReadError } from './readBackup.js'
import { record, restoreTree, text, timestamp } from './portable.js'
const imageMime = async (blob: Blob): Promise<string> => {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer()), h = new TextDecoder('ascii').decode(b)
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x89 && h.slice(1, 4) === 'PNG') return 'image/png'
  if (h.startsWith('GIF8')) return 'image/gif'
  if (h.startsWith('RIFF') && h.slice(8, 12) === 'WEBP') return 'image/webp'
  if (h.startsWith('II') && b[2] === 42 && b[3] === 0 || h.startsWith('MM') && b[2] === 0 && b[3] === 42) return 'image/tiff'
  if (h.startsWith('BM')) return 'image/bmp'
  if (h.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(h.slice(8, 12))) return 'image/avif'
  return ''
}
export const deepseekSession = async (
  blob: Blob,
  expectedId: string,
  zip: IndexedArchive,
  repair: boolean,
  expectedCount?: number,
  control?: ImportControl
): Promise<ImportCandidate> => {
  const metadata: Record<string, unknown> = Object.create(null)
  const messages: ReturnType<typeof readSessionMessage>[] = []
  const reader = new JsonReader(blob, control?.signal)
  const total = expectedCount ?? null
  control?.report({ stage: 'parsing', bytes: null, records: { completed: 0, total } })
  let foundMessages = false
  let lastProgress = performance.now()
  for await (const key of reader.keys()) {
    if (key !== 'messages') {
      metadata[key] = await reader.value()
      continue
    }
    foundMessages = true
    for await (const item of reader.array()) {
      const source = record(item)
      messages.push(readSessionMessage(repair ? {
        ...source,
        thinking_enabled: source.thinking_enabled ?? false,
        search_enabled: source.search_enabled ?? false,
        accumulated_token_usage: source.accumulated_token_usage ?? 0,
      } : source))
      if (performance.now() - lastProgress >= 40) {
        control?.report({ records: { completed: messages.length, total } })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        control?.signal.throwIfAborted()
        lastProgress = performance.now()
      }
    }
  }
  if (!foundMessages) throw new Error('缺少消息列表')
  const parsed = { ...readSessionMetadata(metadata), messages }
  if (parsed.id !== expectedId) throw new Error('会话 ID 与 ZIP 路径不一致')
  if (expectedCount !== undefined && expectedCount !== messages.length) throw new Error('会话消息数与索引不一致')
  control?.report({ records: { completed: messages.length, total } })
  control?.report({ stage: 'validating', records: null })
  let result: { session: Session; repaired: number }
  try { result = { session: toLocalSession(parsed).session, repaired: 0 } }
  catch (error) {
    if (!repair) throw error
    const local = [...parsed.messages].sort((a, b) => a.id - b.id).map((m): Message => ({ ...toLocalMessage(m), parentId: m.parent_id === null ? null : String(m.parent_id) }))
    const provisional: Session = { id: parsed.id, title: parsed.title ?? '', createdAt: timestamp(parsed.inserted_at), updatedAt: timestamp(parsed.updated_at), messages: local, rootMessageId: null }
    const fixed = restoreTree(provisional, true)
    const byId = new Map(fixed.session.messages.map((m) => [m.id, m]))
    for (const m of fixed.session.messages) if (m.parentId) byId.get(m.parentId)!.selectedChildId = m.id
    let current = byId.get(String(parsed.current_message_id)) ?? fixed.session.messages.at(-1)
    if (current) {
      current.selectedChildId = undefined
      const visited = new Set<string>()
      while (current.parentId && !visited.has(current.id)) { visited.add(current.id); const parent = byId.get(current.parentId); if (!parent) break; parent.selectedChildId = current.id; current = parent }
      fixed.session.rootMessageId = current.id
    }
    result = fixed
  }
  if (metadata.pinned === true) { result.session.pinned = true; result.session.pinnedAt = result.session.updatedAt }
  const images = new Map<string, string>()
  for (const m of parsed.messages) for (const fragment of m.fragments) if (fragment.type === 'FILE') for (const file of fragment.files) {
    if (!file.is_image || !file.export_path) continue
    const path = file.export_path.normalize('NFC')
    if (!path.startsWith(`chat_sessions/${parsed.id}_files/`) || images.has(file.id) && images.get(file.id) !== path) throw new Error('图片引用路径无效')
    images.set(file.id, path)
  }
  const attachments = new Map<string, string | undefined>()
  for (const m of result.session.messages) if (m.role === 'user') for (const file of m.files) {
    if (file.isImage) attachments.set(file.id, images.get(file.id))
  }
  const files: ImportCandidate['files'] = []
  const types = new Map<string, string>()
  let missingFiles = 0
  let completed = 0
  if (attachments.size) control?.report({ stage: 'images', records: { completed, total: attachments.size } })
  lastProgress = performance.now()
  for (const [id, path] of attachments) {
    control?.signal.throwIfAborted()
    if (path && zip.has(path)) {
      const image = await zip.get(path)
      const mime = await imageMime(image)
      files.push({ id, blob: new Blob([image], { type: mime }) })
      types.set(id, mime)
    } else missingFiles++
    completed++
    if (completed === attachments.size || performance.now() - lastProgress >= 40) {
      control?.report({ records: { completed, total: attachments.size } })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      lastProgress = performance.now()
    }
  }
  for (const m of result.session.messages) if (m.role === 'user') for (const file of m.files) file.mimeType = types.get(file.id) ?? ''
  return { ...result, files, missingFiles }
}
export const deepseekIndex = async (zip: IndexedArchive, signal?: AbortSignal): Promise<{ ids: string[]; verified: boolean; counts: Map<string, number> }> => {
  if (!zip.has('chat_session_index.json')) return { ids: [], verified: false, counts: new Map() }
  try {
    const value: unknown = JSON.parse(await (await zip.get('chat_session_index.json')).text())
    const rows = Array.isArray(value) ? value : record(value).sessions
    if (!Array.isArray(rows)) throw new Error('索引格式无效')
    const ids = rows.map((r) => text(record(r).id))
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('索引 ID 无效')
    const counts = new Map<string, number>()
    rows.forEach((v) => { const r = record(v); if (Number.isSafeInteger(r.message_count) && (r.message_count as number) >= 0) counts.set(text(r.id), r.message_count as number) })
    return { ids, verified: true, counts }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof BackupReadError) throw error
    return { ids: [], verified: false, counts: new Map() }
  }
}