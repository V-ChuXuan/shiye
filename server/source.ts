import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import type { Collector, DiscoveredArticle, ParsedArticle, Session } from '../shared/types.js';
import { decodeEntities, parsePage, dateText } from './parser.js';

const PUBLIC_KEYS = ['__biz', 'mid', 'idx', 'sn', 'chksm'];
const SECRET_KEYS = /^(?:uin|key|pass_ticket|cookie|token|access_token|auth|authorization|wxtoken|appmsg_token)$/i;
const RISK = /环境异常|访问过于频繁|操作过于频繁|完成验证后|安全验证|当前访问存在风险|captcha|verify_page|wappoc_appmsgcaptcha/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SESSION_TTL = 15 * 60_000;

const MESSAGES: Record<string, string> = {
  verification: '微信返回验证页，请在微信完成验证后重新连接。',
  rate_limited: '微信限制了访问频率，采集通道已暂停，请稍后重新连接。',
  session_expired: '微信会话已过期或访问被拒绝，请打开该公众号文章后重新连接。',
  need_session: '请在电脑微信打开该公众号的一篇文章，然后点击连接微信。',
  deleted: '该文章已删除或不再可访问。', network: '网络请求暂时失败，请稍后重试。',
  invalid_content: '未取得完整可识别的文章或图片内容。', invalid_url: '请提供有效的微信公众号文章链接。',
  cancelled: '任务已暂停。',
};

export class SourceError extends Error {
  readonly code: string;
  readonly blocked: boolean;
  constructor(code: string, message = MESSAGES[code] || MESSAGES.invalid_content, blocked = ['verification', 'rate_limited', 'session_expired'].includes(code)) {
    super(message);
    this.name = 'SourceError'; this.code = code; this.blocked = blocked;
  }
}

export function sanitizeArticleUrl(input: string): string {
  let url: URL;
  try { url = new URL(decodeEntities(String(input).trim())); } catch { throw new SourceError('invalid_url'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password ||
      !(url.pathname === '/s' || /^\/s\/[A-Za-z0-9_-]{8,}\/?$/.test(url.pathname))) throw new SourceError('invalid_url');
  const clean = new URL(`https://mp.weixin.qq.com${url.pathname.replace(/\/$/, '')}`);
  for (const key of PUBLIC_KEYS) {
    if (url.searchParams.getAll(key).length > 1) throw new SourceError('invalid_url');
    const value = url.searchParams.get(key);
    if (value) clean.searchParams.set(key, value);
  }
  if (url.pathname === '/s') {
    const biz = clean.searchParams.get('__biz') || '';
    if (!/^[A-Za-z0-9+/=_-]{4,128}$/.test(biz) || !/^\d+$/.test(clean.searchParams.get('mid') || '') ||
        (clean.searchParams.has('idx') && !/^\d+$/.test(clean.searchParams.get('idx') || ''))) throw new SourceError('invalid_url');
    if (!clean.searchParams.has('idx')) clean.searchParams.set('idx', '1');
  }
  return clean.toString();
}

export function articleIdentity(input: string): { biz: string; mid: string; idx: string; key: string } {
  const url = new URL(sanitizeArticleUrl(input));
  const biz = url.searchParams.get('__biz') || '';
  const mid = url.searchParams.get('mid') || '';
  const idx = url.searchParams.get('idx') || (mid ? '1' : '');
  return { biz, mid, idx, key: mid ? `${biz}:${mid}:${idx}` : `url:${url.pathname}` };
}

function imageUrl(input: string, original = false): string {
  let url: URL;
  try { url = new URL(decodeEntities(input)); } catch { throw new SourceError('invalid_content'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mmbiz.qpic.cn' || url.port || url.username || url.password) throw new SourceError('invalid_content');
  for (const key of [...url.searchParams.keys()]) if (SECRET_KEYS.test(key) || /^wx_lazy$|^wxfrom$/i.test(key)) url.searchParams.delete(key);
  url.hash = '';
  if (original) url.pathname = url.pathname.replace(/\/\d+$/, '/0');
  return url.toString();
}

export function sanitizeCoverUrl(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096) return undefined;
  try { return imageUrl(input.trim().replace(/^http:/i, 'https:')); } catch { return undefined; }
}

function gifImage(buffer: Buffer): boolean {
  if (buffer.length < 14 || !buffer.readUInt16LE(6) || !buffer.readUInt16LE(8)) return false;
  let offset = 13 + (buffer[10] & 0x80 ? 3 * (2 << (buffer[10] & 7)) : 0), frames = 0;
  const blocks = () => {
    let bytes = 0;
    while (offset < buffer.length) {
      const length = buffer[offset++];
      if (!length) return bytes;
      if (offset + length > buffer.length) return -1;
      offset += length; bytes += length;
    }
    return -1;
  };
  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) return frames > 0 && offset === buffer.length;
    if (marker === 0x21) { if (offset >= buffer.length) return false; offset++; if (blocks() < 0) return false; }
    else if (marker === 0x2c) {
      if (offset + 9 > buffer.length || !buffer.readUInt16LE(offset + 4) || !buffer.readUInt16LE(offset + 6)) return false;
      const packed = buffer[offset + 8]; offset += 9 + (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0);
      if (offset >= buffer.length || buffer[offset] < 2 || buffer[offset++] > 8 || blocks() <= 0) return false;
      frames++;
    } else return false;
  }
  return false;
}

