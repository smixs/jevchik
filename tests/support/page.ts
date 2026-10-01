import { Window } from 'happy-dom'

export interface Node_ {
  textContent: string | null
  getAttribute(name: string): string | null
  dispatchEvent(event: unknown): boolean
  querySelector(selector: string): Node_ | null
}

export interface Page {
  window: Window
  $: (selector: string) => Node_ | null
  $$: (selector: string) => Node_[]
  text: () => string
  waitFor: (selector: string) => Promise<Node_>
  click: (selector: string) => Promise<void>
  /** What the page asked Telegram to vibrate, in order. */
  haptics: string[]
  /** The links the page asked Telegram to open, in order. */
  opened: string[]
}

/** Rewrites a JSON answer of the API before the page sees it: for fields the server of this branch does not give yet. */
export type Patch = (path: string, body: Record<string, unknown>) => Record<string, unknown>

export interface Site {
  /** The address of the running web server. */
  base: string
  /** The built client script. */
  bundle: string
}

/** Motion is reduced by default, so no test depends on an animation; `motion: true` opens the page as a person without that setting. */
export async function openPage(site: Site, initData: string, options: { patch?: Patch; motion?: boolean } = {}): Promise<Page> {
  const { base, bundle } = site
  const { patch, motion = false } = options
  const window = new Window({ url: `${base}/`, settings: { device: { prefersReducedMotion: motion ? 'no-preference' : 'reduce' } } })
  const haptics: string[] = []
  const HapticFeedback = {
    impactOccurred: (style: string) => haptics.push(`impact:${style}`),
    notificationOccurred: (type: string) => haptics.push(`notification:${type}`),
    selectionChanged: () => haptics.push('selection'),
  }
  const opened: string[] = []
  const telegram = { WebApp: { initData, ready: () => {}, expand: () => {}, HapticFeedback, openTelegramLink: (url: string) => opened.push(url) } }
  ;(window as unknown as { Telegram: unknown }).Telegram = telegram
  if (patch) {
    const real = window.fetch.bind(window)
    ;(window as unknown as { fetch: unknown }).fetch = async (input: string, init?: object) => {
      const response = await real(input, init)
      if (!response.ok) return response
      const body = patch(new URL(input, base).pathname, (await response.json()) as unknown as Record<string, unknown>)
      return new window.Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } })
    }
  }
  window.document.body.innerHTML = '<nav id="nav"></nav><main id="app">Загрузка…</main>'
  window.eval(bundle)
  const $ = (selector: string) => window.document.querySelector(selector) as unknown as Node_ | null
  const $$ = (selector: string) => Array.from(window.document.querySelectorAll(selector)) as unknown as Node_[]
  const waitFor = async (selector: string): Promise<Node_> => {
    for (let i = 0; i < 150; i++) {
      const found = $(selector)
      if (found) return found
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`not found: ${selector}\n${window.document.body.textContent}`)
  }
  const click = async (selector: string): Promise<void> => {
    const element = await waitFor(selector)
    element.dispatchEvent(new window.Event('click', { bubbles: true }))
  }
  return { window, $, $$, text: () => window.document.getElementById('app')!.textContent ?? '', waitFor, click, haptics, opened }
}

