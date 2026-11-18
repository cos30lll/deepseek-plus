export type PresetRecord = { id: string; name: string; body: string }
/** Fingerprints identify only the unchanged v11 defaults; no default prompt text is shipped. */
const LEGACY_PRESET_BODY: Record<string, readonly string[]> = {
  "novel": [
    "165:3096425421",
    "646:1039720766"
  ],
  "poem": [
    "107:3102550762",
    "396:2780299846"
  ],
  "prose": [
    "129:1053177630",
    "474:1118943531"
  ]
}
const bodyFingerprint = (text: string): string => {
  const value = text.trim()
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return `${value.length}:${hash >>> 0}`
}
/** Preserve user-created IDs and edited former defaults, even if their names match a default. */
export const removeBuiltInPresets = <T extends PresetRecord>(rows: T[]): T[] => rows.filter((row) => !LEGACY_PRESET_BODY[row.id]?.includes(bodyFingerprint(row.body)))
