// Pure HTML helpers adapted from wechat-mp-archiver/src/article.js; no runtime link to the old project.
export function decodeEntities(input = '') {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function codePoint(value) {
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

export function stripTags(html = '') {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function literal(value) {
  return decodeEntities(value.replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|([\\/"'nrt]))/gi,
    (_, x, u, c) => x || u ? codePoint(parseInt(x || u, 16)) : ({ n: '\n', r: '\r', t: '\t' }[c] ?? c)));
}

export function readVariable(html, name) {
  const pattern = new RegExp(`(?:\\b(?:var|let|const)\\s+|\\bwindow\\.)${name}\\s*=\\s*(?:(?:""|'')\\s*\\|\\|\\s*)?(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|(\\d+))`, 'i');
  const match = pattern.exec(html);
  return match ? literal(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function domText(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i').exec(html);
  return match ? stripTags(match[2]) : '';
}

function metaValue(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs.property || attrs.name) === name) return attrs.content || '';
  }
  return '';
}

export function dateText(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(milliseconds));
}

function publicationText(value, timestamp) {
  const match = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/.exec(value);
  if (!match) return dateText(timestamp);
  const pad = value => value.padStart(2, '0');
  return `${match[1]}-${pad(match[2])}-${pad(match[3])}${match[4] ? ` ${pad(match[4])}:${match[5]}` : ''}`;
}

function contentHtml(html) {
  const open = /<div\b[^>]*(?:\bid\s*=\s*["']js_content["']|\bclass\s*=\s*["'][^"']*\brich_media_content\b[^"']*["'])[^>]*>/i.exec(html);
  if (!open) return null;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = open.index;
  let depth = 0;
  for (let tag; (tag = tags.exec(html));) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, tag.index);
  }
  return null;
}

function plainText(fragment) {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|section|div|blockquote|h[1-6]|li)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '• ').replace(/<[^>]*>/g, ''))
    .split('\n').map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function parsePage(html) {
  const clean = String(html).replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const body = contentHtml(clean);
  const blocks = [];
  const images = [];
  let unsupportedImages = 0;
  if (body !== null) {
    let last = 0;
    const pushText = fragment => { const text = plainText(fragment); if (text) blocks.push({ type: 'text', text }); };
    for (const match of body.matchAll(/<img\b[^>]*>/gi)) {
      pushText(body.slice(last, match.index));
      const attrs = attributes(match[0]);
      let src = (attrs['data-src'] || attrs['data-original'] || attrs['data-backsrc'] || attrs.src || '').trim();
      if (src.startsWith('//')) src = `https:${src}`;
      if (src.startsWith('http://')) src = `https://${src.slice(7)}`;
      if (/^https:\/\/mmbiz\.qpic\.cn\//i.test(src) && !/\/(?:icon|emotion)\//i.test(src)) {
        const seq = images.length + 1;
        images.push({ seq, src });
        blocks.push({ type: 'image', seq });
      } else if (/^https?:\/\//i.test(src) && !/^https:\/\/res\.wx\.qq\.com\//i.test(src)) unsupportedImages++;
      last = match.index + match[0].length;
    }
    pushText(body.slice(last));
  }
  const ct = readVariable(html, 'ct');
  const timestamp = /^\d{9,13}$/.test(ct) ? Number(ct) * (ct.length === 13 ? 1 : 1000) : 0;
  return {
    biz: readVariable(html, 'biz'), mid: readVariable(html, 'mid'), idx: readVariable(html, 'idx'),
    title: domText(clean, 'activity-name') || readVariable(html, 'msg_title') || metaValue(clean, 'og:title'),
    account: domText(clean, 'js_name') || readVariable(html, 'nickname') || readVariable(html, 'nick_name'),
    avatarUrl: readVariable(html, 'round_head_img'),
    publishedAt: publicationText(domText(clean, 'publish_time'), timestamp), canonicalUrl: metaValue(clean, 'og:url'),
    sn: readVariable(html, 'sn'), chksm: readVariable(html, 'chksm'), blocks, images,
    textLength: blocks.filter(block => block.type === 'text').reduce((n, block) => n + block.text.length, 0),
    hasContainer: body !== null, visibleText: stripTags(clean), unsupportedImages,
  };
}
