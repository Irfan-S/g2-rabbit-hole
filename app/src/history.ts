// Topics the reader has opened, newest first. Stored on the phone through the
// Even bridge's key-value storage as a JSON array of Wikipedia titles.

export const HISTORY_MAX = 50

/** Puts `title` at the front, without duplicates, keeping at most HISTORY_MAX. */
export function recordVisit(history: string[], title: string): string[] {
  return [title, ...history.filter(item => item !== title)].slice(0, HISTORY_MAX)
}

/** Reads what storage returned. Anything unexpected counts as an empty history. */
export function parseHistory(raw: unknown): string[] {
  try {
    const list: unknown = JSON.parse(String(raw))
    if (!Array.isArray(list)) return []
    return list.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, HISTORY_MAX)
  } catch {
    return []
  }
}
