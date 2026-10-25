import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContentBlock, ImportResult } from '../shared/types.js';
import type { ArchiveService } from './service.js';
import { AppError } from './service.js';
import { articleIdentity, sanitizeArticleUrl, validateImage } from './source.js';

type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const inside = (root: string, path: string) => { const child = relative(root, path); return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child); };
async function confined(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  if (!inside(root, actual)) throw new AppError('旧资料包含越界路径，已拒绝导入', 422, 'unsafe_path');
  return actual;
}
async function boundedText(path: string, max = 10 * 1024 * 1024) {
  if ((await stat(path)).size > max) throw new AppError('旧资料文件超过导入上限', 422, 'import_size');
  return readFile(path, 'utf8');
}
function publicImage(value: unknown): string {
  if (!text(value)) return '';
  const url = new URL(text(value));
  if (url.hostname !== 'mmbiz.qpic.cn' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new AppError('旧图片地址无效', 422, 'invalid_content');
  url.protocol = 'https:';
  for (const key of [...url.searchParams.keys()]) if (/cookie|token|ticket|auth|^uin$|^key$/i.test(key)) url.searchParams.delete(key);
  url.hash = ''; return url.toString();
}
function markdownBlocks(markdown: string, files: Map<string, number>): ContentBlock[] {
  const divider = markdown.indexOf('---');
  const body = divider >= 0 ? markdown.slice(divider + 3) : markdown;
  const blocks: ContentBlock[] = [];
  let previous = 0;
  for (const match of body.matchAll(/!\[[^\]]*\]\(images\/([^\s)]+)\)/g)) {
    const before = body.slice(previous, match.index).trim(); if (before) blocks.push({ type: 'text', text: before });
    const seq = files.get(match[1]); if (seq) blocks.push({ type: 'image', seq });
    previous = match.index! + match[0].length;
  }
  const last = body.slice(previous).trim(); if (last) blocks.push({ type: 'text', text: last });
  return blocks;
}

export async function importLegacy(service: ArchiveService, inputPath: string, limit = 1000): Promise<ImportResult> {
  await service.beginImport();
  try { return await copyLegacy(service, inputPath, limit); }
  finally { service.endImport(); }
}

