import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { articleIdentity, sanitizeArticleUrl, validateImage, SourceError, WechatSource } from '../server/source.js';

const BIZ = 'MzkzNzg5Njc2MQ==';
const LONG = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=2247483691&idx=1&sn=public-signature&chksm=public-checksum`;
const SHORT = 'https://mp.weixin.qq.com/s/eWiGC2NzJV4l_mu_XXrWuA';
const IMAGE = 'https://mmbiz.qpic.cn/mmbiz_png/example/640?wx_fmt=png';
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 128, 64, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
const session = { biz: BIZ, uin: 'test-uin', key: 'PRIVATE-KEY-ONLY-IN-MEMORY', passTicket: 'PRIVATE-PASS-TICKET' };

function html(body = `<p>第一段 &amp; 文字</p><img src="data:image/gif;base64,placeholder" data-src="${IMAGE}"><p>第二段</p>`, vars = true): string {
  return `<html><head><meta property="og:url" content="${LONG.replace(/&/g, '&amp;')}"></head>
    ${vars ? `<script>var biz = "" || "${BIZ}"; var mid = "" || "2247483691"; var idx = "" || "1";var ct="1741759059";</script>` : ''}
    <h1 id="activity-name">一篇测试文章</h1><a id="js_name">测试公众号</a>
    <div id="js_content"><section>${body}</section></div>
    <img data-src="https://mmbiz.qpic.cn/recommend/640"><script>alert('DO-NOT-EXECUTE')</script></html>`;
}

function sourceReturning(body: string | Buffer, status = 200, contentType = 'text/html') {
  let calls = 0;
  const source = new WechatSource({ delayMs: 0, capture: async () => session,
    fetch: (async () => { calls++; return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': contentType } }); }) as typeof fetch });
  return { source, count: () => calls };
}

test('public URL cleaning keeps request signatures but never credentials', () => {
  const cleaned = sanitizeArticleUrl(`${LONG}&key=PRIVATE&uin=123&pass_ticket=PRIVATE#wechat_redirect`);
  const url = new URL(cleaned);
  assert.equal(url.searchParams.get('sn'), 'public-signature');
  assert.equal(url.searchParams.get('chksm'), 'public-checksum');
  assert.equal(url.searchParams.has('key'), false);
  assert.equal(url.searchParams.has('uin'), false);
  assert.equal(url.searchParams.has('pass_ticket'), false);
  assert.equal(url.hash, '');
  assert.equal(articleIdentity(cleaned).key, `${BIZ}:2247483691:1`);
  assert.notEqual(articleIdentity(SHORT).key, articleIdentity(SHORT.replace('eWiGC2NzJV4l_mu_XXrWuA', 'another_short_alias')).key);
  for (const bad of ['http://mp.weixin.qq.com/s/valid_short', 'https://mp.weixin.qq.com.evil.test/s/valid_short', 'https://user:pass@mp.weixin.qq.com/s/valid_short', `${LONG}&mid=22`]) {
    assert.throws(() => sanitizeArticleUrl(bad), SourceError);
  }
});

test('short URL resolves empty-or vars/canonical identity and body-only ordered blocks', async () => {
  const { source } = sourceReturning(html());
  const article = await source.fetchArticle(SHORT);
  assert.equal(article.biz, BIZ); assert.equal(article.mid, '2247483691'); assert.equal(article.idx, '1');
  assert.equal(article.title, '一篇测试文章'); assert.equal(article.account, '测试公众号');
  assert.equal(article.images.length, 1);
  assert.deepEqual(article.blocks.map(block => block.type), ['text', 'image', 'text']);
  assert.deepEqual(article.blocks[0], { type: 'text', text: '第一段 & 文字' });
  assert.equal(new URL(article.url).searchParams.get('chksm'), 'public-checksum');
  assert.equal(articleIdentity(article.url).key, articleIdentity(LONG).key);
  assert.ok(!JSON.stringify(article.blocks).includes('DO-NOT-EXECUTE'));
});

