import { describe, expect, it } from 'vitest'

// Both are read when the server module loads, so set them before importing.
process.env.MOCK = '1'
process.env.APP_TOKEN = 'the-owners-code'
const { app } = await import('../src/index.ts')

const topic = (headers: Record<string, string> = {}) => app.request('/api/topic?title=Entropy', { headers })

describe('who may use /api', () => {
  it('lets the owner in with the access code', async () => {
    expect((await topic({ 'X-App-Token': 'the-owners-code' })).status).toBe(200)
  })

  it('lets anyone in who brings their own key', async () => {
    expect((await topic({ 'X-Anthropic-Key': 'sk-their-own' })).status).toBe(200)
  })

  it('refuses a request with neither, and says what to do', async () => {
    const res = await topic()
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toMatch(/app settings/)
  })

  it('refuses a wrong access code', async () => {
    const res = await topic({ 'X-App-Token': 'the-owners-cod' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toMatch(/not right/)
  })

  it('leaves the health check open', async () => {
    expect((await app.request('/health')).status).toBe(200)
  })

  it('caps own-key requests per address but never the owner', async () => {
    const from = { 'X-Anthropic-Key': 'sk-their-own', 'X-Forwarded-For': '203.0.113.9' }
    const statuses: number[] = []
    for (let i = 0; i < 62; i++) statuses.push((await topic(from)).status)
    expect(statuses.slice(0, 60).every(status => status === 200)).toBe(true)
    expect(statuses.slice(60)).toEqual([429, 429])
    // a different address, and the owner, are unaffected
    expect((await topic({ 'X-Anthropic-Key': 'sk-their-own', 'X-Forwarded-For': '203.0.113.10' })).status).toBe(200)
    expect((await topic({ 'X-App-Token': 'the-owners-code', 'X-Forwarded-For': '203.0.113.9' })).status).toBe(200)
  })
})
