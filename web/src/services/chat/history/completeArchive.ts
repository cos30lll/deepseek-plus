import type { BackupSettings } from './importTypes.js'
import type { Session } from '../types.js'
import { readNativeSession, readParameters, readPresets } from './portable.js'
import { writeArchive } from './zipWriter.js'
const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })
export const exportCompleteArchive = async (sessions: AsyncIterable<Session>, settings: BackupSettings, loadFile: (id: string) => Promise<Blob | undefined>): Promise<Blob> => {
  const entries: { name: string; blob: Blob }[] = [], index: { id: string; title: string; path: string; messages: number }[] = [], files: { id: string; path: string; mime: string }[] = [], seen = new Set<string>()
  let missingFiles = 0
  for await (const value of sessions) {
    // Whitelist the application data model; service credentials and remote upload IDs are never backed up.
    const session = readNativeSession(structuredClone(value), false).session, path = `sessions/${index.length}.json`
    index.push({ id: session.id, title: session.title, path, messages: session.messages.length })
    entries.push({ name: path, blob: json(session) })
    for (const m of session.messages) for (const file of m.files ?? []) {
      if (seen.has(file.id)) continue; seen.add(file.id)
      const blob = await loadFile(file.id)
      if (!blob) { missingFiles++; continue }
      const path = `files/${files.length}.bin`
      files.push({ id: file.id, path, mime: blob.type || file.mimeType }); entries.push({ name: path, blob })
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return writeArchive([
    { name: 'manifest.json', blob: json({ format: 'deepseek-plus-archive', version: 1, createdAt: Date.now(), sessions: index, files, missingFiles }) },
    { name: 'settings.json', blob: json({ defaults: readParameters(settings.defaults ?? {}), presets: readPresets(settings.presets) }) },
    ...entries,
  ])
}
