import type { ChatParameters, PromptPreset } from '../../chatParameters.js'
import type { ContextSummary, FileAttachment, Message, ReplyBlock, Session, SessionSummary } from '../types.js'
import { normalizeSession } from '../branches.js'
import type { ImportMode } from './importTypes.js'
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录格式无效')
  return value as Record<string, unknown>
}
export const text = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback
export const list = (v: unknown): unknown[] => Array.isArray(v) ? v : []
export const timestamp = (v: unknown, fallback = Date.now()): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) { const n = /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n }
  return fallback
}
export const readParameters = (v: unknown): Partial<ChatParameters> => {
  const r = record(v), p: Partial<ChatParameters> = {}
  if (r.mode === 'creative' || r.mode === 'roleplay') p.mode = r.mode
  if (typeof r.model === 'string') p.model = r.model
  if (typeof r.system === 'string') p.system = r.system
  if (Array.isArray(r.enabledPresetIds) && r.enabledPresetIds.every((id) => typeof id === 'string')) p.enabledPresetIds = r.enabledPresetIds
  if (r.reasoningLevel === 'off' || r.reasoningLevel === 'high' || r.reasoningLevel === 'max') p.reasoningLevel = r.reasoningLevel
  if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2) p.temperature = r.temperature
  if (typeof r.topP === 'number' && r.topP >= 0 && r.topP <= 1) p.topP = r.topP
  for (const key of ['maxTokens', 'contextLength'] as const) if (r[key] === null || Number.isSafeInteger(r[key]) && (r[key] as number) > 0) p[key] = r[key] as number | null
  return p
}
export const readPresets = (value: unknown): PromptPreset[] => {
  const ids = new Set<string>()
  return list(value).map((value) => {
  const r = record(value)
  if (!text(r.id) || ids.has(text(r.id)) || typeof r.name !== 'string' || typeof (r.body ?? r.content) !== 'string') throw new Error('预设格式无效')
  ids.add(text(r.id))
  return { id: text(r.id), name: r.name, body: text(r.body ?? r.content) }
  })
}
export const restoreTree = (input: Session, repair: boolean): { session: Session; repaired: number } => {
  const base = input.rootMessageId === undefined && input.messages.some((m) => m.parentId !== undefined) ? { ...input, rootMessageId: input.messages.find((m) => !m.parentId)?.id ?? null } : normalizeSession(input)
  const session = { ...base, messages: base.messages.map((m) => ({ ...m })) }, byId = new Map<string, Message>(), changed = new Set<string>()
  const mark = (m: Message, parent: string | null) => { if (!repair) throw new Error('消息分支不完整'); m.parentId = parent; changed.add(m.id) }
  for (const m of session.messages) { if (!m.id || byId.has(m.id)) throw new Error('消息 ID 重复或为空'); byId.set(m.id, m) }
  for (const m of session.messages) { m.parentId ??= null; if (m.parentId && !byId.has(m.parentId)) mark(m, null) }
  const visited = new Set<string>()
  for (const m of session.messages) {
    const path = new Set<string>(); let node: Message | undefined = m
    while (node && !visited.has(node.id)) {
      if (path.has(node.id)) { mark(node, null); break }
      path.add(node.id); node = node.parentId ? byId.get(node.parentId) : undefined
    }
    path.forEach((id) => visited.add(id))
  }
  const children = new Map<string | null, Message[]>()
  for (const m of session.messages) { const parent = m.parentId ?? null; const group = children.get(parent) ?? []; group.push(m); children.set(parent, group) }
  for (const m of session.messages) {
    const group = children.get(m.id) ?? []
    if (m.selectedChildId && !group.some((child) => child.id === m.selectedChildId)) {
      if (!repair) throw new Error('消息版本指向无效')
      m.selectedChildId = group.at(-1)?.id; changed.add(m.id)
    }
  }
  if (changed.size) for (const m of session.messages) { const group = children.get(m.id) ?? []; if (!m.selectedChildId && group.length) m.selectedChildId = group.at(-1)!.id }
  const roots = children.get(null) ?? []
  if (session.messages.length && !roots.some((m) => m.id === session.rootMessageId)) {
    if (!repair) throw new Error('会话起点无效')
    session.rootMessageId = roots[0]?.id ?? null; changed.add(session.rootMessageId ?? '')
  }
  if (!session.messages.length) session.rootMessageId = null
  return { session, repaired: changed.size }
}
const readFile = (v: unknown): FileAttachment => {
  const r = record(v)
  if (!text(r.id) || typeof r.name !== 'string') throw new Error('附件记录无效')
  return { id: text(r.id), name: r.name, serverId: null, size: typeof r.size === 'number' && r.size >= 0 ? r.size : 0, isImage: r.isImage === true, mimeType: text(r.mimeType) }
}
const validBlock = (value: unknown): ReplyBlock => {
  const b = record(value), strings = (r: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof r[k] === 'string')
  const fail = (): never => { throw new Error('消息内容块无效') }
  if (b.type === 'text') {
    if (typeof b.text !== 'string') fail()
    if (b.citations !== undefined && (!Array.isArray(b.citations) || b.citations.some((v) => { const c = record(v); return c.type !== 'web_search_result_location' || !strings(c, ['url', 'cited_text', 'encrypted_index']) || c.title !== null && typeof c.title !== 'string' }))) fail()
  } else if (b.type === 'thinking') {
    if (typeof b.thinking !== 'string' || b.signature !== undefined && typeof b.signature !== 'string') fail()
    for (const key of ['startedAt', 'endedAt', 'elapsedSeconds']) if (b[key] !== undefined && (typeof b[key] !== 'number' || !Number.isFinite(b[key]))) fail()
  } else if (b.type === 'server_tool_use') {
    if (!strings(b, ['id']) || !['deepseek_web_search', 'deepseek_read_url'].includes(text(b.name)) || !['search', 'deep_search', 'read_link', 'image_search', 'deep_image_search'].includes(text(b.kind))) fail()
    const i = record(b.input)
    if (i.action === 'search') { if (!Array.isArray(i.queries) || i.queries.some((v) => typeof v !== 'string')) fail() }
    else if (i.action === 'read_link' || i.action === 'open_page') { if (typeof i.url !== 'string') fail() }
    else if (i.action === 'find_in_page') { if (!strings(i, ['url', 'pattern'])) fail() }
    else fail()
    b.caller = { type: 'direct' }
  } else if (b.type === 'web_search_tool_result') {
    if (typeof b.tool_use_id !== 'string' || !['search', 'deep_search', 'image_search', 'deep_image_search'].includes(text(b.kind)) || !Array.isArray(b.content)) fail()
    for (const v of list(b.content)) { const c = record(v); if (c.type === 'web_search_tool_result_error') { if (c.error_code !== 'unavailable') fail() } else if (c.type !== 'web_search_result' || !strings(c, ['title', 'url', 'snippet', 'encrypted_content']) || ['site_icon', 'site_name', 'page_age'].some((k) => c[k] !== null && typeof c[k] !== 'string')) fail() }
  } else if (b.type === 'web_fetch_tool_result') {
    if (typeof b.tool_use_id !== 'string' || !['read_link', 'deep_search'].includes(text(b.kind)) || b.signature !== undefined && typeof b.signature !== 'string') fail()
    const c = record(b.content)
    if (c.type === 'web_fetch_tool_result_error') { if (!['url_not_accessible', 'url_not_allowed', 'unavailable'].includes(text(c.error_code))) fail() }
    else { const d = record(c.content), src = record(d.source); if (c.type !== 'web_fetch_result' || typeof c.url !== 'string' || c.published_at !== null && typeof c.published_at !== 'string' || d.type !== 'document' || d.title !== null && typeof d.title !== 'string' || src.type !== 'text' || src.media_type !== 'text/plain' || typeof src.data !== 'string') fail() }
  } else fail()
  if (b.type === 'text') return { type: 'text', text: b.text, ...(b.isTemplate === true ? { isTemplate: true } : {}), ...(b.citations !== undefined ? { citations: list(b.citations).map((v) => { const c = record(v); return { type: c.type, url: c.url, title: c.title, cited_text: c.cited_text, encrypted_index: c.encrypted_index } }) } : {}) } as ReplyBlock
  if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, ...Object.fromEntries(['signature', 'startedAt', 'endedAt', 'elapsedSeconds'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) } as ReplyBlock
  if (b.type === 'server_tool_use') { const i = record(b.input); return { type: b.type, id: b.id, name: b.name, caller: { type: 'direct' }, kind: b.kind, input: Object.fromEntries(['action', 'query', 'queries', 'url', 'pattern'].filter((k) => i[k] !== undefined).map((k) => [k, i[k]])) } as ReplyBlock }
  if (b.type === 'web_search_tool_result') return { type: b.type, tool_use_id: b.tool_use_id, kind: b.kind, content: list(b.content).map((v) => { const c = record(v); return c.type === 'web_search_tool_result_error' ? { type: c.type, error_code: c.error_code } : Object.fromEntries(['type', 'title', 'url', 'image_url', 'snippet', 'site_icon', 'site_name', 'encrypted_content', 'page_age'].filter((k) => c[k] !== undefined).map((k) => [k, c[k]])) }) } as ReplyBlock
  const c = record(b.content)
  return { type: b.type, tool_use_id: b.tool_use_id, kind: b.kind, ...(typeof b.signature === 'string' ? { signature: b.signature } : {}), content: c.type === 'web_fetch_tool_result_error' ? { type: c.type, error_code: c.error_code } : { type: c.type, url: c.url, published_at: c.published_at, content: { type: 'document', title: record(c.content).title, source: { type: 'text', media_type: 'text/plain', data: record(record(c.content).source).data } } } } as ReplyBlock
}
export const readNativeSession = (value: unknown, repair: boolean) => {
  const r = record(value)
  if (!text(r.id) || !Array.isArray(r.messages)) throw new Error('会话记录无效')
  const messages: Message[] = r.messages.map((v) => {
    const m = record(v), id = text(m.id)
    if (!id || !['user', 'assistant'].includes(text(m.role))) throw new Error('消息格式无效')
    if (m.files !== undefined && !Array.isArray(m.files)) throw new Error('附件列表无效')
    const branch = { id, parentId: m.parentId === null ? null : typeof m.parentId === 'string' ? m.parentId : undefined, selectedChildId: typeof m.selectedChildId === 'string' ? m.selectedChildId : undefined, createdAt: timestamp(m.createdAt) }
    if (m.role === 'user') { if (typeof m.content !== 'string') throw new Error('消息正文无效'); return { ...branch, role: 'user', content: m.content, files: list(m.files).map(readFile) } }
    if (!Array.isArray(m.blocks)) throw new Error('消息内容块无效')
    const blocks = m.blocks.map(validBlock)
    const reply = { ...branch, role: 'assistant' as const, model: typeof m.model === 'string' ? m.model : null, prefix: m.prefix === true, status: m.status === 'done' || m.status === 'error' ? m.status : 'stopped' as const, blocks, ...(m.files !== undefined ? { files: list(m.files).map(readFile) } : {}) }
    const result = reply as import('../types.js').AssistantMessage
    for (const key of ['providerId', 'latestReminder'] as const) if (typeof m[key] === 'string') result[key] = m[key]
    for (const key of ['thinking', 'search'] as const) if (typeof m[key] === 'boolean') result[key] = m[key]
    if (['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(text(m.stopReason))) result.stopReason = m.stopReason as typeof result.stopReason
    if (m.stopDetails && record(m.stopDetails).type === 'refusal') result.stopDetails = { type: 'refusal', category: null, explanation: null }
    if (m.usage) { const u = record(m.usage); if (['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some((k) => typeof u[k] !== 'number' || !Number.isFinite(u[k]))) throw new Error('用量记录无效'); result.usage = { input_tokens: u.input_tokens as number, output_tokens: u.output_tokens as number, cache_read_input_tokens: u.cache_read_input_tokens as number, cache_creation_input_tokens: u.cache_creation_input_tokens as number }; if (u.server_tool_use) { const t = record(u.server_tool_use); if (typeof t.web_search_requests !== 'number' || typeof t.tool_search !== 'number') throw new Error('工具用量无效'); result.usage.server_tool_use = { web_search_requests: t.web_search_requests, tool_search: t.tool_search } } }
    if (m.error) { const e = record(m.error); result.error = { kind: ['http', 'stream', 'network', 'interrupted', 'protocol', 'upload'].includes(text(e.kind)) ? e.kind as NonNullable<typeof result.error>['kind'] : 'protocol', message: text(e.message), ...(typeof e.status === 'number' ? { status: e.status } : {}), ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}) } }
    return result
  })
  const messageIds = new Set(messages.map((m) => m.id))
  const summaries = list(r.contextSummaries).map((v): ContextSummary => {
    const s = record(v)
    if (typeof s.text !== 'string' || !Array.isArray(s.coveredIds) || !s.coveredIds.every((id) => typeof id === 'string' && messageIds.has(id)) || s.throughMessageId !== undefined && !messageIds.has(text(s.throughMessageId))) throw new Error('前情提要格式无效')
    return { id: text(s.id) || undefined, providerId: text(s.providerId), model: text(s.model), throughMessageId: text(s.throughMessageId) || undefined, coveredIds: s.coveredIds, fingerprint: text(s.fingerprint), text: s.text, createdAt: timestamp(s.createdAt), updatedAt: timestamp(s.updatedAt, timestamp(s.createdAt)) }
  })
  return restoreTree({ id: text(r.id), title: text(r.title), createdAt: timestamp(r.createdAt), updatedAt: timestamp(r.updatedAt), rootMessageId: r.rootMessageId === null ? null : typeof r.rootMessageId === 'string' ? r.rootMessageId : undefined, messages, contextSummaries: summaries, ...(r.chatSettings ? { chatSettings: readParameters(r.chatSettings) } : {}), ...(r.pinned === true ? { pinned: true, pinnedAt: timestamp(r.pinnedAt) } : {}) }, repair)
}
export type ConflictPlan = { session: Session; replaceId?: string; skipped: boolean }
export const planImport = (session: Session, existing: SessionSummary[], mode: ImportMode): ConflictPlan => {
  const same = existing.find((s) => s.id === session.id)
  if (mode === 'merge') return { session, skipped: !!same }
  const titled = existing.filter((s) => s.title === session.title).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
  if (mode === 'replace_same') return { session, replaceId: (same ?? titled)?.id, skipped: false }
  if (!same && !titled) return { session, skipped: false }
  const base = session.title.replace(/(?:（副本(?: \d+)?）|\(copy(?: \d+)?\))$/, ''), titles = new Set(existing.map((s) => s.title))
  let index = 1, title = `${base}（副本）`
  while (titles.has(title)) title = `${base}（副本 ${++index}）`
  const id = `${session.id}~${crypto.randomUUID()}`, ids = new Map(session.messages.map((m) => [m.id, `${id}#${m.id}`]))
  return { skipped: false, session: { ...session, id, title, rootMessageId: session.rootMessageId ? ids.get(session.rootMessageId) : session.rootMessageId, messages: session.messages.map((m) => ({ ...m, id: ids.get(m.id)!, parentId: m.parentId ? ids.get(m.parentId) ?? null : m.parentId, selectedChildId: m.selectedChildId ? ids.get(m.selectedChildId) : undefined })), contextSummaries: session.contextSummaries?.map((s) => ({ ...s, coveredIds: s.coveredIds.map((id) => ids.get(id) ?? id), throughMessageId: s.throughMessageId ? ids.get(s.throughMessageId) : undefined })) } }
}
export const simpleBlocks = (content: string, reasoning: string | null, thinkingMs?: number): ReplyBlock[] => [
  ...(reasoning ? [{ type: 'thinking' as const, thinking: reasoning, ...(thinkingMs !== undefined ? { elapsedSeconds: thinkingMs / 1000 } : {}) }] : []),
  ...(content ? [{ type: 'text' as const, text: content }] : []),
]