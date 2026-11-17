import { describe, expect, it } from 'vitest'
import { parseSession, sessionLabel, type SavedEntry } from '../src/session'

const entry = (title: string, paragraphs: number): SavedEntry => ({
  label: title,
  title,
  url: 'u',
  license: 'l',
  blocks: [
    { kind: 'heading', text: title, links: [] },
    ...Array.from({ length: paragraphs }, (_, i) => ({ kind: 'para' as const, text: `Paragraph ${i}.`, links: [] })),
  ],
})

describe('parseSession', () => {
  const entries = [entry('Entropy', 4), entry('Heat', 2)]

  it('puts topics and positions back together', () => {
    const session = parseSession(JSON.stringify(entries), JSON.stringify([{ block: 3, word: 5 }, { block: 1, word: 2 }]))
    expect(session?.entries.map(e => e.title)).toEqual(['Entropy', 'Heat'])
    expect(session?.positions).toEqual([{ block: 3, word: 5 }, { block: 1, word: 2 }])
    expect(sessionLabel(session!)).toBe('Heat (2/3)')
  })

  it('starts a level from its beginning when its position is missing or out of range', () => {
    const lost = parseSession(JSON.stringify(entries), 'not json')
    expect(lost?.positions).toEqual([{ block: 0, word: 0 }, { block: 0, word: 0 }])
    const wild = parseSession(JSON.stringify(entries), JSON.stringify([{ block: 99, word: -4 }]))
    expect(wild?.positions).toEqual([{ block: 4, word: 0 }, { block: 0, word: 0 }])
  })

  it('offers nothing when there is nothing readable to go back to', () => {
    expect(parseSession(null, null)).toBeNull()
    expect(parseSession('', '[]')).toBeNull()
    expect(parseSession('[]', '[]')).toBeNull()
    expect(parseSession('{"entries":1}', '[]')).toBeNull()
    // a topic that never got as far as a paragraph, and text of the wrong shape
    expect(parseSession(JSON.stringify([entry('Empty', 0)]), '[]')).toBeNull()
    expect(parseSession(JSON.stringify([{ ...entry('Bad', 1), blocks: [{ kind: 'para', text: 5 }] }]), '[]')).toBeNull()
  })
})
