import { nativeFetch } from '../native.js'
import { endpoint, getProvider, recordContextLimit, type Provider } from '../providers.js'
import { isOfficialDeepSeek } from '../modelCatalog.js'
import { thinkingParameters, samplingParameters, outputTokenLimit } from './thinking.js'
import { searchEvents, searchQuery, searchWanted, webSearch, withSearchResults } from './search.js'
import { assertPayloadFits } from './tokenBudget.js'
import { fileBelongsTo, ownedFileId, openAIStream, toMessages } from './compatible.js'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const anthropicUrl = (kind: 'messages' | 'files') => endpoint(getProvider(), kind)
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await nativeFetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(endpoint(getProvider(), 'models'), {
    method: 'GET',
    headers: getProvider().protocol === 'anthropic' ? anthropicHeaders(apiKey, false) : { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const profile = getProvider()
  if (profile.protocol === 'openai') throw new ApiError('protocol', '通用附件应从本机读取，不调用 Files API')
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(anthropicUrl('files'), {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  const result = (await response.json()) as FileObject
  return { ...result, id: ownedFileId(profile, result.id) }
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  const profile = getProvider()
  if (!fileBelongsTo(profile, fileId) || profile.protocol === 'openai' || !isOfficialDeepSeek(profile)) return
  const remoteId = fileId.slice(`sourcefile:${profile.id}:`.length)
  await request(`${anthropicUrl('files')}/${encodeURIComponent(remoteId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  snapshot?: Provider,
  fileTokens?: ReadonlyMap<string, number>
): AsyncGenerator<MessageStreamEvent> {
  const profile = { ...(snapshot ?? getProvider()) }
  try {
    if (!body.model.trim()) throw new ApiError('protocol', '请先在模型设置中选择或填写模型 ID')
    if (profile.protocol !== 'deepseek' && searchWanted(body)) {
      const query = searchQuery(body), sources = await webSearch(query, signal)
      yield* searchEvents(query, sources, `local-search:${crypto.randomUUID()}`)
      body = withSearchResults(body, sources)
    }
    if (profile.protocol === 'openai') { yield* openAIStream(profile, apiKey, body, signal, request, fileTokens); return }
    const payload: Record<string, unknown> = profile.protocol === 'deepseek' && isOfficialDeepSeek(profile)
      ? { ...body, messages: await toMessages(body, profile), ...thinkingParameters(profile, body.thinking.type === 'enabled') }
      : { model: body.model, system: body.system, messages: await toMessages(body, profile), ...thinkingParameters(profile, body.thinking.type === 'enabled') }
    if (profile.protocol === 'deepseek' && isOfficialDeepSeek(profile) && !body.system.trim()) payload.system = '该助手为DeepSeek，由深度求索公司创造。'
    Object.assign(payload, samplingParameters(profile, body.thinking.type === 'enabled'))
    const output = outputTokenLimit(profile, body.thinking.type === 'enabled')
    if (output !== null) payload.max_tokens = output
    assertPayloadFits(profile, payload, fileTokens)
    const response = await request(endpoint(profile, 'messages'), {
      method: 'POST',
      headers: {
        ...anthropicHeaders(apiKey, hasFile(body) && isOfficialDeepSeek(profile)),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    })
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      throw await readErrorResponse(response, 'protocol', '')
    }
    for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        throw new ApiError('stream', payload.error.message)
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
    // 服务端没有提供错误内容时保持为空，不推测断流原因。
    throw new ApiError('interrupted', '')
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    const limit = recordContextLimit(profile, message)
    if (limit) throw new ApiError(error instanceof ApiError ? error.kind : 'protocol', `${message}\n已记录此接口/模型的窗口上限 ${limit} Token。请手动压缩上下文或减少本轮内容；本次不自动重发。`, error instanceof ApiError ? error.status : undefined)
    throw error
  }
}

/** Read real model IDs; do not inject hardcoded Flash / Pro choices. */
export const fetchModels = async (apiKey: string, signal?: AbortSignal): Promise<string[]> => {
  const profile = getProvider()
  const response = await request(endpoint(profile, 'models'), { method: 'GET', headers: profile.protocol === 'anthropic' ? anthropicHeaders(apiKey, false) : { Authorization: `Bearer ${apiKey}` }, signal })
  const raw = await response.json() as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] }
  const rows = raw.data ?? raw.models
  if (!Array.isArray(rows)) throw new ApiError('protocol', '模型列表不是预期的 data/models 数组')
  return [...new Set(rows.map((v) => v.id ?? ('name' in v ? v.name : '')).filter((v): v is string => typeof v === 'string' && !!v.trim()))]
}
