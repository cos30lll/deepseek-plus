import type { Root } from 'mdast'
import { toMdAst } from './parse.js'

/** Bound the amount of formatted content React can mount for one message. */
export const parseBoundedMarkdown = (
  content: string,
  options: Parameters<typeof toMdAst>[1]
): Root | null => {
  try {
    const ast = toMdAst(content, options)
    const pending: { node: unknown; depth: number }[] = [{ node: ast, depth: 0 }]
    let count = 0
    while (pending.length) {
      const { node, depth } = pending.pop()!
      if (++count > 5000 || depth > 80) return null
      if (node && typeof node === 'object' && 'children' in node && Array.isArray(node.children)) {
        for (const child of node.children) pending.push({ node: child, depth: depth + 1 })
      }
    }
    return ast
  } catch {
    return null
  }
}
