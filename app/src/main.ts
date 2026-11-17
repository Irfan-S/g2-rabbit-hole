// Rabbit Hole for Even G2.
//
// Speak a topic -> the backend rewrites the Wikipedia article as a breakdown ->
// the glasses play it one word at a time in the large box, with the paragraph
// being read in the side box. Linked terms appear in [brackets] and can be
// opened from the menu, which starts a new topic one level deeper.
//
// Controls (temple touchpads or the R1 ring):
//   reading : press = play/pause   swipe up/down = sentence back/forward
//             double press = menu (links, speed, back, new topic, exit)
//             hold = ask a question about what you are reading; let go to send it
//   menu    : swipe = move   press = choose   double press = close
//   home    : press = speak a topic   swipe = topics already read   double press = exit

import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import { streamTopic, transcribe, type TopicParams } from './api'
import { concatBytes, toBytes } from './audio'
import {
  CANVAS_W,
  COVER_MS,
  COVER_TEXT,
  MAX_ASK_MS,
  MAX_LISTEN_MS,
  MAX_MENU_LINKS,
  MENU_ROWS,
  PARA_BOX,
  STATUS_BOX,
  TEXT_MENU,
  WORD_ANCHOR,
  WORD_BOX,
  WPM_DEFAULT,
  WPM_MAX,
  WPM_MIN,
  WPM_STEP,
  innerWidth,
  lineCapacity,
} from './config'
import { Glass } from './glass'
import homeArt from './home.png'
import { parseHistory, recordVisit } from './history'
import { Reader } from './reader'
import { placeLine } from './text'
import type { Block, Candidate, LeadImage } from './types'
import { mountUi, renderUi } from './ui'

type State = 'home' | 'listening' | 'thinking' | 'loading' | 'cover' | 'reading' | 'menu' | 'error'
type Gesture = 'click' | 'double' | 'up' | 'down' | 'hold' | 'release'

/** One topic on the trail. Its stream keeps filling `blocks` even while the reader is elsewhere. */
interface Entry {
  label: string
  title: string
  url: string
  license: string
  blocks: Block[]
  complete: boolean
  error?: string
  /** The article's main picture, if it has one. Shown once, as a cover, when the topic opens. */
  image?: LeadImage
  covered?: boolean
  /** Set when this entry is the answer to a question rather than a topic. */
  ask?: TopicParams['ask']
  position: { block: number; word: number }
  abort: AbortController
}

const HOME_TEXT =
  'Rabbit Hole\n\nPress, say a topic, then press again.\nSwipe for topics you have read.\n\nDouble press to exit.'
/** The same, as three lines to sit under the home picture. */
const HOME_LINES = ['Rabbit Hole', 'Press, say a topic, press again', 'Swipe: topics read.  Double press: exit']

const bridge = await waitForEvenAppBridge()
const glass = new Glass(bridge)

/** Titles of topics already opened, newest first. Kept on the phone between sessions. */
let history: string[] = await bridge
  .getLocalStorage('history')
  .then(parseHistory)
  .catch(() => [])

let state: State = 'home'
let trail: Entry[] = []
let active: Entry | null = null
/** How many of the active entry's blocks the reader has been given. */
let fed = 0
let errorText = ''
let menuActions: Array<{ label: string; run: () => Promise<void> | void }> = []
let pcmChunks: Uint8Array[] = []
let listenTimer: number | null = null
/** Bumped whenever a pending transcription should be ignored. */
let listenToken = 0
/** Set while the reader is choosing between several meanings of what they asked for. */
let choices: { query: string; options: Candidate[] } | null = null
/** The cover card stays up until this time (ms), unless a press skips it. */
let coverUntil = 0
/** What the microphone is recording: a new topic, or a question about the one being read. */
let listenFor: 'topic' | 'question' = 'topic'
/** The article and passage a spoken question is about, noted when recording starts. */
let askAbout = { title: '', passage: '' }

const reader = new Reader(
  {
    word: content => glass.setWord(content),
    para: content => glass.setPara(content),
    changed: () => refresh(),
  },
  {
    wordBoxWidth: innerWidth(WORD_BOX),
    wordBoxLines: lineCapacity(WORD_BOX),
    wordAnchor: WORD_ANCHOR,
    paraBoxLines: lineCapacity(PARA_BOX),
    measure: getTextWidth,
    paraLines: text => measureTextWrap(text, innerWidth(PARA_BOX)).lineCount,
  },
  await loadWpm(),
)

