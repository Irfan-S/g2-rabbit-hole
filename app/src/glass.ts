// Everything that draws on the glasses. Three page layouts:
//   message : one full-screen text box (home, listening, loading, errors)
//   reader  : info column (with the section's picture under it) + speed-reader word in
//             the middle + paragraph column
//             (when BIG_WORD_PX is set, the speed-reader box holds a picture of the text)
//   menu    : one full-screen list (links and controls)
//   cover   : a topic's picture with its title and credit underneath
//
// Rules from Even's display docs that shape this file:
//   - exactly one container per page receives input (isEventCapture: 1)
//   - changing layout needs rebuildPageContainer, which flickers; changing
//     text inside a layout uses textContainerUpgrade, which does not
//   - a list holds at most 20 items of at most 63 bytes each

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  BIG_WORD_PX,
  CANVAS_H,
  CENTRE_WORDS,
  CANVAS_W,
  COVER_IMAGE,
  COVER_TEXT,
  FIGURE_IMAGE,
  PARA_BOX,
  SIDE_FIGURES,
  STATUS_BOX,
  WORD_BOX,
  WORD_IMAGE,
  type Box,
} from './config'
import { pivotOf } from './text'

type Layout = 'none' | 'message' | 'reader' | 'menu' | 'cover'

const MAX_TEXT_BYTES = 990
const MAX_ITEM_BYTES = 63
const MAX_ITEMS = 20

const encoder = new TextEncoder()

/** Trims a string so its UTF-8 encoding fits `maxBytes`, without splitting a character. */
export function clampBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > maxBytes - 3) break
    out += char
    used += size
  }
  return out.trimEnd() + '...'
}

function textBox(box: Box, id: number, name: string, content: string, capture: boolean, borderColor: number) {
  return new TextContainerProperty({
    xPosition: box.x,
    yPosition: box.y,
    width: box.w,
    height: box.h,
    borderWidth: box.border,
    borderColor,
    borderRadius: box.border ? 6 : 0,
    paddingLength: box.pad,
    containerID: id,
    containerName: name,
    content: clampBytes(content, MAX_TEXT_BYTES),
    isEventCapture: capture ? 1 : 0,
  })
}

const FULL: Box = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, pad: 8, border: 0 }

let canvas: HTMLCanvasElement | null = null

async function pngOf(source: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>(resolve => source.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not encode the picture')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Downloads a picture and fits it inside a frame of the given size as a PNG; an empty
 * `url` gives a blank frame. The glasses turn it into 16 shades of green. A white backing
 * goes under it first: many diagrams are dark lines on a transparent background, which
 * would otherwise vanish on a black display.
 */
export async function photoPng(
  url: string,
  { w, h }: { w: number; h: number } = COVER_IMAGE,
  timeoutMs = 4000,
): Promise<Uint8Array> {
  const frame = Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = frame.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  if (!url) return pngOf(frame)
  const image = new Image()
  image.crossOrigin = 'anonymous' // without this the canvas cannot be read back
  image.src = url
  await Promise.race([
    image.decode(),
    new Promise((_, reject) => window.setTimeout(() => reject(new Error('picture took too long')), timeoutMs)),
  ])
  const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight)
  const width = Math.round(image.naturalWidth * scale)
  const height = Math.round(image.naturalHeight * scale)
  const x = Math.round((w - width) / 2)
  const y = Math.round((h - height) / 2)
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, width, height)
  ctx.drawImage(image, x, y, width, height)
  return pngOf(frame)
}

/**
 * Draws the contents of the speed-reader box as a PNG, white on black.
 * - One word: centred, and shrunk if it is too long to fit. With CENTRE_WORDS off, its
 *   pivot letter sits on the centre line instead (as placeWord does for the firmware font).
 * - Several words (a heading or notice): centred, on two lines if one would be too small.
 * An empty string gives a blank picture.
 */