test('account avatar comes from page metadata and never from recommended or body images', async () => {
  const avatar = 'http://mmbiz.qpic.cn/account/avatar/0?wx_fmt=png&key=PRIVATE';
  const page = html().replace('</head>', `<script>var round_head_img="${avatar}";</script></head>`)
    .replace('</html>', '<img class="recommend-avatar" src="https://mmbiz.qpic.cn/other-account/0"></html>');
  const article = await sourceReturning(page).source.fetchArticle(SHORT);
  assert.equal(article.avatarUrl, 'https://mmbiz.qpic.cn/account/avatar/0?wx_fmt=png');
  assert.equal(article.images.length, 1); assert.equal(article.images[0].src, IMAGE);
  assert.equal((await sourceReturning(html()).source.fetchArticle(SHORT)).avatarUrl, undefined);
  assert.equal((await sourceReturning(page.replace(avatar, 'https://127.0.0.1/private')).source.fetchArticle(SHORT)).avatarUrl, undefined);
});

test('visible Chinese publication dates normalize for chronological filtering', async () => {
  const { source } = sourceReturning(html().replace('<div id="js_content">', '<em id="publish_time">2025年3月12日 9:05</em><div id="js_content">'));
  assert.equal((await source.fetchArticle(SHORT)).publishedAt, '2025-03-12 09:05');
});

test('canonical og:url can identify a pure-image article without nickname', async () => {
  const { source } = sourceReturning(html(`<img data-src="${IMAGE}">`, false).replace('<a id="js_name">测试公众号</a>', ''));
  const article = await source.fetchArticle(SHORT);
  assert.equal(article.account, '未知公众号'); assert.equal(article.images.length, 1);
  assert.equal(article.mid, '2247483691');
});

test('empty, foreign-account and unsupported-image pages cannot be completed', async () => {
  for (const page of [html(''), html().replaceAll(BIZ, 'OtherBiz123=').replaceAll(encodeURIComponent(BIZ), 'OtherBiz123%3D'),
    html('<p>正文</p><img src="https://evil.test/image.jpg">'), '<h1>有标题</h1><body>Skeleton</body>']) {
    const { source } = sourceReturning(page);
    await assert.rejects(source.fetchArticle(LONG), SourceError);
  }
});

test('verification page sets shared gate, does not retry or leak response detail', async () => {
  const { source, count } = sourceReturning('<html>安全验证 captcha PRIVATE-CREDENTIAL</html>');
  await assert.rejects(source.fetchArticle(SHORT), (error: unknown) => {
    assert.ok(error instanceof SourceError); assert.equal(error.code, 'verification'); assert.equal(error.blocked, true);
    assert.ok(!error.message.includes('PRIVATE')); return true;
  });
  assert.equal(source.getGate(), 'verification');
  await assert.rejects(source.fetchArticle(SHORT));
  assert.equal(count(), 1);
});

test('429 and 403 stop immediately; bounded transient errors remain retryable', async () => {
  for (const [status, code] of [[429, 'rate_limited'], [403, 'session_expired']] as const) {
    const { source, count } = sourceReturning('PRIVATE', status);
    await assert.rejects(source.fetchArticle(SHORT), (error: unknown) => error instanceof SourceError && error.code === code && error.blocked);
    assert.equal(count(), 1);
  }
  let calls = 0;
  const source = new WechatSource({ delayMs: 0, fetch: (async () => {
    calls++; return new Response(calls === 1 ? 'temporary' : html(), { status: calls === 1 ? 503 : 200 });
  }) as typeof fetch });
  assert.equal((await source.fetchArticle(SHORT)).mid, '2247483691'); assert.equal(calls, 2);
});

