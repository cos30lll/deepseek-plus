import { create } from 'zustand'
import type { Provider } from './providers.js'
import { removeBuiltInPresets } from './presetMigration.js'
export type ReasoningLevel = 'off' | 'high' | 'max'
export type ChatParameters = {
  mode: 'creative' | 'roleplay'; model: string; system: string; enabledPresetIds: string[]
  reasoningLevel: ReasoningLevel; temperature: number; topP: number; maxTokens: number | null; contextLength: number | null
}
export const REFERENCE_DEFAULTS: ChatParameters = { mode: 'creative', model: 'deepseek-flash', system: '', enabledPresetIds: [], reasoningLevel: 'off', temperature: 1, topP: 1, maxTokens: null, contextLength: null }
export type PromptPreset = { id: string; name: string; body: string }
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback } catch { return fallback } }
const loadPresets = (): PromptPreset[] => {
  const rows = read<PromptPreset[]>('simplechat:presets', [])
  const kept = removeBuiltInPresets(rows)
  if (kept.length !== rows.length) {
    try {
      // Publish the filtered list only; do not visit/rewrite user conversations or keys.
      localStorage.setItem('simplechat:presets', JSON.stringify(kept))
    } catch { /* Filtering still applies in memory when persistence is unavailable. */ }
  }
  return kept
}
export const useChatParameters = create(() => ({ defaults: read<Partial<ChatParameters>>('simplechat:defaults', {}), presets: loadPresets() }))
export const updateDefaultChatParameters = (patch: Partial<ChatParameters>) => {
  const defaults = { ...useChatParameters.getState().defaults, ...patch }
  localStorage.setItem('simplechat:defaults', JSON.stringify(defaults))
  useChatParameters.setState({ defaults })
}
export const updatePresets = (presets: PromptPreset[]) => {
  localStorage.setItem('simplechat:presets', JSON.stringify(presets))
  useChatParameters.setState({ presets })
}
export const resolveParameters = (profile: Provider, settings?: Partial<ChatParameters>, existing = false): ChatParameters => ({ ...REFERENCE_DEFAULTS, model: profile.model || REFERENCE_DEFAULTS.model, system: profile.system, ...(!existing ? useChatParameters.getState().defaults : {}), ...settings })
/** b70.a: preset list order, then the trimmed conversation-specific extra prompt. */
export const combinedSystemPrompt = (settings: ChatParameters): string => [
  ...useChatParameters.getState().presets.filter((p) => settings.enabledPresetIds.includes(p.id)).map((p) => p.body.trim()).filter(Boolean), settings.system.trim(),
].filter(Boolean).join('\n\n')
export const resolveChatProfile = (profile: Provider, settings?: Partial<ChatParameters>, existing = false): Provider => {
  const parameters = resolveParameters(profile, settings, existing)
  return { ...profile, ...parameters, system: combinedSystemPrompt(parameters) }
}

export const restoreParameterSettings = (settings: { defaults?: Partial<ChatParameters>; presets: PromptPreset[] }): void => {
  const keys = ['simplechat:defaults', 'simplechat:presets'], before = keys.map((key) => localStorage.getItem(key))
  const defaults = settings.defaults ?? useChatParameters.getState().defaults
  try { localStorage.setItem(keys[0], JSON.stringify(defaults)); localStorage.setItem(keys[1], JSON.stringify(settings.presets)) }
  catch (error) { keys.forEach((key, i) => { try { if (before[i] === null) localStorage.removeItem(key); else localStorage.setItem(key, before[i]!) } catch { /* Surface the original failure. */ } }); throw error }
  useChatParameters.setState({ defaults, presets: settings.presets })
}
