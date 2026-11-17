import { API_BASE, API_TOKEN } from './config'
import type { StreamEvent } from './types'

/**
 * How this reader gets to use the backend: the owner's access code, or their own API keys.
 * Entered on the phone-side page and kept on the phone. A build may carry a default code
 * (VITE_API_TOKEN) for development; a published build carries none.
 */
export interface Credentials {
  code: string
  anthropic: string
  elevenlabs: string
}

let credentials: Credentials = { code: API_TOKEN, anthropic: '', elevenlabs: '' }

export function setCredentials(next: Credentials) {
  credentials = next
}

/** 'code', 'keys', or 'none' when nothing has been entered yet. */
export function accessKind(): 'code' | 'keys' | 'none' {
  return credentials.code ? 'code' : credentials.anthropic ? 'keys' : 'none'
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  // With an access code the reader's own keys are not needed, so they are not sent.
  if (credentials.code) return { 'X-App-Token': credentials.code, ...extra }
  const own: Record<string, string> = {}
  if (credentials.anthropic) own['X-Anthropic-Key'] = credentials.anthropic
  if (credentials.elevenlabs) own['X-ElevenLabs-Key'] = credentials.elevenlabs
  return { ...own, ...extra }
}

/** Splits an NDJSON byte stream into events, tolerating chunks that end mid-line. */
export class NdjsonDecoder {
  private buffer = ''
  private readonly decoder = new TextDecoder()

  constructor(private readonly onEvent: (event: StreamEvent) => void) {}

  push(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    this.drain()
  }

  end() {
    this.buffer += this.decoder.decode()
    this.drain()
    if (this.buffer.trim()) this.parse(this.buffer)
    this.buffer = ''
  }

  private drain() {
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      this.parse(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
    }
  }

  private parse(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      this.onEvent(JSON.parse(trimmed) as StreamEvent)
    } catch {
      console.warn('Skipping unreadable line from backend:', trimmed.slice(0, 80))
    }
  }
}

/** A question about the article `title`, asked while the reader was on `passage`. */
export interface Ask {
  title: string
  question: string
  passage: string
}

export interface TopicParams {
  q?: string
  title?: string
  ask?: Ask
}

/**
 * Opens a topic and reports blocks as they arrive. Pass `q` for free text
 * (a spoken topic), `title` for an exact Wikipedia title (a link dive), or
 * `ask` for a question about an article, which is answered in the same form.
 */
export async function streamTopic(
  params: TopicParams,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const query = params.title ? `title=${encodeURIComponent(params.title)}` : `q=${encodeURIComponent(params.q ?? '')}`
  const res = params.ask
    ? await fetch(`${API_BASE}/api/ask`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(params.ask),
        signal,
      })
    : await fetch(`${API_BASE}/api/topic?${query}`, { headers: headers(), signal })
  if (!res.ok) {
    let message = `Backend returned ${res.status}`
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      /* keep the status message */
    }
    throw new Error(message)
  }

  const decoder = new NdjsonDecoder(onEvent)
  const body = res.body
  if (!body) {
    // Some WebViews do not expose a readable stream: fall back to the whole body.
    decoder.push(new TextEncoder().encode(await res.text()))
    decoder.end()
    return
  }
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) decoder.push(value)
  }
  decoder.end()
}

/** Sends recorded PCM (16 kHz, 16-bit, mono) and gets the spoken topic back as text. */
export async function transcribe(pcm: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<{ topic: string; transcript: string }> {
  const res = await fetch(`${API_BASE}/api/stt`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/octet-stream' }),
    body: pcm,
    signal,
  })
  const data = (await res.json().catch(() => ({}))) as { topic?: string; transcript?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `Backend returned ${res.status}`)
  return { topic: data.topic ?? '', transcript: data.transcript ?? '' }
}
