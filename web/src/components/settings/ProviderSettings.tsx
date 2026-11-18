import { ModelSettings } from './SimpleChatSettings.js'
export { ModelSettings } from './SimpleChatSettings.js'
import { useChatStore } from '../../services/chat/store.js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { addProvider, deleteProvider, getProvider, providerSite, selectProvider, updateProvider, useProviders } from '../../services/providers.js'
import { setApiKey, useSettings } from '../../services/settings.js'
import { fetchModels } from '../../services/api/client.js'
import { openExternal, writeSecret } from '../../services/native.js'
import { useUploads } from '../../services/attachments.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import './ProviderSettings.css'
const useBusy = () => {
  const generating = useChatStore((s) => Object.keys(s.streaming).length > 0)
  const uploading = useUploads((s) => Object.values(s.tasks).some((v) => v.status === 'uploading'))
  return generating || uploading
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="source-row"><span>{label}</span><div className="source-value">{children}</div></div>
const Group = ({ title, children }: { title: string; children: ReactNode }) => <section className="source-group"><h3>{title}</h3><div>{children}</div></section>
const report = (error: unknown) => showToast(error instanceof Error ? error.message : String(error))
const useModels = () => {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const fetch = async () => {
    if (busy) return
    const profile = getProvider(), key = useSettings.getState().apiKey
    if (!key || !profile.baseUrl) { setStatus('请先填写 Base URL 和 API Key'); return }
    setBusy(true); setStatus('正在获取模型…')
    const token = new AbortController(); controller.current = token
    try {
      const models = await fetchModels(key, token.signal)
      if (token.signal.aborted) return
      updateProvider(profile.id, { models, ...(!profile.model && models.length ? { model: models[0] } : {}) })
      setStatus(`已获取 ${models.length} 个模型`)
    } catch (error) { if (!token.signal.aborted) setStatus(error instanceof Error ? error.message : String(error)) }
    finally { if (!token.signal.aborted) setBusy(false) }
  }
  return { busy, status, fetch }
}
export const ProviderSettings = () => {
  const state = useProviders()
  const profile = state.rows.find((p) => p.id === state.activeId)!
  const key = useSettings((s) => s.apiKey)
  const busy = useBusy()
  const models = useModels()
  const [editor, setEditor] = useState<'add' | 'rename' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const disabled = busy || models.busy
  const [modelOpen, setModelOpen] = useState(false)
  return <div className="source-settings">
    <Group title="API 配置管理"><Row label="当前服务商"><Select value={profile.id} options={state.rows.map((p) => ({ value: p.id, label: p.name }))} disabled={disabled} onChange={selectProvider} /></Row>
      <div className="source-actions"><Button variant="outlined" disabled={disabled} onClick={() => { setName(''); setEditor('add') }}>添加服务商</Button><Button variant="outlined" disabled={disabled} onClick={() => { setName(profile.name); setEditor('rename') }}>重命名</Button><Button variant="outlined" disabled={disabled || state.rows.length < 2} onClick={() => setEditor('delete')}>删除</Button></div></Group>
    <Group title="服务"><Row label="Base URL"><input aria-label="Base URL" value={profile.baseUrl} placeholder="https://example.com/v1" disabled={disabled} onChange={(e) => updateProvider(profile.id, { baseUrl: e.target.value })} /></Row>
      <Row label="服务商网址"><input aria-label="服务商网址" value={profile.siteUrl ?? ''} placeholder="选填" disabled={disabled} onChange={(e) => updateProvider(profile.id, { siteUrl: e.target.value })} /></Row>
      <Row label="协议通道"><Select value={profile.protocol} disabled={disabled} options={[{ value: 'deepseek', label: 'DeepSeek 官方扩展' }, { value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic 兼容' }]} onChange={(protocol) => updateProvider(profile.id, { protocol })} /></Row>
</Group>
    <Group title="鉴权"><Row label="API Key"><input key={profile.id} aria-label="API Key" type="password" autoComplete="off" spellCheck={false} value={key ?? ''} disabled={disabled} placeholder="sk-…" onChange={(e) => { try { setApiKey(e.target.value.trim()) } catch (error) { report(error) } }} /></Row><div className="source-actions"><Button variant="outlined" disabled={disabled} onClick={() => void models.fetch()}>{models.busy ? '正在获取…' : '获取模型'}</Button><Button variant="outlined" onClick={() => setModelOpen(true)}>模型设置</Button><Button variant="outlined" onClick={() => { try { const current = getProvider(); if (!current.siteUrl?.trim() && !current.baseUrl.trim()) throw new Error('请先填写服务商地址'); openExternal(providerSite(current)) } catch (error) { report(error) } }}>获取 Key</Button></div>{models.status ? <p className="source-note" role="status">{models.status}</p> : null}</Group>
    {busy ? <p className="source-note">任务进行中</p> : null}
    {editor ? <Modal title={editor === 'add' ? '添加服务商' : editor === 'rename' ? '重命名服务商' : '删除服务商'} onClose={() => setEditor(null)} footer={<><Button variant="outlined" onClick={() => setEditor(null)}>取消</Button><Button onClick={() => { try { if (editor === 'add') addProvider(name); else if (editor === 'rename') { if (!name.trim()) throw new Error('请填写服务商名称'); updateProvider(profile.id, { name: name.trim() }) } else { writeSecret(`profile:${profile.id}`, ''); deleteProvider(profile.id) } setEditor(null) } catch (error) { report(error) } }}>确认</Button></>}>
      {editor === 'delete' ? <p>删除“{profile.name}”的配置和 Key？</p> : <input className="source-name" autoFocus aria-label="服务商名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="服务商名称" />}</Modal> : null}
    {modelOpen ? <ModelSettings onClose={() => setModelOpen(false)} /> : null}
  </div>
}
