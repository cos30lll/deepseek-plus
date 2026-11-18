import type { Provider } from '../providers.js'
import { isOfficialDeepSeek, modelInfo } from '../modelCatalog.js'
export const thinkingEnabled = (profile: Provider): boolean => modelInfo(profile).supportsThinking && profile.reasoningLevel !== 'off'
export const thinkingParameters = (profile: Provider, wanted: boolean): Record<string, unknown> => {
  const supports = modelInfo(profile).supportsThinking, enabled = supports && wanted
  if (profile.protocol === 'openai') return { ...(supports ? { thinking: { type: enabled ? 'enabled' : 'disabled' } } : {}), ...(enabled ? { reasoning_effort: profile.reasoningLevel } : {}) }
  if (isOfficialDeepSeek(profile)) return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
  return enabled ? { thinking: { type: 'enabled', budget_tokens: 4096 } } : {}
}
export const outputTokenLimit = (profile: Provider, wanted: boolean): number | null => {
  const max = profile.maxTokens && profile.maxTokens > 0 ? profile.maxTokens : null
  if (profile.protocol === 'openai' || isOfficialDeepSeek(profile)) return max
  const value = max ?? 8192
  return wanted && modelInfo(profile).supportsThinking ? Math.max(value, 5120) : value
}
export const samplingParameters = (profile: Provider, wanted: boolean): Record<string, unknown> => {
  const enabled = wanted && modelInfo(profile).supportsThinking
  if (profile.protocol === 'openai') return enabled ? { top_p: profile.topP } : { temperature: profile.temperature }
  if (isOfficialDeepSeek(profile)) return { top_p: profile.topP }
  return enabled ? {} : { temperature: profile.temperature }
}
