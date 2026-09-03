import { randomUUID } from 'node:crypto';

import { OperationCancelledError } from '../../cancellation.js';
import type {
  BrowserBackend,
  BrowserBackendOperationContext,
  BrowserBackendSession,
  BrowserFormControl,
  BrowserFormDescriptor,
  BrowserInspectRequest,
  BrowserInspectResult,
  BrowserLink,
  BrowserNavigateRequest,
  BrowserNavigationResult,
  BrowserReadRequest,
  BrowserReadResult,
  BrowserSessionScope,
  BrowserSessionState
} from './contracts.js';
import { assessBrowserContentSecurity } from './security.js';

interface FetchPageState {
  readonly requestedUrl: string;
  readonly url: string;
  readonly status: number;
  readonly title?: string;
  readonly contentType?: string;
  readonly html: string;
  readonly text: string;
  readonly links: readonly BrowserLink[];
  readonly security: ReturnType<typeof assessBrowserContentSecurity>;
}

export interface FetchBrowserBackendOptions {
  readonly maxResponseBytes?: number;
  readonly maxLinks?: number;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_LINKS = 200;
const DEFAULT_MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

function parseAttributes(source: string): Map<string, string | null> {
  const attributes = new Map<string, string | null>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!name) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? null);
  }
  return attributes;
}

function extractControls(html: string, remaining: number): BrowserFormControl[] {
  const controls: BrowserFormControl[] = [];
  const pattern = /<(input|textarea|select|button)\b([^>]*)>/gi;
  for (let match = pattern.exec(html); match && controls.length < remaining; match = pattern.exec(html)) {
    const tag = (match[1] ?? '').toLowerCase() as BrowserFormControl['tag'];
    const attributes = parseAttributes(match[2] ?? '');
    const type = attributes.get('type') ?? undefined;
    const hasValue = attributes.has('value') && type?.toLowerCase() !== 'password';
    controls.push({
      tag,
      ...(attributes.get('name') ? { name: attributes.get('name') ?? undefined } : {}),
      ...(type ? { type } : {}),
      required: attributes.has('required'),
      disabled: attributes.has('disabled'),
      hasValue
    });
  }
  return controls;
}