function webpImage(buffer: Buffer, start = 12, end = buffer.length, frame = false): boolean {
  let offset = start, images = 0;
  while (offset + 8 <= end) {
    const type = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), data = offset + 8;
    if (data + length + length % 2 > end) return false;
    if (type === 'VP8 ') {
      if (length <= 10 || buffer[data] & 1 || buffer.toString('hex', data + 3, data + 6) !== '9d012a' || !(buffer.readUInt16LE(data + 6) & 0x3fff) || !(buffer.readUInt16LE(data + 8) & 0x3fff)) return false;
      images++;
    } else if (type === 'VP8L') {
      if (length <= 5 || buffer[data] !== 0x2f || buffer[data + 4] & 0xe0) return false;
      images++;
    } else if (type === 'ANMF') {
      if (frame || length <= 16 || !webpImage(buffer, data + 16, data + length, true)) return false;
      images++;
    } else if (type === 'VP8X' && length !== 10 || type === 'ANIM' && length !== 6) return false;
    offset = data + length + length % 2;
  }
  return offset === end && images > 0;
}

function bmpImage(buffer: Buffer): boolean {
  if (buffer.length < 26 || buffer.readUInt32LE(2) !== buffer.length) return false;
  const dib = buffer.readUInt32LE(14), pixels = buffer.readUInt32LE(10);
  if (dib !== 12 && dib < 40 || 14 + dib > buffer.length || pixels < 14 + dib || pixels >= buffer.length) return false;
  const core = dib === 12, width = core ? buffer.readUInt16LE(18) : buffer.readInt32LE(18), height = core ? buffer.readUInt16LE(20) : buffer.readInt32LE(22);
  const planes = buffer.readUInt16LE(core ? 22 : 26), bits = buffer.readUInt16LE(core ? 24 : 28), compression = core ? 0 : buffer.readUInt32LE(30);
  if (width <= 0 || !height || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits)) return false;
  if (compression === 0 || compression === 3 || compression === 6) return Math.ceil(width * bits / 32) * 4 * Math.abs(height) <= buffer.length - pixels;
  const length = buffer.readUInt32LE(34);
  return (compression === 1 && bits === 8 || compression === 2 && bits === 4) && length > 2 && pixels + length <= buffer.length && buffer[pixels + length - 2] === 0 && buffer[pixels + length - 1] === 1;
}

export function validateImage(buffer: Buffer, suppliedMime?: string): { ext: string; mime: string } {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 32 * 1024 * 1024) throw new SourceError('invalid_content');
  let ext = '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    let offset = 2, frame = false, scan = false;
    while (offset + 4 < buffer.length) {
      if (buffer[offset++] !== 0xff) break;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (!marker || marker === 0xd9 || offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length - 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        frame = length >= 8 && buffer.readUInt16BE(offset + 3) > 0 && buffer.readUInt16BE(offset + 5) > 0;
      }
      if (marker === 0xda) { scan = length >= 6 && offset + length < buffer.length - 2; break; }
      offset += length;
    }
    if (frame && scan) ext = 'jpg';
  }
  else if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    let offset = 8, ended = false, payload = false, chunks = 0;
    while (offset + 12 <= buffer.length && ++chunks <= 100_000) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > buffer.length) break;
      if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) break;
      if (offset === 8 && (type !== 'IHDR' || length !== 13 || !buffer.readUInt32BE(offset + 8) || !buffer.readUInt32BE(offset + 12))) break;
      if (type === 'IDAT' && length > 0) payload = true;
      offset += 12 + length;
      if (type === 'IEND') { ended = length === 0 && offset === buffer.length; break; }
    }
    if (ended && payload) ext = 'png';
  } else if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) && gifImage(buffer)) ext = 'gif';
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length && webpImage(buffer)) ext = 'webp';
  else if (buffer.toString('ascii', 0, 2) === 'BM' && bmpImage(buffer)) ext = 'bmp';
  else if (buffer.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(buffer.toString('ascii', 8, Math.min(40, buffer.length))) && buffer.includes(Buffer.from('mdat'))) {
    let offset = 0, payload = false;
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length < 8 || offset + length > buffer.length) break;
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'mdat' && length > 8) payload = true;
      offset += length;
    }
    if (offset === buffer.length && payload) ext = 'avif';
  }
  if (!ext) throw new SourceError('invalid_content');
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const actual = suppliedMime?.split(';')[0].trim().toLowerCase();
  if (actual && actual !== mime && !(ext === 'jpg' && actual === 'image/jpg')) throw new SourceError('invalid_content');
  return { ext, mime };
}

