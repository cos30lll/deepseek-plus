import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'
const root = new URL('./src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root) && url.endsWith('.ts')) {
      let source = readFileSync(fileURLToPath(url), 'utf8')
      if (url.endsWith('/chat/describe.ts')) source = 'export const describeReply = () => null'
      if (url.endsWith('/i18n/index.ts')) source = 'export const translate = (key: string) => key; export const isTranslationKey = (key: unknown) => typeof key === "string"'
      if (url.endsWith('/history/errors.ts')) source = source.replace(/^import .*from .*i18n.*$/m, 'const translate = (key: string) => key')
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return next(url, context)
  },
})
const base = new URL('services/chat/', root)
const db = await import(new URL('db.ts', base))
const { readImportInput } = await import(new URL('history/input.ts', base))
const { runImport, newImportReport } = await import(new URL('history/importer.ts', base))
const { exportCompleteArchive } = await import(new URL('history/completeArchive.ts', base))
const { writeArchive } = await import(new URL('history/zipWriter.ts', base))
const { restoreTree } = await import(new URL('history/portable.ts', base))
const { getVisibleMessages } = await import(new URL('branches.ts', base))
const { objectArray, objectMetadata } = await import(new URL('history/jsonStream.ts', base))
const { openArchive } = await import(new URL('history/zipReader.ts', base))
let settings = { defaults: {}, presets: [] }
const opts = (mode = 'merge') => ({ mode, repair: true, settings: true })
const json = (v) => new Blob([JSON.stringify(v)], { type: 'application/json' })
const file = (v, name = 'backup.json') => new File([json(v)], name)
const native = (id, title = id) => ({ id, title, createdAt: 1, updatedAt: 2, rootMessageId: 'u', messages: [{ id: 'u', role: 'user', parentId: null, selectedChildId: 'a', content: 'question', files: [], createdAt: 1 }, { id: 'a', parentId: 'u', role: 'assistant', model: 'model', status: 'done', prefix: false, blocks: [{ type: 'thinking', thinking: 'reason', elapsedSeconds: 1.5 }, { type: 'text', text: 'answer' }], createdAt: 2 }] })
const foreign = (id, title = id) => ({ id, title, createdAt: 1, updatedAt: 2, messages: [{ id: 'u', parentId: null, active: true, role: 'user', content: 'question', createdAt: 1 }, { id: 'a', parentId: 'u', active: true, role: 'assistant', content: 'answer', reasoning: 'reason', createdAt: 2 }] })
const simple = (conversations, presets = []) => ({ format: 'simplechat-backup', version: 2, conversations, presets })
const run = async (f, options = opts(), control, onReport = () => {}) => {
  let summaries = await db.loadSessionSummaries()
  return runImport(await readImportInput(f, options.repair, control), options, {
    summaries: () => summaries, settings: () => settings, saveSettings: (s) => { settings = structuredClone(s) },
    commit: db.commitImportedSession,
    committed: (session, id) => { summaries = [...summaries.filter((s) => s.id !== session.id && s.id !== id), session] },
    saveReport: db.saveImportReport,
  }, newImportReport(options), onReport, control)
}
const tests = []
const test = async (name, fn) => { if (process.env.IMPORT_CASE && process.env.IMPORT_CASE !== name) return; await fn(); tests.push(name); console.log('PASS', name) }
await test('three_modes_and_partial_failure', async () => {
  await db.saveSession(native('kept', 'shared'))
  let r = await run(file(simple([foreign('new', 'shared'), { id: 'broken', messages: [{ id: '', role: 'user' }] }, foreign('later')])))
  assert.equal(r.imported, 2); assert.equal(r.failed, 1); assert.equal(r.completed, true)
  assert.ok(await db.loadSession('kept')); assert.ok(await db.loadSession('later'))
  r = await run(file(simple([foreign('new', 'changed title')])))
  assert.equal(r.skipped, 1); assert.equal((await db.loadSession('new')).title, 'shared')
  r = await run(file(simple([foreign('replacement', 'shared')])), opts('replace_same'))
  assert.equal(r.imported, 1); assert.equal(await db.loadSession('kept'), undefined); assert.ok(await db.loadSession('new'))
  r = await run(file(simple([foreign('new', 'shared')])), opts('rename'))
  const copy = await db.loadSession(r.sessions[0].targetId)
  assert.ok(copy.id.startsWith('new~')); assert.notEqual(copy.messages[0].id, 'u')
  assert.equal(getVisibleMessages(copy).length, 2); assert.ok(copy.title.includes('副本'))
})
await test('atomic_replacement_and_shared_original', async () => {
  const shared = { id: 'shared-file', name: 'shared.bin', size: 4, serverId: null, isImage: false, mimeType: 'application/octet-stream' }
  const a = native('atomic'), b = native('shared-owner'); a.messages[0].files = [shared]; b.messages[0].files = [shared]
  await db.saveSession(a, [{ id: shared.id, blob: new Blob(['keep']) }]); await db.saveSession(b)
  const invalid = native('atomic'); invalid.cannotClone = () => {}
  await assert.rejects(db.commitImportedSession(invalid, [{ id: 'rollback-file', blob: new Blob(['must rollback']) }], 'atomic', { version: 1 }))
  assert.equal((await db.loadSession('atomic')).messages[0].content, 'question'); assert.equal(await db.loadFile('rollback-file'), undefined)
  await db.commitImportedSession(native('atomic'), [], 'atomic')
  assert.equal(await (await db.loadFile('shared-file')).text(), 'keep')
  await db.deleteSession('shared-owner'); assert.equal(await db.loadFile('shared-file'), undefined)
})
await test('attachments_preset_conflicts_and_complete_roundtrip', async () => {
  settings.presets = [{ id: 'p', name: 'local', body: 'local body' }]
  const row = foreign('with-files'); row.enabledPresetIds = ['p']; row.systemPrompt = 'system'; row.pinned = true
  row.messages[0].attachments = [{ kind: 'FILE', name: 'text.txt', mime: 'text/plain', data: btoa('text') }]
  row.messages[1].attachments = [{ kind: 'IMAGE', name: 'result.png', mime: 'image/png', data: btoa('image') }]
  const r = await run(file(simple([row], [{ id: 'p', name: 'imported', content: 'imported body' }])))
  assert.equal(r.imported, 1); assert.equal(r.missingFiles, 0); assert.equal(r.presets, 1)
  const s = await db.loadSession('with-files'), pid = s.chatSettings.enabledPresetIds[0]
  assert.notEqual(pid, 'p'); assert.equal(settings.presets.find((p) => p.id === pid).body, 'imported body')
  assert.ok(s.messages.every((m) => m.files?.[0].id.startsWith('import:')))
  s.chatSettings.contextLength = 64000; s.chatSettings.temperature = 0.4
  s.contextSummaries = [{ id: 'recap', coveredIds: ['u'], throughMessageId: 'u', providerId: 'local-profile', model: 'model', fingerprint: 'fp', text: 'recap text', createdAt: 1 }]
  const backup = await exportCompleteArchive((async function* () { yield s })(), settings, db.loadFile)
  const input = await readImportInput(new File([backup], 'complete.zip'), true)
  const tasks = []; for await (const t of input.tasks) tasks.push(t)
  const candidate = await tasks[0].load()
  assert.equal(candidate.session.chatSettings.contextLength, 64000); assert.equal(candidate.session.contextSummaries[0].text, 'recap text')
  assert.equal(candidate.files.length, 2); assert.equal(candidate.session.messages[1].files[0].name, 'result.png')
  assert.equal(candidate.session.pinned, true); assert.equal(candidate.session.messages[0].files[0].serverId, null)
  assert.equal(candidate.session.messages[1].blocks[0].thinking, 'reason')
  const copyResult = await run(new File([backup], 'complete.zip'), opts('rename'))
  const copy = await db.loadSession(copyResult.sessions[0].targetId)
  assert.equal(copy.contextSummaries[0].throughMessageId, copy.messages[0].id)
  assert.equal(copy.contextSummaries[0].coveredIds[0], copy.messages[0].id)
  const z = await openArchive(new File([backup], 'complete.zip')); const all = (await Promise.all(z.names.filter((n) => n.endsWith('.json')).map(async (n) => (await z.get(n)).text()))).join('')
  assert.ok(!all.includes('apiKey')); assert.ok(!all.includes('source-secret:'))
})
await test('orphan_cycle_repair_and_duplicate_rejection', async () => {
  const s = native('repair'); s.messages[0].parentId = 'a'; s.messages[1].parentId = 'u'; s.rootMessageId = null
  assert.throws(() => restoreTree(s, false)); const fixed = restoreTree(s, true)
  assert.ok(fixed.repaired > 0); assert.equal(getVisibleMessages(fixed.session).length, 2)
  const orphan = native('orphan'); orphan.messages[0].parentId = 'absent'; assert.ok(restoreTree(orphan, true).repaired > 0)
  const duplicate = native('duplicate'); duplicate.messages[1].id = 'u'; assert.throws(() => restoreTree(duplicate, true))
})
await test('simplechat_zip_and_chatbox_json_zip', async () => {
  const blob = await writeArchive([{ name: 'manifest.json', blob: json({ format: 'simplechat-archive', version: 1 }) }, { name: 'backup.json', blob: json(simple([foreign('simple-zip')])) }])
  assert.equal((await run(new File([blob], 'simple.zip'))).imported, 1)
  const cb = { name: 'Chatbox session', messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello', timestamp: '1700000000000' }, { role: 'assistant', contentParts: [{ type: 'reasoning', text: 'reason' }, { type: 'text', text: 'answer' }, { type: 'image', storageKey: 'storage-1' }], timestamp: 1700000001000 }], settings: { modelId: 'arbitrary-model' } }
  let r = await run(file({ format: 'chatbox-backup', sessions: [cb] }))
  assert.equal(r.imported, 1); assert.equal(r.missingFiles, 1)
  r = await run(file({ format: 'chatbox-backup', sessions: [cb] })); assert.equal(r.skipped, 1)
  cb.id = 'chatbox-zip'; const zip = await writeArchive([{ name: 'manifest.json', blob: json({ format: 'chatbox-backup', resources: [{ kind: 'image', path: 'resources/image.bin', mimeType: 'image/png', originalStorageKeys: ['storage-1'] }], data: { copilots: [{ id: 'copilot', name: 'preset', prompt: 'copilot prompt' }] } }) }, { name: 'sessions/session.json', blob: json(cb) }, { name: 'resources/image.bin', blob: new Blob(['picture']) }])
  r = await run(new File([zip], 'chatbox.zip')); assert.equal(r.imported, 1); assert.equal(r.missingFiles, 0); assert.equal(r.presets, 1)
  const s = await db.loadSession('chatbox-zip'); assert.equal(s.messages[0].createdAt, 1700000000000); assert.equal(s.chatSettings.system, 'System'); assert.equal(s.chatSettings.model, 'arbitrary-model'); assert.equal(s.messages[1].files.length, 1)
})
await test('stream_chunks_and_invalid_tail_preserves_commits', async () => {
  const content = '汉字\\"\n'.repeat(25000), blob = json(simple([foreign('stream-1'), { ...foreign('stream-2'), title: content }]))
  const meta = await objectMetadata(blob, new Set(['conversations'])); assert.equal(meta.format, 'simplechat-backup')
  const rows = []; for await (const r of objectArray(blob, 'conversations')) rows.push(r)
  assert.equal(rows[1].title, content)
  const malformed = new File(['{"format":"simplechat-backup","version":2,"conversations":[', JSON.stringify(foreign('before-invalid')), ', {"id":}]}'], 'invalid.json')
  const r = await run(malformed); assert.equal(r.completed, false); assert.ok(r.fatal); assert.equal(r.imported, 1); assert.ok(await db.loadSession('before-invalid'))
  const persisted = await db.loadImportReport(); assert.equal(persisted.imported, 1); assert.ok(persisted.fatal)
})
await test('stop_after_first_commit', async () => {
  const controller = new AbortController()
  const input = file(simple([foreign('stopped-kept'), foreign('stopped-pending')]))
  const r = await run(input, opts(), { signal: controller.signal, report: () => {} }, (r) => {
    if (r.imported === 1) controller.abort()
  })
  assert.equal(r.cancelled, true)
  assert.equal(r.failed, 0)
  assert.equal(r.imported, 1)
  assert.ok(await db.loadSession('stopped-kept'))
  assert.equal(await db.loadSession('stopped-pending'), undefined)
  assert.equal((await db.loadImportReport()).cancelled, true)
})

let realArchive
const originalPath = process.argv[2]
if (originalPath) await test('deepseek_archive_in_memory_commit', async () => {
  const stages = new Set()
  const positions = new Set()
  let currentStage
  let firstAttachmentCount
  let firstSavedAt
  const started = performance.now()
  const controller = new AbortController()
  const control = { signal: controller.signal, report(update) {
    if (update.stage) {
      currentStage = update.stage
      stages.add(update.stage)
    }
    if (update.current) positions.add(update.current.position)
    if (positions.size === 1 && currentStage === 'images' && update.records) firstAttachmentCount = update.records.total
  } }
  const originalBytes = readFileSync(originalPath)
  const backup = new File([originalBytes], 'deepseek.zip')
  const report = await run(backup, opts(), control, (progress) => {
    if (progress.imported === 1) firstSavedAt ??= performance.now()
  })
  assert.equal(report.source, 'deepseek')
  assert.equal(report.completed, true, report.fatal)
  assert.equal(report.failed, 0, JSON.stringify(report.sessions.filter(({ status }) => status === 'failed').map(({ reason }) => reason)))
  assert.ok(report.imported > 0)
  assert.equal(positions.size, report.imported)
  assert.ok(['directory', 'index', 'preparing', 'sessions', 'parsing', 'validating', 'committing'].every((stage) => stages.has(stage)))
  let messages = 0, visibleMessages = 0, attachments = 0
  for (const entry of report.sessions) {
    const session = await db.loadSession(entry.targetId)
    assert.equal(session.messages.length, entry.messages)
    messages += session.messages.length
    visibleMessages += getVisibleMessages(session).length
    const files = new Map(session.messages.flatMap((m) => (m.files ?? []).map((f) => [f.id, f])))
    for (const f of files.values()) {
      const original = await db.loadFile(f.id)
      if (original) {
        assert.ok(original.size > 0)
        attachments++
      }
    }
  }
  assert.equal(messages, report.messages)
  assert.equal((await db.loadImportReport()).completed, true)
  const repeated = await run(backup)
  assert.equal(repeated.skipped, report.imported)
  assert.equal(repeated.imported, 0)
  realArchive = {
    sessions: report.imported, messages, visibleMessages, attachments,
    missingFiles: report.missingFiles, firstAttachmentCount,
    indexVerified: report.indexVerified, repeatSkipped: repeated.skipped,
    firstSavedMs: Math.round(firstSavedAt - started), stages: [...stages],
  }
})
await test('deepseek_blocks_and_index_fallback', async () => {
  const { toSessionFile, toIndexEntry } = await import(new URL('history/toArchive.ts', base))
  const s = native('deepseek-fixture')
  const a = s.messages[1], time = '2026-11-18T00:00:00Z'
  a.blocks.push({ type: 'server_tool_use', id: 'search', name: 'deepseek_web_search', caller: { type: 'direct' }, kind: 'search', input: { action: 'search', queries: ['query'] } })
  a.blocks.push({ type: 'web_search_tool_result', tool_use_id: 'search', kind: 'search', content: [{ type: 'web_search_result', title: 'Result', url: 'https://example.com', snippet: 'snippet', site_icon: null, site_name: 'Example', encrypted_content: '', page_age: time }] })
  a.blocks.push({ type: 'server_tool_use', id: 'link', name: 'deepseek_read_url', caller: { type: 'direct' }, kind: 'read_link', input: { action: 'read_link', url: 'https://example.com' } })
  a.blocks.push({ type: 'web_fetch_tool_result', tool_use_id: 'link', kind: 'read_link', signature: 'signed-page', content: { type: 'web_fetch_result', url: 'https://example.com', published_at: null, content: { type: 'document', title: 'Page', source: { type: 'text', media_type: 'text/plain', data: '' } } } })
  const original = toSessionFile(s, () => null)
  const makeZip = async (index) => new File([await writeArchive([{ name: 'manifest.json', blob: json({ export_format_version: 3 }) }, { name: 'chat_sessions/deepseek-fixture.json', blob: json(original) }, ...(index === undefined ? [] : [{ name: 'chat_session_index.json', blob: json(index) }])])], 'deepseek.zip')
  let input = await readImportInput(await makeZip({ sessions: [toIndexEntry(original)] }), true)
  assert.equal(input.indexVerified, true)
  for await (const t of input.tasks) {
    const c = await t.load(); assert.equal(c.session.messages.length, 2)
    const blocks = c.session.messages[1].blocks
    assert.ok(blocks.some((b) => b.type === 'web_search_tool_result' && b.content.some((v) => v.snippet === 'snippet')))
    assert.ok(blocks.some((b) => b.type === 'web_fetch_tool_result' && b.signature === 'signed-page'))
  }
  input = await readImportInput(await makeZip(undefined), true); assert.equal(input.indexVerified, false)
  let count = 0; for await (const t of input.tasks) { await t.load(); count++ } assert.equal(count, 1)
})
const result = { passed: tests.length, tests, realArchive, isolatedInMemoryDatabase: true, userDatabaseWritten: false, appStarted: false, installed: false, requestsSent: 0 }
console.log('IMPORT_V15_OK', JSON.stringify(result))
db.reconnectDatabase()