// ── state transitions run one at a time ──

let queue: Promise<void> = Promise.resolve()
function transition(step: () => Promise<void> | void) {
  queue = queue.then(step).catch(err => {
    console.error(err)
    return showError((err as Error)?.message ?? String(err))
  })
  return queue
}

// ── screens ──

/**
 * The opening screen: the rabbit picture (art/home.py) with the title and controls under
 * it. Falls back to plain text if the glasses will not show the picture.
 */
async function showHome() {
  const width = innerWidth(COVER_TEXT)
  const text = HOME_LINES.map(line => placeLine(line, width, 1, getTextWidth)).join('\n')
  const shown = await glass.cover(text, homeArt).catch(err => {
    console.warn('home picture failed:', err)
    return false
  })
  if (!shown) await glass.message(HOME_TEXT)
}

async function goHome() {
  for (const entry of trail) entry.abort.abort()
  choices = null
  trail = []
  active = null
  reader.reset()
  state = 'home'
  await showHome()
  refresh()
}

async function showError(message: string) {
  reader.stop()
  errorText = message
  state = 'error'
  await glass.message(`Something went wrong\n\n${message}\n\nPress to continue.`).catch(() => undefined)
  refresh()
}

async function recover() {
  errorText = ''
  const top = trail[trail.length - 1]
  if (top && top.blocks.length) await activate(top, false)
  else await goHome()
}

async function enterReader(autoplay: boolean) {
  state = 'reading'
  await glass.reader({ word: ' ', para: ' ', status: statusText() })
  await reader.redraw()
  if (autoplay) reader.play()
  refresh()
}

/** Points the reader at an entry: either resumes it or shows a loading screen until blocks arrive. */
async function activate(entry: Entry, autoplay: boolean) {
  active = entry
  fed = 0
  reader.reset()
  if (!entry.blocks.length) {
    state = 'loading'
    await glass.message(`Opening\n\n${entry.label}`)
    refresh()
    return
  }
  feedReader(entry)
  reader.restore(entry.position)
  await enterReader(autoplay)
}

function feedReader(entry: Entry) {
  while (fed < entry.blocks.length) reader.addBlock(entry.blocks[fed++]!)
  if (entry.complete) reader.finish()
}

/** Called whenever the active entry may have new blocks. */
async function sync() {
  const entry = active
  if (!entry || (state !== 'loading' && state !== 'cover' && state !== 'reading' && state !== 'menu')) return
  feedReader(entry)
  if (state === 'loading' && fed > 0 && entry.image && !entry.covered) await showCover(entry)
  else if (state === 'loading' && fed > 0) await enterReader(true)
  else if (state === 'cover' && Date.now() >= coverUntil) await enterReader(true)
  refresh()
}

/** Shows the topic's picture for a few seconds while the breakdown is still being written. */
async function showCover(entry: Entry) {
  entry.covered = true
  state = 'cover'
  const width = innerWidth(COVER_TEXT)
  const lines = [pxTruncate(entry.title, width), entry.license, 'Press to start reading']
  const shown = await glass.cover(lines.map(line => placeLine(line, width, 1, getTextWidth)).join('\n'), entry.image!.url)
  if (!shown) return enterReader(true)
  coverUntil = Date.now() + COVER_MS
  window.setTimeout(() => void transition(sync), COVER_MS + 20)
}

// ── topics ──

async function startTopic(params: TopicParams, label: string, resetTrail: boolean) {
  if (resetTrail) {
    for (const entry of trail) entry.abort.abort()
    trail = []
  } else if (active) {
    active.position = reader.position()
  }
  reader.stop()
  errorText = ''
  choices = null
  const entry: Entry = {
    label,
    title: label,
    url: '',
    license: '',
    blocks: [],
    complete: false,
    ask: params.ask,
    position: { block: 0, word: 0 },
    abort: new AbortController(),
  }
  trail.push(entry)
  await activate(entry, true)
  void runStream(entry, params)
}

