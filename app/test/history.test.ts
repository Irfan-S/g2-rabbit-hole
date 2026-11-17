import { describe, expect, it } from 'vitest'
import { HISTORY_MAX, parseHistory, recordVisit } from '../src/history'

describe('recordVisit', () => {
  it('puts the newest topic first and never lists one twice', () => {
    let history = recordVisit([], 'Entropy')
    history = recordVisit(history, 'Black hole')
    history = recordVisit(history, 'Entropy')
    expect(history).toEqual(['Entropy', 'Black hole'])
  })

  it('drops the oldest topics past the cap', () => {
    let history: string[] = []
    for (let i = 0; i < HISTORY_MAX + 5; i++) history = recordVisit(history, `Topic ${i}`)
    expect(history).toHaveLength(HISTORY_MAX)
    expect(history[0]).toBe(`Topic ${HISTORY_MAX + 4}`)
    expect(history).not.toContain('Topic 0')
  })
})

describe('parseHistory', () => {
  it('round-trips a stored list', () => {
    expect(parseHistory(JSON.stringify(['Entropy', 'Black hole']))).toEqual(['Entropy', 'Black hole'])
  })

  it('treats missing or damaged storage as empty', () => {
    for (const raw of [undefined, null, '', 'not json', '{"a":1}', '42']) expect(parseHistory(raw)).toEqual([])
    expect(parseHistory('["ok", 3, "", null]')).toEqual(['ok'])
  })
})
