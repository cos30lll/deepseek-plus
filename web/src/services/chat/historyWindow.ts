import type { Message } from './types.js'

export const HISTORY_PAGE_SIZE = 12
/** 只切展示页，消息树、分支、上下文、数据库和导出仍保留完整消息。 */
export const historyWindow = (messages: Message[], anchorId: string | null) => {
  const found = anchorId === null ? -1 : messages.findIndex((message) => message.id === anchorId)
  const end = found < 0 ? messages.length : found + 1
  const start = Math.max(0, end - HISTORY_PAGE_SIZE)
  return { start, end, messages: messages.slice(start, end) }
}