async function runStream(entry: Entry, params: TopicParams) {
  try {
    await streamTopic(
      params,
      event => {
        if (event.type === 'meta' && entry.ask) {
          entry.url = event.url
          entry.license = event.license
          // An answer opens with the question as it was heard, so a mishearing is visible.
          entry.blocks.push({
            kind: 'heading',
            text: 'Your question',
            links: [],
            note: `${entry.ask.question}\n\nAnswered by Claude, using the article.`,
          })
        } else if (event.type === 'meta') {
          entry.title = event.title
          history = recordVisit(history, event.title)
          void bridge.setLocalStorage('history', JSON.stringify(history)).catch(() => undefined)
          entry.url = event.url
          entry.license = event.license
          entry.image = event.image
          // A title card opens every topic and carries the source credit.
          entry.blocks.push({
            kind: 'heading',
            text: event.title,
            links: [],
            note: `${event.title}\n\nSource: ${event.license}.\nRewritten by Claude.`,
          })
        } else if (event.type === 'choices') {
          return void transition(() => chooseTopic(entry, event.query, event.options))
        } else if (event.type === 'block') {
          entry.blocks.push(event.block)
        } else if (event.type === 'done') {
          entry.complete = true
        } else if (event.type === 'error') {
          entry.error = event.message
        }
        void transition(sync)
      },
      entry.abort.signal,
    )
    if (!entry.complete && !entry.error) entry.error = 'The connection closed before the topic finished.'
  } catch (err) {
    if (entry.abort.signal.aborted) return
    entry.error = (err as Error)?.message ?? String(err)
  }
  if (entry.error) void transition(() => failTopic(entry))
}

async function failTopic(entry: Entry) {
  const hasText = entry.blocks.some(block => block.kind === 'para')
  if (hasText) {
    // Keep what arrived; the reader simply ends early.
    entry.complete = true
    if (entry === active) {
      errorText = `Stopped early: ${entry.error}`
      await sync()
    }
    return
  }
  trail = trail.filter(item => item !== entry)
  if (entry === active) await showError(`Could not open "${entry.label}".\n${entry.error}`)
}

/**
 * The request was a bare name with several meanings ("mercury"). Nothing has been
 * opened: list the meanings and open the one the reader picks.
 */
async function chooseTopic(entry: Entry, query: string, options: Candidate[]) {
  if (entry !== active) return
  trail = trail.filter(item => item !== entry)
  active = null
  reader.reset()
  choices = { query, options }
  menuActions = [
    // The firmware list holds 20 items; each label is cut to fit by the list itself.
    ...options.slice(0, 19).map(option => ({
      label: option.description ? `${option.title}: ${option.description}` : option.title,
      run: () => startTopic({ title: option.title }, option.title, true),
    })),
    { label: 'Cancel', run: goHome },
  ]
  await showMenu()
}

async function dive(title: string) {
  await startTopic({ title }, title, false)
}

/** The article and passage a question asked right now would be about. */
function readingNow() {
  // A question asked while on an answer is still about the article behind it.
  return { title: active?.ask?.title ?? active?.title ?? '', passage: reader.currentBlock()?.text ?? '' }
}

/** Opens the answer one level deeper, like a link: "Back" returns to where the reader was. */
async function startAnswer(question: string, about: { title: string; passage: string }) {
  await startTopic({ ask: { ...about, question } }, `Q: ${question}`, false)
}

async function goBack() {
  if (trail.length < 2) return
  const gone = trail.pop()
  gone?.abort.abort()
  await activate(trail[trail.length - 1]!, false)
}

// ── spoken topic ──

async function startListening(what: 'topic' | 'question' = 'topic') {
  listenFor = what
  if (what === 'question') askAbout = readingNow()
  reader.pause()
  if (active) active.position = reader.position()
  state = 'listening'
  pcmChunks = []
  await glass.message(
    what === 'question'
      ? 'Listening...\n\nAsk your question.\nLet go, or press, when done.'
      : 'Listening...\n\nSay a topic.\nPress when done.',
  )
  await bridge.audioControl(true)
  listenTimer = window.setTimeout(
    () => void transition(stopListening),
    what === 'question' ? MAX_ASK_MS : MAX_LISTEN_MS,
  )
  refresh()
}

