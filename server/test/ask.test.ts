import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '../src/types.ts'

// MOCK is read when the server module loads, so set it before importing.
process.env.MOCK = '1'
const { app } = await import('../src/index.ts')

const ask = (body: unknown) =>
  app.request('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('POST /api/ask', () => {
  it('streams the question back as meta, then answer paragraphs, then done', async () => {
    const res = await ask({ title: 'Entropy', question: '  Why does it   increase? ', passage: 'x' })
    expect(res.status).toBe(200)
    const events = (await res.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as StreamEvent)
    expect(events[0]).toMatchObject({ type: 'meta', title: 'Why does it increase?' })
    expect(events.at(-1)).toEqual({ type: 'done' })
    const paras = events.flatMap(event => (event.type === 'block' ? [event.block] : []))
    expect(paras.length).toBeGreaterThan(0)
    expect(paras.every(block => block.kind === 'para' && !/\[\[|\]\]/.test(block.text))).toBe(true)
    expect(paras[0]!.links.map(link => link.title)).toEqual(['Wave function'])
  })

  it('rejects a missing title, a missing or oversized question, and a body that is not JSON', async () => {
    for (const body of [{ question: 'Why?' }, { title: 'Entropy' }, { title: 'Entropy', question: 'x'.repeat(501) }, 'not json']) {
      expect((await ask(body)).status).toBe(400)
    }
  })
})
