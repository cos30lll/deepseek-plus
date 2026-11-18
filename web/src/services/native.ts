type NativeApi = {
  getSecret(key: string): string
  setSecret(key: string, value: string): boolean
  request(id: string, url: string, method: string, headers: string, body: string): void
  cancel(id: string): void
  saveFile(name: string, content: string): void
  openExternal(url: string): void
}
declare global {
  interface Window {
    NativeApi?: NativeApi
    __nativeResponse?: (id: string, kind: string, value: string) => void
    __sourceBack?: () => boolean
  }
}
export const readSecret = (key: string): string | null => {
  if (window.NativeApi) return window.NativeApi.getSecret(key) || null
  return sessionStorage.getItem(`source-secret:${key}`)
}
export const writeSecret = (key: string, value: string): void => {
  if (window.NativeApi) {
    if (!window.NativeApi.setSecret(key, value)) throw new Error('安全存储写入失败')
  } else {
    // Standalone web build: credentials are session-only, never localStorage.
    if (value) sessionStorage.setItem(`source-secret:${key}`, value)
    else sessionStorage.removeItem(`source-secret:${key}`)
  }
}
const base64 = (bytes: Uint8Array): string => {
  let result = ''
  for (let i = 0; i < bytes.length; i += 16384) result += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(result)
}
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
type Job = {
  resolve: (value: Response) => void
  reject: (reason: Error) => void
  stream: ReadableStreamDefaultController<Uint8Array>
  cleanup: () => void
  headers: boolean
}
const jobs = new Map<string, Job>()
window.__nativeResponse = (id, kind, value) => {
  const job = jobs.get(id)
  if (!job) return
  try {
    if (kind === 'headers') {
      const { status, headers } = JSON.parse(value) as { status: number; headers: Record<string, string> }
      if (status === 204 || status === 205 || status === 304) { job.resolve(new Response(null, { status, headers })); job.cleanup(); jobs.delete(id); return }
      job.headers = true
      job.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { job.stream = controller },
        cancel() { window.NativeApi?.cancel(id); job.cleanup(); jobs.delete(id) },
      }), { status, headers }))
    } else if (kind === 'data') job.stream.enqueue(decode(value))
    else if (kind === 'end') { job.stream.close(); job.cleanup(); jobs.delete(id) }
    else throw new Error(value || '网络请求失败')
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (job.headers) job.stream?.error(failure)
    else job.reject(failure)
    job.cleanup(); jobs.delete(id)
  }
}
export const nativeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  if (!window.NativeApi) return fetch(url, init)
  init.signal?.throwIfAborted()
  const headers = new Headers(init.headers)
  let body = ''
  if (init.body !== undefined && init.body !== null) {
    const serial = new Response(init.body)
    if (!headers.has('Content-Type') && serial.headers.has('Content-Type')) headers.set('Content-Type', serial.headers.get('Content-Type')!)
    const bytes = new Uint8Array(await serial.arrayBuffer())
    if (bytes.length > 40 * 1024 * 1024) throw new Error('单次请求超过 40 MiB 上限')
    body = base64(bytes)
  }
  init.signal?.throwIfAborted()
  const id = crypto.randomUUID()
  return new Promise<Response>((resolve, reject) => {
    const abort = () => {
      const job = jobs.get(id)
      if (!job) return
      const error = new DOMException('请求已停止', 'AbortError')
      if (job.headers) job.stream?.error(error)
      else reject(error)
      jobs.delete(id); job.cleanup(); window.NativeApi?.cancel(id)
    }
    const cleanup = () => init.signal?.removeEventListener('abort', abort)
    jobs.set(id, { resolve, reject, cleanup, headers: false, stream: undefined as unknown as ReadableStreamDefaultController<Uint8Array> })
    init.signal?.addEventListener('abort', abort, { once: true })
    try { window.NativeApi!.request(id, url, init.method ?? 'GET', JSON.stringify(Object.fromEntries(headers.entries())), body) }
    catch (error) { jobs.delete(id); cleanup(); reject(error) }
  })
}
export const saveNativeFile = async (name: string, blob: Blob): Promise<boolean> => {
  if (!window.NativeApi) return false
  if (blob.size > 64 * 1024 * 1024) throw new Error('导出文件超过 64 MiB，请使用网页版导出')
  window.NativeApi.saveFile(name, base64(new Uint8Array(await blob.arrayBuffer())))
  return true
}

export const openExternal = (address: string): void => {
  const url = new URL(address)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('服务商地址无效')
  if (window.NativeApi) {
    window.NativeApi.openExternal(url.href)
  } else {
    const link = document.createElement('a')
    link.href = url.href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.click()
  }
}
