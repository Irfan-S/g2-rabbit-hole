import { describe, expect, it } from 'vitest'
import { NdjsonDecoder } from '../src/api'
import { concatBytes, toBytes } from '../src/audio'
import type { StreamEvent } from '../src/types'

describe('NdjsonDecoder', () => {
  const lines =
    '{"type":"meta","title":"Schrödinger equation","url":"u","license":"l","cached":false}\n' +
    '{"type":"block","block":{"kind":"para","text":"Hello — world.","links":[]}}\n' +
    'not json\n\n' +
    '{"type":"done"}'
  const bytes = new TextEncoder().encode(lines)

  it('gives the same events however the bytes are split, including mid-character', () => {
    const run = (size: number) => {
      const events: StreamEvent[] = []
      const decoder = new NdjsonDecoder(event => events.push(event))
      for (let i = 0; i < bytes.length; i += size) decoder.push(bytes.slice(i, i + size))
      decoder.end()
      return events
    }
    const whole = run(bytes.length)
    expect(whole.map(e => e.type)).toEqual(['meta', 'block', 'done'])
    expect(whole[0]).toMatchObject({ title: 'Schrödinger equation' })
    for (const size of [1, 2, 3, 5, 17]) expect(run(size)).toEqual(whole)
  })
})

describe('audio helpers', () => {
  it('accepts bytes, number arrays and base64', () => {
    expect(toBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]))
    expect(toBytes([1, 2, 255])).toEqual(new Uint8Array([1, 2, 255]))
    expect(toBytes(btoa(String.fromCharCode(0, 127, 255)))).toEqual(new Uint8Array([0, 127, 255]))
    expect(toBytes({})).toBeNull()
  })
  it('joins chunks in order', () => {
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(new Uint8Array([1, 2, 3]))
  })
})
