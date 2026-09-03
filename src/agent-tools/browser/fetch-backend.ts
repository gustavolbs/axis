import { randomUUID } from 'node:crypto';

import { OperationCancelledError } from '../../cancellation.js';
import type {
  BrowserBackend,
  BrowserBackendSession,
  BrowserLink,
  BrowserNavigateRequest,
  BrowserNavigationResult,
  BrowserOperationContext,
  BrowserReadRequest,
  BrowserReadResult,
  BrowserSessionScope
} from './contracts.js';

interface FetchPageState {
  readonly requestedUrl: string;
  readonly url: string;
  readonly status: number;
  readonly title?: string;
  readonly contentType?: string;
  readonly html: string;
  readonly text: string;
  readonly links: readonly BrowserLink[];
}

export interface FetchBrowserBackendOptions {
  readonly maxResponseBytes?: number;
  readonly maxLinks?: number;
  readonly userAgent?: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_LINKS = 200;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function validHtmlCodePoint(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'
  };
  return value
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return validHtmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#x([\da-f]+);/gi, (match, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return validHtmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|nav)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? htmlToText(match[1] ?? '') : '';
  return title || undefined;
}

function safeHttpUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error(`Invalid browser URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Browser navigation only supports http/https URLs, not ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Browser navigation URLs must not contain embedded credentials.');
  }
  return url;
}

function extractLinks(html: string, baseUrl: string, maxLinks: number): BrowserLink[] {
  const links: BrowserLink[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (let match = anchor.exec(html); match && links.length < maxLinks; match = anchor.exec(html)) {
    const rawHref = match[1] ?? match[2] ?? match[3] ?? '';
    if (!rawHref) continue;
    let href: URL;
    try {
      href = safeHttpUrl(rawHref, baseUrl);
    } catch {
      continue;
    }
    const normalized = href.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push({
      text: htmlToText(match[4] ?? '').slice(0, 500),
      href: normalized
    });
  }
  return links;
}

async function readBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new OperationCancelledError('Browser navigation was cancelled.');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new Error(`Browser response exceeded the ${maxResponseBytes}-byte safety limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted && !(error instanceof OperationCancelledError)) {
      throw new OperationCancelledError('Browser navigation was cancelled.');
    }
    throw error;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function textLike(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    /application\/(json|xml|xhtml\+xml|javascript)/.test(normalized)
  );
}

function truncate(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function extractMatches(text: string, query: string, maxMatches: number): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) throw new Error('Browser extract format requires a non-empty query.');
  const lower = text.toLocaleLowerCase();
  const matches: string[] = [];
  let offset = 0;
  while (matches.length < maxMatches) {
    const index = lower.indexOf(needle, offset);
    if (index < 0) break;
    const start = Math.max(0, index - 160);
    const end = Math.min(text.length, index + needle.length + 240);
    matches.push(text.slice(start, end).replace(/\s+/g, ' ').trim());
    offset = Math.max(index + needle.length, index + 1);
  }
  return matches;
}

class FetchBrowserSession implements BrowserBackendSession {
  readonly id = randomUUID();
  private page?: FetchPageState;
  private closed = false;

  constructor(
    readonly scope: BrowserSessionScope,
    private readonly maxResponseBytes: number,
    private readonly maxLinks: number,
    private readonly userAgent: string
  ) {}

  private assertOpen(): void {
    if (this.closed) throw new Error(`Browser session ${this.id} is closed.`);
  }

