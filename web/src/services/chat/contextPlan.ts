import type { Provider } from '../providers.js'
import type { MessageParam } from '../api/types.js'
import { attachmentTokenReserve, estimatePayloadInputTokens, estimateTokens } from '../api/tokenBudget.js'
import { effectiveContextLength } from '../api/contextLimits.js'
import { toSelectedRequestMessages } from './reply.js'
import { selectContextMessages, validRecap } from './recapPlan.js'
import { recapPrompts } from '../recapPrompts.js'
import type { AssistantMessage, ContextSummary, FileAttachment, Message, UserMessage } from './types.js'
export const contextFileId = (file: FileAttachment): string => `context-file:${file.id}`
export const contextFiles = (history: Message[], question: UserMessage): Map<string, FileAttachment> => new Map([...history.filter((message): message is UserMessage => message.role === 'user').flatMap((message) => message.files), ...question.files].map((file) => [contextFileId(file), file]))
export const selectedContextFiles = (messages: MessageParam[]): Set<string> => new Set(messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content.flatMap((part) => part.type === 'image' || part.type === 'document' && part.source.type === 'file' ? [part.source.file_id] : [])))
export const recapSystemPrompt = (system: string, summary: string, locale = 'zh-CN'): string => [system.trim(), summary.trim() ? (recapPrompts[locale] ?? recapPrompts['zh-CN']).prompt_recap_intro + summary.trim() : ''].filter(Boolean).join('\n\n')
/** All messages and attachments at/before the boundary leave the request together. Originals stay local. */
export const buildContextMessages = (history: Message[], recap: ContextSummary | undefined, question: UserMessage, prefix: AssistantMessage | undefined, thinking: boolean, latestReminder?: string): MessageParam[] => toSelectedRequestMessages(selectContextMessages(history, recap), question, prefix, thinking, latestReminder, contextFileId)
export const estimateContextMessages = (messages: MessageParam[], system: string, files: ReadonlyMap<string, FileAttachment>, fileTokens?: ReadonlyMap<string, number>): number => {
  const reserves = new Map([...files].map(([id, file]) => [id, fileTokens?.get(id) ?? attachmentTokenReserve(file)]))
  return estimatePayloadInputTokens({ messages, system }, reserves)
}
export type ContextUsage = { inputTokens: number; inputBudget: number; summaryTokens: number; coveredMessages: number; hasAttachments: boolean; attachmentCount: number; effectiveLength: number }
export type ContextPreviewInput = { profile: Provider; history: Message[]; question: UserMessage; prefix?: AssistantMessage; thinking: boolean; latestReminder?: string; checkpoints: ContextSummary[]; search: boolean; locale?: string; fileTokens?: ReadonlyMap<string, number> }
export const previewContextUsage = (input: ContextPreviewInput): ContextUsage => {
  const recap = validRecap(input.history, input.checkpoints), summary = recap?.text ?? ''
  const messages = buildContextMessages(input.history, recap, input.question, input.prefix, input.thinking)
  const attachmentCount = messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? 0 : message.content.filter((part) => part.type === 'image' || part.type === 'document' && part.source.type === 'file').length), 0)
  // hi.t counts the user system prompt and recap, not generated headers/JSON/protocol framing.
  const inputTokens = estimateContextMessages(messages, input.profile.system + summary, contextFiles(input.history, input.question), input.fileTokens)
  return { inputTokens, inputBudget: effectiveContextLength(input.profile), summaryTokens: estimateTokens(summary), coveredMessages: recap ? input.history.findIndex((m) => m.id === (recap.throughMessageId ?? recap.coveredIds.at(-1))) + 1 : 0, hasAttachments: attachmentCount > 0, attachmentCount, effectiveLength: effectiveContextLength(input.profile) }
}