function windowsSession(biz: string): Promise<Session> {
  if (process.platform !== 'win32') return Promise.reject(new SourceError('need_session', '微信会话连接目前支持 Windows，请导入文章清单或归档资料。'));
  return new Promise((resolveSession, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/capture-session.ps1'), '-Biz', biz],
      { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new SourceError('need_session')); return; }
        try { resolveSession(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as Session); }
        catch { reject(new SourceError('need_session')); }
      });
  });
}

type Options = { fetch?: typeof globalThis.fetch; delayMs?: number; capture?: (biz: string) => Promise<Session> };
type RequestKind = 'article' | 'image' | 'cover' | 'history';

export class WechatSource implements Collector {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly capture: (biz: string) => Promise<Session>;
  private readonly delayMs: number;
  private readonly sessions = new Map<string, { session: Session; expires: number }>();
  private gate: string | null = null;
  private nextRequestAt = 0;

  constructor(options: Options = {}) {
    this.fetcher = options.fetch || globalThis.fetch;
    this.capture = options.capture || windowsSession;
    this.delayMs = Math.max(0, options.delayMs ?? 650);
  }

  getGate(): string | null { return this.gate; }
  clearGate(): void { this.gate = null; }
  hasSession(biz: string): boolean {
    const saved = this.sessions.get(biz);
    if (!saved || saved.expires <= Date.now()) { this.sessions.delete(biz); return false; }
    return true;
  }

  async captureSession(biz: string): Promise<void> {
    if (!/^[A-Za-z0-9+/=_-]{4,128}$/.test(biz)) throw new SourceError('invalid_url');
    let result: Session;
    try { result = await this.capture(biz); } catch { throw new SourceError('need_session'); }
    if (!result || result.biz !== biz || typeof result.uin !== 'string' || !result.uin || typeof result.key !== 'string' || !result.key ||
        (result.passTicket !== undefined && typeof result.passTicket !== 'string') || /[\r\n]/.test(result.uin + result.key + result.passTicket)) throw new SourceError('need_session');
    this.sessions.set(biz, { session: { biz, uin: result.uin, key: result.key, passTicket: result.passTicket || '' }, expires: Date.now() + SESSION_TTL });
    this.clearGate();
  }

  private blocked(code: string): SourceError {
    this.gate = code;
    if (code === 'session_expired') this.sessions.clear();
    return new SourceError(code, undefined, true);
  }

  private target(value: string, kind: RequestKind): string {
    if (kind === 'article') return sanitizeArticleUrl(value);
    if (kind === 'image' || kind === 'cover') return imageUrl(value);
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/mp/profile_ext' || url.port || url.username || url.password) throw new SourceError('invalid_content');
    return url.toString();
  }

