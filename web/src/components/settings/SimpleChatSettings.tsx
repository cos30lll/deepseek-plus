import { useState } from 'react'
import { selectProvider, useProviders } from '../../services/providers.js'
import { combinedSystemPrompt, resolveParameters, updatePresets, useChatParameters, type ChatParameters, type PromptPreset } from '../../services/chatParameters.js'
import { resolveChatProfile } from '../../services/chatParameters.js'
import { modelChoices, modelInfo } from '../../services/modelCatalog.js'
import { fetchModels } from '../../services/api/client.js'
import { updateProvider } from '../../services/providers.js'
import { reportedContextLength } from '../../services/api/contextLimits.js'
import { useSettings } from '../../services/settings.js'
import { contextProgress, useContextProgress } from '../../services/chat/context.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { validRecap } from '../../services/chat/recapPlan.js'
import { clearCurrentContextSummary, compressCurrentContext, editCurrentContextSummary, stopReply, updateCurrentChatParameters, useChatStore } from '../../services/chat/store.js'
import { useUploads } from '../../services/attachments.js'
import { formatTokenSize, parseTokenSize } from '../../utils/tokenSize.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from './settingsDialogState.js'
import './ProviderSettings.css'
const report = (error: unknown) => showToast(error instanceof Error ? error.message : String(error))
const useBusy = () => {
  const busy = useChatStore((s) => s.importingHistory || Object.keys(s.streaming).length > 0)
  const uploads = useUploads((s) => Object.values(s.tasks).some((t) => t.status === 'uploading'))
  return busy || uploads
}
export const ModelSettings = ({ onClose }: { onClose: () => void }) => {
  const state = useProviders(), base = state.rows.find((p) => p.id === state.activeId)!
  const activeId = useChatStore((s) => s.activeId)
  const session = useChatStore((s) => activeId ? s.sessionCache[activeId] : undefined)
  useChatParameters()
  const parameters = resolveParameters(base, session?.chatSettings, activeId !== null), profile = resolveChatProfile(base, session?.chatSettings, activeId !== null), info = modelInfo(profile)
  const busy = useBusy(), [loading, setLoading] = useState(false)
  const disabled = busy || loading
  const change = (patch: Partial<ChatParameters>) => { try { updateCurrentChatParameters(patch) } catch (e) { report(e) } }
  const thinking = info.supportsThinking && parameters.reasoningLevel !== 'off'
  return <Modal title={activeId ? '会话设置' : '新会话默认设置'} closable className="source-model-dialog" onClose={onClose}>
    <div className="source-settings">
      <section className="source-group"><h3>模型</h3><div>
        <label className="source-row"><span>API 配置</span><div className="source-value"><Select value={base.id} disabled={disabled} options={state.rows.map((p) => ({ value: p.id, label: p.name }))} onChange={selectProvider} /></div></label>
        <label className="source-row"><span>模型</span><div className="source-value"><Select value={parameters.model} disabled={disabled} options={modelChoices({ ...profile }).map((m) => ({ value: m.id, label: m.displayName }))} onChange={(model) => change({ model })} /></div></label>
        <label className="source-row"><span>模型 ID</span><div className="source-value"><input aria-label="模型 ID" value={parameters.model} disabled={disabled} onChange={(e) => change({ model: e.target.value.trim() })} /></div></label>
        <div className="source-actions"><Button variant="outlined" disabled={disabled} onClick={() => { const key = useSettings.getState().apiKey; if (!key) return showToast('请先填写 API Key'); setLoading(true); void fetchModels(key).then((models) => updateProvider(base.id, { models })).catch(report).finally(() => setLoading(false)) }}>获取模型</Button><Button variant="outlined" onClick={() => { onClose(); openSettings('api') }}>API 配置</Button></div>
        <label className="source-row"><span>上下文长度</span><div className="source-value"><ContextLengthInput key={`${activeId ?? 'new'}:${parameters.contextLength ?? 'auto'}:${parameters.model}`} value={parameters.contextLength ?? null} fallback={info.contextWindow} disabled={disabled} onChange={(contextLength) => change({ contextLength })} /></div></label>
        <p className="source-note">支持 32K、128K、1M（1K = 1024），留空使用模型默认值。实际窗口以接口限制为准。</p>
        <p className="source-note">{info.supportsVision ? '图片 · ' : ''}{info.supportsThinking ? '思考 · ' : ''}目录窗口 {formatTokenSize(info.contextWindow)}{reportedContextLength(profile) ? ` · 接口曾报上限 ${formatTokenSize(reportedContextLength(profile)!)}` : ''}</p>
      </div></section>
      <section className="source-group"><h3>生成参数</h3><div>
        <label className="source-row"><span>模式</span><div className="source-value"><Select value={parameters.mode} disabled={disabled} options={[{ value: 'creative', label: '文学创作' }, { value: 'roleplay', label: '角色扮演' }]} onChange={(mode) => change({ mode })} /></div></label>
        <label className="source-row"><span>思考</span><div className="source-value source-slider"><input aria-label="思考档位" type="range" min="0" max="2" step="1" disabled={disabled || !info.supportsThinking} value={parameters.reasoningLevel === 'off' ? 0 : parameters.reasoningLevel === 'high' ? 1 : 2} onChange={(e) => change({ reasoningLevel: (['off', 'high', 'max'] as const)[Number(e.target.value)] })} /><output>{!info.supportsThinking || parameters.reasoningLevel === 'off' ? '关闭' : parameters.reasoningLevel === 'high' ? 'High' : 'Max'}</output></div></label>
        {!info.supportsThinking ? <p className="source-note">当前模型无思考选项。</p> : null}
        <label className="source-row"><span>Temperature</span><div className="source-value source-slider"><input aria-label="Temperature" type="range" min="0" max="2" step="0.01" disabled={disabled || thinking} value={parameters.temperature} onChange={(e) => change({ temperature: Number(e.target.value) })} /><output>{parameters.temperature.toFixed(2)}</output></div></label>
        <label className="source-row"><span>Top P</span><div className="source-value source-slider"><input aria-label="Top P" type="range" min="0.95" max="1" step="0.01" disabled={disabled || !thinking} value={parameters.topP} onChange={(e) => change({ topP: Number(e.target.value) })} /><output>{parameters.topP.toFixed(2)}</output></div></label>
        <label className="source-row"><span>最大输出</span><div className="source-value"><OutputLimit key={`${activeId ?? 'new'}:${parameters.maxTokens}`}  value={parameters.maxTokens} disabled={disabled} onChange={(maxTokens) => change({ maxTokens })} /></div></label>
        <p className="source-note">留空使用默认值；第三方 Anthropic 默认 8192，思考时至少 5120。</p>
      </div></section>
      <PromptSettings parameters={parameters} disabled={disabled} change={change} />
      <RecapSettings key={activeId ?? 'new'} />
      <p className="source-note">{activeId ? '生成参数仅用于当前会话。' : '生成参数用于之后新建的会话。'}</p>
    </div>
  </Modal>
}
const OutputLimit = ({ value, disabled, onChange }: { value: number | null; disabled: boolean; onChange: (v: number | null) => void }) => {
  const [draft, setDraft] = useState(value === null ? '' : formatTokenSize(value, true))
  const commit = () => {
    if (!draft.trim()) { onChange(null); return }
    const n = parseTokenSize(draft)
    if (n !== null && n > 0) { onChange(n); setDraft(formatTokenSize(n, true)) }
    else { setDraft(value === null ? '' : formatTokenSize(value, true)); showToast('请输入正整数或留空') }
  }
  return <input aria-label="最大输出" placeholder="服务端默认" value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
}
const ContextLengthInput = ({ value, fallback, disabled, onChange }: { value: number | null; fallback: number; disabled: boolean; onChange: (v: number | null) => void }) => {
  const [draft, setDraft] = useState(value === null ? '' : formatTokenSize(value, true))
  const commit = () => {
    if (!draft.trim()) { onChange(null); return }
    const parsed = parseTokenSize(draft)
    if (parsed !== null) { onChange(parsed); setDraft(formatTokenSize(parsed, true)) }
    else { setDraft(value === null ? '' : formatTokenSize(value, true)); showToast('请输入正整数或 K/M 数值，留空使用默认值') }
  }
  return <input aria-label="上下文长度" autoComplete="off" spellCheck={false} placeholder={`默认 ${formatTokenSize(fallback, true)}`} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
}
const PromptSettings = ({ parameters, disabled, change }: { parameters: ChatParameters; disabled: boolean; change: (patch: Partial<ChatParameters>) => void }) => {
  const presets = useChatParameters((s) => s.presets)
  const [editor, setEditor] = useState<PromptPreset | null>(null)
  const [preview, setPreview] = useState(false)
  return <section className="source-group"><h3>系统提示词</h3><div>
    {!presets.length ? <p className="source-note">暂无预设</p> : null}
    {presets.map((preset, index) => <div className="source-row" key={preset.id}><label className="source-preset-check"><input type="checkbox" checked={parameters.enabledPresetIds.includes(preset.id)} disabled={disabled} onChange={(e) => change({ enabledPresetIds: e.target.checked ? [...parameters.enabledPresetIds, preset.id] : parameters.enabledPresetIds.filter((id) => id !== preset.id) })} />{preset.name}</label><div className="source-value source-actions"><Button variant="outlined" disabled={disabled} onClick={() => setEditor({ ...preset })}>编辑</Button>{index > 0 ? <Button variant="outlined" disabled={disabled} onClick={() => { const rows = [...presets]; [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]]; updatePresets(rows) }}>上移</Button> : null}</div></div>)}
    <div className="source-actions"><Button variant="outlined" disabled={disabled} onClick={() => setEditor({ id: crypto.randomUUID(), name: '', body: '' })}>新建预设</Button><Button variant="outlined" onClick={() => setPreview((v) => !v)}>{preview ? '收起' : '预览提示词'}</Button></div>
    <label className="source-prompt">补充提示词<textarea aria-label="补充提示词" rows={4} value={parameters.system} placeholder="补充本会话设定" disabled={disabled} onChange={(e) => change({ system: e.target.value })} /></label>
    {preview ? <pre className="source-recap-text">{combinedSystemPrompt(parameters) || '（空）'}</pre> : null}
    {editor ? <Modal className="source-model-dialog" title={presets.some((p) => p.id === editor.id) ? '编辑预设' : '新建预设'} closable onClose={() => setEditor(null)} footer={<><Button variant="outlined" disabled={disabled} onClick={() => { if (window.confirm('删除此预设？')) { updatePresets(presets.filter((p) => p.id !== editor.id)); setEditor(null) } }}>删除</Button><Button variant="outlined" onClick={() => setEditor(null)}>取消</Button><Button disabled={disabled} onClick={() => { if (!editor.name.trim()) return showToast('请填写预设名称'); updatePresets([...presets.filter((p) => p.id !== editor.id), editor].sort((a, b) => { const i = (p: PromptPreset) => { const x = presets.findIndex((v) => v.id === p.id); return x < 0 ? presets.length : x }; return i(a) - i(b) })); setEditor(null) }}>保存</Button></>}><input className="source-name" aria-label="预设名称" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} /><label className="source-prompt">正文<textarea rows={10} aria-label="预设正文" value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} /></label></Modal> : null}
  </div></section>
}
export const RecapSettings = () => {
  const activeId = useChatStore((s) => s.activeId)
  const session = useChatStore((s) => activeId ? s.sessionCache[activeId] : undefined)
  const progress = useContextProgress((s) => activeId ? s.jobs[activeId] : undefined)
  const busy = useBusy(), [saving, setSaving] = useState(false), [editing, setEditing] = useState(false), [draft, setDraft] = useState('')
  const recap = session ? validRecap(getVisibleMessages(session), session.contextSummaries ?? []) : undefined
  const disabled = busy || saving
  const action = (run: () => Promise<void>) => { setSaving(true); void run().catch(report).finally(() => setSaving(false)) }
  return <section className="source-group"><h3>前情提要</h3><div>
    <p className="source-note">保留最近至少 6 条有效消息，不删除原记录。压缩计入 API 用量。</p>
    {progress?.running ? <><p className="source-note" role="status">{progress.status}</p><pre className="source-recap-text">{progress.text || '正在等待模型…'}</pre><div className="source-actions"><Button variant="outlined" disabled={!activeId} onClick={() => activeId && stopReply(activeId)}>停止压缩</Button><Button variant="outlined" onClick={() => { if (activeId) { stopReply(activeId); contextProgress(activeId, { text: '', error: undefined }) } }}>放弃压缩</Button></div></> : <>
      <div className="source-actions"><Button variant="outlined" disabled={disabled || !session} onClick={() => action(compressCurrentContext)}>{recap ? '再次压缩' : '压缩上下文'}</Button>{recap && !editing ? <Button variant="outlined" disabled={disabled} onClick={() => { setDraft(recap.text); setEditing(true) }}>编辑提要</Button> : null}{recap ? <Button variant="outlined" disabled={disabled} onClick={() => { if (window.confirm('丢弃提要并恢复完整上下文？')) action(clearCurrentContextSummary) }}>丢弃提要</Button> : null}</div>
      {editing ? <><label className="source-prompt">前情提要正文<textarea aria-label="前情提要正文" rows={12} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} /></label><div className="source-actions"><Button variant="outlined" disabled={saving} onClick={() => setEditing(false)}>取消</Button><Button disabled={disabled} onClick={() => action(async () => { await editCurrentContextSummary(draft); setEditing(false) })}>保存</Button></div></> : recap ? <details className="source-summary"><summary>查看前情提要</summary><pre>{recap.text}</pre></details> : <p className="source-note">尚无前情提要</p>}
      {progress?.text ? <details className="source-summary"><summary>未保存的提要</summary><pre>{progress.text}</pre><Button variant="outlined" onClick={() => activeId && contextProgress(activeId, { text: '', error: undefined })}>放弃此草稿</Button></details> : null}
    </>}
    {progress?.error ? <p className="source-note" role="alert">{progress.error}</p> : !progress?.running && progress?.status ? <p className="source-note" role="status">{progress.status}</p> : null}
    <p className="source-note">提要不含图片内容，需要时请重新附图。</p>
  </div></section>
}