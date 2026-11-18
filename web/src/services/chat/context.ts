import { create } from 'zustand'
import type { Provider } from '../providers.js'
import { apiBase } from '../providers.js'
import { streamMessage } from '../api/client.js'
import { loadFile } from './db.js'
import { estimateTokens } from '../api/tokenBudget.js'
import { recapPrompts } from '../recapPrompts.js'
import { buildContextMessages, recapSystemPrompt } from './contextPlan.js'
import { messageText, planRecap, validRecap } from './recapPlan.js'
import type { AssistantMessage, ContextSummary, Message, UserMessage } from './types.js'
export type ContextProgress = { running: boolean; status: string; text?: string; error?: string; inputTokens?: number; summaryTokens?: number }
export const useContextProgress = create<{ jobs: Record<string, ContextProgress> }>(() => ({ jobs: {} }))
export const contextProgress = (id: string, patch: Partial<ContextProgress>) => useContextProgress.setState((state) => ({ jobs: { ...state.jobs, [id]: { ...(state.jobs[id] ?? { running: false, status: '' }), ...patch } } }))
export type ContextInput = { sessionId: string; profile: Provider; history: Message[]; question: UserMessage; prefix?: AssistantMessage; thinking: boolean; latestReminder?: string; checkpoints: ContextSummary[]; locale: string }
/** Normal send never triggers compression and never silently drops the oldest messages. */
export const prepareContext = (input: ContextInput) => {
  const recap = validRecap(input.history, input.checkpoints)
  contextProgress(input.sessionId, { status: recap ? '已使用前情提要' : '完整上下文' })
  return { messages: buildContextMessages(input.history, recap, input.question, input.prefix, input.thinking, input.latestReminder), system: recapSystemPrompt(input.profile.system, recap?.text ?? '', input.locale) }
}
export const formatRecapInput = async (messages: Message[], previous: string, locale: string, signal: AbortSignal): Promise<string> => {
  const r = recapPrompts[locale] ?? recapPrompts['zh-CN']
  let text = previous ? r.prompt_compact_existing + previous + r.prompt_compact_new : ''
  for (const message of messages) {
    signal.throwIfAborted()
    text += (message.role === 'user' ? r.prompt_user_prefix : r.prompt_ai_prefix) + messageText(message).trim()
    if (message.role === 'user') {
      for (const file of message.files.filter((f) => !f.isImage)) {
        const blob = await loadFile(file.id)
        if (!blob) throw new Error(`文本附件原件不可用：${file.name}；未生成新提要，原提要保留`)
        if (blob.type === 'application/pdf' || /officedocument|msword/.test(blob.type)) throw new Error(`暂不解析此格式的文本附件：${file.name}`)
        const content = await blob.text()
        if (content.includes('\u0000')) throw new Error(`附件不是 UTF-8 文本：${file.name}`)
        text += `\n<<<附件开始：${file.name}>>>\n${content}${content.endsWith('\n') ? '' : '\n'}<<<附件结束：${file.name}>>>\n`
      }
      if (message.files.some((f) => f.isImage)) text += r.prompt_has_image
    }
    text += '\n\n'
  }
  return text
}
/** Generate the recap using the current provider and its OpenAI-compatible endpoint. */
export const compressContext = async (input: { sessionId: string; profile: Provider; apiKey: string; path: Message[]; checkpoints: ContextSummary[]; locale: string; signal: AbortSignal }): Promise<ContextSummary> => {
  const { sessionId, profile, apiKey, path, locale, signal } = input
  const previous = validRecap(path, input.checkpoints), plan = planRecap(path, previous)
  if (!plan.throughMessageId) throw new Error('可压缩的消息不足；需保留最近至少 6 条有效消息')
  contextProgress(sessionId, { running: true, status: '正在压缩上下文…', text: '', error: undefined })
  let text = ''
  try {
    const content = await formatRecapInput(plan.prefix, previous?.text ?? '', locale, signal)
    const system = (recapPrompts[locale] ?? recapPrompts['zh-CN']).prompt_compact_system
    // Strip ordinary Anthropic channel suffix only; never switch provider or key.
    const baseUrl = apiBase(profile).replace(/\/(?:chat\/completions|messages)$/, '').replace(/\/anthropic\/v1$/, '').replace(/\/anthropic$/, '')
    const snapshot: Provider = { ...profile, baseUrl, protocol: 'openai', system, reasoningLevel: 'off', temperature: 0.3, maxTokens: null }
    for await (const event of streamMessage(apiKey, { model: profile.model, system, messages: [{ role: 'user', content }], thinking: { type: 'disabled' }, tools: [], safety_check: { level: 'high' } }, signal, snapshot)) {
      signal.throwIfAborted()
      if (event.type === 'content_block_start' && event.content_block.type === 'text') text += event.content_block.text
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
      contextProgress(sessionId, { text, summaryTokens: estimateTokens(text) })
    }
    signal.throwIfAborted()
    if (!text.trim()) throw new Error('模型返回的前情提要为空，原提要保留')
    const throughMessageId = plan.throughMessageId, boundary = path.findIndex((m) => m.id === throughMessageId)
    return { id: previous?.id ?? crypto.randomUUID(), providerId: profile.id, model: profile.model, throughMessageId, coveredIds: path.slice(0, boundary + 1).map((m) => m.id), fingerprint: '', text: text.trim(), createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now() }
  } catch (error) {
    contextProgress(sessionId, { status: signal.aborted ? '压缩已停止，原提要保留' : '压缩失败，原提要保留', error: signal.aborted ? undefined : error instanceof Error ? error.message : String(error) })
    throw error
  } finally { contextProgress(sessionId, { running: false }) }
}