function extractForms(
  html: string,
  baseUrl: string,
  maxEntries: number
): { forms: BrowserFormDescriptor[]; truncated: boolean } {
  const forms: BrowserFormDescriptor[] = [];
  let controlCount = 0;
  let truncated = false;
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (forms.length + controlCount >= maxEntries) {
      truncated = true;
      break;
    }
    const attributes = parseAttributes(match[1] ?? '');
    const remaining = Math.max(0, maxEntries - forms.length - controlCount - 1);
    const controls = extractControls(match[2] ?? '', remaining);
    controlCount += controls.length;
    if (extractControls(match[2] ?? '', remaining + 1).length > controls.length) truncated = true;
    const rawAction = attributes.get('action') ?? undefined;
    let action: string | undefined;
    if (rawAction) {
      try {
        action = safeHttpUrl(rawAction, baseUrl).toString();
      } catch {
        action = undefined;
      }
    }
    forms.push({
      ...(action ? { action } : {}),
      method: (attributes.get('method') ?? 'GET').toUpperCase(),
      controls
    });
  }
  return { forms, truncated };
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
  private readonly history: string[] = [];

  constructor(
    readonly scope: BrowserSessionScope,
    private readonly maxResponseBytes: number,
    private readonly maxLinks: number,
    private readonly maxRedirects: number,
    private readonly userAgent: string
  ) {}

  private assertOpen(): void {
    if (this.closed) throw new Error(`Browser session ${this.id} is closed.`);
  }

  private async fetchWithRedirectPolicy(
    requestUrl: string,
    context: BrowserBackendOperationContext
  ): Promise<{ response: Response; requestedUrl: string; finalUrl: string }> {
    const initial = await context.authorizeNavigation(requestUrl, 'explicit');
    let current = initial.normalizedUrl;
    const requestedUrl = current;

    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      if (context.signal.aborted) throw new OperationCancelledError('Browser navigation was cancelled.');
      let response: Response;
      try {
        response = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
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

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, requestedUrl, finalUrl: current };
      }

      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error(`Browser redirect from ${current} did not include a Location header.`);
      }
      if (redirectCount >= this.maxRedirects) {
        throw new Error(`Browser navigation exceeded the ${this.maxRedirects}-redirect safety limit.`);
      }
      const target = safeHttpUrl(location, current).toString();
      const authorization = await context.authorizeNavigation(target, 'redirect');
      current = authorization.normalizedUrl;
      context.reportProgress({
        message: `Browser redirect authorized to ${authorization.host}.`,
        metadata: {
          redirectCount: redirectCount + 1,
          host: authorization.host,
          classification: authorization.classification
        }
      });
    }
    throw new Error(`Browser navigation exceeded the ${this.maxRedirects}-redirect safety limit.`);
  }

  async navigate(
    request: BrowserNavigateRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserNavigationResult> {
    this.assertOpen();
    const requested = safeHttpUrl(request.url, this.page?.url);
    context.reportProgress({
      message: `Navigating browser to ${requested.host}.`,
      metadata: { host: requested.host }
    });
    if (context.signal.aborted) throw new OperationCancelledError('Browser navigation was cancelled.');

    const { response, requestedUrl, finalUrl } = await this.fetchWithRedirectPolicy(
      requested.toString(),
      context
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Browser navigation to ${finalUrl} failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`
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
    const isHtml = contentType?.toLowerCase().includes('html') ?? false;
    const text = isHtml ? htmlToText(html) : html.trim();
    const security = assessBrowserContentSecurity(text);
    const page: FetchPageState = {
      requestedUrl,
      url: finalUrl,
      status: response.status,
      title: isHtml ? extractTitle(html) : undefined,
      contentType,
      html,
      text,
      links: isHtml ? extractLinks(html, finalUrl, this.maxLinks) : [],
      security
    };
    this.page = page;
    this.history.push(finalUrl);
    context.reportProgress({
      message: `Browser loaded ${finalUrl}.`,
      completed: body.byteLength,
      total: body.byteLength,
      metadata: {
        status: response.status,
        contentType,
        suspectedPromptInjection: security.suspectedPromptInjection
      }
    });
    return {
      requestedUrl: page.requestedUrl,
      url: page.url,
      status: page.status,
      title: page.title,
      contentType: page.contentType,
      security: page.security
    };
  }

  async read(
    request: BrowserReadRequest,
    context: BrowserBackendOperationContext
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
        truncated: false,
        security: page.security
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
        truncated: matches.some((match) => match.length > request.maxChars),
        security: page.security
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
      truncated: limited.truncated,
      security: page.security
    };
  }

  async state(context: BrowserBackendOperationContext): Promise<BrowserSessionState> {
    this.assertOpen();
    if (context.signal.aborted) throw new OperationCancelledError('Browser state read was cancelled.');
    return {
      url: this.page?.url,
      title: this.page?.title,
      history: Object.freeze([...this.history]),
      storageMode: 'ephemeral-session',
      features: Object.freeze({
        interact: false,
        inspect: Object.freeze(['dom', 'forms'] as const),
        developerRead: Object.freeze([]),
        screenshot: false
      })
    };
  }

  async inspect(
    request: BrowserInspectRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserInspectResult> {
    this.assertOpen();
    if (context.signal.aborted) throw new OperationCancelledError('Browser inspection was cancelled.');
    const page = this.page;
    if (!page) {
      throw new Error('Browser session has no current page. Navigate explicitly before inspection.');
    }
    if (request.selector?.trim()) {
      throw new Error(
        'The fetch browser backend cannot evaluate DOM selectors. Use a backend with live DOM inspection; Axis will not emulate selectors with regex.'
      );
    }
    context.reportProgress({
      message: `Inspecting static ${request.kind} from ${page.url}.`,
      metadata: { kind: request.kind, source: 'response-html' }
    });
    if (request.kind === 'dom') {
      const limited = truncate(page.html, request.maxChars);
      return {
        kind: 'dom',
        url: page.url,
        source: 'response-html',
        content: limited.value,
        truncated: limited.truncated,
        security: page.security
      };
    }
    const extracted = extractForms(page.html, page.url, request.maxEntries);
    return {
      kind: 'forms',
      url: page.url,
      source: 'response-html',
      forms: extracted.forms,
      truncated: extracted.truncated,
      security: page.security
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.page = undefined;
    this.history.length = 0;
  }
}

/**
 * Minimal provider-neutral read backend. It supports explicit HTTP(S)
 * navigation, redirect policy enforcement, deterministic text/HTML/link
 * extraction and static DOM/form inspection, but deliberately exposes no
 * interaction, screenshot, console or network developer surface.
 */
export class FetchBrowserBackend implements BrowserBackend {
  readonly id = 'fetch';
  private readonly maxResponseBytes: number;
  private readonly maxLinks: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;

  constructor(options: FetchBrowserBackendOptions = {}) {
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    );
    this.maxLinks = positiveInteger(options.maxLinks, DEFAULT_MAX_LINKS, 'maxLinks');
    this.maxRedirects = positiveInteger(
      options.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
      'maxRedirects'
    );
    this.userAgent = options.userAgent?.trim() || 'Axis browser tool';
  }

  async openSession(
    scope: BrowserSessionScope,
    context: BrowserBackendOperationContext
  ): Promise<BrowserBackendSession> {
    if (context.signal.aborted) throw new OperationCancelledError('Browser session creation was cancelled.');
    return new FetchBrowserSession(
      scope,
      this.maxResponseBytes,
      this.maxLinks,
      this.maxRedirects,
      this.userAgent
    );
  }
}
