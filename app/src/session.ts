// The reading session as it is kept on the phone between runs, so that after leaving
// the app the reader can carry on from the exact word they stopped at.
//
// Two stored values: the topics themselves (large, and they change rarely) and the
// positions within them (tiny, and they change with every word). Keeping them apart
// means the frequent save is a few bytes rather than the whole text again.

import type { Ask } from './api'
import type { Block, LeadImage } from './types'

/** One level of the trail: a topic or an answer, with the text that was being read. */
export interface SavedEntry {
  label: string
  title: string
  url: string
  license: string
  image?: LeadImage
  ask?: Ask
  blocks: Block[]
}

export interface Position {
  block: number
  word: number
}

export interface SavedSession {
  /** Outermost topic first; the last one is what was on screen. */
  entries: SavedEntry[]
  positions: Position[]
}

/** Deeper trails are cut to the levels nearest the reader, to bound what is stored. */
export const SESSION_MAX_ENTRIES = 4

const isBlock = (value: unknown): value is Block => {
  const block = value as Block
  return !!block && (block.kind === 'heading' || block.kind === 'para') && typeof block.text === 'string' && Array.isArray(block.links)
}

/**
 * Puts the two stored values back together. Returns null unless they describe a session
 * that can actually be resumed: anything missing, damaged or from an older shape of the
 * data is treated as "nothing to resume" rather than risked.
 */
export function parseSession(rawEntries: unknown, rawPositions: unknown): SavedSession | null {
  try {
    const entries = JSON.parse(String(rawEntries)) as SavedEntry[]
    if (!Array.isArray(entries) || !entries.length) return null
    for (const entry of entries) {
      if (typeof entry?.title !== 'string' || !Array.isArray(entry.blocks) || !entry.blocks.every(isBlock)) return null
      if (!entry.blocks.some(block => block.kind === 'para')) return null
    }
    let stored: unknown = []
    try {
      stored = JSON.parse(String(rawPositions))
    } catch {
      /* positions lost: resume each level from its start */
    }
    const list = Array.isArray(stored) ? (stored as Array<Partial<Position>>) : []
    const positions = entries.map((entry, i) => {
      const at = list[i]
      const block = Number.isInteger(at?.block) ? Math.min(Math.max(0, at!.block!), entry.blocks.length - 1) : 0
      return { block, word: Number.isInteger(at?.word) ? Math.max(0, at!.word!) : 0 }
    })
    return { entries, positions }
  } catch {
    return null
  }
}

/** What to call the session on the opening screen: where the reader was, and how far in. */
export function sessionLabel(session: SavedSession): string {
  const top = session.entries[session.entries.length - 1]!
  const at = session.positions[session.positions.length - 1]!
  return `${top.title} (${at.block + 1}/${top.blocks.length})`
}