test('a shared block stops a concurrent cover request already waiting for its turn', async context => {
  context.mock.method(Date, 'now', () => 10_000);
  let release!: (response: Response) => void, calls = 0;
  const pending = new Promise<Response>(done => { release = done; });
  const source = new WechatSource({ delayMs: 25, fetch: (async () => {
    calls++;
    return calls === 1 ? pending : new Response(PNG, { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch });
  const blocked = (error: unknown) => error instanceof SourceError && error.code === 'rate_limited' && error.blocked;
  const article = assert.rejects(source.fetchArticle(SHORT), blocked);
  const cover = assert.rejects(source.fetchCover(IMAGE, LONG), blocked);
  assert.equal(calls, 1);
  release(new Response(null, { status: 429 }));
  await article;
  await cover;
  assert.equal(calls, 1, 'Waiting requests must not reach fetch after another request blocks the source.');
});

test('cancelling a throttled cover request prevents sending it', async context => {
  context.mock.method(Date, 'now', () => 10_000);
  let calls = 0;
  const source = new WechatSource({ delayMs: 25, fetch: (async () => {
    calls++; return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch });
  await source.fetchCover(IMAGE, LONG);
  const controller = new AbortController();
  const waiting = assert.rejects(source.fetchCover(IMAGE, LONG, controller.signal),
    (error: unknown) => error instanceof SourceError && error.code === 'cancelled');
  controller.abort();
  await waiting;
  assert.equal(calls, 1, 'A cancelled waiter must not rely on fetch honoring its aborted signal.');
});

test('redirects are manual, bounded and cannot leave allowed domains', async () => {
  let calls = 0;
  const source = new WechatSource({ delayMs: 0, fetch: (async (_url, options) => {
    calls++; assert.equal(options?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://evil.test/private' } });
  }) as typeof fetch });
  await assert.rejects(source.fetchArticle(SHORT), SourceError); assert.equal(calls, 1);
  const looping = new WechatSource({ delayMs: 0, fetch: (async () => {
    calls++; return new Response(null, { status: 302, headers: { location: SHORT } });
  }) as typeof fetch });
  await assert.rejects(looping.fetchArticle(SHORT), SourceError); assert.equal(calls, 5);
});

test('image MIME/signature/truncation validated and original-size URL retained', async () => {
  assert.deepEqual(validateImage(PNG, 'image/png'), { ext: 'png', mime: 'image/png' });
  assert.throws(() => validateImage(PNG.subarray(0, PNG.length - 1), 'image/png'), SourceError);
  assert.throws(() => validateImage(PNG, 'text/html'), SourceError);
  assert.throws(() => validateImage(Buffer.from('<html>not an image</html>'), 'image/png'), SourceError);
  assert.throws(() => validateImage(Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex'), 'image/jpeg'), SourceError);
  const corrupt = Buffer.from(PNG); corrupt[45] ^= 0xff;
  assert.throws(() => validateImage(corrupt, 'image/png'), SourceError);
  let requested = '';
  const source = new WechatSource({ delayMs: 0, fetch: (async (value, options) => {
    assert.equal((options?.headers as Record<string, string>).Referer, LONG);
    requested = String(value); return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch });
  const image = await source.fetchImage(`${IMAGE}&key=PRIVATE`, LONG);
  assert.equal(new URL(requested).pathname.endsWith('/0'), true);
  assert.equal(new URL(requested).searchParams.has('key'), false);
  assert.equal(image.sha256.length, 64); assert.equal(image.buffer.length, PNG.length);
});

test('image containers require image payload and retain genuine supported images', () => {
  // The JPEG and WebP were exported from a 1x1 canvas and decoded by Edge.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCSABJ3f//Z', 'base64');
  const webp = Buffer.from('UklGRjQAAABXRUJQVlA4ICgAAABwAQCdASoBAAEAAUAmJaACdAF1AAD+73Zwq//n5n/+GH//hh/RIAAA', 'base64');
  // These fixtures were generated by FFmpeg and decoded by Edge, including animated WebP.
  const lossless = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ9Y/+ByKi/wEA', 'base64');
  const animated = Buffer.from('UklGRp4AAABXRUJQVlA4WAoAAAASAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GNgAAAAAAAAAAAAEAAAEAAPQBAAJWUDhMHgAAAC8BQAAAFzD/AoIi/0eb//kPNAsK27ZBYXEQ0f/IA0FOTUY0AAAAAAAAAAAAAQAAAQAA9AEAAFZQOEwcAAAALwFAABAXIBBIYZM//wKCIv9Hm/+AvcEYRPQ/BA==', 'base64');
  const avif = Buffer.from('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAACAAAAAgAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoFGAA2wCAyEhgAAABQAABAA1Lt5xf080WmIA==', 'base64');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const bmp = Buffer.alloc(58); bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(4, 34); bmp[56] = 255;
  for (const [bytes, ext] of [[PNG, 'png'], [jpeg, 'jpg'], [webp, 'webp'], [lossless, 'webp'], [animated, 'webp'], [gif, 'gif'], [bmp, 'bmp'], [avif, 'avif']] as const) assert.equal(validateImage(bytes).ext, ext);
  const emptyWebp = Buffer.from('524946460400000057454250', 'hex');
  const emptyGif = Buffer.from('474946383961010001000000003b', 'hex');
  const emptyBmp = Buffer.alloc(26); emptyBmp.write('BM'); emptyBmp.writeUInt32LE(emptyBmp.length, 2);
  const emptyPng = Buffer.concat([PNG.subarray(0, 33), pngChunk('IEND', Buffer.alloc(0))]);
  const emptyAvif = Buffer.concat([Buffer.from('0000001466747970617669660000000061766966', 'hex'), Buffer.from('000000086d646174', 'hex')]);
  for (const bytes of [emptyWebp, emptyGif, emptyBmp, emptyPng, emptyAvif]) assert.throws(() => validateImage(bytes), SourceError);
  for (const bytes of [webp, gif, bmp]) assert.throws(() => validateImage(bytes.subarray(0, bytes.length - 1)), SourceError);
  const truncatedChunk = Buffer.from(webp); truncatedChunk.writeUInt32LE(0xffff, 16);
  assert.throws(() => validateImage(truncatedChunk), SourceError);
});

test('verification redirect blocks without requesting the validation page', async () => {
  let calls = 0;
  const source = new WechatSource({ delayMs: 0, fetch: (async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://mp.weixin.qq.com/mp/verify?key=PRIVATE' } });
  }) as typeof fetch });
  await assert.rejects(source.fetchArticle(SHORT), (error: unknown) => error instanceof SourceError && error.code === 'verification' && error.blocked);
  assert.equal(calls, 1); assert.equal(source.getGate(), 'verification');
});

test('session expires in memory and a mismatched capture never clears shared gate', async context => {
  let now = 10_000;
  context.mock.method(Date, 'now', () => now);
  const source = new WechatSource({ delayMs: 0, capture: async () => session });
  await source.captureSession(BIZ); assert.equal(source.hasSession(BIZ), true);
  now += 16 * 60_000; assert.equal(source.hasSession(BIZ), false);
  const blocked = new WechatSource({ delayMs: 0, capture: async () => ({ ...session, biz: 'OtherBiz' }),
    fetch: (async () => new Response('rate limit', { status: 429 })) as typeof fetch });
  await assert.rejects(blocked.fetchArticle(SHORT));
  await assert.rejects(blocked.captureSession(BIZ), SourceError);
  assert.equal(blocked.getGate(), 'rate_limited');
});

test('declared/body size limits reject oversized content without parsing', async () => {
  const source = new WechatSource({ delayMs: 0, fetch: (async () => new Response('tiny', {
    headers: { 'content-length': String(9 * 1024 * 1024) },
  })) as typeof fetch });
  await assert.rejects(source.fetchArticle(SHORT), SourceError);
});

test('history requires matching ephemeral session; flattens primary/sub items', async () => {
  let requested = '';
  const payload = { ret: 0, next_offset: 10, can_msg_continue: 1, general_msg_list: JSON.stringify({ list: [{
    comm_msg_info: { datetime: 1741759059 }, app_msg_ext_info: {
      title: '主文章', content_url: `${LONG}&key=DO-NOT-SAVE`, cover: `${IMAGE}&key=DO-NOT-SAVE`, multi_app_msg_item_list: [
        { title: '子文章', content_url: LONG.replace('idx=1', 'idx=2'), cover: IMAGE.replace('https:', 'http:') },
        { title: '坏封面仍保留文章', content_url: LONG.replace('idx=1', 'idx=3'), cover: 'https://127.0.0.1/private.png' },
      ],
    },
  }] }) };
  const source = new WechatSource({ delayMs: 0, capture: async () => session, fetch: (async url => {
    requested = String(url); return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  await assert.rejects(source.discoverPage(BIZ, 0), (error: unknown) => error instanceof SourceError && error.code === 'need_session');
  await source.captureSession(BIZ); assert.equal(source.hasSession(BIZ), true);
  assert.equal(source.hasSession('OtherBiz'), false);
  const result = await source.discoverPage(BIZ, 0);
  assert.equal(result.entries.length, 3); assert.equal(result.entries[1].idx, '2');
  assert.equal(result.entries[0].coverUrl, IMAGE); assert.equal(result.entries[1].coverUrl, IMAGE);
  assert.equal(result.entries[2].coverUrl, undefined);
  assert.equal(result.canContinue, true); assert.equal(result.nextOffset, 10);
  assert.ok(result.entries.every(entry => !entry.url.includes('DO-NOT-SAVE')));
  assert.ok(!JSON.stringify(result.entries).includes('DO-NOT-SAVE'));
  assert.equal(new URL(requested).searchParams.get('key'), session.key);
  assert.ok(!JSON.stringify(source).includes(session.key));
});

test('cover images retain thumbnail size and enforce a 2 MiB streaming limit', async () => {
  let requested = '';
  const source = new WechatSource({ delayMs: 0, fetch: (async input => {
    requested = String(input); return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch });
  const cover = await source.fetchCover(`${IMAGE}&uin=PRIVATE&pass_ticket=PRIVATE`, LONG);
  assert.equal(requested, IMAGE); assert.equal(cover.buffer.length, PNG.length);
  await source.fetchImage(IMAGE, LONG); assert.ok(new URL(requested).pathname.endsWith('/0'));
  for (const declared of [false, true]) {
    const bounded = new WechatSource({ delayMs: 0, fetch: (async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'image/png', ...(declared ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}) },
    })) as typeof fetch });
    await assert.rejects(bounded.fetchCover(IMAGE, LONG), SourceError);
  }
});

test('malformed history and expired session expose safe error codes', async () => {
  for (const [body, code] of [['null', 'invalid_content'], ['{"ret":-3,"errmsg":"PRIVATE"}', 'session_expired']] as const) {
    const { source } = sourceReturning(body);
    await source.captureSession(BIZ);
    await assert.rejects(source.discoverPage(BIZ, 0), (error: unknown) => {
      assert.ok(error instanceof SourceError); assert.equal(error.code, code); assert.ok(!error.message.includes('PRIVATE')); return true;
    });
  }
});

test('Windows helper syntax parses without executing UI Automation', { skip: process.platform !== 'win32' }, () => {
  const script = resolve('scripts/capture-session.ps1').replaceAll("'", "''");
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors);if($errors.Count){Write-Output 'invalid';exit 1};Write-Output 'valid'`], { encoding: 'utf8', windowsHide: true });
  assert.equal(output.trim(), 'valid');
});
