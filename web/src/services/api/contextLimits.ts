import type { Provider } from '../providers.js'
import { modelInfo } from '../modelCatalog.js'
export const contextScope = (profile: Pick<Provider, 'protocol' | 'baseUrl' | 'model'>): string => {
  let base = profile.baseUrl.trim().replace(/\/+$/, '')
  try { base = new URL(base).href.replace(/\/+$/, '') } catch { /* Settings may still be incomplete. */ }
  return `${profile.protocol}|${base}|${profile.model.trim()}`
}
export const reportedContextLength = (profile: Provider): number | undefined => {
  const value = profile.contextLimits?.[contextScope(profile)]
  return Number.isSafeInteger(value) && value! >= 4096 && value! <= 2097152 ? value : undefined
}
/** Optional local window override; never an unsupported context_length API parameter. */
export const customContextLength = (profile: Pick<Provider, 'contextLength'>): number | undefined => Number.isSafeInteger(profile.contextLength) && profile.contextLength! > 0 ? profile.contextLength! : undefined
export const effectiveContextLength = (profile: Provider): number => customContextLength(profile) ?? modelInfo(profile).contextWindow
/** Only explicit admission limits, never the request token count or output-token limit. */
export const parseReportedContextLength = (message: string): number | undefined => {
  const patterns = [
    /(?:maximum|max)\s+context\s+(?:length|window)\s*(?:(?:is|of|:)\s*)?([\d,]+)\s*tokens?/i,
    /context\s+(?:window\s+)?(?:limit|length)\s*(?:is|of|:|=)\s*([\d,]+)\s*tokens?/i,
    /(?:上下文|输入)[^\d\n]{0,12}(?:上限|最大长度|最大限制)[^\d\n]{0,8}([\d,]+)\s*(?:tokens?|令牌)/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    if (!match) continue
    const value = Number(match[1].replaceAll(',', ''))
    if (Number.isSafeInteger(value) && value >= 4096 && value <= 2097152) return value
  }
  return undefined
}
