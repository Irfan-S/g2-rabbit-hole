import { describe, expect, it } from 'vitest'
import { HEADING_MS } from '../src/config'
import { Reader, type Clock } from '../src/reader'
import type { Block } from '../src/types'

/** A clock the test advances by hand. */
class FakeClock implements Clock {
  time = 0
  private id = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  now = () => this.time
  setTimeout = (fn: () => void, ms: number) => {
    this.timers.set(++this.id, { at: this.time + ms, fn })
    return this.id
  }
  clearTimeout = (handle: unknown) => void this.timers.delete(handle as number)
  /** Runs timers in order until `ms` has passed, letting promises settle between them. */
  async advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      await flush()
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.timers.delete(next[0])
      this.time = next[1].at
      next[1].fn()
    }
    this.time = end
    await flush()
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function setup(wpm = 600) {
  const clock = new FakeClock()
  const shown: string[] = []
  const paras: string[] = []
  let changes = 0
  const reader = new Reader(
    {
      word: async content => void shown.push(content.trim()),
      para: async content => void paras.push(content),
      changed: () => void changes++,
    },
    { wordBoxWidth: 358, wordBoxLines: 8, paraBoxLines: 2, measure: t => t.length * 8, paraLines: t => Math.ceil(t.length / 24) },
    wpm,
    clock,
  )
  return { clock, shown, paras, reader, changes: () => changes }
}

const heading: Block = { kind: 'heading', text: 'What it is', links: [], note: 'credit' }
const p1: Block = { kind: 'para', text: 'One two three. Four five six. Seven eight nine.', links: [{ start: 4, end: 7, title: 'Two' }] }
const p2: Block = { kind: 'para', text: 'Ten eleven. Twelve.', links: [{ start: 4, end: 10, title: 'Eleven' }] }

describe('Reader playback', () => {
  it('plays a heading card, then every word in order, then stops at the end', async () => {
    const { clock, shown, reader } = setup()
    reader.addBlock(heading)
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    await clock.advance(HEADING_MS + 60_000)
    expect(shown).toEqual(['What it is', 'One', '[two]', 'three.', 'Four', 'five', 'six.', 'Seven', 'eight', 'nine.', 'End'])
    expect(reader.playing).toBe(false)
    expect(reader.atEnd).toBe(true)
  })

  it('shows the side note for a heading and the paragraph piece for words', async () => {
    const { clock, paras, reader } = setup()
    reader.addBlock(heading)
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    await clock.advance(HEADING_MS + 60_000)
    expect(paras[0]).toBe('credit')
    // The 2-line side box cannot hold the whole paragraph, so it turns pages at sentence ends.
    expect(paras.slice(1, -1).join(' ')).toBe('One [two] three. Four five six. Seven eight nine.')
    expect(paras.length).toBeGreaterThan(3)
  })

  it('holds each word for its delay', async () => {
    const { clock, shown, reader } = setup(300) // 200 ms per plain word
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    await clock.advance(1)
    expect(shown).toEqual(['One'])
    await clock.advance(198)
    expect(shown).toEqual(['One'])
    await clock.advance(1)
    expect(shown).toEqual(['One', '[two]'])
  })

  it('waits when it catches up with the stream and carries on when more arrives', async () => {
    const { clock, shown, reader } = setup()
    reader.addBlock(p2)
    reader.play()
    await clock.advance(10_000)
    expect(shown[shown.length - 1]).toBe('...')
    expect(reader.playing).toBe(true)
    reader.addBlock({ kind: 'para', text: 'More.', links: [] })
    reader.finish()
    await clock.advance(10_000)
    expect(shown.slice(-2)).toEqual(['More.', 'End'])
  })

  it('never shows a word for less than the Bluetooth floor, whatever the speed', async () => {
    const { clock, shown, reader } = setup(2000)
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    await clock.advance(119)
    expect(shown).toEqual(['One'])
    await clock.advance(1)
    expect(shown).toEqual(['One', '[two]'])
  })

  it('pause stops the words and play resumes from the same place', async () => {
    const { clock, shown, reader } = setup()
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    await clock.advance(150)
    reader.pause()
    const count = shown.length
    await clock.advance(10_000)
    expect(shown.length).toBe(count)
    reader.play()
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe(shown[count - 1])
  })

  it('pressing play at the end starts the topic again', async () => {
    const { clock, shown, reader } = setup()
    reader.addBlock(p2)
    reader.finish()
    reader.play()
    await clock.advance(10_000)
    reader.play()
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Ten')
  })
})

describe('Reader heading cards', () => {
  it('previews the next paragraph in the side box instead of repeating the heading', async () => {
    const { clock, paras, shown, reader } = setup()
    reader.addBlock({ kind: 'heading', text: 'Why it matters', links: [] })
    reader.addBlock(p2)
    reader.finish()
    reader.play()
    await clock.advance(1)
    expect(shown).toEqual(['Why it matters'])
    expect(paras).toEqual(['Ten [eleven]. Twelve.'])
    await clock.advance(HEADING_MS + 500)
    // The paragraph was already showing, so starting it costs no extra write.
    expect(paras).toEqual(['Ten [eleven]. Twelve.'])
  })

  it('falls back to the heading text when the paragraph has not arrived yet', async () => {
    const { clock, paras, reader } = setup()
    reader.addBlock({ kind: 'heading', text: 'Why it matters', links: [] })
    reader.play()
    await clock.advance(1)
    expect(paras).toEqual(['Why it matters'])
  })
})