async function stopMic() {
  if (listenTimer !== null) window.clearTimeout(listenTimer)
  listenTimer = null
  await bridge.audioControl(false).catch(() => undefined)
}

async function stopListening() {
  if (state !== 'listening') return
  await stopMic()
  state = 'thinking'
  await glass.message(listenFor === 'question' ? 'Thinking...' : 'Finding topic...')
  refresh()
  const token = ++listenToken
  const audio = concatBytes(pcmChunks)
  pcmChunks = []
  // Under a tenth of a second of audio means the microphone delivered nothing.
  if (audio.length < 3200) return showError('Heard nothing. Check the microphone permission, then try again.')
  // The network call runs outside the queue so a double press can still cancel it.
  void transcribe(audio)
    .then(result =>
      transition(async () => {
        if (token !== listenToken || state !== 'thinking') return
        if (listenFor === 'question') {
          const question = result.transcript.trim()
          if (!question) throw new Error('No question heard. Try again.')
          return startAnswer(question, askAbout)
        }
        if (!result.topic) throw new Error('No topic heard. Try again.')
        await startTopic({ q: result.topic }, result.topic, true)
      }),
    )
    .catch(err =>
      transition(async () => {
        if (token !== listenToken || state !== 'thinking') return
        await showError((err as Error)?.message ?? String(err))
      }),
    )
}

async function cancelListening() {
  listenToken++
  await stopMic()
  await recover()
}

// ── menu ──

/** The highlighted item, and the first item on screen, of a text menu. */
let menuIndex = 0
let menuTop = 0

/** Shows `menuActions` as a menu on the glasses, with the first item highlighted. */
async function showMenu() {
  menuIndex = 0
  menuTop = 0
  state = 'menu'
  if (TEXT_MENU) await glass.message(menuText())
  else await glass.menu(menuActions.map(action => action.label))
  refresh()
}

/** The visible part of the menu as text: a ">" marks the highlighted item. */
function menuText(): string {
  // Scroll the window just far enough to keep the highlight on screen.
  if (menuIndex < menuTop) menuTop = menuIndex
  if (menuIndex >= menuTop + MENU_ROWS) menuTop = menuIndex - MENU_ROWS + 1
  const marker = '> '
  const spaceWidth = Math.max(1, getTextWidth(' '.repeat(10)) / 10)
  const indent = ' '.repeat(Math.max(1, Math.round(getTextWidth(marker) / spaceWidth)))
  const room = CANVAS_W - 16 - getTextWidth(marker) - 8
  return menuActions
    .slice(menuTop, menuTop + MENU_ROWS)
    .map((action, row) => (menuTop + row === menuIndex ? marker : indent) + pxTruncate(action.label, room))
    .join('\n')
}

/** Moves the highlight one item up or down. Menus are circular: past either end is the other end. */
async function moveMenu(step: -1 | 1) {
  const count = menuActions.length
  if (!count) return
  menuIndex = (menuIndex + step + count) % count
  await glass.message(menuText())
}

async function openMenu() {
  reader.pause()
  const links = reader.links(MAX_MENU_LINKS)
  const slower = Math.max(WPM_MIN, reader.wpm - WPM_STEP)
  const faster = Math.min(WPM_MAX, reader.wpm + WPM_STEP)
  menuActions = [
    { label: 'Resume reading', run: () => enterReader(true) },
    // Same as holding the ring while reading, for when a long press does not get through.
    { label: 'Ask a question (speak)', run: () => startListening('question') },
    // The linked words get a list of their own, so this menu stays short.
    ...(links.length ? [{ label: `Open a link (${links.length})`, run: openLinks }] : []),
    { label: `Slower (${slower} wpm)`, run: () => changeSpeed(slower) },
    { label: `Faster (${faster} wpm)`, run: () => changeSpeed(faster) },
  ]
  const parent = trail[trail.length - 2]
  if (parent) menuActions.push({ label: `Back to: ${parent.title}`, run: goBack })
  menuActions.push({ label: 'Topics you have read', run: openHistory })
  menuActions.push({ label: 'New topic (speak)', run: () => startListening() })
  menuActions.push({ label: 'Exit', run: () => void bridge.shutDownPageContainer(1) })
  await showMenu()
}

