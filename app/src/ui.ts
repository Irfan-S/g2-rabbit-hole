// The phone-side screen (the WebView inside the Even app). The glasses are the
// main surface; this page mirrors what is being read and gives typed controls
// that are handy on the desktop simulator, where there is no ring.

import type { Block, Candidate, LeadImage } from './types'

export interface UiModel {
  state: string
  title: string
  url: string
  license: string
  trail: string[]
  wpm: number
  measuredWpm: number
  playing: boolean
  progress: string
  block?: Block
  links: string[]
  /** Topics already opened, newest first. */
  history: string[]
  /** Meanings to choose between when the request named several things. */
  choices?: { query: string; options: Candidate[] }
  /** The topic's main picture. */
  image?: LeadImage
  error?: string
}

export interface UiHandlers {
  openTopic(topic: string): void
  openLink(title: string): void
  /** Reopen a topic from the history by its exact title. */
  openRead(title: string): void
  toggle(): void
  sentence(direction: -1 | 1): void
  speed(direction: -1 | 1): void
  back(): void
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

export function mountUi(handlers: UiHandlers) {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) return
  app.innerHTML = `
    <main>
      <header>
        <h1>Rabbit Hole</h1>
        <span id="state" class="chip"></span>
      </header>
      <form id="topicForm">
        <input id="topic" type="text" placeholder="Type a topic, or ?a question about this one" autocomplete="off" />
        <button type="submit">Go</button>
      </form>
      <p id="error" class="error" hidden></p>
      <section class="card">
        <div id="trail" class="muted"></div>
        <h2 id="title"></h2>
        <a id="photoLink" class="photo" target="_blank" rel="noopener" hidden>
          <img id="photo" alt="" />
          <span class="muted">Image from Wikimedia Commons. Tap for author and licence.</span>
        </a>
        <p id="block"></p>
        <div id="links" class="links"></div>
      </section>
      <section class="controls">
        <button data-act="prev">Sentence back</button>
        <button data-act="toggle" id="toggle">Play</button>
        <button data-act="next">Sentence on</button>
        <button data-act="slower">Slower</button>
        <span id="speed" class="muted"></span>
        <button data-act="faster">Faster</button>
        <button data-act="back" id="back">Back up</button>
      </section>
      <section class="card" id="historyCard" hidden>
        <div class="muted">Topics you have read</div>
        <div id="history" class="links"></div>
      </section>
      <footer id="source" class="muted"></footer>
    </main>`

  app.querySelector<HTMLFormElement>('#topicForm')?.addEventListener('submit', event => {
    event.preventDefault()
    const input = app.querySelector<HTMLInputElement>('#topic')
    const topic = input?.value.trim()
    if (topic) handlers.openTopic(topic)
    if (input) input.value = ''
  })

  app.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act],[data-link],[data-read]')
    if (!target) return
    if (target.dataset.read) return handlers.openRead(target.dataset.read)
    const link = target.dataset.link
    if (link) return handlers.openLink(link)
    switch (target.dataset.act) {
      case 'prev': return handlers.sentence(-1)
      case 'next': return handlers.sentence(1)
      case 'toggle': return handlers.toggle()
      case 'slower': return handlers.speed(-1)
      case 'faster': return handlers.speed(1)
      case 'back': return handlers.back()
    }
  })
}

export function renderUi(model: UiModel) {
  const set = (id: string, html: string) => {
    const el = document.getElementById(id)
    if (el && el.innerHTML !== html) el.innerHTML = html
  }
  set('state', escapeHtml(model.state))
  set('trail', escapeHtml(model.trail.join('  >  ')))
  set('title', escapeHtml(model.title ? `${model.title}  ${model.progress}` : ''))
  set(
    'block',
    model.choices
      ? `<strong>${escapeHtml(`"${model.choices.query}" can mean several things. Pick one:`)}</strong>`
      : model.block
        ? blockHtml(model.block)
        : '<span class="muted">Nothing open yet.</span>',
  )
  set(
    'links',
    (model.choices
      ? model.choices.options.map(
          option =>
            `<button class="link" data-read="${escapeHtml(option.title)}" title="${escapeHtml(option.description)}">${escapeHtml(option.title)}</button>`,
        )
      : model.links.map(title => {
        const seen = model.history.includes(title) ? ' seen' : ''
        return `<button class="link${seen}" data-link="${escapeHtml(title)}">${escapeHtml(title)}</button>`
      })
    ).join(''),
  )
  set(
    'history',
    model.history.map(title => `<button class="link" data-read="${escapeHtml(title)}">${escapeHtml(title)}</button>`).join(''),
  )
  const photoLink = document.getElementById('photoLink') as HTMLAnchorElement | null
  const photo = document.getElementById('photo') as HTMLImageElement | null
  if (photoLink && photo) {
    photoLink.hidden = !model.image
    if (model.image && photo.src !== model.image.url) {
      photo.src = model.image.url
      photoLink.href = model.image.page
    }
  }
  const historyCard = document.getElementById('historyCard')
  if (historyCard) historyCard.hidden = !model.history.length
  const pace =
    model.measuredWpm && model.measuredWpm < model.wpm * 0.85 ? ` (reaching ${Math.round(model.measuredWpm)})` : ''
  set('speed', `${model.wpm} wpm${pace}`)
  set('toggle', model.playing ? 'Pause' : 'Play')
  set(
    'source',
    model.url
      ? `Source: <a href="${escapeHtml(model.url)}" target="_blank" rel="noopener">${escapeHtml(model.title)}</a>, ${escapeHtml(model.license)}. Rewritten by Claude; wording differs from the article.`
      : '',
  )
  const error = document.getElementById('error')
  if (error) {
    error.hidden = !model.error
    error.textContent = model.error ?? ''
  }
  const back = document.getElementById('back') as HTMLButtonElement | null
  if (back) back.disabled = model.trail.length < 2
}

function blockHtml(block: Block): string {
  if (block.kind === 'heading') return `<strong>${escapeHtml(block.text)}</strong>`
  let html = ''
  let cursor = 0
  for (const link of [...block.links].sort((a, b) => a.start - b.start)) {
    if (link.start < cursor) continue
    html += escapeHtml(block.text.slice(cursor, link.start))
    html += `<a href="#" class="term" data-link="${escapeHtml(link.title)}">${escapeHtml(block.text.slice(link.start, link.end))}</a>`
    cursor = link.end
  }
  return html + escapeHtml(block.text.slice(cursor))
}
