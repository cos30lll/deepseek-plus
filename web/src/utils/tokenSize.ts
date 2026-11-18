/** 1K means 1024 tokens; persisted configuration continues to use integer token counts. */
export const formatTokenSize = (tokens: number, exact = false): string => {
  if (!Number.isFinite(tokens)) return '—'
  if (tokens === 0) return '0K'
  const value = tokens / 1024
  return `${exact ? String(value) : value >= 100 ? value.toFixed(0) : Number(value.toFixed(2))}K`
}
export const parseTokenSize = (input: string): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(k|m)?\s*$/i.exec(input)
  if (!match) return null
  const scale = match[2]?.toLowerCase() === 'm' ? 1048576 : match[2] ? 1024 : 1
  const value = Number(match[1]) * scale
  return Number.isSafeInteger(value) && value > 0 ? value : null
}