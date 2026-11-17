import { describe, expect, it } from 'vitest'
import { cleanSpokenTopic, pcmToWav } from '../src/stt.ts'

describe('pcmToWav', () => {
  it('writes a valid 16 kHz mono 16-bit header', () => {
    const pcm = new Uint8Array(3200)
    const wav = pcmToWav(pcm)
    const view = new DataView(wav.buffer)
    const ascii = (o: number) => String.fromCharCode(...wav.slice(o, o + 4))
    expect(wav.length).toBe(3244)
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(view.getUint32(4, true)).toBe(3236)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(3200)
  })
})

describe('cleanSpokenTopic', () => {
  it.each([
    ['Tell me about quantum mechanics.', 'quantum mechanics'],
    ['um, what is superposition?', 'superposition'],
    ['Okay, could you explain the Roman Empire', 'the Roman Empire'],
    ['Black holes', 'Black holes'],
    ['search for the topic of entropy', 'entropy'],
    ['What Is Life?', 'Life'],
    ['(background noise) Tell me about black holes. (laughter)', 'black holes'],
    ['[music] Entropy', 'Entropy'],
  ])('%s -> %s', (spoken, topic) => {
    expect(cleanSpokenTopic(spoken)).toBe(topic)
  })
})
