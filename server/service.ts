import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Account, AppSettings, ArticleDetail, Collector, Coverage, Job, JobPage, ParsedArticle, SettingsUpdateResult, UpdatePolicy } from '../shared/types.js';
import { Store, type StoredAsset, type StoredJob } from './store.js';
import { articleIdentity, sanitizeArticleUrl, sanitizeCoverUrl, validateImage, WechatSource } from './source.js';
import { CoverCache } from './covers.js';
import { ImageStorage, StorageError } from './image-storage.js';

export class AppError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'invalid_request') { super(message); }
}
const messages: Record<string, string> = {
  verification: '微信要求验证，采集通道已暂停，请在微信处理后重新连接',
  rate_limited: '微信限制了访问频率，采集通道已暂停，请稍后重新连接',
  session_expired: '微信会话已失效，请打开目标公众号文章并重新连接',
  need_session: '请先在电脑微信打开该公众号文章，再连接微信',
  deleted: '该文章已删除或当前不可访问', network: '网络请求未完成，可稍后继续任务',
  invalid_content: '未识别到有效正文或图片，未计为完整归档',
  invalid_url: '请提供有效的微信公众号文章链接',
  processing_error: '本地处理未完成，请检查数据目录并重试',
};
export function safeFailure(error: unknown): { code: string; message: string; blocked: boolean } {
  if (error instanceof AppError) return { code: error.code, message: error.message, blocked: false };
  const candidate = error as { code?: unknown; blocked?: unknown; status?: unknown } | null;
  let code = typeof candidate?.code === 'string' && messages[candidate.code] ? candidate.code : 'processing_error';
  if (candidate?.status === 429) code = 'rate_limited';
  if (candidate?.status === 401 || candidate?.status === 403) code = 'session_expired';
  return { code, message: messages[code], blocked: ['verification', 'rate_limited', 'session_expired'].includes(code) || candidate?.blocked === true };
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isAborted = (error: unknown) => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);