export async function wordPng(display: string): Promise<Uint8Array> {
  canvas ??= Object.assign(document.createElement('canvas'), { width: WORD_IMAGE.w, height: WORD_IMAGE.h })
  const ctx = canvas.getContext('2d')!
  const { w, h } = WORD_IMAGE
  const room = w - 4
  const font = (px: number) => `600 ${px}px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
  const widthAt = (text: string, px: number) => ((ctx.font = font(px)), ctx.measureText(text).width)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'

  const words = display.split(/\s+/).filter(Boolean)
  let lines = words.length ? [words.join(' ')] : []
  if (words.length > 1 && widthAt(lines[0]!, BIG_WORD_PX) > room) {
    // Split at the space nearest the middle.
    const half = lines[0]!.length / 2
    const head = (count: number) => words.slice(0, count).join(' ')
    let cut = 1
    for (let i = 2; i < words.length; i++) {
      if (Math.abs(head(i).length - half) < Math.abs(head(cut).length - half)) cut = i
    }
    lines = [head(cut), words.slice(cut).join(' ')]
  }
  const most = lines.length > 1 ? Math.min(BIG_WORD_PX, Math.floor(h / 2) - 4) : BIG_WORD_PX
  const widest = Math.max(0, ...lines.map(line => widthAt(line, most)))
  const px = widest > room ? Math.floor((most * room) / widest) : most
  ctx.font = font(px)

  lines.forEach((line, i) => {
    const width = ctx.measureText(line).width
    let x = (w - width) / 2
    if (words.length === 1 && !CENTRE_WORDS) {
      const pivot = pivotOf(line)
      const pivotCentre =
        ctx.measureText(line.slice(0, pivot)).width + ctx.measureText(line.slice(pivot, pivot + 1)).width / 2
      // The picture is centred on the display, so its middle is where the pivot letter goes.
      x = Math.max(2, Math.min(w / 2 - pivotCentre, w - 2 - width))
    }
    ctx.fillText(line, x, h / 2 + (i - (lines.length - 1) / 2) * (px + 4))
  })

  return pngOf(canvas)
}

export class Glass {
  private layout: Layout = 'none'
  private started = false
  private chain: Promise<unknown> = Promise.resolve()
  /** Last content sent to each container, to skip writes that change nothing. */
  private shown = new Map<string, string>()
  /** Big-word mode. Turned off for the session if the glasses reject a picture. */
  private bigWord = BIG_WORD_PX > 0
  /** Word currently in the picture: '' = blank, null = not written since the page was built. */
  private pictured: string | null = null
  /** Section pictures in the info column. Turned off if the glasses refuse the extra container. */
  private sideFigures = SIDE_FIGURES
  /** Picture asked for in the info column ('' = none), and the one actually there (null = unknown). */
  private figureWanted = ''
  private figureShown: string | null = null

  constructor(private readonly bridge: EvenAppBridge) {}

  /** Bridge calls run one at a time: overlapping writes can race on Bluetooth. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job, job)
    this.chain = result.catch(() => undefined)
    return result
  }

  private async build(
    layout: Layout,
    page: {
      textObject?: TextContainerProperty[]
      listObject?: ListContainerProperty[]
      imageObject?: ImageContainerProperty[]
    },
  ) {
    const containerTotalNum =
      (page.textObject?.length ?? 0) + (page.listObject?.length ?? 0) + (page.imageObject?.length ?? 0)
    const rebuild = () => this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum, ...page }))
    if (!this.started) {
      const result = await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum, ...page }),
      )
      // The startup page can only be created once per run of the plugin. If this page was
      // reloaded (a dev-server reload, or the WebView restarting), the glasses still have
      // the old one and refuse a second: rebuild it instead. Seen on real glasses.
      if (result !== 0 && !(await rebuild())) {
        throw new Error(`The glasses refused the first screen (createStartUpPageContainer code ${result})`)
      }
      this.started = true
    } else if (!(await rebuild())) {
      throw new Error('rebuildPageContainer was rejected')
    }
    this.layout = layout
    this.shown.clear()
    this.pictured = null
    this.figureShown = null
    for (const box of page.textObject ?? []) this.shown.set(box.containerName ?? '', box.content ?? '')
  }

  private async upgrade(id: number, name: string, content: string) {
    const clamped = clampBytes(content, MAX_TEXT_BYTES)
    if (this.shown.get(name) === clamped) return
    this.shown.set(name, clamped)
    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: id, containerName: name, content: clamped }),
    )
  }

  /** Shows a full-screen message. */
  message(text: string): Promise<void> {
    return this.run(async () => {
      if (this.layout === 'message') return this.upgrade(1, 'main', text)
      await this.build('message', { textObject: [textBox(FULL, 1, 'main', text, true, 0)] })
    })
  }

  /**
   * Shows a topic's picture with `text` under it. Returns false, leaving the screen as it
   * was, if the picture cannot be loaded; the caller then goes straight to reading.
   */
  cover(text: string, url: string): Promise<boolean> {
    return this.run(async () => {
      let png: Uint8Array
      try {
        png = await photoPng(url)
      } catch (err) {
        console.warn('cover picture skipped:', err)
        return false
      }
      await this.build('cover', {
        textObject: [textBox(COVER_TEXT, 1, 'main', text, true, 0)],
        imageObject: [
          new ImageContainerProperty({
            xPosition: COVER_IMAGE.x,
            yPosition: COVER_IMAGE.y,
            width: COVER_IMAGE.w,
            height: COVER_IMAGE.h,
            containerID: 2,
            containerName: 'photo',
          }),
        ],
      })
      const result = await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: 2, containerName: 'photo', imageData: png }),
      )
      if (result !== ImageRawDataUpdateResult.success) console.warn(`cover picture failed (${result})`)
      return result === ImageRawDataUpdateResult.success
    })
  }

  /** Switches to the reader layout. */
  reader(initial: { word: string; para: string; status: string }): Promise<void> {
    const image = (name: string, id: number, box: { x: number; y: number; w: number; h: number }) =>
      new ImageContainerProperty({
        xPosition: box.x,
        yPosition: box.y,
        width: box.w,
        height: box.h,
        containerID: id,
        containerName: name,
      })
    const page = () => ({
      textObject: [
        // The word box takes input. Its content is always short, so the
        // firmware never scrolls it and swipes come through as events.
        textBox(WORD_BOX, 1, 'word', initial.word, true, 10),
        textBox(PARA_BOX, 2, 'para', initial.para, false, 4),
        textBox(STATUS_BOX, 3, 'status', initial.status, false, 0),
      ],
      imageObject: [
        ...(this.bigWord ? [image('bigword', 4, WORD_IMAGE)] : []),
        ...(this.sideFigures ? [image('figure', 5, FIGURE_IMAGE)] : []),
      ],
    })
    return this.run(async () => {
      try {
        await this.build('reader', page())
      } catch (err) {
        // A second image container has never been tried on real glasses. If they refuse
        // the page, reading matters more than the picture: build it again without one.
        if (!this.sideFigures) throw err
        console.warn('reader page refused with a section picture; retrying without it')
        this.sideFigures = false
        await this.build('reader', page())
      }
    })
  }

  /**
   * Shows the picture for the section being read in the info column, or clears it.
   * Cheap to call on every refresh: it only sends when the picture actually changes.
   */
  setFigure(url = ''): Promise<void> {
    if (!this.sideFigures || (url === this.figureWanted && this.figureShown !== null)) return Promise.resolve()
    this.figureWanted = url
    // Download and encode outside the queue, so words keep flowing meanwhile.
    const png = photoPng(url, FIGURE_IMAGE).catch(() => null)
    return this.run(async () => {
      const data = await png
      // Skip if the page changed, a newer picture was asked for, or this one is already up.
      if (this.layout !== 'reader' || url !== this.figureWanted || url === this.figureShown || !data) return
      const result = await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: 5, containerName: 'figure', imageData: data }),
      )
      if (result === ImageRawDataUpdateResult.success) this.figureShown = url
      else console.warn(`section picture failed (${result})`)
    })
  }

  /** Puts `display` in the word picture. Returns false if the glasses refused it. */
  private async picture(display: string): Promise<boolean> {
    if (this.pictured === display) return true
    const result = await this.bridge.updateImageRawData(
      new ImageRawDataUpdate({ containerID: 4, containerName: 'bigword', imageData: await wordPng(display) }),
    )
    if (result !== ImageRawDataUpdateResult.success) {
      console.warn(`word picture failed (${result}): using the firmware font from here on`)
      this.bigWord = false
      return false
    }
    this.pictured = display
    return true
  }

  /**
   * `content` is a word or line already placed for the firmware font (blank lines and
   * spaces, then the text). In big-word mode the text goes in the picture instead and
   * the firmware text box under it stays empty, so the two never overlap.
   */
  setWord(content: string): Promise<void> {
    return this.run(async () => {
      if (this.layout !== 'reader') return
      if (this.bigWord && (await this.picture(content.trim()))) return
      await this.upgrade(1, 'word', content)
    })
  }

  setPara(content: string): Promise<void> {
    return this.run(async () => {
      if (this.layout === 'reader') await this.upgrade(2, 'para', content)
    })
  }

  setStatus(content: string): Promise<void> {
    return this.run(async () => {
      if (this.layout === 'reader') await this.upgrade(3, 'status', content)
    })
  }

  /** Switches to a full-screen list. The firmware handles scrolling and highlighting. */
  menu(items: string[]): Promise<void> {
    return this.run(async () => {
      const itemName = items.slice(0, MAX_ITEMS).map(item => clampBytes(item, MAX_ITEM_BYTES))
      await this.build('menu', {
        listObject: [
          new ListContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: CANVAS_W,
            height: CANVAS_H,
            borderWidth: 0,
            paddingLength: 4,
            containerID: 1,
            containerName: 'menu',
            isEventCapture: 1,
            itemContainer: new ListItemContainerProperty({
              itemCount: itemName.length,
              itemWidth: CANVAS_W - 8,
              isItemSelectBorderEn: 1,
              itemName,
            }),
          }),
        ],
      })
    })
  }

  get current(): Layout {
    return this.layout
  }
}
