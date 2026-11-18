import { create } from 'zustand'
import { contextScope, parseReportedContextLength } from './api/contextLimits.js'
import { readSecret } from './native.js'
import type { ChatParameters } from './chatParameters.js'
import { setApiKey, setThinking } from './settings.js'
export type Protocol = 'deepseek' | 'openai' | 'anthropic'
export type Provider = {
  id: string; name: string; baseUrl: string; siteUrl?: string; protocol: Protocol; model: string; models: string[]
  contextLimits?: Record<string, number>
} & ChatParameters
const KEY = 'source-chat:providers'
const PARAMETER_MIGRATION = 'source-chat:simplechat-parameters-v11'
const migrateRow = (value: Provider): Provider => {
  const base = defaults(value.id, value.name)
  return { ...base, id: value.id, name: value.name, baseUrl: value.baseUrl ?? '', siteUrl: value.siteUrl ?? '', protocol: value.protocol ?? 'openai', model: value.model || base.model, models: value.models ?? [], contextLimits: value.contextLimits, ...(localStorage.getItem(PARAMETER_MIGRATION) === '1' ? { mode: value.mode ?? base.mode, system: value.system ?? '', enabledPresetIds: value.enabledPresetIds ?? [], reasoningLevel: value.reasoningLevel ?? 'off', temperature: value.temperature ?? 1, topP: value.topP ?? 1, maxTokens: value.maxTokens ?? null, contextLength: value.contextLength ?? null } : { system: value.system ?? '' }) }
}
export const ACTIVE_KEY = 'source-chat:active-provider'
const defaults = (id: string = crypto.randomUUID(), name = '自定义服务商'): Provider => ({
  id, name, baseUrl: '', siteUrl: '', protocol: 'openai', model: 'deepseek-flash', models: [],
  mode: 'creative', system: '', enabledPresetIds: [], reasoningLevel: 'off', temperature: 1, topP: 1, maxTokens: null, contextLength: null,
})
const ECAPI_SEEDED = 'source-chat:ecapi-preset-v1'
const ecapiPreset = (): Provider => ({
  ...defaults('ecapi', 'ECAPI（低价渠道）'),
  baseUrl: 'https://ecmod.zhake.win/v1',
  siteUrl: 'https://ecmod.zhake.win',
})
const addEcapiPreset = (rows: Provider[]): Provider[] => {
  if (localStorage.getItem(ECAPI_SEEDED) === '1') return rows
  const exists = rows.some((row) => {
    if (row.id === 'ecapi') return true
    try { return new URL(row.baseUrl).hostname === 'ecmod.zhake.win' } catch { return false }
  })
  return exists ? rows : [...rows, ecapiPreset()]
}
const load = (): Provider[] => {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (Array.isArray(rows) && rows.length) { const valid = rows.filter((v): v is Provider => typeof v?.id === 'string' && typeof v?.name === 'string').map(migrateRow); if (valid.length) return addEcapiPreset(valid) }
  } catch { /* Leave unrelated browser data intact. */ }
  return addEcapiPreset([{ ...defaults('deepseek', 'DeepSeek 官方'), baseUrl: 'https://api.deepseek.com', protocol: 'deepseek' }])
}
const ECAPI_LABEL_MIGRATED = 'source-chat:ecapi-label-v1'
const upgradeEcapiLabel = (rows: Provider[]): Provider[] => {
  if (localStorage.getItem(ECAPI_LABEL_MIGRATED) === '1') return rows
  return rows.map((row) => {
    if (row.id !== 'ecapi' || row.name !== 'ECAPI') return row
    try { if (new URL(row.baseUrl).hostname !== 'ecmod.zhake.win') return row } catch { return row }
    return { ...row, name: 'ECAPI（低价渠道）' }
  })
}
if (localStorage.getItem(PARAMETER_MIGRATION) !== '1' && localStorage.getItem(KEY)) localStorage.setItem('source-chat:providers-before-v11', localStorage.getItem(KEY)!)
const rows = upgradeEcapiLabel(load())
const selected = localStorage.getItem(ACTIVE_KEY)
export const useProviders = create(() => ({ rows, activeId: rows.find((v) => v.id === selected)?.id ?? rows[0].id }))
export const getProvider = (): Provider => {
  const state = useProviders.getState()
  return state.rows.find((v) => v.id === state.activeId) ?? state.rows[0]
}
const persist = () => {
  const { rows, activeId } = useProviders.getState()
  localStorage.setItem(KEY, JSON.stringify(rows))
  localStorage.setItem(ACTIVE_KEY, activeId)
  localStorage.setItem(ECAPI_SEEDED, '1')
  localStorage.setItem(ECAPI_LABEL_MIGRATED, '1')
  localStorage.setItem(PARAMETER_MIGRATION, '1')
}
export const updateProvider = (id: string, patch: Partial<Omit<Provider, 'id'>>) => {
  useProviders.setState((state) => ({ rows: state.rows.map((v) => v.id === id ? { ...v, ...patch } : v) }))
  persist()
}
export const recordContextLimit = (profile: Provider, message: string): number | undefined => {
  const limit = parseReportedContextLength(message), scope = contextScope(profile)
  if (!limit) return undefined
  const row = useProviders.getState().rows.find((item) => item.id === profile.id)
  if (row) updateProvider(profile.id, { contextLimits: { ...row.contextLimits, [scope]: limit } })
  return limit
}
export const selectProvider = (id: string) => {
  if (!useProviders.getState().rows.some((v) => v.id === id)) return
  useProviders.setState({ activeId: id }); persist()
  setApiKey(readSecret(`profile:${id}`))
  setThinking(false)
}
export const addProvider = (name: string) => {
  name = name.trim()
  if (!name) throw new Error('请填写服务商名称')
  if (useProviders.getState().rows.some((v) => v.name === name)) throw new Error('服务商名称已存在')
  const value = defaults(crypto.randomUUID(), name)
  useProviders.setState((state) => ({ rows: [...state.rows, value] }))
  selectProvider(value.id)
}
export const deleteProvider = (id: string) => {
  const state = useProviders.getState()
  if (state.rows.length <= 1) throw new Error('请至少保留一家服务商')
  const remaining = state.rows.filter((v) => v.id !== id)
  useProviders.setState({ rows: remaining })
  if (state.activeId === id) selectProvider(remaining[0].id)
  persist()
}
export const apiBase = (profile: Provider): string => {
  const raw = profile.baseUrl.trim().replace(/\/+$/, '')
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 http(s) API 地址，不要附带 Key 或查询参数')
  return raw
}
export const providerSite = (profile: Provider): string => {
  const address = profile.siteUrl?.trim() || apiBase(profile)
  const url = new URL(address)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务商网址无效')
  return url.href
}
export const endpoint = (profile: Provider, kind: 'models' | 'messages' | 'files'): string => {
  let base = apiBase(profile)
  base = base.replace(/\/(?:chat\/completions|messages|models|files)$/, '')
  if (kind === 'models') return profile.protocol === 'deepseek' ? `${base.replace(/\/(?:anthropic\/)?v1$/, '').replace(/\/anthropic$/, '')}/models` : `${base}/models`
  if (profile.protocol === 'openai') return kind === 'messages' ? `${base}/chat/completions` : `${base}/${kind}`
  if (base.endsWith('/anthropic/v1')) return `${base}/${kind}`
  if (base.endsWith('/anthropic')) return `${base}/v1/${kind}`
  if (base.includes('api.deepseek.com')) return `${base}/anthropic/v1/${kind}`
  if (!base.endsWith('/v1')) base += '/v1'

  return `${base}/${kind}`
}
persist()
useProviders.subscribe((state, previous) => {
  const current = state.rows.find((v) => v.id === state.activeId)
  const old = previous.rows.find((v) => v.id === previous.activeId)
  if (current?.model !== old?.model) setThinking(false)
})