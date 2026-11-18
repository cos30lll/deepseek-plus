import type { Provider } from '../providers.js'
import { customContextLength, effectiveContextLength } from './contextLimits.js'
/** do0.O/P + uk0.I: UTF-16 character heuristic; never a provider tokenizer. */
export const estimateTokens = (text: string): number => {
  if (!text.length) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c >= 19968 && c < 40960 || c >= 13312 && c < 19904 || c >= 12352 && c < 12544 || c >= 44032 && c < 55216) cjk++ }
  return Math.max(1, Math.round((text.length - cjk) / 4 + cjk / 1.5))
}
export const IMAGE_TOKEN_RESERVE = 1024
export const attachmentTokenReserve = (file: { isImage: boolean; size: number }): number => file.isImage ? IMAGE_TOKEN_RESERVE : 0
export const estimatePayloadInputTokens = (payload: Record<string, unknown>, fileTokens: ReadonlyMap<string, number> = new Map()): number => {
  let count = 0
  const texts: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { texts.push(value); return }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const v = value as Record<string, unknown>
    if (v.type === 'image' || v.type === 'image_url') { count += IMAGE_TOKEN_RESERVE; return }
    if (v.type === 'document') { count += fileTokens.get((v.source as { file_id?: string })?.file_id ?? '') ?? 0; return }
    if (v.type === 'text') { visit(v.text); return }
    if ('content' in v) visit(v.content)
  }
  visit(payload.system); visit(payload.messages)
  return estimateTokens(texts.join('')) + count
}
/** Only an explicit custom window blocks an estimated overflow. No automatic compression or clipping. */
export const assertPayloadFits = (profile: Provider, payload: Record<string, unknown>, fileTokens?: ReadonlyMap<string, number>) => {
  const estimated = estimatePayloadInputTokens(payload, fileTokens), limit = effectiveContextLength(profile)
  const output = typeof payload.max_tokens === 'number' && Number.isSafeInteger(payload.max_tokens) && payload.max_tokens > 0 ? payload.max_tokens : 0
  if (customContextLength(profile) !== undefined && estimated + output > limit) throw new Error(`请求未发送：输入约 ${estimated}${output ? ` + 最大输出 ${output}` : ''} Token，超过上下文长度 ${limit}。请压缩上下文或减少内容。`)
}
