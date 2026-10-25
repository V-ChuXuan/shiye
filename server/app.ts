import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Collector } from '../shared/types.js';
import { ArchiveService, AppError, safeFailure } from './service.js';
import { importLegacy } from './legacy.js';
import { chooseWindowsDirectory } from './directory-picker.js';

declare module 'fastify' { interface FastifyInstance { archive: ArchiveService } }

export interface AppOptions { dataDir?: string; source?: Collector; staticDir?: string; schedulerEnabled?: boolean; defaultImageDirectory?: string; chooseDirectory?: (initialDirectory: string) => Promise<string | null> }
export type ArchiveApp = FastifyInstance & { archive: ArchiveService };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function createApp(options: AppOptions = {}): Promise<ArchiveApp> {
  const service = new ArchiveService(resolve(options.dataDir || 'data'), options.source, options.schedulerEnabled ?? true, options.defaultImageDirectory);
  const canChooseDirectory = Boolean(options.chooseDirectory) || process.platform === 'win32';
  const pickerController = new AbortController();
  const chooseDirectory = options.chooseDirectory || ((initial: string) => chooseWindowsDirectory(initial, pickerController.signal));
  let choosingDirectory = false;
  const app = Object.assign(Fastify({ logger: false, bodyLimit: 1024 * 1024 }), { archive: service });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) return reply.code(403).send({ error: '仅允许本机访问', code: 'invalid_host' });
    const origin = request.headers.origin;
    if (origin) {
      let allowed = false;
      try { const url = new URL(origin); allowed = url.protocol === 'http:' && url.host === host; } catch { /* Reject malformed origins. */ }
      if (!allowed) return reply.code(403).send({ error: '请求来源无效', code: 'invalid_origin' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '请求来源无效', code: 'invalid_origin' });
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    const status = (error as { statusCode?: number })?.statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: '请求格式无效', code: 'invalid_request' });
    const failure = safeFailure(error);
    const responseStatus = failure.code === 'invalid_url' ? 400 : failure.blocked ? 409 : 500;
    return reply.code(responseStatus).send({ error: failure.message, code: failure.code });
  });
  app.get('/api/health', async (_request, reply) => reply.header('X-Wechat-Archive', '1').send({ ok: true }));
  app.get('/api/summary', async () => service.summary());
  app.get<{ Params: { articleId: string } }>('/api/reading-positions/:articleId', async request => {
    const position = service.store.readingPosition(request.params.articleId);
    if (!position) throw new AppError('文章不存在', 404, 'not_found');
    return position;
  });
  app.put<{ Params: { articleId: string } }>('/api/reading-positions/:articleId', async request => {
    const body = object(request.body);
    if (Object.keys(body).length !== 2 || !['mode', 'top'].every(key => Object.hasOwn(body, key)) ||
      (body.mode !== 'body' && body.mode !== 'gallery') || typeof body.top !== 'number' || !Number.isFinite(body.top) || body.top < 0 || body.top > 10_000_000) throw new AppError('阅读位置无效');
    const position = service.store.saveReadingPosition(request.params.articleId, body.mode, body.top);
    if (!position) throw new AppError('文章不存在', 404, 'not_found');
    return position;
  });
  app.get('/api/settings', async () => service.settings(canChooseDirectory));
  app.put('/api/settings', async request => service.updateSettings(object(request.body), canChooseDirectory));
  app.post('/api/settings/choose-directory', async () => {
    if (!canChooseDirectory) throw new AppError('当前系统请直接填写文件夹路径', 400, 'unsupported');
    if (choosingDirectory) throw new AppError('目录选择窗口已经打开', 409, 'busy');
    choosingDirectory = true;
    try { return { path: await chooseDirectory(service.settings().imageDirectory) }; }
    catch { throw new AppError('无法打开系统目录选择器，请直接填写路径', 422, 'directory_picker_failed'); }
    finally { choosingDirectory = false; }
  });
  app.get('/api/about', async () => {
    const metadata = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string; description: string };
    return { name: '拾页', version: metadata.version, description: metadata.description };
  });
  app.get('/api/accounts', async () => service.accounts());
  app.post('/api/accounts', async (request, reply) => reply.code(201).send(await service.addAccount(object(request.body))));
  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async request => service.updateAccount(request.params.id, object(request.body)));
  app.post<{ Params: { id: string } }>('/api/accounts/:id/connect', async request => service.connect(request.params.id));
  app.post<{ Params: { id: string } }>('/api/accounts/:id/profile', async request => service.refreshProfile(request.params.id));
  app.get<{ Params: { id: string } }>('/api/accounts/:id/avatar', async (request, reply) => {
    const avatar = await service.avatar(request.params.id); return reply.type(avatar.mime).send(avatar.buffer);
  });
  app.post<{ Params: { id: string } }>('/api/accounts/:id/discover', async (request, reply) => {
    const body = object(request.body);
    if (body.maxArticles !== undefined && (typeof body.maxArticles !== 'number' || !Number.isInteger(body.maxArticles))) throw new AppError('文章上限必须为整数');
    return reply.code(201).send(service.createDiscoveryJob(request.params.id, body.maxPages === undefined ? 20 : Number(body.maxPages), false, body.maxArticles as number | undefined));
  });
  app.get<{ Querystring: { accountId?: string; q?: string; since?: string; until?: string; status?: string } }>('/api/articles', async request => {
    const query = request.query;
    for (const value of [query.accountId, query.q, query.since, query.until, query.status]) if (value !== undefined && typeof value !== 'string') throw new AppError('筛选条件无效');
    return service.store.articles(query).map(({ blocks: _blocks, assets: _assets, ...article }) => article);
  });
  app.get<{ Querystring: { accountId?: string; q?: string; since?: string; until?: string; status?: string; page?: string; pageSize?: string } }>('/api/articles/page', async request => {
    const query = request.query;
    if (Object.keys(query).some(key => !['accountId', 'q', 'since', 'until', 'status', 'page', 'pageSize'].includes(key))) throw new AppError('筛选条件无效');
    for (const value of [query.accountId, query.q, query.since, query.until, query.status]) if (value !== undefined && typeof value !== 'string') throw new AppError('筛选条件无效');
    const integer = (value: unknown, fallback: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError('页码和每页数量必须为正整数');
      return Number(value);
    };
    const page = integer(query.page, 1), pageSize = integer(query.pageSize, 50);
    if (pageSize > 100 || !Number.isSafeInteger(page * pageSize)) throw new AppError('每页最多100篇，页码不能超出有效范围');
    if ((query.q?.length ?? 0) > 500 || (query.accountId?.length ?? 0) > 128 || query.status && !['discovered', 'downloading', 'partial', 'complete', 'unavailable'].includes(query.status)) throw new AppError('筛选条件无效');
    for (const value of [query.since, query.until]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new AppError('请提供有效的筛选日期');
    if (query.since && query.until && query.since > query.until) throw new AppError('开始日期不能晚于结束日期');
    return service.store.articlePage({ ...query, page, pageSize });
  });
  app.get<{ Params: { id: string } }>('/api/articles/:id', async request => service.article(request.params.id));
  app.get<{ Params: { articleId: string } }>('/api/covers/:articleId', async (request, reply) => {
    const cover = await service.cover(request.params.articleId);
    return reply.type(cover.mime).send(cover.buffer);
  });
  app.get<{ Querystring: { scope?: string } }>('/api/jobs', async request => {
    const query = request.query;
    if (Object.keys(query).some(key => key !== 'scope') || query.scope !== undefined && query.scope !== 'open') throw new AppError('任务范围无效');
    return query.scope === 'open' ? service.openJobs() : service.jobs();
  });
  app.get<{ Querystring: { page?: string; pageSize?: string; focus?: string } }>('/api/jobs/history', async request => {
    const query = request.query;
    if (Object.keys(query).some(key => !['page', 'pageSize', 'focus'].includes(key))) throw new AppError('任务分页条件无效');
    const integer = (value: unknown, fallback: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError('页码和每页数量必须为正整数');
      return Number(value);
    };
    const page = integer(query.page, 1), pageSize = integer(query.pageSize, 20);
    if (pageSize > 100 || !Number.isSafeInteger(page * pageSize)) throw new AppError('每页最多100条，页码不能超出有效范围');
    if (query.focus !== undefined && (typeof query.focus !== 'string' || !query.focus || query.focus.length > 128)) throw new AppError('任务定位无效');
    return service.jobHistory(page, pageSize, query.focus);
  });
  app.post('/api/jobs', async (request, reply) => {
    const body = object(request.body);
    if (typeof body.accountId !== 'string') throw new AppError('请选择公众号');
    return reply.code(201).send(service.createArchiveJob(body.accountId, body.articleIds));
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/pause', async request => service.pause(request.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/resume', async request => service.resume(request.params.id));
  app.post('/api/import', async request => {
    const body = object(request.body);
    if (typeof body.path !== 'string') throw new AppError('请填写旧archive文件夹路径');
    return importLegacy(service, body.path, body.limit === undefined ? 1000 : Number(body.limit));
  });
  app.get<{ Params: { articleId: string; seq: string } }>('/api/assets/:articleId/:seq', async (request, reply) => {
    service.article(request.params.articleId);
    if (!/^\d+$/.test(request.params.seq)) throw new AppError('图片不存在', 404, 'not_found');
    const asset = service.store.storedAssets(request.params.articleId).find(item => item.seq === Number(request.params.seq));
    if (!asset?.file || asset.status !== 'complete') throw new AppError('图片尚未完整归档', 404, 'not_found');
    let path: string;
    try { path = await service.filePath(asset.file, asset.storageDirectory); } catch { throw new AppError('本地图片缺失，可重新建立任务补全', 404, 'not_found'); }
    return reply.type(asset.mime || 'application/octet-stream').send(createReadStream(path));
  });
  const staticDir = resolve(options.staticDir || 'dist/client');
  if (existsSync(staticDir)) await app.register(fastifyStatic, { root: staticDir, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || !existsSync(resolve(staticDir, 'index.html'))) return reply.code(404).send({ error: '页面或接口不存在', code: 'not_found' });
    return reply.type('text/html').send(createReadStream(resolve(staticDir, 'index.html')));
  });
  app.addHook('preClose', async () => { pickerController.abort(); await service.closePreviews(); });
  app.addHook('onClose', async () => service.close());
  return app;
}
