import type { CreateMessageRequest, MessageStreamEvent, MessageUsage, StopReason } from './types.js'
import { endpoint, type Provider } from '../providers.js'
import { loadFile } from '../chat/db.js'
import { isOfficialDeepSeek, modelInfo } from '../modelCatalog.js'
import { readServerSentEvents } from './sse.js'
import { thinkingParameters, outputTokenLimit, samplingParameters } from './thinking.js'
import { assertPayloadFits } from './tokenBudget.js'
export const ownedFileId = (profile: Provider, remoteId: string) => `sourcefile:${profile.id}:${remoteId}`
export const fileBelongsTo = (profile: Provider, id: string) => id.startsWith(`sourcefile:${profile.id}:`)
const remoteFileId = (profile: Provider, id: string) => id.slice(`sourcefile:${profile.id}:`.length)
const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let raw = ''
  for (let i = 0; i < bytes.length; i += 16384) raw += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(raw)
}
export const toMessages = async (body: CreateMessageRequest, profile: Provider): Promise<Record<string, unknown>[]> => {
  const messages: Record<string, unknown>[] = []
  if (profile.protocol === 'openai' && body.system) messages.push({ role: 'system', content: body.system })
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      if (profile.protocol === 'deepseek' && isOfficialDeepSeek(profile)) messages.push(message)
      else messages.push({ role: 'user', content: `【系统时间与地区参考】${message.content}` })
      continue
    }
    if (typeof message.content === 'string') { messages.push(message); continue }
    const content: Record<string, unknown>[] = []
    const blocks = message.role === 'user' ? [...message.content.filter((b) => b.type === 'text'), ...message.content.filter((b) => b.type === 'document'), ...message.content.filter((b) => b.type !== 'text' && b.type !== 'document')] : message.content
    for (const block of blocks) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'image' || block.type === 'document') {
        if (!fileBelongsTo(profile, block.source.file_id)) throw new Error('附件属于另一家服务商，请重新添加附件')
        const id = remoteFileId(profile, block.source.file_id)
        if (profile.protocol !== 'openai' && isOfficialDeepSeek(profile)) { content.push({ type: block.type, source: { ...block.source, file_id: id } }); continue }
        const blob = await loadFile(id)
        if (!blob) throw new Error('本机附件原件已丢失，请重新添加')
        if (block.type === 'image') {
          if (!modelInfo(profile).supportsVision) throw new Error('参考模型目录未声明此模型支持图片输入，请更换支持图片的模型')
          if (blob.size > 12 * 1024 * 1024) throw new Error('图片超过 12 MiB，请压缩后重试')
          const data = await toBase64(blob)
          if (profile.protocol === 'openai') content.push({ type: 'image_url', image_url: { url: `data:${blob.type || 'image/png'};base64,${data}` } })
          else content.push({ type: 'image', source: { type: 'base64', media_type: blob.type || 'image/png', data } })
        } else {
          if (blob.size > 2 * 1024 * 1024) throw new Error('文本附件超过 2 MiB')
          if (blob.type === 'application/pdf' || /officedocument|msword|presentation|spreadsheet/.test(blob.type)) throw new Error('此通道暂不解析 PDF／Office，请改用文本附件或官方文件通道')
          const text = await blob.text()
          if (text.includes('\u0000')) throw new Error('此附件不是可直接读取的 UTF-8 文本')
          content.push({ type: 'text', text: `<<<附件开始：${block.title ?? id}>>>\n${text}${text.endsWith('\n') ? '' : '\n'}<<<附件结束：${block.title ?? id}>>>\n` })
        }
      } else if (profile.protocol === 'deepseek') content.push(block as unknown as Record<string, unknown>)
    }
    if (content.length) messages.push({ role: message.role, content: profile.protocol === 'openai' && content.every((v) => v.type === 'text') ? content.map((v) => v.text).join('\n') : content })
  }
  if (profile.protocol === 'openai' || isOfficialDeepSeek(profile)) return messages
  const normalized: Record<string, unknown>[] = []
  for (const message of messages) {
    const previous = normalized.at(-1)
    if (previous && previous.role === message.role) {
      const left = previous.content, right = message.content
      previous.content = typeof left === 'string' && typeof right === 'string' ? `${left}\n\n${right}` : [...(typeof left === 'string' ? [{ type: 'text', text: left }] : left as unknown[]), ...(typeof right === 'string' ? [{ type: 'text', text: right }] : right as unknown[])]
    } else normalized.push(message)
  }
  while (normalized[0]?.role === 'assistant') normalized.shift()
  return normalized
}
type RequestFn = (url: string, init: RequestInit) => Promise<Response>
export async function* openAIStream(profile: Provider, key: string, body: CreateMessageRequest, signal: AbortSignal, request: RequestFn, fileTokens?: ReadonlyMap<string, number>): AsyncGenerator<MessageStreamEvent> {
  const payload: Record<string, unknown> = { model: body.model, messages: await toMessages(body, profile), stream: true, ...samplingParameters(profile, body.thinking.type === 'enabled'), ...thinkingParameters(profile, body.thinking.type === 'enabled') }
  const output = outputTokenLimit(profile, body.thinking.type === 'enabled')
  if (output !== null) payload.max_tokens = output
  assertPayloadFits(profile, payload, fileTokens)
  const response = await request(endpoint(profile, 'messages'), { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(payload), signal })
  const usage = (raw: Record<string, unknown> = {}): MessageUsage => ({ input_tokens: Number(raw.prompt_tokens ?? 0), output_tokens: Number(raw.completion_tokens ?? 0), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  yield { type: 'message_start', message: { id: crypto.randomUUID(), model: body.model } }
  let stopped = false, finish: StopReason = 'end_turn', currentUsage: MessageUsage | undefined
  let nextIndex = 0, currentKind: 'text' | 'thinking' | null = null, currentIndex = 0
  const readChunk = function* (raw: unknown): Generator<MessageStreamEvent> {
    if (!raw || typeof raw !== 'object') return
    const value = raw as Record<string, unknown>
    if (value.error) throw new Error(JSON.stringify(value.error))
    if (value.usage && typeof value.usage === 'object') currentUsage = usage(value.usage as Record<string, unknown>)
    const choice = (value.choices as Record<string, unknown>[] | undefined)?.[0]
    if (!choice) return
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>
    if (delta.tool_calls || delta.function_call) throw new Error('服务商返回了客户端工具调用；此版本尚未提供工具执行器')
    const parts: ['thinking' | 'text', unknown][] = [['thinking', delta.reasoning_content ?? delta.reasoning], ['text', delta.content]]
    for (const [kind, part] of parts) {
      if (typeof part !== 'string' || !part) continue
      if (currentKind !== kind) {
        if (currentKind) yield { type: 'content_block_stop', index: currentIndex }
        currentIndex = nextIndex++; currentKind = kind
        yield { type: 'content_block_start', index: currentIndex, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } }
      }
      yield { type: 'content_block_delta', index: currentIndex, delta: kind === 'text' ? { type: 'text_delta', text: part } : { type: 'thinking_delta', thinking: part } }
    }
    if (choice.finish_reason) { stopped = true; finish = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'content_filter' ? 'refusal' : 'end_turn' }
  }
  const type = response.headers.get('Content-Type') ?? ''
  if (type.includes('application/json')) {
    yield* readChunk(await response.json()); stopped = true
  } else {
    if (!response.body || !type.includes('text/event-stream')) throw new Error('接口未返回 SSE 或 JSON 聊天响应')
    for await (const { data } of readServerSentEvents(response.body, signal)) {
      if (data.trim() === '[DONE]') { stopped = true; break }
      let value: unknown
      try { value = JSON.parse(data) } catch { continue }
      yield* readChunk(value)
    }
  }
  if (!stopped) throw new Error('连接在服务商完成响应前中断，请重试')
  if (currentKind) yield { type: 'content_block_stop', index: currentIndex }
  yield { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: currentUsage }
  yield { type: 'message_stop' }
}