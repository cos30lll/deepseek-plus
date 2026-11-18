import type { FileAttachment, Message, Session } from '../types.js'
import type { StoredFile } from '../db.js'
import type { ImportCandidate } from './importTypes.js'
import { list, record, restoreTree, simpleBlocks, text, timestamp } from './portable.js'
export type ResolveImage = (entry: Record<string, unknown>, id: string) => Promise<StoredFile | undefined>
const decoded = (value: string, mime: string): Blob | undefined => {
  const raw = value.replace(/^data:[^,]*;base64,/, '').replace(/\s/g, '')
  if (!raw) return undefined
  const bytes = atob(raw), parts: Blob[] = []
  for (let i = 0; i < bytes.length; i += 65536) parts.push(new Blob([Uint8Array.from(bytes.slice(i, i + 65536), (s) => s.charCodeAt(0))]))
  return new Blob(parts, { type: mime })
}
export const inlineAttachment: ResolveImage = async (r, id) => {
  const mime = text(r.mime ?? r.mimeType, 'application/octet-stream')
  const blob = decoded(text(r.data), mime)
  return blob ? { id, blob } : undefined
}
export const simpleChatSession = async (value: unknown, repair: boolean, resolve: ResolveImage = inlineAttachment): Promise<ImportCandidate> => {
  const r = record(value), id = text(r.id)
  if (!id || !Array.isArray(r.messages)) throw new Error('会话记录无效')
  const originals: StoredFile[] = [], messages: Message[] = [], active = new Set<string>(), childGroups = new Map<string | null, { id: string; order: number }[]>()
  let missingFiles = 0
  for (const [index, value] of r.messages.entries()) {
    const m = record(value), mid = text(m.id), role = text(m.role)
    if (!mid || typeof m.content !== 'string' || !['user', 'assistant'].includes(role)) throw new Error('消息 ID 或角色无效')
    const parentId = text(m.parentId) || null, files: FileAttachment[] = []
    for (const [at, value] of list(m.attachments).entries()) {
      const a = record(value), fid = `${id}:${mid}:file:${at}`, mime = text(a.mime, text(a.kind).toUpperCase() === 'IMAGE' ? 'image/jpeg' : 'application/octet-stream')
      let file: StoredFile | undefined
      try { file = await resolve(a, fid) } catch { /* Keep metadata and count the unavailable original. */ }
      if (file) originals.push(file); else missingFiles++
      files.push({ id: fid, name: text(a.name, `附件 ${at + 1}`), size: file?.blob.size ?? 0, serverId: null, mimeType: file?.blob.type || mime, isImage: text(a.kind).toUpperCase() === 'IMAGE' || mime.startsWith('image/') })
    }
    const createdAt = timestamp(m.createdAt), content = text(m.content)
    messages.push(role === 'user' ? { id: mid, parentId, role: 'user', content, files, createdAt } : {
      id: mid, parentId, role: 'assistant', files, createdAt, model: text(m.model) || null, prefix: false,
      status: text(m.status).toUpperCase() === 'ERROR' ? 'error' : ['STOPPED', 'PENDING', 'STREAMING'].includes(text(m.status).toUpperCase()) ? 'stopped' : 'done',
      blocks: simpleBlocks(content, text(m.reasoning) || null, typeof m.thinkingMs === 'number' ? m.thinkingMs : undefined),
      ...(['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(text(m.stopReason)) ? { stopReason: m.stopReason as 'end_turn' } : {}),
      ...(text(m.errorMessage) ? { error: { kind: 'protocol' as const, message: text(m.errorMessage) } } : {}),
    })
    if (m.active === true) active.add(mid)
    const group = childGroups.get(parentId) ?? []; group.push({ id: mid, order: typeof m.variantIndex === 'number' ? m.variantIndex : index }); childGroups.set(parentId, group)
  }
  for (const group of childGroups.values()) group.sort((a, b) => a.order - b.order)
  const selected = (parent: string | null) => { const group = childGroups.get(parent) ?? []; return group.find((m) => active.has(m.id))?.id ?? group[0]?.id }
  for (const m of messages) m.selectedChildId = selected(m.id)
  const session: Session = { id, title: text(r.title), createdAt: timestamp(r.createdAt), updatedAt: timestamp(r.updatedAt), rootMessageId: selected(null) ?? null, messages,
    chatSettings: { mode: text(r.mode).toUpperCase().includes('ROLE') ? 'roleplay' : 'creative', ...(text(r.model) ? { model: text(r.model) } : {}), system: text(r.systemPrompt), enabledPresetIds: list(r.enabledPresetIds).filter((v): v is string => typeof v === 'string') },
    ...(r.pinned === true ? { pinned: true, pinnedAt: timestamp(r.pinnedAt, timestamp(r.updatedAt)) } : {}),
  }
  return { ...restoreTree(session, repair), files: originals, missingFiles }
}
const chatboxContent = (r: Record<string, unknown>): string => typeof r.content === 'string' && r.content.trim() ? r.content : list(r.contentParts).flatMap((v) => { const p = record(v); return p.type === 'text' ? [text(p.text)] : [] }).join('\n\n')
export const stableId = async (value: string): Promise<string> => 'chatbox-' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('')
export const chatboxSession = async (value: unknown, repair: boolean, resolve: ResolveImage): Promise<ImportCandidate> => {
  const r = record(value), rows = list(r.messages), id = text(r.id) || await stableId(JSON.stringify(rows)), converted: unknown[] = [], system: string[] = []
  let parentId = ''
  for (const [index, value] of rows.entries()) {
    const m = record(value), role = text(m.role)
    if (role === 'system') { system.push(chatboxContent(m)); continue }
    if (role !== 'user' && role !== 'assistant') continue
    const content = chatboxContent(m), parts = list(m.contentParts).map(record)
    const reasoning = parts.filter((p) => p.type === 'reasoning').map((p) => text(p.text)).join('\n\n')
    const attachments = parts.filter((p) => p.type === 'image').map((p) => ({ ...p, kind: 'IMAGE', name: text(p.name, '导入图片'), mime: text(p.mimeType, 'image/jpeg') }))
    if (!content && !reasoning && !attachments.length) continue
    const mid = text(m.id) || `${id}#${index}`
    converted.push({ id: mid, parentId, active: true, role, content, reasoning, attachments, status: 'DONE', createdAt: timestamp(m.timestamp ?? m.createdAt) })
    parentId = mid
  }
  if (!converted.length) throw new Error('没有可导入的消息')
  const settings = r.settings && typeof r.settings === 'object' ? record(r.settings) : {}
  return simpleChatSession({ id, title: text(r.name, text(r.title, '导入的对话')), createdAt: timestamp(r.createdAt, Math.min(...converted.map((v) => timestamp(record(v).createdAt)))), updatedAt: timestamp(r.updatedAt, Math.max(...converted.map((v) => timestamp(record(v).createdAt)))), mode: 'creative', model: text(settings.modelId), systemPrompt: system.filter(Boolean).join('\n\n'), messages: converted }, repair, resolve)
}