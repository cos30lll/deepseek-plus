import type { Source } from '../chat/view.js'
import { parseBoundedMarkdown } from './parseBounded.js'

/** 工作线程只解析本地文本，超时由调用方终止。 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; content: string; sources?: Source[]; disableLink: boolean }>) => void) | null
  postMessage(value: unknown): void
}
scope.onmessage = ({ data }) => {
  const ast = parseBoundedMarkdown(data.content, { sources: data.sources, disableLink: data.disableLink })
  scope.postMessage({ id: data.id, ast })
}