async function copyLegacy(service: ArchiveService, inputPath: string, limit: number): Promise<ImportResult> {
  if (!inputPath || !isAbsolute(inputPath)) throw new AppError('请填写旧archive文件夹的绝对路径');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new AppError('导入数量应为1至10000的整数');
  let root: string, lines: string[];
  try {
    root = await realpath(resolve(inputPath));
    const index = await confined(root, join(root, 'index.jsonl'));
    lines = (await boundedText(index, 30 * 1024 * 1024)).split('\n').filter(line => line.trim());
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError('无法读取该文件夹中的index.jsonl', 422, 'invalid_import'); }
  const result: ImportResult = { accounts: 0, articles: 0, images: 0, skipped: 0, errors: [] };
  const accountIds = new Set<string>();
  for (const [index, line] of lines.slice(0, limit).entries()) {
    let title = `第${index + 1}条`;
    try {
      const entry = record(JSON.parse(line));
      const directory = text(entry.dir);
      if (!directory) throw new AppError('缺少文章目录');
      const dir = await confined(root, isAbsolute(directory) ? directory : resolve(root, directory));
      const metaPath = await confined(root, join(dir, 'meta.json'));
      const meta = record(JSON.parse(await boundedText(metaPath)));
      const url = sanitizeArticleUrl(text(meta.url) || text(entry.url));
      const identity = articleIdentity(url), biz = text(meta.biz) || identity.biz || text(entry.biz);
      if (!biz || !/^[A-Za-z0-9+/=_-]{6,128}$/.test(biz) || identity.biz && identity.biz !== biz) throw new AppError('公众号身份不一致');
      const mid = text(meta.mid) || identity.mid, idx = text(meta.idx) || identity.idx || (mid ? '1' : '');
      if (mid && !/^\d+$/.test(mid) || idx && !/^\d+$/.test(idx) || identity.mid && identity.mid !== mid || identity.idx && identity.idx !== idx) throw new AppError('文章身份不一致');
      title = (text(meta.title) || text(entry.title) || title).slice(0, 250);
      const account = service.store.upsertAccount(biz, (text(meta.account) || text(entry.account) || '未命名公众号').slice(0, 200));
      accountIds.add(account.id);
      const images = Array.isArray(meta.images) ? meta.images.map(record) : [];
      if (images.length > 10000) throw new AppError('单篇图片数量超过上限');
      const expected = Number.isInteger(meta.imageCount) && Number(meta.imageCount) >= images.length ? Number(meta.imageCount) : images.length;
      if (expected > 10000) throw new AppError('单篇图片数量超过上限');
      const seqSet = new Set<number>(), files = new Map<string, number>();
      for (const [offset, image] of images.entries()) {
        const seq = Number(image.seq || offset + 1), file = text(image.file);
        if (!Number.isInteger(seq) || seq < 1 || seq > 10000 || seqSet.has(seq) || !file || basename(file) !== file || /[/\\]/.test(file)) throw new AppError('图片清单包含无效序号或路径');
        seqSet.add(seq); files.set(file, seq);
      }
      const markdownPath = await confined(root, join(dir, 'article.md'));
      const blocks = markdownBlocks(await boundedText(markdownPath), files);
      if (!blocks.length) throw new AppError('未找到可阅读正文');
      const previous = service.store.findArticle({ biz, mid, idx, url });
      const previousAssets = previous ? service.store.storedAssets(previous.id) : [];
      if (previous?.status === 'complete' && previous.blocks.length && previousAssets.length === previous.imageCount && await service.validAssets(previousAssets)) {
        service.store.upsertArticle({ accountId: account.id, biz, mid: previous.mid || mid, idx: previous.idx || idx, title: previous.title, url: previous.url }, [url]);
        result.skipped++; continue;
      }
      // Import fills an existing document; an older backup cannot shrink its body or resource list.
      const keepBody = previous?.blocks.length ? previous : undefined;
      const targetExpected = keepBody?.imageCount ?? expected;
      const targetBlocks = keepBody?.blocks || blocks;
      const article = service.store.upsertArticle({ accountId: account.id, biz, mid, idx,
        title: keepBody?.title || title, url: keepBody?.url || url, publishedAt: keepBody?.publishedAt || text(meta.publishTime) || text(entry.publishTime), blocks: targetBlocks, imageCount: targetExpected,
        textLength: targetBlocks.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0) }, [url]);
      if (!keepBody) service.store.pruneAssets(article.id, [...seqSet]);
      let complete = true;
      for (const [offset, image] of images.entries()) {
        const seq = Number(image.seq || offset + 1), src = publicImage(image.src);
        if (keepBody && !targetBlocks.some(block => block.type === 'image' && block.seq === seq)) continue;
        const old = service.store.storedAssets(article.id).find(asset => asset.seq === seq);
        if (keepBody && old && old.src !== src) continue;
        if (old && await service.validAsset(old)) continue;
        service.store.saveAsset(article.id, { seq, src, status: 'pending' });
        try {
          const imagePath = await confined(root, join(dir, 'images', text(image.file)));
          if ((await stat(imagePath)).size > 32 * 1024 * 1024) throw new AppError('图片超过大小上限');
          const bytes = await readFile(imagePath), format = validateImage(bytes);
          if (typeof image.sha1 === 'string' && /^[a-f0-9]{40}$/i.test(image.sha1) && createHash('sha1').update(bytes).digest('hex') !== image.sha1.toLowerCase()) throw new AppError('图片指纹不匹配');
          if (typeof image.bytes === 'number' && image.bytes !== bytes.length) throw new AppError('图片长度不匹配');
          await service.saveImage(article.id, { seq, src, status: 'pending' }, bytes, format.ext, format.mime);
          result.images++;
        } catch {
          complete = false; service.store.saveAsset(article.id, { seq, src, status: 'failed' });
          result.errors.push(`${title}：第${seq}张图片未通过本地校验`);
        }
      }
      const saved = service.store.storedAssets(article.id);
      complete = complete && saved.length === targetExpected && targetBlocks.filter(block => block.type === 'image').length === targetExpected && await service.validAssets(saved);
      service.store.setArticle(article.id, { status: complete ? 'complete' : 'partial', error: complete ? undefined : '旧资料含缺失图片，可建立任务补全' });
      result.articles++;
    } catch (error) {
      result.skipped++; result.errors.push(`${title}：${error instanceof AppError ? error.message : '资料格式无效或文件不可读取'}`);
    }
  }
  result.accounts = accountIds.size;
  return result;
}
