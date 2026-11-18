import type { Root } from 'mdast'
import type { Source } from '../chat/view.js'

type Job = {
  id: number
  content: string
  sources?: Source[]
  disableLink: boolean
  resolve: (ast: Root | null) => void
  cancelled: boolean
}
let worker: Worker | null = null
let active: Job | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0
const queue: Job[] = []

const discardWorker = () => { worker?.terminate(); worker = null }
const finish = (ast: Root | null, reset = false) => {
  clearTimeout(timer)
  const job = active
  active = null
  if (reset) discardWorker()
  if (job && !job.cancelled) job.resolve(ast)
  pump()
}
const pump = () => {
  if (active) return
  while (queue[0]?.cancelled) queue.shift()
  const job = queue.shift()
  if (!job) return
  active = job
  try {
    if (!worker) {
      worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<{ id: number; ast: Root | null }>) => {
        if (active?.id === event.data.id) finish(event.data.ast)
      }
      const instance = worker
      worker.onerror = (event) => { event.preventDefault(); if (worker === instance) finish(null, true) }
      worker.onmessageerror = () => { if (worker === instance) finish(null, true) }
    }
    // 只控制解析工作线程；超时降级为原文，不会修改消息或打断会话。
    timer = setTimeout(() => finish(null, true), 6000)
    worker.postMessage({ id: job.id, content: job.content, sources: job.sources, disableLink: job.disableLink })
  } catch {
    // 不递归地在不支持 Worker 的环境批量失败，给 UI 留出绘制机会。
    timer = setTimeout(() => finish(null, true), 0)
  }
}

/** 可取消的串行工作线程解析；任何失败只回落原文，主线程从不补跑同步解析。 */
export const parseMarkdownAsync = (content: string, sources: Source[] | undefined, disableLink: boolean) => {
  let job: Job
  const promise = new Promise<Root | null>((resolve) => {
    job = { id: ++sequence, content, sources, disableLink, resolve, cancelled: false }
    queue.push(job)
  })
  pump()
  return {
    promise,
    cancel: () => {
      job.cancelled = true
      job.resolve(null)
      if (active === job) finish(null, true)
      else { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1) }
    },
  }
}