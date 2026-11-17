// The speed reader engine. It owns the reading position and the timing, and
// talks to the display only through `ReaderView`, so it runs the same against
// the glasses, the simulator and the unit tests.

import { HEADING_MS, MIN_WORD_MS } from './config'
import { chunkWords, placeLine, placeWord, tokenize, wordDelay, type Chunk, type CountLines, type MeasureWidth, type Word } from './text'
import type { Block, Figure } from './types'

export interface ReaderView {
  /** Replace the contents of the speed-reader box. */
  word(content: string): Promise<void>
  /** Replace the contents of the side box. */
  para(content: string): Promise<void>
  /** Position, speed or play state changed: redraw the status strip. */
  changed(): void
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface Geometry {
  wordBoxWidth: number
  wordBoxLines: number
  paraBoxLines: number
  measure: MeasureWidth
  /** Where the pivot letter sits across the word box (0 to 1); placeWord's default if absent. */
  wordAnchor?: number
  /** Wrapped line count of `text` inside the side box. */
  paraLines: CountLines
}

interface Item {
  block: Block
  words: Word[]
  chunks: Chunk[]
}

export interface LinkChoice {
  title: string
  /** True when the link sits in the paragraph being read. */
  here: boolean
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export class Reader {
  wpm: number
  playing = false
  /** True once the backend has sent the whole topic. */
  complete = false
  /** Words per minute actually achieved, smoothed. 0 until measured. */
  measuredWpm = 0

  private items: Item[] = []
  private b = 0
  private w = 0
  private timer: unknown = null
  private generation = 0
  private waitingForMore = false
  private shownChunk = ''
  private lastWordAt = 0

  constructor(
    private readonly view: ReaderView,
    private readonly geometry: Geometry,
    wpm: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.wpm = wpm
  }

  // ── content ──

  reset() {
    this.cancel()
    this.items = []
    this.b = 0
    this.w = 0
    this.playing = false
    this.complete = false
    this.waitingForMore = false
    this.shownChunk = ''
    this.measuredWpm = 0
  }

  addBlock(block: Block) {
    const words = block.kind === 'para' ? tokenize(block) : []
    const chunks = block.kind === 'para' ? chunkWords(words, this.geometry.paraLines, this.geometry.paraBoxLines) : []
    this.items.push({ block, words, chunks })
    if (this.waitingForMore) {
      this.waitingForMore = false
      if (this.playing) void this.tick(this.generation)
      else void this.show(this.generation)
    }
  }

  finish() {
    this.complete = true
    if (this.waitingForMore) {
      this.waitingForMore = false
      void this.tick(this.generation)
    }
  }

  // ── position ──

  get blockIndex() {
    return this.b
  }
  get blockCount() {
    return this.items.length
  }
  get atEnd() {
    return this.b >= this.items.length
  }
  position() {
    return { block: this.b, word: this.w }
  }

  /** Jump to a saved position (used when stepping back up the trail). */
  restore(position: { block: number; word: number }) {
    this.cancel()
    this.b = Math.min(Math.max(0, position.block), Math.max(0, this.items.length - 1))
    const max = Math.max(0, (this.items[this.b]?.words.length ?? 1) - 1)
    this.w = Math.min(Math.max(0, position.word), max)
    // Resume from the start of the sentence, not mid-thought.
    this.w = this.sentenceStart(this.b, this.w)
  }

  /** Links the reader can open: those in the current paragraph first, then the rest. */
  links(limit: number): LinkChoice[] {
    const seen = new Set<string>()
    const out: LinkChoice[] = []
    const take = (item: Item | undefined, here: boolean) => {
      for (const link of item?.block.links ?? []) {
        if (seen.has(link.title) || out.length >= limit) continue
        seen.add(link.title)
        out.push({ title: link.title, here })
      }
    }
    const current = Math.min(this.b, this.items.length - 1)
    take(this.items[current], true)
    // Then nearest paragraphs first: the reader most likely wants a term just seen.
    for (let distance = 1; distance < this.items.length && out.length < limit; distance++) {
      take(this.items[current - distance], false)
      take(this.items[current + distance], false)
    }
    return out
  }

  /** Text of the block being read, for the phone-side mirror. */
  currentBlock(): Block | undefined {
    return this.items[Math.min(this.b, this.items.length - 1)]?.block
  }

  /**
   * The picture for what is on screen: the paragraph's own or, during a heading card,
   * the one its first paragraph will show, so it is already up when the words start.
   */
  currentFigure(): Figure | undefined {
    const item = this.items[Math.min(this.b, this.items.length - 1)]
    return item?.block.kind === 'heading' ? this.items[this.b + 1]?.block.image : item?.block.image
  }

  // ── transport ──

  play() {
    if (this.playing) return
    this.cancel()
    if (this.atEnd && this.complete) {
      // Pressing play at the end starts the topic again.
      this.b = 0
      this.w = 0
    }
    this.playing = true
    this.lastWordAt = 0
    this.view.changed()
    void this.tick(this.generation)
  }

  pause() {
    if (!this.playing) return
    this.cancel()
    this.playing = false
    this.view.changed()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  setWpm(wpm: number) {
    this.wpm = wpm
    this.measuredWpm = 0
    this.view.changed()
  }

  /** Step to the previous (-1) or next (+1) sentence. This is the re-read control. */
  seekSentence(direction: -1 | 1) {
    if (!this.items.length) return
    if (this.atEnd && direction > 0) return
    this.cancel()
    if (this.atEnd) {
      // Stepping back from the end lands on the last sentence.
      this.b = this.items.length - 1
      const last = Math.max(0, this.items[this.b]!.words.length - 1)
      this.w = this.sentenceStart(this.b, last)
      return void this.afterSeek()
    }

    if (direction < 0) {
      const start = this.sentenceStart(this.b, this.w)
      if (this.w > start) {
        this.w = start // first press restarts the current sentence
      } else if (start > 0) {
        this.w = this.sentenceStart(this.b, start - 1)
      } else if (this.b > 0) {
        this.b--
        const last = Math.max(0, this.items[this.b]!.words.length - 1)
        this.w = this.sentenceStart(this.b, last)
      }
    } else {
      const words = this.items[this.b]!.words
      const sentence = words[this.w]?.sentence
      let next = this.w
      while (next < words.length && words[next]!.sentence === sentence) next++
      if (next < words.length) {
        this.w = next
      } else if (this.b < this.items.length - 1) {
        this.b++
        this.w = 0
      }
    }
    this.afterSeek()
  }

  /** Redraw the current word and paragraph (after the reader page is rebuilt). */
  async redraw() {
    this.shownChunk = ''
    await this.show(this.generation)
  }

  stop() {
    this.cancel()
    this.playing = false
  }

  // ── internals ──

  private afterSeek() {
    this.lastWordAt = 0
    this.view.changed()
    if (this.playing) void this.tick(this.generation)
    else void this.show(this.generation)
  }

  private sentenceStart(block: number, word: number): number {
    const words = this.items[block]?.words ?? []
    const sentence = words[word]?.sentence
    let start = word
    while (start > 0 && words[start - 1]!.sentence === sentence) start--
    return start
  }

  private cancel() {
    this.generation++
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** Draws the current position. Returns how long it should stay up. */
  private async show(generation: number): Promise<number> {
    const { wordBoxWidth, wordBoxLines, measure } = this.geometry
    const item = this.items[this.b]

    if (!item) {
      if (this.complete) {
        await this.setPara('End of topic.\nPress to read again.\nDouble press for links.')
        if (generation !== this.generation) return 0
        await this.view.word(placeLine('End', wordBoxWidth, wordBoxLines, measure))
      } else {
        await this.view.word(placeLine('...', wordBoxWidth, wordBoxLines, measure))
      }
      return 0
    }

    if (item.block.kind === 'heading') {
      // A heading card previews the paragraph that follows it, so the side
      // box is already in place when the words start.
      const upcoming = this.items[this.b + 1]
      const preview = upcoming?.block.kind === 'para' ? upcoming.chunks[0]?.text : undefined
      await this.setPara(item.block.note ?? preview ?? item.block.text)
      if (generation !== this.generation) return 0
      await this.view.word(placeLine(item.block.text, wordBoxWidth, wordBoxLines, measure))
      return HEADING_MS
    }

    const word = item.words[this.w]
    if (!word) return 0
    const chunk = item.chunks.find(c => this.w >= c.from && this.w < c.to)
    if (chunk) await this.setPara(chunk.text)
    if (generation !== this.generation) return 0
    await this.view.word(placeWord(word.display, wordBoxWidth, wordBoxLines, measure, this.geometry.wordAnchor))
    return wordDelay(word, this.wpm, MIN_WORD_MS)
  }

  private async setPara(text: string) {
    if (text === this.shownChunk) return
    this.shownChunk = text
    await this.view.para(text)
  }

  private advance() {
    const item = this.items[this.b]
    if (!item) return
    if (item.block.kind === 'heading' || this.w + 1 >= item.words.length) {
      this.b++
      this.w = 0
      this.view.changed()
    } else {
      this.w++
    }
  }

  private async tick(generation: number) {
    if (generation !== this.generation || !this.playing) return
    const startedAt = this.clock.now()
    const isWord = this.items[this.b]?.block.kind === 'para'
    const delay = await this.show(generation)
    if (generation !== this.generation || !this.playing) return

    if (!this.items[this.b]) {
      if (this.complete) {
        this.playing = false
        this.view.changed()
      } else {
        this.waitingForMore = true // addBlock() or finish() restarts the loop
      }
      return
    }

    if (isWord) this.trackPace(startedAt)

    // Hold the beat from when the write started. If Bluetooth is slower than
    // the beat, the next word follows immediately: words are never queued up.
    const wait = Math.max(0, delay - (this.clock.now() - startedAt))
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      if (generation !== this.generation || !this.playing) return
      this.advance()
      void this.tick(generation)
    }, wait)
  }

  private trackPace(startedAt: number) {
    if (this.lastWordAt) {
      const interval = startedAt - this.lastWordAt
      if (interval > 0 && interval < 5000) {
        const wpm = 60000 / interval
        this.measuredWpm = this.measuredWpm ? this.measuredWpm * 0.9 + wpm * 0.1 : wpm
      }
    }
    this.lastWordAt = startedAt
  }
}
