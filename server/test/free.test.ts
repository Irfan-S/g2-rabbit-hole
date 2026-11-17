import { describe, expect, it } from 'vitest'

// Read when the server module loads, so set them before importing.
process.env.MOCK = '1'
process.env.APP_TOKEN = 'the-owners-code'
process.env.FREE_DAILY_BUDGET_USD = '0.03' // five topics at the $0.006 charged for each
process.env.FREE_PER_ADDRESS = '3'
const { app } = await import('../src/index.ts')

const topic = (headers: Record<string, string> = {}) => app.request('/api/topic?title=Entropy', { headers })
const from = (address: string) => ({ 'X-Forwarded-For': address })
const error = async (res: Response) => ((await res.json()) as { error: string }).error

describe('the free allowance', () => {
  it('lets an address with no keys in, up to its daily share', async () => {
    for (let i = 0; i < 3; i++) expect((await topic(from('203.0.113.1'))).status).toBe(200)
    const res = await topic(from('203.0.113.1'))
    expect(res.status).toBe(429)
    expect(await error(res)).toMatch(/Today's free reading is used up/)
  })

  it('stops everyone once the total for the day is spent, except people with a code or keys', async () => {
    // three are already spent above; two more reach the total
    expect((await topic(from('203.0.113.2'))).status).toBe(200)
    expect((await topic(from('203.0.113.2'))).status).toBe(200)
    const res = await topic(from('203.0.113.3'))
    expect(res.status).toBe(429)
    expect(await error(res)).toMatch(/for everyone today/)
    expect((await topic({ 'X-App-Token': 'the-owners-code' })).status).toBe(200)
    expect((await topic({ 'X-Anthropic-Key': 'sk-their-own' })).status).toBe(200)
  })

  it('still refuses a wrong access code instead of falling back to the allowance', async () => {
    expect((await topic({ 'X-App-Token': 'wrong', ...from('203.0.113.4') })).status).toBe(401)
  })
})