  async navigate(
    request: BrowserNavigateRequest,
    context: BrowserOperationContext
  ): Promise<BrowserNavigationResult> {
    this.assertOpen();
    const requested = safeHttpUrl(request.url, this.page?.url);
    context.reportProgress({
      message: `Navigating browser to ${requested.host}.`,
      metadata: { host: requested.host }
    });
    if (context.signal.aborted) throw new OperationCancelledError('Browser navigation was cancelled.');

    let response: Response;
    try {
      response = await fetch(requested, {
        method: 'GET',
        redirect: 'follow',
        signal: context.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'user-agent': this.userAgent
        }
      });
    } catch (error) {
      if (context.signal.aborted) {
        throw new OperationCancelledError('Browser navigation was cancelled.');
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Browser navigation to ${requested.toString()} failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`
      );
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    if (!textLike(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Browser read backend does not support response content type ${contentType ?? '(unknown)'}.`
      );
    }
    const body = await readBody(response, this.maxResponseBytes, context.signal);
    const html = new TextDecoder().decode(body);
    const finalUrl = safeHttpUrl(response.url || requested.toString()).toString();
    const isHtml = contentType?.toLowerCase().includes('html') ?? false;
    const page: FetchPageState = {
      requestedUrl: requested.toString(),
      url: finalUrl,
      status: response.status,
      title: isHtml ? extractTitle(html) : undefined,
      contentType,
      html,
      text: isHtml ? htmlToText(html) : html.trim(),
      links: isHtml ? extractLinks(html, finalUrl, this.maxLinks) : []
    };
    this.page = page;
    context.reportProgress({
      message: `Browser loaded ${finalUrl}.`,
      completed: body.byteLength,
      total: body.byteLength,
      metadata: { status: response.status, contentType }
    });
    return {
      requestedUrl: page.requestedUrl,
      url: page.url,
      status: page.status,
      title: page.title,
      contentType: page.contentType
    };
  }

  async read(
    request: BrowserReadRequest,
    context: BrowserOperationContext
  ): Promise<BrowserReadResult> {
    this.assertOpen();
    if (context.signal.aborted) throw new OperationCancelledError('Browser read was cancelled.');
    const page = this.page;
    if (!page) {
      throw new Error('Browser session has no current page. Navigate explicitly before reading; Axis will not choose a URL implicitly.');
    }
    context.reportProgress({
      message: `Reading ${request.format} from ${page.url}.`,
      metadata: { format: request.format, url: page.url }
    });

    if (request.format === 'links') {
      return {
        url: page.url,
        title: page.title,
        status: page.status,
        contentType: page.contentType,
        format: request.format,
        links: page.links,
        truncated: false
      };
    }
    if (request.format === 'extract') {
      const matches = extractMatches(page.text, request.query ?? '', request.maxMatches);
      const limited = matches.map((match) => truncate(match, request.maxChars).value);
      return {
        url: page.url,
        title: page.title,
        status: page.status,
        contentType: page.contentType,
        format: request.format,
        matches: limited,
        truncated: matches.some((match) => match.length > request.maxChars)
      };
    }

    const source = request.format === 'html' ? page.html : page.text;
    const limited = truncate(source, request.maxChars);
    return {
      url: page.url,
      title: page.title,
      status: page.status,
      contentType: page.contentType,
      format: request.format,
      content: limited.value,
      truncated: limited.truncated
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.page = undefined;
  }
}

/**
 * Minimal provider-neutral read backend. It supports explicit HTTP(S)
 * navigation plus deterministic text/HTML/link extraction, but deliberately
 * exposes no interaction method. DOM mutation requires an explicitly injected
 * interactive browser backend (for example a future Electron/CDP driver).
 */
export class FetchBrowserBackend implements BrowserBackend {
  readonly id = 'fetch';
  private readonly maxResponseBytes: number;
  private readonly maxLinks: number;
  private readonly userAgent: string;

  constructor(options: FetchBrowserBackendOptions = {}) {
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    );
    this.maxLinks = positiveInteger(options.maxLinks, DEFAULT_MAX_LINKS, 'maxLinks');
    this.userAgent = options.userAgent?.trim() || 'Axis browser tool';
  }

  async openSession(
    scope: BrowserSessionScope,
    context: BrowserOperationContext
  ): Promise<BrowserBackendSession> {
    if (context.signal.aborted) throw new OperationCancelledError('Browser session creation was cancelled.');
    return new FetchBrowserSession(
      scope,
      this.maxResponseBytes,
      this.maxLinks,
      this.userAgent
    );
  }
}
