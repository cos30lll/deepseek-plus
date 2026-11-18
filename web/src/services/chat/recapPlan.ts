import type { ContextSummary, Message } from './types.js'
import { getReplyText } from './reply.js'
export const messageText = (message: Message): string => message.role === 'user' ? message.content : getReplyText(message)
export const isStreamingMessage = (message: Message): boolean => message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming')
export const validRecap = (path: Message[], rows: ContextSummary[]): ContextSummary | undefined => rows.filter((r) => !!r.text.trim() && path.some((m) => m.id === (r.throughMessageId ?? r.coveredIds.at(-1)))).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0]
export const recapBoundary = (path: Message[], recap?: ContextSummary): number => recap ? path.findIndex((m) => m.id === (recap.throughMessageId ?? recap.coveredIds.at(-1))) : -1
/** mn0.J: boundary first, non-streaming/nonempty next, start with a user. Not turn pairs. */
export const selectContextMessages = (path: Message[], recap?: ContextSummary): Message[] => {
  const messages = path.slice(recapBoundary(path, recap) + 1).filter((m) => !isStreamingMessage(m) && (messageText(m).trim() || m.role === 'user' && m.files.length))
  const first = messages.findIndex((m) => m.role === 'user')
  return first < 0 ? [] : messages.slice(first)
}
/** mt.a: only nonempty text counts toward the six-message tail; rewind cut to USER. */
export const planRecap = (path: Message[], recap?: ContextSummary) => {
  const candidates = path.slice(recapBoundary(path, recap) + 1).filter((m) => !isStreamingMessage(m) && !!messageText(m).trim())
  let cut = Math.max(0, candidates.length - 6)
  while (cut > 0 && candidates[cut].role !== 'user') cut--
  const prefix = candidates.slice(0, cut)
  return { prefix, tail: candidates.slice(cut), throughMessageId: prefix.at(-1)?.id }
}