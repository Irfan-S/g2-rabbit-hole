// Pure text handling for the speed reader. No SDK or DOM access here, so every
// function can be unit-tested; text measurement is passed in.

import type { Block } from './types'

export interface Word {
  /** The word as it appears in the text, with its punctuation. */
  text: string
  /** What the glasses show: linked terms are wrapped in [ ]. */
  display: string
  /** Index of the sentence this word belongs to, within its block. */
  sentence: number
  /** Wikipedia title this word links to, if it is part of a linked term. */
  link?: string
  /** True on the last word of a sentence. */
  endsSentence: boolean
}

/** Trailing dots on these do not end a sentence. */
const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'no.', 'fig.', 'approx.', 'c.', 'ca.',
])

function endsSentence(word: string): boolean {
  if (!/[.!?]["')\]]*$/.test(word)) return false
  const bare = word.replace(/["')\]]+$/, '').toLowerCase()
  if (ABBREVIATIONS.has(bare)) return false
  if (/^(?:[a-z]\.){2,}$/.test(bare)) return false // U.S., a.m.
  if (/^[a-z]\.$/.test(bare)) return false // single initials
  return true
}

/** Splits a block into words, tagging each with its sentence and any link. */
export function tokenize(block: Block): Word[] {
  const words: Word[] = []
  let sentence = 0
  for (const match of block.text.matchAll(/\S+/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const text = match[0]
    const span = block.links.find(link => link.start < end && link.end > start)

    let display = text
    if (span) {
      // Brackets hug the linked words, leaving surrounding punctuation outside:
      // "wave function." with link on both words -> "[wave" "function]."
      const first = start <= span.start
      const last = end >= span.end
      if (first) {
        const cut = Math.max(0, span.start - start)
        display = display.slice(0, cut) + '[' + display.slice(cut)
      }
      if (last) {
        const cut = display.length - Math.max(0, end - span.end)
        display = display.slice(0, cut) + ']' + display.slice(cut)
      }
    }

    const ends = endsSentence(text)
    words.push({ text, display, sentence, link: span?.title, endsSentence: ends })
    if (ends) sentence++
  }
  if (words.length) words[words.length - 1]!.endsSentence = true
  return words
}

export interface Chunk {
  /** Index of the first word in the chunk. */
  from: number
  /** Index one past the last word. */
  to: number
  /** Text for the side box. */
  text: string
}

export type CountLines = (text: string) => number

/**
 * Cuts a paragraph into pieces that each fit the side box. The side box stays
 * on one piece while its words flash by, then turns to the next piece.
 * Prefers to end a piece at a sentence end when one falls in its last 40%.
 */
export function chunkWords(words: Word[], countLines: CountLines, maxLines: number): Chunk[] {
  const chunks: Chunk[] = []
  let from = 0
  while (from < words.length) {
    let to = from + 1
    let text = words[from]!.display
    while (to < words.length) {
      const candidate = text + ' ' + words[to]!.display
      if (countLines(candidate) > maxLines) break
      text = candidate
      to++
    }
    if (to < words.length) {
      const earliest = from + Math.ceil((to - from) * 0.6)
      for (let cut = to; cut >= earliest; cut--) {
        if (words[cut - 1]!.endsSentence) {
          to = cut
          break
        }
      }
      text = words.slice(from, to).map(word => word.display).join(' ')
    }
    chunks.push({ from, to, text })
    from = to
  }
  return chunks
}

/** Index of the letter the eye should land on (the "optimal recognition point"). */
export function pivotIndex(length: number): number {
  if (length <= 1) return 0
  if (length <= 5) return 1
  if (length <= 9) return 2
  if (length <= 13) return 3
  return 4
}

/** Pivot position inside a displayed word, skipping leading brackets and trailing punctuation. */
export function pivotOf(display: string): number {
  const lead = display.match(/^[\[("']+/)?.[0].length ?? 0
  const core = display.slice(lead).replace(/[\]).,;:!?"']+$/, '')
  return lead + pivotIndex(core.length)
}

export type MeasureWidth = (text: string) => number

/**
 * The firmware font is one fixed size, left-aligned and top-aligned, so a word
 * is placed by padding: blank lines above it and spaces before it. The spaces
 * are chosen so the word's pivot letter always lands on the same pixel column,
 * which is what lets the eye stay still while words change.
 */
export function placeWord(
  display: string,
  boxInnerWidth: number,
  boxLines: number,
  measure: MeasureWidth,
  anchor = 0.42,
): string {
  const pivot = pivotOf(display)
  const before = measure(display.slice(0, pivot))
  const pivotChar = display.slice(pivot, pivot + 1)
  const leftOfCentre = before + measure(pivotChar) / 2

  const spaceWidth = Math.max(1, measure(' '.repeat(10)) / 10)
  const total = measure(display)
  let padPx = boxInnerWidth * anchor - leftOfCentre
  // Never push a long word past the right edge, where it would wrap.
  padPx = Math.min(padPx, boxInnerWidth - total - spaceWidth)
  const spaces = Math.max(0, Math.round(padPx / spaceWidth))

  const linesAbove = Math.max(0, Math.floor((boxLines - 1) / 2))
  return '\n'.repeat(linesAbove) + ' '.repeat(spaces) + display
}

/** Places a short multi-word line (a heading or a notice) in the middle of the box. */
export function placeLine(text: string, boxInnerWidth: number, boxLines: number, measure: MeasureWidth): string {
  const spaceWidth = Math.max(1, measure(' '.repeat(10)) / 10)
  const width = measure(text)
  const linesAbove = Math.max(0, Math.floor((boxLines - 1) / 2))
  if (width >= boxInnerWidth) return '\n'.repeat(Math.max(0, linesAbove - 1)) + text
  const spaces = Math.max(0, Math.floor((boxInnerWidth - width) / 2 / spaceWidth))
  return '\n'.repeat(linesAbove) + ' '.repeat(spaces) + text
}

/**
 * How long a word stays up. Longer words, punctuation and linked terms get more
 * time: a fixed beat is what makes one-word-at-a-time reading hard to follow.
 */
export function wordDelay(word: Word, wpm: number, minMs: number): number {
  const base = 60000 / wpm
  const letters = word.text.replace(/[^\p{L}\p{N}]/gu, '').length
  let factor = 1
  if (letters > 8) factor += 0.3
  if (letters > 12) factor += 0.2
  if (/\d/.test(word.text)) factor += 0.3
  if (word.link) factor += 0.2
  if (word.endsSentence) factor += 1.0
  else if (/[,;:]["')\]]*$/.test(word.text)) factor += 0.4
  return Math.max(minMs, Math.round(base * factor))
}
