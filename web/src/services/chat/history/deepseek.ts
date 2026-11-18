import type { Message, Session } from '../types.js'
import type { ImportCandidate } from './importTypes.js'
import type { IndexedArchive } from './zipReader.js'
import { readSessionFile } from './schema.js'
import { toLocalSession, toLocalMessage } from './toLocal.js'
import { objectArray, objectMetadata } from './jsonStream.js'
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
export const deepseekSession = async (blob: Blob, expectedId: string, zip: IndexedArchive, repair: boolean): Promise<ImportCandidate> => {
  const metadata = await objectMetadata(blob, new Set(['messages']))
  if (!('messages' in metadata)) throw new Error('缺少消息列表')
  const messages: ReturnType<typeof readSessionFile>['messages'] = []
  let n = 0
  for await (const item of objectArray(blob, 'messages')) {
    const source = record(item)
    const normalized = repair ? { ...source, thinking_enabled: source.thinking_enabled ?? false, search_enabled: source.search_enabled ?? false, accumulated_token_usage: source.accumulated_token_usage ?? 0 } : source
    messages.push(readSessionFile({ ...metadata, messages: [normalized] }).messages[0])
    if (++n % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const parsed = readSessionFile({ ...metadata, messages })
  if (parsed.id !== expectedId) throw new Error('会话 ID 与 ZIP 路径不一致')
  let result: { session: Session; repaired: number }
  try { result = { session: toLocalSession(parsed).session, repaired: 0 } }
  catch (error) {
    if (!repair) throw error
    const local = parsed.messages.toSorted((a, b) => a.id - b.id).map((m): Message => ({ ...toLocalMessage(m), parentId: m.parent_id === null ? null : String(m.parent_id) }))
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
  const files: ImportCandidate['files'] = [], seen = new Set<string>()
  let missingFiles = 0
  for (const m of result.session.messages) if (m.role === 'user') for (const file of m.files) {
    if (seen.has(file.id)) continue
    seen.add(file.id)
    const path = images.get(file.id)
    if (!path || !zip.names.includes(path)) { if (file.isImage) missingFiles++; continue }
    const image = await zip.get(path), mime = await imageMime(image)
    const blob = new Blob([image], { type: mime })
    files.push({ id: file.id, blob }); file.mimeType = mime
  }
  const types = new Map(files.map((f) => [f.id, f.blob.type]))
  for (const m of result.session.messages) if (m.role === 'user') for (const file of m.files) file.mimeType = types.get(file.id) ?? ''
  return { ...result, files, missingFiles }
}
export const deepseekIndex = async (zip: IndexedArchive): Promise<{ ids: string[]; verified: boolean; counts: Map<string, number> }> => {
  if (!zip.names.includes('chat_session_index.json')) return { ids: [], verified: false, counts: new Map() }
  try {
    const value: unknown = JSON.parse(await (await zip.get('chat_session_index.json')).text())
    const rows = Array.isArray(value) ? value : record(value).sessions
    if (!Array.isArray(rows)) throw new Error('索引格式无效')
    const ids = rows.map((r) => text(record(r).id))
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('索引 ID 无效')
    const counts = new Map<string, number>()
    rows.forEach((v) => { const r = record(v); if (Number.isSafeInteger(r.message_count) && (r.message_count as number) >= 0) counts.set(text(r.id), r.message_count as number) })
    return { ids, verified: true, counts }
  } catch { return { ids: [], verified: false, counts: new Map() } }
}