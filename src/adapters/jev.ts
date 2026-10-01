import { JevError, type JevClient, type JevRequest, type JevResponse } from '../ports.js'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

export class HttpJevClient implements JevClient {
  constructor(
    private readonly apiKey: string,
    private readonly url: string = JEV_URL,
    private readonly timeoutMs = 30_000,
  ) {}

  async evaluate(request: JevRequest): Promise<JevResponse> {
    const response = await this.post(request)
    const text = await response.text().catch(() => '')
    throwIfFailed(response, text)
    return parseBody(text, response.status)
  }

  private async post(request: JevRequest): Promise<Response> {
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new JevError('transient', `network: ${String(error)}`)
    }
  }
}

function throwIfFailed(response: Response, text: string): void {
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new JevError('rate_limit', 'rate limited', { status: 429, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, body: text })
  }
  if (response.status >= 500) throw new JevError('transient', `server ${response.status}`, { status: response.status, body: text })
  if (!response.ok) throw new JevError('reject', `rejected ${response.status}`, { status: response.status, body: text })
}

function parseBody(text: string, status: number): JevResponse {
  try {
    const body = JSON.parse(text) as JevResponse
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
    return { answers: body.answers ?? {}, usage: body.usage }
  } catch {
    throw new JevError('garbage', 'unparseable body', { status, body: text.slice(0, 500) })
  }
}
