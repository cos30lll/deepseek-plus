import { toMdAst } from './parse.js'
import type { Source } from '../chat/view.js'

/** 只接收本地内存中的文本，不联网；解析卡住时主线程可终止本 Worker。 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; content: string; sources?: Source[]; disableLink: boolean }>) => void) | null
  postMessage(value: unknown): void
}
scope.onmessage = ({ data }) => {
  try {
    const ast = toMdAst(data.content, { sources: data.sources, disableLink: data.disableLink })
    const queue: { node: unknown; depth: number }[] = [{ node: ast, depth: 0 }]
    let count = 0
    while (queue.length) {
      const { node, depth } = queue.pop()!
      if (++count > 5000 || depth > 80) {
        scope.postMessage({ id: data.id, ast: null })
        return
      }
      if (node && typeof node === 'object' && 'children' in node && Array.isArray(node.children)) {
        for (const child of node.children) queue.push({ node: child, depth: depth + 1 })
      }
    }
    scope.postMessage({ id: data.id, ast })
  } catch {
    // 不传递错误原文，避免解析器错误内容带入消息正文。
    scope.postMessage({ id: data.id, ast: null })
  }
}