describe('Reader sentence stepping', () => {
  async function at(wordsIn: number) {
    const ctx = setup()
    ctx.reader.addBlock(p1)
    ctx.reader.addBlock(p2)
    ctx.reader.finish()
    ctx.reader.play()
    await ctx.clock.advance(1)
    for (let i = 0; i < wordsIn; i++) await ctx.clock.advance(250)
    ctx.reader.pause()
    return ctx
  }

  it('back restarts the current sentence, and back again goes to the previous one', async () => {
    const { reader, shown, clock } = await at(2) // reading "five" in sentence 2... position varies by delay
    const before = shown[shown.length - 1]!
    expect(['Four', 'five', 'six.']).toContain(before)
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe(before === 'Four' ? 'One' : 'Four')
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('One')
    reader.seekSentence(-1) // already at the very start
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('One')
  })

  it('while playing, repeated swipes back walk back through the sentences', async () => {
    // 60 wpm: each word stays up for a second or more, so positions are easy to pin down.
    const { reader, shown, clock } = setup(60)
    reader.addBlock(p1) // "One two three. Four five six. Seven eight nine."
    reader.finish()
    reader.play()
    while (shown[shown.length - 1] !== 'eight') await clock.advance(100)

    reader.seekSentence(-1) // restarts the sentence being read
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Seven')

    await clock.advance(1200) // the reader moves on a word, as it always has by the next swipe
    expect(shown[shown.length - 1]).toBe('eight')
    reader.seekSentence(-1) // soon after: one sentence further back, not "Seven" again
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Four')

    await clock.advance(1200)
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('One')
  })

  it('a swipe back after a pause in swiping restarts the current sentence again', async () => {
    const { reader, shown, clock } = setup(60)
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    while (shown[shown.length - 1] !== 'eight') await clock.advance(100)
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Seven')
    while (shown[shown.length - 1] !== 'nine.') await clock.advance(100)
    await clock.advance(900) // still on "nine.", now about three seconds after the first swipe
    expect(shown[shown.length - 1]).toBe('nine.')
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Seven')
  })

  it('forward moves to the next sentence and across paragraphs', async () => {
    const { reader, shown, clock } = await at(0)
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      reader.seekSentence(1)
      await clock.advance(1)
      seen.push(shown[shown.length - 1]!)
    }
    expect(seen).toEqual(['Four', 'Seven', 'Ten', 'Twelve.', 'Twelve.', 'Twelve.'])
  })

  it('back crosses into the previous paragraph', async () => {
    const { reader, shown, clock } = await at(0)
    for (let i = 0; i < 3; i++) reader.seekSentence(1) // at "Ten"
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Seven')
  })

  it('keeps playing after a step if it was playing', async () => {
    const { reader, shown, clock } = setup()
    reader.addBlock(p1)
    reader.finish()
    reader.play()
    await clock.advance(1)
    reader.seekSentence(1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Four')
    await clock.advance(150)
    expect(shown[shown.length - 1]).toBe('five')
  })

  it('stepping back from the end lands on the last sentence', async () => {
    const { reader, shown, clock } = setup()
    reader.addBlock(p2)
    reader.finish()
    reader.play()
    await clock.advance(10_000)
    reader.seekSentence(-1)
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Twelve.')
  })
})

describe('Reader links and positions', () => {
  it('lists links from the current paragraph first', async () => {
    const { reader, clock } = setup()
    reader.addBlock(p1)
    reader.addBlock(p2)
    reader.finish()
    expect(reader.links(12)).toEqual([{ title: 'Two', here: true }, { title: 'Eleven', here: false }])
    reader.play()
    await clock.advance(1)
    for (let i = 0; i < 3; i++) reader.seekSentence(1)
    expect(reader.links(12)).toEqual([{ title: 'Eleven', here: true }, { title: 'Two', here: false }])
    expect(reader.links(1)).toHaveLength(1)
  })

  it('restores a saved position at the start of its sentence', async () => {
    const { reader, shown, clock } = setup()
    reader.addBlock(p1)
    reader.addBlock(p2)
    reader.finish()
    reader.restore({ block: 0, word: 4 }) // "five"
    await reader.redraw()
    expect(shown[shown.length - 1]).toBe('Four')
    reader.restore({ block: 99, word: 99 })
    await reader.redraw()
    await clock.advance(1)
    expect(shown[shown.length - 1]).toBe('Twelve.')
  })

  it('reset clears everything', async () => {
    const { reader } = setup()
    reader.addBlock(p1)
    reader.finish()
    reader.reset()
    expect(reader.blockCount).toBe(0)
    expect(reader.complete).toBe(false)
    expect(reader.links(5)).toEqual([])
  })
})