  private async request(input: string, kind: RequestKind, signal?: AbortSignal, referer = 'https://mp.weixin.qq.com/'): Promise<{ buffer: Buffer; headers: Headers; url: string }> {
    if (this.gate) throw new SourceError(this.gate, undefined, true);
    const cap = (kind === 'cover' ? 2 : kind === 'image' ? 32 : 8) * 1024 * 1024;
    let current = this.target(input, kind);
    let redirects = 0, failures = 0;
    while (true) {
      if (this.gate) throw new SourceError(this.gate, undefined, true);
      if (signal?.aborted) throw new SourceError('cancelled');
      const pause = Math.max(0, this.nextRequestAt - Date.now());
      this.nextRequestAt = Math.max(Date.now(), this.nextRequestAt) + this.delayMs;
      try { if (pause) await wait(pause, undefined, { signal }); } catch { throw new SourceError('cancelled'); }
      if (this.gate) throw new SourceError(this.gate, undefined, true);
      if (signal?.aborted) throw new SourceError('cancelled');
      let response: Response;
      try {
        response = await this.fetcher(current, {
          redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
          headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: referer, Accept: kind === 'image' || kind === 'cover' ? 'image/*' : '*/*' },
        });
      } catch {
        if (signal?.aborted) throw new SourceError('cancelled');
        if (++failures <= 1) continue;
        throw new SourceError('network');
      }
      if (response.status === 429) { await response.body?.cancel(); throw this.blocked('rate_limited'); }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw this.blocked('session_expired'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || ++redirects > 3) throw new SourceError('invalid_content');
        let redirect: URL;
        try { redirect = new URL(location, current); } catch { throw new SourceError('invalid_content'); }
        if ((redirect.hostname === 'mp.weixin.qq.com' && /captcha|verify/i.test(redirect.pathname)) || redirect.hostname === 'weixin110.qq.com') throw this.blocked('verification');
        try { current = this.target(redirect.toString(), kind); } catch { throw new SourceError('invalid_content'); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500 && ++failures <= 1) continue;
        throw new SourceError(response.status === 404 || response.status === 410 ? 'deleted' : 'network');
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > cap) { await response.body?.cancel(); throw new SourceError('invalid_content'); }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new SourceError('invalid_content');
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > cap) { await reader.cancel(); throw new SourceError('invalid_content'); }
          chunks.push(Buffer.from(part.value));
        }
      } catch (error) {
        if (error instanceof SourceError) throw error;
        if (signal?.aborted) throw new SourceError('cancelled');
        throw new SourceError('network');
      } finally { reader.releaseLock(); }
      return { buffer: Buffer.concat(chunks), headers: response.headers, url: current };
    }
  }

  async fetchArticle(input: string, signal?: AbortSignal): Promise<ParsedArticle> {
    const requested = sanitizeArticleUrl(input);
    const response = await this.request(requested, 'article', signal);
    const html = response.buffer.toString('utf8');
    const page = parsePage(html);
    if ((!page.hasContainer || !page.blocks.length) && RISK.test(page.visibleText + html)) throw this.blocked('verification');
    if (!page.hasContainer || !page.blocks.length || !page.title || page.unsupportedImages || (!page.biz && !page.canonicalUrl)) {
      throw new SourceError(/已被发布者删除|内容已被删除|此内容因违规无法查看|内容已过期/.test(page.visibleText) ? 'deleted' : 'invalid_content');
    }
    const requestedIdentity = articleIdentity(requested);
    let canonical = response.url;
    if (page.canonicalUrl) {
      try { canonical = sanitizeArticleUrl(page.canonicalUrl.replace(/^http:/, 'https:')); } catch { throw new SourceError('invalid_content'); }
    }
    const canonicalIdentity = articleIdentity(canonical);
    const biz = page.biz || canonicalIdentity.biz || requestedIdentity.biz;
    const mid = page.mid || canonicalIdentity.mid || requestedIdentity.mid;
    const idx = page.idx || canonicalIdentity.idx || requestedIdentity.idx || '1';
    if (!biz || !/^\d+$/.test(mid) || !/^\d+$/.test(idx) || (requestedIdentity.biz && requestedIdentity.biz !== biz) ||
        (requestedIdentity.mid && requestedIdentity.mid !== mid) || (requestedIdentity.idx && requestedIdentity.idx !== idx) ||
        (canonicalIdentity.biz && canonicalIdentity.biz !== biz) || (canonicalIdentity.mid && canonicalIdentity.mid !== mid) ||
        (canonicalIdentity.mid && canonicalIdentity.idx !== idx)) throw new SourceError('invalid_content');
    const canonicalUrl = new URL(canonical);
    const publicUrl = new URL('https://mp.weixin.qq.com/s');
    publicUrl.searchParams.set('__biz', biz); publicUrl.searchParams.set('mid', mid); publicUrl.searchParams.set('idx', idx);
    const original = new URL(requested);
    for (const key of ['sn', 'chksm']) {
      const value = canonicalUrl.searchParams.get(key) || original.searchParams.get(key) || page[key as 'sn' | 'chksm'];
      if (value) publicUrl.searchParams.set(key, value);
    }
    const images = page.images.map((image: { seq: number; src: string }) => ({ ...image, src: imageUrl(image.src) }));
    return { biz, mid, idx, title: page.title, account: page.account || '未知公众号', avatarUrl: sanitizeCoverUrl(page.avatarUrl), publishedAt: page.publishedAt,
      url: sanitizeArticleUrl(publicUrl.toString()), blocks: page.blocks as ParsedArticle['blocks'], images, textLength: page.textLength };
  }

  async fetchImage(input: string, referer: string, signal?: AbortSignal): Promise<{ buffer: Buffer; ext: string; mime: string; sha256: string }> {
    return this.fetchImageResource(input, referer, false, signal);
  }

  async fetchCover(input: string, referer: string, signal?: AbortSignal): Promise<{ buffer: Buffer; ext: string; mime: string; sha256: string }> {
    return this.fetchImageResource(input, referer, true, signal);
  }

  private async fetchImageResource(input: string, referer: string, cover: boolean, signal?: AbortSignal): Promise<{ buffer: Buffer; ext: string; mime: string; sha256: string }> {
    const cleanReferer = sanitizeArticleUrl(referer);
    const response = await this.request(imageUrl(input, !cover), cover ? 'cover' : 'image', signal, cleanReferer);
    const mime = response.headers.get('content-type') || '';
    if (!/^image\//i.test(mime) && RISK.test(response.buffer.toString('utf8'))) throw this.blocked('verification');
    if (!mime) throw new SourceError('invalid_content');
    const format = validateImage(response.buffer, mime);
    return { ...format, buffer: response.buffer, sha256: createHash('sha256').update(response.buffer).digest('hex') };
  }

  async discoverPage(biz: string, offset: number, signal?: AbortSignal): Promise<{ entries: DiscoveredArticle[]; nextOffset: number; canContinue: boolean }> {
    if (!this.hasSession(biz)) throw new SourceError('need_session');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SourceError('invalid_content');
    const session = this.sessions.get(biz)!.session;
    const url = new URL('https://mp.weixin.qq.com/mp/profile_ext');
    for (const [key, value] of Object.entries({ action: 'getmsg', __biz: biz, f: 'json', offset: String(offset), count: '10',
      is_ok: '1', scene: '124', uin: session.uin, key: session.key, pass_ticket: session.passTicket })) url.searchParams.set(key, value);
    const response = await this.request(url.toString(), 'history', signal);
    const text = response.buffer.toString('utf8');
    if (/^\s*</.test(text) && RISK.test(text)) throw this.blocked('verification');
    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { throw new SourceError('invalid_content'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SourceError('invalid_content');
    if (Number(data.ret ?? 0) !== 0) throw this.blocked(Number(data.ret) === 200013 ? 'rate_limited' : 'session_expired');
    let raw: { list?: unknown[] };
    try { raw = typeof data.general_msg_list === 'string' ? JSON.parse(data.general_msg_list) : data.general_msg_list as { list?: unknown[] }; }
    catch { throw new SourceError('invalid_content'); }
    if (!raw || !Array.isArray(raw.list)) throw new SourceError('invalid_content');
    const entries: DiscoveredArticle[] = [];
    const push = (value: unknown, publishedAt: string) => {
      if (!value || typeof value !== 'object') return;
      const item = value as Record<string, unknown>;
      if (typeof item.content_url !== 'string' || !item.content_url) return;
      let publicUrl = decodeEntities(item.content_url.replace(/\\\//g, '/'));
      if (publicUrl.startsWith('/')) publicUrl = `https://mp.weixin.qq.com${publicUrl}`;
      publicUrl = sanitizeArticleUrl(publicUrl.replace(/^http:/, 'https:'));
      const identity = articleIdentity(publicUrl);
      if (identity.biz && identity.biz !== biz) throw new SourceError('invalid_content');
      entries.push({ url: publicUrl, title: decodeEntities(String(item.title || '未命名文章')), publishedAt,
        coverUrl: sanitizeCoverUrl(typeof item.cover === 'string' ? item.cover.replace(/\\\//g, '/') : undefined), ...identity });
    };
    for (const value of raw.list) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      const common = row.comm_msg_info as { datetime?: unknown } | undefined;
      const publishedAt = dateText(Number(common?.datetime || 0) * 1000);
      const app = row.app_msg_ext_info as { multi_app_msg_item_list?: unknown[] } | undefined;
      if (app) { push(app, publishedAt); for (const child of app.multi_app_msg_item_list || []) push(child, publishedAt); }
      const multi = row.multi_msg_info as { multi_msg_item_list?: unknown[] } | undefined;
      for (const child of multi?.multi_msg_item_list || []) push(child, publishedAt);
    }
    const canContinue = Number(data.can_msg_continue) === 1 || data.can_msg_continue === true;
    const nextOffset = !canContinue && Number(data.next_offset ?? -1) < 0 ? offset : Number(data.next_offset ?? offset);
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) throw new SourceError('invalid_content');
    return { entries, nextOffset, canContinue };
  }
}