/** Lists the linked words near what is being read; choosing one opens it a level deeper. */
async function openLinks() {
  menuActions = [
    { label: 'Back to menu', run: openMenu },
    // "Reread" marks a link whose topic has been opened before.
    ...reader.links(MAX_MENU_LINKS).map(link => ({
      label: `${history.includes(link.title) ? 'Reread' : 'Open'}: ${link.title}`,
      run: () => dive(link.title),
    })),
  ]
  await showMenu()
}

/** Lists topics already read, newest first. Choosing one opens it as a fresh trail. */
async function openHistory() {
  reader.pause()
  menuActions = [
    { label: history.length ? 'Close' : 'Nothing read yet. Close', run: () => (active ? enterReader(false) : goHome()) },
    // The firmware list holds 20 items.
    ...history.slice(0, 19).map(title => ({ label: title, run: () => startTopic({ title }, title, true) })),
  ]
  await showMenu()
}

async function changeSpeed(wpm: number) {
  reader.setWpm(wpm)
  void bridge.setLocalStorage('wpm', String(wpm)).catch(() => undefined)
  if (state === 'menu') await enterReader(true)
  else refresh()
}

async function loadWpm(): Promise<number> {
  try {
    const stored = Number(await bridge.getLocalStorage('wpm'))
    if (stored >= WPM_MIN && stored <= WPM_MAX) return stored
  } catch {
    /* first run, or storage unavailable */
  }
  return WPM_DEFAULT
}

// ── input ──

async function handle(gesture: Gesture, listIndex?: number) {
  switch (state) {
    case 'home':
      if (gesture === 'click') return startListening()
      if (gesture === 'up' || gesture === 'down') return openHistory()
      if (gesture === 'double') return void bridge.shutDownPageContainer(1)
      return
    case 'listening':
      if (gesture === 'click') return stopListening()
      if (gesture === 'release' && listenFor === 'question') return stopListening()
      if (gesture === 'double') return cancelListening()
      return
    case 'thinking':
      if (gesture === 'double') return cancelListening()
      return
    case 'loading':
      if (gesture === 'double') {
        // Give up on the topic that is still loading.
        const entry = trail.pop()
        entry?.abort.abort()
        return recover()
      }
      return
    case 'cover':
      if (gesture === 'click' || gesture === 'double') return enterReader(true)
      return
    case 'reading':
      if (gesture === 'click') return reader.toggle()
      if (gesture === 'up') return reader.seekSentence(-1)
      if (gesture === 'down') return reader.seekSentence(1)
      if (gesture === 'double') return openMenu()
      if (gesture === 'hold') return startListening('question')
      return
    case 'menu':
      // A firmware list reports which item was pressed; a text menu tracks it itself.
      if (gesture === 'click') return menuActions[listIndex ?? menuIndex]?.run()
      if (TEXT_MENU && gesture === 'up') return moveMenu(-1)
      if (TEXT_MENU && gesture === 'down') return moveMenu(1)
      // The list of read topics can be opened from home, where there is nothing to resume.
      if (gesture === 'double') return active ? enterReader(false) : goHome()
      return
    case 'error':
      if (gesture === 'click' || gesture === 'double') return recover()
      return
  }
}

// A press is event type 0, and protobuf leaves zero-valued fields off the wire,
// so a press arrives with `eventType` undefined. The default must be applied
// inside the envelope that is present, or every audio frame would read as a press.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const audio = event.audioEvent?.audioPcm
  if (audio) {
    const bytes = state === 'listening' ? toBytes(audio) : null
    if (bytes) pcmChunks.push(bytes)
    return
  }

  const sys = eventTypeOf(event.sysEvent)
  const text = eventTypeOf(event.textEvent)
  const list = eventTypeOf(event.listEvent)

  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return cleanup()
  if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return reader.pause()

  const DOUBLE = OsEventTypeList.DOUBLE_CLICK_EVENT
  if (sys === DOUBLE || text === DOUBLE || list === DOUBLE) return void transition(() => handle('double'))
  // Hold to talk: recording starts on the long press and is sent when it is released.
  const kinds = [sys, text, list]
  if (kinds.includes(OsEventTypeList.LONG_PRESS_EVENT)) return void transition(() => handle('hold'))
  if (kinds.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return void transition(() => handle('release'))
  if (text === OsEventTypeList.SCROLL_TOP_EVENT) return void transition(() => handle('up'))
  if (text === OsEventTypeList.SCROLL_BOTTOM_EVENT) return void transition(() => handle('down'))

  if (list === OsEventTypeList.CLICK_EVENT) {
    // The first list item is index 0, which is also dropped from the wire.
    const index = event.listEvent?.currentSelectItemIndex ?? 0
    return void transition(() => handle('click', index))
  }
  if (list !== null) return // a firmware list moves its own highlight and reports nothing

  if (sys === OsEventTypeList.CLICK_EVENT || text === OsEventTypeList.CLICK_EVENT) {
    return void transition(() => handle('click'))
  }
})

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  reader.stop()
  for (const entry of trail) entry.abort.abort()
  void bridge.audioControl(false).catch(() => undefined)
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)

