/** Buffered JSON reader. Arrays are consumed one item at a time; skipped values are never accumulated. */
export class JsonReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private buffer = ''; private offset = 0; private ended = false; private lastYield = performance.now()
  constructor(blob: Blob) { this.reader = blob.stream().getReader() }
  private async fill(): Promise<boolean> {
    if (this.offset < this.buffer.length) return true
    if (this.ended) return false
    if (performance.now() - this.lastYield >= 40) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); this.lastYield = performance.now() }
    const { value, done } = await this.reader.read()
    this.buffer = this.decoder.decode(value, { stream: !done }); this.offset = 0; this.ended = done
    return this.buffer.length > 0 || !done && this.fill()
  }
  async peek(): Promise<string> {
    while (await this.fill()) {
      while (this.offset < this.buffer.length && /\s/.test(this.buffer[this.offset])) this.offset++
      if (this.offset < this.buffer.length) return this.buffer[this.offset]
    }
    return ''
  }
  async take(expected: string): Promise<void> {
    if (await this.peek() !== expected) throw new Error('JSON 结构不完整')
    this.offset++
  }
  async raw(keep = true): Promise<string> {
    const first = await this.peek()
    if (!first) throw new Error('JSON 提前结束')
    const parts: string[] = []
    let depth = 0, quoted = false, escaped = false, started = false
    while (await this.fill()) {
      const start = this.offset
      while (this.offset < this.buffer.length) {
        const ch = this.buffer[this.offset]
        if (!quoted && started && depth === 0 && /[\s,\]}]/.test(ch)) {
          if (keep) parts.push(this.buffer.slice(start, this.offset))
          return parts.join('')
        }
        started = true; this.offset++
        if (quoted) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') { quoted = false; if (depth === 0) { if (keep) parts.push(this.buffer.slice(start, this.offset)); return parts.join('') } }
        } else if (ch === '"') quoted = true
        else if (ch === '[' || ch === '{') depth++
        else if (ch === ']' || ch === '}') {
          depth--
          if (depth < 0) throw new Error('JSON 结构无效')
          if (depth === 0) { if (keep) parts.push(this.buffer.slice(start, this.offset)); return parts.join('') }
        }
      }
      if (keep) parts.push(this.buffer.slice(start, this.offset))
    }
    if (!started || quoted || depth !== 0) throw new Error('JSON 结构不完整')
    return parts.join('')
  }
  async value(): Promise<unknown> { return JSON.parse(await this.raw()) }
  async end(): Promise<void> { if (await this.peek()) throw new Error('JSON 尾部有多余内容') }
  async close(): Promise<void> { await this.reader.cancel().catch(() => {}); this.reader.releaseLock() }
  async *array(): AsyncGenerator<unknown> {
    await this.take('[')
    if (await this.peek() !== ']') {
      while (true) { yield await this.value(); if (await this.peek() !== ',') break; await this.take(',') }
    }
    await this.take(']')
  }
  async *keys(): AsyncGenerator<string> {
    const seen = new Set<string>()
    await this.take('{')
    if (await this.peek() !== '}') {
      while (true) {
        const key = await this.value()
        if (typeof key !== 'string' || seen.has(key)) throw new Error('JSON 字段名无效')
        seen.add(key)
        await this.take(':'); yield key
        if (await this.peek() !== ',') break
        await this.take(',')
      }
    }
    await this.take('}'); await this.end()
  }
}
export const objectMetadata = async (blob: Blob, skipped: Set<string>): Promise<Record<string, unknown>> => {
  const reader = new JsonReader(blob), result: Record<string, unknown> = Object.create(null)
  try { for await (const key of reader.keys()) { if (skipped.has(key)) { if (await reader.peek() !== '[') throw new Error('消息列表格式无效'); await reader.raw(false); result[key] = null } else result[key] = await reader.value() } }
  finally { await reader.close() }
  return result
}
export async function* objectArray(blob: Blob, name: string): AsyncGenerator<unknown> {
  const reader = new JsonReader(blob)
  try { for await (const key of reader.keys()) { if (key === name) yield* reader.array(); else await reader.raw(false) } }
  finally { await reader.close() }
}