import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { describe, expect, it } from 'vitest'
import { WORD_BOX, innerWidth, lineCapacity } from '../src/config'
import { chunkWords, pivotIndex, placeLine, placeWord, tokenize, wordDelay } from '../src/text'
import type { Block } from '../src/types'

const text = 'The full description is called its wave function. It holds "every" state, e.g. both paths. Dr. Bohr agreed.'
const start = text.indexOf('wave function')
const block: Block = { kind: 'para', text, links: [{ start, end: start + 'wave function'.length, title: 'Wave function' }] }
const words = tokenize(block)

describe('tokenize', () => {
  it('brackets a linked term and keeps punctuation outside the brackets', () => {
    expect(words.map(w => w.display).slice(6, 8)).toEqual(['[wave', 'function].'])
    expect(words.filter(w => w.link).map(w => w.text)).toEqual(['wave', 'function.'])
  })

  it('brackets a single-word link on both sides', () => {
    const single = tokenize({ kind: 'para', text: 'A qubit, then.', links: [{ start: 2, end: 7, title: 'Qubit' }] })
    expect(single.map(w => w.display)).toEqual(['A', '[qubit],', 'then.'])
  })

  it('splits sentences, ignoring abbreviations and titles', () => {
    const ends = words.filter(w => w.endsSentence).map(w => w.text)
    expect(ends).toEqual(['function.', 'paths.', 'agreed.'])
    expect(new Set(words.map(w => w.sentence)).size).toBe(3)
  })

  it('always ends the block on a sentence end', () => {
    const open = tokenize({ kind: 'para', text: 'No full stop here', links: [] })
    expect(open[open.length - 1]!.endsSentence).toBe(true)
  })
})

describe('chunkWords', () => {
  // Fixed sizes, not the live layout: these check the chunker, and the sentence-end
  // preference below only holds when a chunk is roomy enough to contain a sentence end.
  const paraWidth = 186
  const maxLines = 8
  const countLines = (t: string) => measureTextWrap(t, paraWidth).lineCount
  const long = tokenize({
    kind: 'para',
    text: Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} has a handful of ordinary words in it.`).join(' '),
    links: [],
  })
  const chunks = chunkWords(long, countLines, maxLines)

  it('covers every word exactly once, in order', () => {
    expect(chunks[0]!.from).toBe(0)
    expect(chunks[chunks.length - 1]!.to).toBe(long.length)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.from).toBe(chunks[i - 1]!.to)
  })

  it('never overflows the side box', () => {
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(countLines(chunk.text)).toBeLessThanOrEqual(maxLines)
  })

  it('prefers to break at a sentence end', () => {
    for (const chunk of chunks.slice(0, -1)) expect(long[chunk.to - 1]!.endsSentence).toBe(true)
  })

  it('still makes progress when one word is wider than the box', () => {
    const monster = tokenize({ kind: 'para', text: 'x'.repeat(400) + ' tail', links: [] })
    const result = chunkWords(monster, countLines, maxLines)
    expect(result[result.length - 1]!.to).toBe(2)
  })
})

describe('placeWord', () => {
  const width = innerWidth(WORD_BOX)
  const lines = lineCapacity(WORD_BOX)
  const pivotColumn = (display: string) => {
    const placed = placeWord(display, width, lines, getTextWidth)
    const line = placed.split('\n').pop()!
    const pad = line.length - line.trimStart().length
    const lead = display.match(/^[\[("']+/)?.[0].length ?? 0
    const core = display.slice(lead).replace(/[\]).,;:!?"']+$/, '')
    const pivot = lead + pivotIndex(core.length)
    return getTextWidth(line.slice(0, pad + pivot)) + getTextWidth(display[pivot]!) / 2
  }

  it('puts the word on the middle line', () => {
    const placed = placeWord('hello', width, lines, getTextWidth)
    expect(placed.split('\n').length - 1).toBe(Math.floor((lines - 1) / 2))
  })

  it('keeps the pivot letter on the same column for words of any length', () => {
    const spaceWidth = getTextWidth(' '.repeat(10)) / 10
    const columns = ['a', 'of', 'wave', '[qubit],', 'function].', 'superposition', 'electromagnetism.'].map(pivotColumn)
    for (const column of columns) expect(Math.abs(column - width * 0.42)).toBeLessThanOrEqual(spaceWidth)
  })

  it('never pushes a word past the right edge', () => {
    const long = 'electroencephalographically,'
    expect(getTextWidth(long)).toBeLessThan(width)
    const placed = placeWord(long, width, lines, getTextWidth)
    expect(getTextWidth(placed.split('\n').pop()!)).toBeLessThanOrEqual(width)
    expect(measureTextWrap(placed, width).lineCount).toBe(Math.floor((lines - 1) / 2) + 1)
    // A word wider than the whole box gets no padding at all.
    const monster = placeWord('x'.repeat(80), width, lines, getTextWidth).split('\n').pop()!
    expect(monster.startsWith('x')).toBe(true)
  })

  it('centres a heading line', () => {
    const placed = placeLine('What it is', width, lines, getTextWidth).split('\n').pop()!
    const left = getTextWidth(placed) - getTextWidth('What it is')
    const right = width - getTextWidth(placed)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(8)
  })
})

describe('wordDelay', () => {
  const plain = words.find(w => w.text === 'full')!
  it('follows the chosen speed for an ordinary word', () => {
    expect(wordDelay(plain, 200, 120)).toBe(300)
    expect(wordDelay(plain, 300, 120)).toBe(200)
  })
  it('holds longer on sentence ends, commas, long words and links', () => {
    const base = wordDelay(plain, 200, 120)
    expect(wordDelay(words.find(w => w.text === 'paths.')!, 200, 120)).toBe(base * 2)
    expect(wordDelay(words.find(w => w.text === 'state,')!, 200, 120)).toBeGreaterThan(base)
    expect(wordDelay(words.find(w => w.text === 'description')!, 200, 120)).toBeGreaterThan(base)
    expect(wordDelay(words.find(w => w.text === 'wave')!, 200, 120)).toBeGreaterThan(base)
  })
  it('never goes below the Bluetooth floor', () => {
    expect(wordDelay(plain, 1000, 120)).toBe(120)
  })
})
