import type { Session } from '../types.js'
import type { StoredFile } from '../db.js'
import type { BackupSettings, ImportCandidate, ImportSource } from './importTypes.js'
import { objectArray, objectMetadata } from './jsonStream.js'
import { isZipFile, openArchive, type IndexedArchive } from './zipReader.js'
import { checkManifest } from './schema.js'
import { deepseekIndex, deepseekSession } from './deepseek.js'
import { chatboxSession, inlineAttachment, simpleChatSession, type ResolveImage } from './foreign.js'
import { list, readNativeSession, readParameters, readPresets, record, text } from './portable.js'
export type ImportTask = { id: string; title: string; load: () => Promise<ImportCandidate> }
export type ImportInput = { source: ImportSource; settings: BackupSettings; indexVerified: boolean | null; warnings: string[]; tasks: AsyncIterable<ImportTask> }
const json = async (blob: Blob) => record(JSON.parse(await blob.text()))
const taskMetadata = (v: unknown) => { const r = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; return { id: text(r.id), title: text(r.title ?? r.name) } }
const chatboxPresets = (meta: Record<string, unknown>) => {
  const data = meta.data && typeof meta.data === 'object' ? record(meta.data) : {}
  return list(data.copilots).flatMap((v, index) => { const r = record(v), name = text(r.name), body = text(r.prompt); return name.trim() && body.trim() ? [{ id: `chatbox-${text(r.id) || `cb-copilot-${index}`}`, name, body }] : [] })
}
const zipImage = (zip?: IndexedArchive, resources: unknown[] = []): ResolveImage => {
  const paths = new Map<string, Record<string, unknown>>()
  for (const item of resources) { const r = record(item); if (r.kind === 'image') for (const key of list(r.originalStorageKeys)) if (typeof key === 'string') paths.set(key, r) }
  return async (r, id) => {
    if (text(r.data) || text(r.url).startsWith('data:')) return inlineAttachment({ ...r, data: r.data ?? r.url }, id)
    const resource = paths.get(text(r.storageKey)), path = text(resource?.path ?? r.path).normalize('NFC')
    if (!zip || !path || !zip.names.includes(path)) return undefined
    return { id, blob: new Blob([await zip.get(path)], { type: text(resource?.mimeType ?? r.mime ?? r.mimeType, 'image/jpeg') }) }
  }
}
const blobInput = async (blob: Blob, repair: boolean, zip?: IndexedArchive): Promise<ImportInput> => {
  const meta = await objectMetadata(blob, new Set(['conversations', 'sessions']))
  const format = text(meta.format), warnings: string[] = []
  if (format !== 'simplechat-backup' && format !== 'chatbox-backup') throw new Error('不支持的备份格式')
  if (format === 'simplechat-backup' && meta.version !== 2) throw new Error('仅支持 Simple Chat 备份版本 2')
  const source = format === 'simplechat-backup' ? 'simplechat' : 'chatbox', array = source === 'simplechat' ? 'conversations' : 'sessions'
  if (!(array in meta)) throw new Error('缺少会话列表')
  if (source === 'chatbox') warnings.push('Chatbox 仅导入可见消息分支。')
  const resolve = zipImage(zip, list(meta.resources)), presets = source === 'simplechat' ? readPresets(meta.presets) : chatboxPresets(meta)
  const tasks = async function* (): AsyncGenerator<ImportTask> {
    for await (const value of objectArray(blob, array)) yield { ...taskMetadata(value), load: () => source === 'simplechat' ? simpleChatSession(value, repair, resolve) : chatboxSession(value, repair, resolve) }
  }
  return { source, warnings, settings: { presets }, indexVerified: null, tasks: tasks() }
}
export const readImportInput = async (file: File, repair: boolean): Promise<ImportInput> => {
  if (!await isZipFile(file)) return blobInput(file, repair)
  const zip = await openArchive(file), manifest = zip.names.includes('manifest.json') ? await json(await zip.get('manifest.json')) : {}
  if ('export_format_version' in manifest) {
    checkManifest(manifest)
    const index = await deepseekIndex(zip), names = zip.names.filter((n) => /^chat_sessions\/[^/]+\.json$/.test(n)), available = new Set(names.map((n) => n.slice(14, -5)))
    const order = new Map(index.ids.map((id, i) => [id, i]))
    names.sort((a, b) => (order.get(a.slice(14, -5)) ?? Infinity) - (order.get(b.slice(14, -5)) ?? Infinity))
    const indexVerified = index.verified && index.ids.length === names.length && index.ids.every((id) => available.has(id))
    const warnings = indexVerified ? [] : ['会话索引未通过核验，已按实际文件读取。']
    const tasks = async function* (): AsyncGenerator<ImportTask> {
      for (const id of index.ids) if (!available.has(id)) yield { id, title: '', load: async () => { throw new Error('索引中的会话文件缺失') } }
      for (const name of names) { const id = name.slice(14, -5); yield { id, title: '', load: async () => {
        const result = await deepseekSession(await zip.get(name), id, zip, repair)
        const count = index.counts.get(id)
        if (count !== undefined && count !== result.session.messages.length) throw new Error('会话消息数与索引不一致')
        return result
      } } }
    }
    return { source: 'deepseek', settings: { presets: [] }, warnings, indexVerified, tasks: tasks() }
  }
  if (manifest.format === 'deepseek-plus-archive') {
    if (manifest.version !== 1 || !Array.isArray(manifest.sessions)) throw new Error('不支持的完整备份版本')
    const settings = await json(await zip.get('settings.json')), paths = new Map<string, { path: string; mime: string }>(), ids = new Set<string>()
    for (const value of list(manifest.files)) { const r = record(value), id = text(r.id), path = text(r.path); if (!id || !path || paths.has(id)) throw new Error('附件索引无效'); paths.set(id, { path, mime: text(r.mime) }) }
    for (const value of manifest.sessions) { const r = record(value), id = text(r.id); if (!id || ids.has(id) || !text(r.path)) throw new Error('会话索引无效'); ids.add(id) }
    const tasks = async function* (): AsyncGenerator<ImportTask> {
      for (const value of manifest.sessions as unknown[]) {
        const r = record(value), path = text(r.path), id = text(r.id), title = text(r.title)
        yield { id, title, load: async () => {
          const parsed = readNativeSession(await json(await zip.get(path)), repair)
          if (parsed.session.id !== id || r.messages !== undefined && r.messages !== parsed.session.messages.length) throw new Error('会话索引 ID 或消息数不一致')
          const files: StoredFile[] = [], seen = new Set<string>(); let missingFiles = 0
          for (const m of parsed.session.messages) for (const f of m.files ?? []) {
            if (seen.has(f.id)) continue; seen.add(f.id)
            const entry = paths.get(f.id)
            if (!entry || !zip.names.includes(entry.path)) { missingFiles++; continue }
            files.push({ id: f.id, blob: new Blob([await zip.get(entry.path)], { type: entry.mime }) })
          }
          return { ...parsed, files, missingFiles }
        } }
      }
    }
    return { source: 'deepseek-plus', settings: { presets: readPresets(settings.presets), ...(settings.defaults ? { defaults: readParameters(settings.defaults) } : {}) }, warnings: [], indexVerified: true, tasks: tasks() }
  }
  if (manifest.format === 'simplechat-archive') {
    if (manifest.version !== 1) throw new Error('不支持的 Simple Chat 归档版本')
    return blobInput(await zip.get('backup.json'), repair, zip)
  }
  if (manifest.format === 'chatbox-backup') {
    const names = zip.names.filter((n) => /^sessions\/.+\.json$/.test(n))
    if (!names.length) throw new Error('没有可导入的 Chatbox 会话')
    const resolve = zipImage(zip, list(manifest.resources))
    const tasks = async function* (): AsyncGenerator<ImportTask> {
      for (const name of names) yield { id: '', title: name, load: async () => chatboxSession(await json(await zip.get(name)), repair, resolve) }
    }
    return { source: 'chatbox', settings: { presets: chatboxPresets(manifest) }, indexVerified: null, warnings: ['Chatbox 仅导入可见消息分支。'], tasks: tasks() }
  }
  throw new Error('无法识别此 ZIP 备份')
}
/** Import originals never overwrite an existing conversation's file with an equal source ID. */
export const isolateFiles = (candidate: ImportCandidate): ImportCandidate => {
  const mapping = new Map<string, string>(), prefix = `import:${crypto.randomUUID()}:`
  const session: Session = { ...candidate.session, messages: candidate.session.messages.map((m) => {
    if (!m.files) return m
    return { ...m, files: m.files.map((f) => { if (!mapping.has(f.id)) mapping.set(f.id, prefix + f.id); return { ...f, id: mapping.get(f.id)!, serverId: null } }) }
  }) }
  return { ...candidate, session, files: candidate.files.filter((f) => mapping.has(f.id)).map((f) => ({ id: mapping.get(f.id)!, blob: f.blob })) }
}