// ── status strip and phone-side mirror ──

function statusText(): string {
  if (!active) return ' '
  const total = reader.blockCount
  const at = Math.min(reader.blockIndex + 1, Math.max(1, total))
  const slow = reader.measuredWpm > 0 && reader.measuredWpm < reader.wpm * 0.85
  const pace = slow ? `~${Math.round(reader.measuredWpm / 10) * 10}` : `${reader.wpm}`
  const depth = trail.length > 1 ? `${trail.length}> ` : ''
  // Four lines at most, to leave the rest of the column for the section's picture:
  // the title (the firmware wraps it; kept to about two lines), position, then speed.
  const title = pxTruncate(depth + active.title, innerWidth(STATUS_BOX) * 1.7)
  return [title, `${at}/${total}${active.complete ? '' : '+'}`, reader.playing ? `${pace} wpm` : 'PAUSED'].join('\n')
}

let refreshPending = false
function refresh() {
  if (refreshPending) return
  refreshPending = true
  window.setTimeout(() => {
    refreshPending = false
    if (state === 'reading') {
      void glass.setStatus(statusText())
      void glass.setFigure(reader.currentFigure()?.url)
    }
    renderUi({
      state,
      title: active?.title ?? '',
      url: active?.url ?? '',
      license: active?.license ?? '',
      trail: trail.map(entry => entry.title),
      wpm: reader.wpm,
      measuredWpm: reader.measuredWpm,
      playing: reader.playing,
      progress: active ? `${Math.min(reader.blockIndex + 1, Math.max(1, reader.blockCount))}/${reader.blockCount}` : '',
      block: active ? reader.currentBlock() : undefined,
      links: active ? reader.links(MAX_MENU_LINKS).map(link => link.title) : [],
      history,
      // The section's own picture when it has one, otherwise the topic's.
      image: (state === 'reading' && reader.currentFigure()) || active?.image,
      choices: choices ?? undefined,
      error: errorText || undefined,
    })
  }, 0)
}

mountUi({
  // Typed text starting with "?" is a question about the topic being read.
  openTopic: topic =>
    void transition(() =>
      topic.startsWith('?') && active && topic.length > 1
        ? startAnswer(topic.slice(1).trim(), readingNow())
        : startTopic({ q: topic }, topic, true),
    ),
  openLink: title => void transition(() => dive(title)),
  openRead: title => void transition(() => startTopic({ title }, title, true)),
  toggle: () => void transition(() => (state === 'reading' ? reader.toggle() : undefined)),
  sentence: direction => void transition(() => (state === 'reading' ? reader.seekSentence(direction) : undefined)),
  speed: direction =>
    void transition(() => changeSpeed(Math.min(WPM_MAX, Math.max(WPM_MIN, reader.wpm + direction * WPM_STEP)))),
  back: () => void transition(goBack),
})

await showHome()
refresh()

// Development shortcut: open the page with ?topic=Something to skip the spoken step.
const preset = new URLSearchParams(window.location.search).get('topic')?.trim()
if (preset) void transition(() => startTopic({ q: preset }, preset, true))
// ...and add &ask=Some question to ask about it straight away (the topic must be an exact title).
const presetAsk = new URLSearchParams(window.location.search).get('ask')?.trim()
if (preset && presetAsk) void transition(() => startAnswer(presetAsk, { title: preset, passage: '' }))
