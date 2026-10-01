import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface Seen {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  body: string
}

export interface Fake {
  url: string
  seen: Seen[]
  close(): Promise<void>
}

export type Responder = (seen: Seen, index: number, res: ServerResponse) => void

/** A local HTTP server that records every request and answers with the given responder. */
export async function fakeServer(responder: Responder): Promise<Fake> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const entry: Seen = { method: req.method, url: req.url, headers: req.headers, body }
      seen.push(entry)
      responder(entry, seen.length - 1, res)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

export function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
