import type { VisionClient, VisionRequest } from '../ports.js'

export const VISION_PROMPT =
  'Опиши изображение для модерации чата: что изображено, какой текст на картинке, какой тон (шутка, ирония, всерьёз, реклама). Ответ: 1-3 предложения по-русски, без вступлений.'

export class HttpVisionClient implements VisionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async describe(request: VisionRequest): Promise<string> {
    const data = Buffer.from(request.image).toString('base64')
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: `data:${request.mime};base64,${data}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`vision ${response.status}`)
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('vision: empty answer')
    return content
  }
}