export class ArchiveService {
  readonly store: Store;
  readonly source: Collector;
  private worker?: Promise<void>;
  private controller?: AbortController;
  private currentJob?: string;
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  private importing = false;
  private readonly identifying = new Set<Promise<ParsedArticle>>();
  private readonly covers: CoverCache;
  private readonly images: ImageStorage;
  private migration?: Promise<SettingsUpdateResult>;
  private readonly imageWrites = new Set<Promise<void>>();
  private profile?: Promise<Account>;
  private readonly profileController = new AbortController();
  constructor(readonly dataDir: string, source: Collector = new WechatSource(), schedulerEnabled = true, defaultImageDirectory?: string) {
    this.store = new Store(dataDir); this.source = source;
    this.images = new ImageStorage(this.store, resolve(dataDir), defaultImageDirectory);
    this.covers = new CoverCache(dataDir, async (url, referer, signal) => {
      this.assertSource();
      try { return await (this.source.fetchCover ? this.source.fetchCover(url, referer, signal) : this.source.fetchImage(url, referer, signal)); }
      catch (error) { const failure = this.recordFailure(error); throw new AppError(failure.message, failure.blocked ? 409 : 422, failure.code); }
    });
    if (schedulerEnabled) { this.timer = setInterval(() => this.schedule(), 30_000); this.timer.unref(); }
  }
  accounts(): Account[] {
    return this.store.accounts().map(account => ({ ...account,
      connection: this.blocked ? 'blocked' : this.source.hasSession(account.biz) ? 'connected' : account.connection === 'connected' ? 'disconnected' : account.connection }));
  }
  get blocked() { return this.store.gate || this.source.getGate(); }
  summary() { return { ...this.store.summary(), connectionBlocked: Boolean(this.blocked) }; }
  settings(canChooseDirectory = process.platform === 'win32'): AppSettings {
    return { imageDirectory: this.images.imageDirectory, defaultImageDirectory: this.images.defaultDirectory,
      dataDirectory: resolve(this.dataDir), canChooseDirectory };
  }
  updateSettings(input: { imageDirectory?: unknown; migrateExisting?: unknown }, canChooseDirectory = process.platform === 'win32'): Promise<SettingsUpdateResult> {
    if (input.migrateExisting !== undefined && typeof input.migrateExisting !== 'boolean') throw new AppError('迁移选项必须为布尔值');
    if (this.closing || this.profile || this.migration || this.importing || this.identifying.size || this.imageWrites.size || this.worker || this.store.hasActiveJobs()) throw new AppError('请等待资料更新、采集、导入或图片迁移完成后再更改保存位置', 409, 'busy');
    const operation = Promise.resolve().then(async () => {
      try { const result = await this.images.setDirectory(input.imageDirectory, input.migrateExisting === true); return { settings: this.settings(canChooseDirectory), ...result }; }
      catch (error) { if (error instanceof StorageError) throw new AppError(error.message, error.statusCode, error.code); throw new AppError('图片迁移未完成，原文件和原保存位置已保留，请检查目录权限及图片完整性', 422, 'storage_error'); }
    }).finally(() => { this.migration = undefined; });
    this.migration = operation;
    return operation;
  }
  private assertNoMigration() { if (this.profile || this.migration || this.closing) throw new AppError('正在更新资料、迁移图片或关闭服务，请稍后操作', 409, 'busy'); }
  account(id: string): Account { const account = this.accounts().find(item => item.id === id); if (!account) throw new AppError('公众号不存在', 404, 'not_found'); return account; }
  article(id: string): ArticleDetail { const article = this.store.article(id); if (!article) throw new AppError('文章不存在', 404, 'not_found'); return article; }
  async cover(id: string) {
    const article = this.article(id);
    if (!article.coverSource) throw new AppError('这篇文章还没有封面，请重新发现文章补齐', 404, 'not_found');
    return this.covers.get(article.id, article.coverSource, article.url);
  }
  async avatar(id: string) {
    const account = this.account(id), source = sanitizeCoverUrl(account.avatarSource);
    const referer = this.store.accountArticleUrl(id);
    if (!source || !referer) throw new AppError('这个公众号还没有头像，请点击头像更新资料', 404, 'not_found');
    return this.covers.get(`account:${id}`, source, sanitizeArticleUrl(referer));
  }
  refreshProfile(id: string): Promise<Account> {
    this.assertNoMigration(); this.assertSource();
    if (this.importing || this.identifying.size || this.imageWrites.size || this.worker || this.store.hasActiveJobs()) throw new AppError('请等待采集或导入完成后再更新头像', 409, 'busy');
    const account = this.account(id), url = this.store.accountArticleUrl(id);
    if (!url) throw new AppError('这个公众号还没有文章，请先发现文章再更新头像', 404, 'not_found');
    this.profile = Promise.resolve().then(async () => {
      try {
        const parsed = await this.source.fetchArticle(sanitizeArticleUrl(url), this.profileController.signal);
        this.profileController.signal.throwIfAborted(); this.assertSource();
        if (parsed.biz !== account.biz) throw new AppError('来源文章不属于这个公众号，原头像已保留', 422, 'account_mismatch');
        const avatarSource = sanitizeCoverUrl(parsed.avatarUrl);
        if (!avatarSource) throw new AppError('来源文章没有可用的公众号头像，原头像已保留', 422, 'avatar_unavailable');
        return this.store.saveAccount({ ...this.store.account(id)!, avatarSource });
      } catch (error) { const failure = this.recordFailure(error); throw new AppError(failure.message, failure.blocked ? 409 : error instanceof AppError ? error.statusCode : 422, failure.code); }
    }).finally(() => { this.profile = undefined; });
    return this.profile;
  }
  async addAccount(input: { url?: unknown; biz?: unknown; name?: unknown }): Promise<Account> {
    this.assertNoMigration();
    if (this.importing) throw new AppError('正在导入旧资料，请完成后再操作', 409, 'busy');
    if (typeof input.url === 'string' && input.url.trim()) {
      this.assertSource();
      const original = sanitizeArticleUrl(input.url.trim());
      let parsed: ParsedArticle;
      const operation = Promise.resolve().then(() => this.source.fetchArticle(original, this.profileController.signal));
      this.identifying.add(operation);
      try { parsed = await operation; this.profileController.signal.throwIfAborted(); } catch (error) { this.recordFailure(error); const failure = safeFailure(error); throw new AppError(failure.message, failure.blocked ? 409 : 422, failure.code); }
      finally { this.identifying.delete(operation); }
      const account = this.store.upsertAccount(parsed.biz, parsed.account || '未命名公众号');
      this.ingestParsed(account, parsed, [original]);
      return this.account(account.id);
    }
    if (typeof input.biz !== 'string' || !/^[A-Za-z0-9+/=_-]{6,128}$/.test(input.biz) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new AppError('请提供有效文章链接，或公众号编号与名称');
    return this.store.upsertAccount(input.biz, input.name.trim());
  }
  updateAccount(id: string, patch: { name?: unknown; updatePolicy?: unknown; intervalMinutes?: unknown }): Account {
    const account = this.account(id);
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 200)) throw new AppError('公众号名称不能为空且不能超过200字');
    if (patch.updatePolicy !== undefined && !['manual', 'discover', 'download'].includes(String(patch.updatePolicy))) throw new AppError('更新策略无效');
    if (patch.intervalMinutes !== undefined && (!Number.isInteger(patch.intervalMinutes) || Number(patch.intervalMinutes) < 5 || Number(patch.intervalMinutes) > 10080)) throw new AppError('更新间隔需为5至10080分钟的整数');
    const next = { ...account, name: typeof patch.name === 'string' ? patch.name.trim() : account.name,
      updatePolicy: (patch.updatePolicy || account.updatePolicy) as UpdatePolicy, intervalMinutes: patch.intervalMinutes === undefined ? account.intervalMinutes : Number(patch.intervalMinutes) };
    next.nextCheckAt = next.updatePolicy === 'manual' ? undefined : new Date(Date.now() + (account.updatePolicy === 'manual' ? 0 : next.intervalMinutes * 60_000)).toISOString();
    return this.store.saveAccount(next);
  }
  async connect(id: string): Promise<Account> {
    const account = this.account(id);
    try { await this.source.captureSession(account.biz); }
    catch (error) { const failure = safeFailure(error); this.store.saveAccount({ ...this.store.account(id)!, connection: 'disconnected' }); throw new AppError(failure.message, 409, failure.code); }
    this.source.clearGate(); this.store.gate = null;
    const current = this.store.account(id)!;
    return this.store.saveAccount({ ...current, connection: 'connected', nextCheckAt: current.updatePolicy === 'manual' ? undefined : new Date().toISOString() });
  }
  createArchiveJob(accountId: string, values: unknown): Job {
    this.assertNoMigration();
    if (this.importing) throw new AppError('正在导入旧资料，请完成后再建立任务', 409, 'busy');
    const account = this.account(accountId);
    if (!Array.isArray(values) || !values.length || values.length > 1000 || values.some(value => typeof value !== 'string')) throw new AppError('请明确选择1至1000篇文章');
    const ids = [...new Set(values as string[])];
    for (const id of ids) if (this.article(id).accountId !== accountId) throw new AppError('选中文章不属于同一个公众号');
    const job = this.store.createJob(account, 'archive', ids); this.wake(); return this.publicJob(job);
  }
  createDiscoveryJob(accountId: string, maxPages = 20, autoDownload = false, maxArticles?: number): Job {
    this.assertNoMigration();
    if (this.importing) throw new AppError('正在导入旧资料，请完成后再刷新', 409, 'busy');
    const account = this.account(accountId);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new AppError('分页上限需为1至200的整数');
    if (maxArticles !== undefined && (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 10000)) throw new AppError('文章上限需为1至10000的整数');
    if (this.store.hasActiveJobs(accountId, 'discover')) throw new AppError('该公众号已有清单刷新任务', 409, 'conflict');
    const job = this.store.createJob(account, 'discover', [], maxPages, autoDownload, maxArticles); this.wake(); return this.publicJob(job);
  }
  private publicJob({ offset: _offset, pages: _pages, maxPages: _maxPages, pageBudget: _budget, autoDownload: _autoDownload, discoveredIds: _ids,
    maxArticles: _maxArticles, articleBudget: _articleBudget, inspectedIds: _inspectedIds, pendingPage: _pendingPage, ...job }: StoredJob): Job { return job; }
  jobs(): Job[] { return this.store.jobs().map(job => this.publicJob(job)); }
  openJobs(): Job[] { return this.store.openJobs().map(job => this.publicJob(job)); }
  jobHistory(page: number, pageSize: number, focus?: string): JobPage {
    const result = this.store.jobHistory(page, pageSize, focus);
    return { ...result, items: result.items.map(job => this.publicJob(job)) };
  }
  pause(id: string): Job {
    const job = this.store.job(id); if (!job) throw new AppError('任务不存在', 404, 'not_found');
    if (!['running', 'queued'].includes(job.status)) throw new AppError('当前任务无需暂停', 409, 'conflict');
    const saved = this.store.saveJob({ ...job, status: 'paused', message: '已暂停，可继续任务' });
    for (const item of this.store.jobItems(id)) if (item.status === 'running') {
      const article = this.store.article(item.articleId);
      if (article?.status === 'downloading') this.store.setArticle(article.id, { status: 'partial', error: '采集已暂停，可继续补全' });
    }
    if (this.currentJob === id) this.controller?.abort();
    return this.publicJob(saved);
  }
  resume(id: string): Job {
    this.assertNoMigration();
    if (this.importing) throw new AppError('正在导入旧资料，请完成后再继续任务', 409, 'busy');
    const job = this.store.job(id); if (!job) throw new AppError('任务不存在', 404, 'not_found');
    if (['running', 'queued', 'completed'].includes(job.status)) throw new AppError('当前任务无需继续', 409, 'conflict');
    if (this.currentJob === id && this.controller?.signal.aborted) throw new AppError('请求仍在暂停处理中，请稍后继续', 409, 'busy');
    if (this.blocked) throw new AppError('采集通道仍受阻，请先处理微信验证并重新连接', 409, 'source_blocked');
    if (job.kind === 'discover' && !this.source.hasSession(this.account(job.accountId).biz)) throw new AppError(messages.need_session, 409, 'need_session');
    for (const item of this.store.jobItems(id)) if (item.status !== 'complete') this.store.setJobItem(id, item.ordinal, 'pending');
    const maxPages = job.kind === 'discover' && job.pages >= job.maxPages ? job.pages + (job.pageBudget || job.maxPages) : job.maxPages;
    const maxArticles = job.kind === 'discover' && job.maxArticles !== undefined && (job.inspectedIds?.length || 0) >= job.maxArticles ? job.maxArticles + (job.articleBudget || job.maxArticles) : job.maxArticles;
    const saved = this.store.saveJob({ ...job, maxPages, maxArticles, status: 'queued', message: '等待继续', failed: 0 }); this.wake(); return this.publicJob(saved);
  }
  private assertSource() { if (this.blocked) throw new AppError('采集通道已暂停，请处理微信验证并重新连接', 409, 'source_blocked'); }
  private recordFailure(error: unknown) {
    const failure = safeFailure(error);
    if (failure.blocked) {
      this.store.gate = failure.code;
      for (const account of this.store.accounts()) this.store.saveAccount({ ...account, connection: failure.code === 'session_expired' ? 'expired' : 'blocked' });
    }
    return failure;
  }
  private wake() {
    if (this.worker || this.closing) return;
    this.worker = Promise.resolve().then(async () => {
      while (!this.closing) {
        const job = this.store.nextQueuedJob();
        if (!job) break;
        this.currentJob = job.id; this.controller = new AbortController();
        await this.run(job, this.controller.signal);
        this.currentJob = undefined; this.controller = undefined;
      }
    }).finally(() => { this.worker = undefined; });
  }
  async idle(): Promise<void> { await this.worker; }
  private async run(job: StoredJob, signal: AbortSignal) {
    this.store.saveJob({ ...job, status: 'running', message: '正在执行' });
    try {
      this.assertSource();
      if (job.kind === 'discover') await this.discover(job, signal); else await this.archive(job, signal);
    } catch (error) {
      const current = job.kind === 'archive' ? this.updateJobCounts(job.id) : this.store.job(job.id)!;
      if (current.status === 'paused' || this.closing || signal.aborted) { this.store.saveJob({ ...current, status: 'paused', message: '已暂停，已保存进度' }); return; }
      const failure = this.recordFailure(error);
      const status = failure.blocked || (error instanceof AppError && error.code === 'source_blocked') ? 'blocked' : ['need_session'].includes(failure.code) ? 'waiting_session' : 'failed';
      this.store.saveJob({ ...current, status, message: failure.message });
    }
  }
  private ingestParsed(account: Account, parsed: ParsedArticle, aliases: string[] = []): ArticleDetail {
    if (parsed.biz !== account.biz) throw new AppError('文章所属公众号与任务不一致', 422, 'account_mismatch');
    const avatarSource = sanitizeCoverUrl(parsed.avatarUrl);
    if (avatarSource) this.store.saveAccount({ ...this.store.account(account.id)!, avatarSource });
    const original = this.store.upsertArticle({ accountId: account.id, biz: account.biz, mid: parsed.mid, idx: parsed.idx, title: parsed.title, url: sanitizeArticleUrl(parsed.url), publishedAt: parsed.publishedAt, blocks: parsed.blocks, imageCount: parsed.images.length, textLength: parsed.textLength }, aliases);
    this.store.pruneAssets(original.id, parsed.images.map(image => image.seq));
    for (const image of parsed.images) {
      const old = this.store.storedAssets(original.id).find(asset => asset.seq === image.seq);
      if (!old || old.src !== image.src) this.store.saveAsset(original.id, { seq: image.seq, src: image.src, status: 'pending' });
    }
    if (original.status === 'complete' && this.store.storedAssets(original.id).some(asset => asset.status !== 'complete')) this.store.setArticle(original.id, { status: 'partial', error: '正文图片发生变化，待补全' });
    return this.store.article(original.id)!;
  }
  private async discover(job: StoredJob, signal: AbortSignal) {
    const account = this.account(job.accountId);
    if (!this.source.hasSession(account.biz)) throw { code: 'need_session' };
    let offset = job.offset, pages = job.pages, pending = job.pendingPage;
    let complete = false, reason = 'page_limit';
    const seen = new Set<string>(), inspected = new Set(job.inspectedIds || []);
    const newIds = new Set(job.discoveredIds || []);
    while (pending || pages < job.maxPages) {
      signal.throwIfAborted(); this.assertSource();
      if (!pending) {
        const page = await this.source.discoverPage(account.biz, offset, signal);
        signal.throwIfAborted(); this.assertSource();
        const entries = page.entries.map(entry => {
          const clean = sanitizeArticleUrl(entry.url), identity = articleIdentity(clean);
          const biz = entry.biz || identity.biz;
          if (biz !== account.biz || identity.biz && identity.biz !== account.biz) throw new AppError('历史清单包含其他公众号，已停止', 422, 'account_mismatch');
          return { url: clean, title: entry.title || '未命名文章', publishedAt: entry.publishedAt,
            coverUrl: sanitizeCoverUrl(entry.coverUrl), biz, mid: entry.mid || identity.mid, idx: entry.idx || identity.idx };
        });
        const fingerprint = entries.map(entry => entry.url).join('\n');
        const stopReason = !page.canContinue ? 'reached_end' : !entries.length ? 'empty_page' : page.nextOffset <= offset ? 'cursor_stalled' : seen.has(fingerprint) ? 'repeated_page' : 'page_limit';
        seen.add(fingerprint); pages++;
        pending = { entries, nextOffset: page.nextOffset, canContinue: page.canContinue, stopReason };
      }
      const page = pending;
      this.store.db.transaction(() => {
        let consumed = 0;
        const stamps = [this.store.job(job.id)?.coverage?.oldest, this.store.job(job.id)?.coverage?.newest].filter((value): value is string => Boolean(value));
        for (const entry of page.entries) {
          const before = this.store.findArticle({ biz: account.biz, mid: entry.mid, idx: entry.idx, url: entry.url });
          if (job.maxArticles !== undefined && inspected.size >= job.maxArticles && (!before || !inspected.has(before.id))) break;
          const article = this.store.upsertArticle({ accountId: account.id, biz: account.biz, mid: entry.mid, idx: entry.idx, url: entry.url, title: entry.title, publishedAt: entry.publishedAt, coverSource: entry.coverUrl });
          inspected.add(article.id); consumed++;
          if (entry.publishedAt) stamps.push(entry.publishedAt);
          if (!before && job.autoDownload) newIds.add(article.id);
        }
        const tail = page.entries.slice(consumed);
        pending = tail.length ? { ...page, entries: tail } : undefined;
        complete = !tail.length && !page.canContinue;
        reason = tail.length ? 'article_limit' : complete ? 'reached_end' : page.stopReason !== 'page_limit' ? page.stopReason : job.maxArticles !== undefined && inspected.size >= job.maxArticles ? 'article_limit' : 'page_limit';
        if (!pending && page.nextOffset > offset) offset = page.nextOffset;
        const current = this.store.job(job.id)!;
        stamps.sort();
        const coverage: Coverage = { count: inspected.size, oldest: stamps[0], newest: stamps.at(-1), complete, stopReason: reason };
        this.store.saveJob({ ...current, offset, pages, pendingPage: pending, inspectedIds: [...inspected], discoveredIds: [...newIds],
          total: inspected.size, completed: inspected.size,
          progress: Math.min(99, Math.round(job.maxArticles !== undefined ? inspected.size / job.maxArticles * 100 : pages / job.maxPages * 100)),
          message: `本任务已检查${inspected.size}篇，读取${pages}批`, coverage });
        const currentAccount = this.account(account.id);
        this.store.saveAccount({ ...currentAccount, lastCheckedAt: new Date().toISOString(),
          coverage: { ...currentAccount.coverage, complete: complete || currentAccount.coverage.complete, stopReason: reason } });
      })();
      if (complete || reason !== 'page_limit') break;
    }
    signal.throwIfAborted();
    const current = this.store.job(job.id)!;
    this.store.db.transaction(() => {
      if (job.autoDownload) {
        const ids = [...newIds].filter(id => this.store.article(id)?.status !== 'complete');
        for (let index = 0; index < ids.length; index += 1000) this.createArchiveJob(account.id, ids.slice(index, index + 1000));
      }
      const limited = reason === 'page_limit' || reason === 'article_limit';
      this.store.saveJob({ ...current, discoveredIds: [], status: limited && !complete ? 'paused' : 'completed', progress: 100,
        message: complete ? `清单已到来源末尾，本任务共检查${current.completed}篇` : reason === 'article_limit' ? '已到本次文章上限，继续任务可从断点检查更多文章' : reason === 'page_limit' ? '已到本次批次上限，继续任务可从断点发现更早文章' : `本次清单刷新结束（${reason}），尚未确认全部历史` });
    })();
  }
  private async archive(job: StoredJob, signal: AbortSignal) {
    for (const item of this.store.jobItems(job.id)) {
      signal.throwIfAborted();
      if (item.status === 'complete') {
        const existing = this.store.article(item.articleId), saved = this.store.storedAssets(item.articleId);
        const valid = existing?.blocks.length && saved.length === existing.imageCount && await this.validAssets(saved, signal);
        signal.throwIfAborted();
        if (valid) continue;
      }
      this.store.setJobItem(job.id, item.ordinal, 'running');
      try {
        const complete = await this.archiveArticle(item.articleId, signal);
        signal.throwIfAborted();
        this.store.setJobItem(job.id, item.ordinal, complete ? 'complete' : 'failed', complete ? undefined : '正文已保存，部分图片待补全');
      } catch (error) {
        if (signal.aborted || isAborted(error) && signal.aborted) throw error;
        const failure = this.recordFailure(error);
        this.store.setJobItem(job.id, item.ordinal, 'failed', failure.message);
        const article = this.store.article(item.articleId);
        if (article) this.store.setArticle(article.id, { status: failure.code === 'deleted' ? 'unavailable' : 'partial', error: failure.message });
        if (failure.blocked || failure.code === 'need_session' || error instanceof AppError && error.code === 'source_blocked') throw error;
      }
      this.updateJobCounts(job.id);
    }
    signal.throwIfAborted();
    const current = this.updateJobCounts(job.id);
    this.store.saveJob({ ...current, status: current.failed ? 'partial' : 'completed', progress: 100, message: current.failed ? `${current.completed}篇完整，${current.failed}篇待处理，可继续补全` : `${current.completed}篇全部完整归档` });
  }
  private updateJobCounts(id: string): StoredJob {
    const items = this.store.jobItems(id), current = this.store.job(id)!;
    const completed = items.filter(item => item.status === 'complete').length, failed = items.filter(item => item.status === 'failed').length;
    return this.store.saveJob({ ...current, completed, failed, progress: items.length ? Math.round((completed + failed) / items.length * 100) : 0, message: `完整${completed} / 待处理${failed} / 共${items.length}篇` });
  }
  async filePath(file: string, storageDirectory?: string): Promise<string> {
    return this.images.filePath(file, storageDirectory);
  }
  async validAsset(asset: StoredAsset): Promise<boolean> {
    return this.images.validAsset(asset);
  }
  async validAssets(assets: StoredAsset[], signal?: AbortSignal): Promise<boolean> {
    for (const asset of assets) {
      signal?.throwIfAborted();
      const valid = await this.validAsset(asset);
      signal?.throwIfAborted();
      if (!valid) return false;
    }
    return true;
  }
  saveImage(articleId: string, asset: StoredAsset, buffer: Buffer, ext: string, mime: string, hash = sha256(buffer)): Promise<void> {
    this.assertNoMigration();
    const write = Promise.resolve().then(async () => {
      const format = validateImage(buffer, mime);
      if (format.ext !== ext || !/^[a-f0-9]{64}$/.test(hash) || sha256(buffer) !== hash) throw new AppError('图片内容与资源指纹不一致', 422, 'invalid_content');
      const file = this.images.imageFile(articleId, `${String(asset.seq).padStart(3, '0')}-${hash.slice(0, 12)}.${ext}`);
      const previous = this.store.storedAssets(articleId).find(item => item.seq === asset.seq);
      const root = this.images.imageDirectory;
      await this.images.write(file, buffer, Boolean(previous?.file && resolve(root, previous.file) === resolve(root, file) && (!previous.storageDirectory || resolve(previous.storageDirectory) === resolve(root))));
      this.store.saveAsset(articleId, { ...asset, status: 'complete', file, storageDirectory: root, mime, sha256: hash, bytes: buffer.length });
    }).finally(() => { this.imageWrites.delete(write); });
    this.imageWrites.add(write);
    return write;
  }
  private async archiveArticle(id: string, signal: AbortSignal): Promise<boolean> {
    let article = this.article(id);
    let assets = this.store.storedAssets(id);
    const hasBody = article.blocks.length > 0 && assets.length === article.imageCount && assets.every(asset => Boolean(asset.src));
    if (!hasBody) {
      this.assertSource();
      const parsed = await this.source.fetchArticle(article.url, signal);
      signal.throwIfAborted();
      article = this.ingestParsed(this.account(article.accountId), parsed, [article.url]);
      id = article.id; assets = this.store.storedAssets(id);
    }
    this.store.setArticle(id, { status: 'downloading', error: undefined });
    let failed = false;
    for (const asset of assets) {
      signal.throwIfAborted();
      const valid = await this.validAsset(asset);
      signal.throwIfAborted();
      if (valid) continue;
      this.assertSource();
      try {
        const image = await this.source.fetchImage(asset.src, article.url, signal);
        signal.throwIfAborted();
        await this.saveImage(id, asset, image.buffer, image.ext, image.mime, image.sha256);
      } catch (error) {
        if (signal.aborted) throw error;
        failed = true;
        this.store.saveAsset(id, { ...asset, status: 'failed', file: undefined });
        const failure = this.recordFailure(error);
        this.store.setArticle(id, { status: 'partial', error: failure.message });
        if (failure.blocked) throw error;
      }
    }
    const saved = this.store.storedAssets(id);
    const complete = !failed && saved.length === article.imageCount && await this.validAssets(saved, signal);
    signal.throwIfAborted();
    this.store.setArticle(id, { status: complete ? 'complete' : 'partial', error: complete ? undefined : '部分图片未完整保存，可继续补全' });
    return complete;
  }
  private schedule() {
    if (this.closing || this.blocked || this.importing || this.migration || this.profile) return;
    for (const account of this.accounts()) {
      if (account.updatePolicy === 'manual' || account.nextCheckAt && Date.parse(account.nextCheckAt) > Date.now()) continue;
      if (this.store.hasActiveJobs(account.id)) continue;
      this.store.saveAccount({ ...account, connection: this.source.hasSession(account.biz) ? 'connected' : 'expired', nextCheckAt: new Date(Date.now() + account.intervalMinutes * 60_000).toISOString() });
      if (this.source.hasSession(account.biz)) this.createDiscoveryJob(account.id, 5, account.updatePolicy === 'download');
    }
  }
  async beginImport() {
    this.assertNoMigration();
    if (this.importing || this.identifying.size || this.store.hasActiveJobs()) throw new AppError('请等待当前操作完成，或暂停采集任务后再导入', 409, 'busy');
    this.importing = true;
    try { await this.worker; } catch (error) { this.importing = false; throw error; }
  }
  endImport() { this.importing = false; }
  async closePreviews() { this.closing = true; this.profileController.abort(); await Promise.allSettled([...this.identifying, this.profile, this.migration, ...this.imageWrites, this.covers.close()]); }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.profileController.abort();
    this.controller?.abort();
    await Promise.allSettled([...this.identifying, this.profile, this.worker, this.migration, ...this.imageWrites, this.covers.close()]);
    this.store.close();
  }
}
