// Backend location and shared token. Set these in app/.env.local (see .env.example).
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787').replace(/\/+$/, '')
export const API_TOKEN = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? ''

// ── Glasses canvas: 576 x 288, one fixed firmware font, 27 px line height ──
export const CANVAS_W = 576
export const CANVAS_H = 288
export const LINE_HEIGHT = 27

export interface Box {
  x: number
  y: number
  w: number
  h: number
  pad: number
  border: number
}

// Reader layout: three columns. Info on the left, the word in the middle of the display
// (where the eye rests on the glasses), the paragraph being read on the right.

/** Left column, top: topic, position, speed or PAUSED (four lines at most). */
export const STATUS_BOX: Box = { x: 0, y: 0, w: 140, h: 150, pad: 6, border: 0 }
/**
 * Left column, bottom: the picture that goes with the section being read, when the
 * article has one. It does not overlap the status text above it. Set SIDE_FIGURES to
 * false to leave the space empty (one image fewer to send over Bluetooth per section).
 */
export const FIGURE_IMAGE = { x: 6, y: 156, w: 128, h: 128 }
export const SIDE_FIGURES = true
/**
 * Middle column. With BIG_WORD_PX set it stays empty under the word picture and only
 * takes input; otherwise the word is placed in it in the firmware font.
 */
export const WORD_BOX: Box = { x: 144, y: 0, w: 288, h: CANVAS_H, pad: 6, border: 0 }
/** Right column: the paragraph being read. */
export const PARA_BOX: Box = { x: 436, y: 0, w: 140, h: CANVAS_H, pad: 6, border: 1 }

/**
 * Size in px of the speed-reader word. The firmware font (about 21 px) cannot be
 * enlarged, so a bigger word is drawn as a picture and sent over Bluetooth.
 * 0 = use the firmware font. Words too long to fit at this size are shrunk.
 * Not yet timed on real glasses: if words lag there, lower this or set it to 0.
 */
export const BIG_WORD_PX = 44
/**
 * true  = each word is centred on the display (the user's preference on the glasses).
 * false = the word's pivot letter, near its start, sits on the centre line instead: the
 *         classic speed-reader placement, which makes long words hang off to the right.
 */
export const CENTRE_WORDS = true
/**
 * true  = letters are pure black and white. Measured on a paragraph of real words, a word
 *         then takes about 270 bytes to send instead of about 620 (compressed estimate).
 * false = smooth grey edges, which look a little softer and cost more than twice the data.
 */
export const CRISP_WORDS = true

// How far a word at BIG_WORD_PX reaches above and below its middle line: accented capitals
// above, brackets and descenders below (measured at 44 px in three common system fonts).
const WORD_ABOVE = Math.ceil(BIG_WORD_PX * 0.64)
const WORD_BELOW = Math.ceil(BIG_WORD_PX * 0.53)
/**
 * The word picture. It is only as tall as the tallest word needs (53 px at 44 px text;
 * it was 64), since every word sends and draws the whole frame. `baseline` is where the
 * word's middle line sits inside it, and `y` puts the letters themselves, not the frame,
 * on the centre of the display. The firmware allows at most 288 x 144, and at least 20.
 */
export const WORD_IMAGE = {
  x: (CANVAS_W - 288) / 2,
  y: Math.round(CANVAS_H / 2 - WORD_ABOVE - BIG_WORD_PX * 0.05),
  w: 288,
  h: Math.max(20, WORD_ABOVE + WORD_BELOW),
  baseline: WORD_ABOVE,
}

/**
 * Cover card: a topic's main picture, shown once when the topic opens, with its title
 * and credit underneath. A picture is at most 288 x 144 on this display.
 */
export const COVER_IMAGE = { x: (CANVAS_W - 288) / 2, y: 4, w: 288, h: 144 }
// Tall enough for four lines: the opening screen needs one more than a topic's cover does,
// for the offer to resume.
export const COVER_TEXT: Box = { x: 0, y: 152, w: CANVAS_W, h: 136, pad: 4, border: 0 }
/** How long the cover stays up before reading starts (a press skips it). */
export const COVER_MS = 3000
/**
 * The opening screen's animation (frames drawn by art/home.py): the pause between frames,
 * on top of however long the glasses take to show one, and how long it runs before
 * resting, so glasses left on the opening screen do not transmit for ever. 0 = no animation.
 */
export const HOME_FRAME_MS = 600
export const HOME_ANIMATE_MS = 30000

export const innerWidth = (box: Box) => box.w - 2 * (box.pad + box.border)
export const innerHeight = (box: Box) => box.h - 2 * (box.pad + box.border)
/**
 * How many lines of the firmware font fit in a box. The first line starts about 5 px below
 * the padding, so a box that is an exact multiple of the line height holds one line fewer:
 * without the allowance the full-height paragraph column overflowed by a line and scrolled.
 */
export const lineCapacity = (box: Box) => Math.max(1, Math.floor((innerHeight(box) - 6) / LINE_HEIGHT))
/** Firmware-font fallback: how far across the word box the pivot letter goes to land mid-display. */
export const WORD_ANCHOR = (CANVAS_W / 2 - WORD_BOX.x - WORD_BOX.pad - WORD_BOX.border) / innerWidth(WORD_BOX)

// ── Speed reader pacing ──
export const WPM_DEFAULT = 200
export const WPM_MIN = 100
export const WPM_MAX = 450
export const WPM_STEP = 25
/**
 * Even's own ASR template debounces glasses writes to 120 ms because the
 * Bluetooth render queue cannot keep up with faster updates. One word is one
 * write, so this is the floor on how short a word can be shown.
 */
export const MIN_WORD_MS = 120
export const HEADING_MS = 1400

// ── Spoken topic ──
export const MAX_LISTEN_MS = 8000
/** A spoken question may run longer than a topic name. */
export const MAX_ASK_MS = 15000

/**
 * true  = the app draws each menu as text and moves the ">" marker itself, so a menu can
 *         wrap around (swipe up on the first item lands on the last).
 * false = the firmware's own list. The glasses then move the highlight privately and only
 *         report presses (seen on real glasses), so wrapping around is impossible.
 */
export const TEXT_MENU = true
/**
 * Items shown at once in a text menu. A full screen holds nine lines, but the text must
 * fit with room to spare: if it could scroll, the firmware would take the swipes itself.
 */
export const MENU_ROWS = 8

/** How many links the menu lists (the firmware list holds 20 items at most). */
export const MAX_MENU_LINKS = 12
