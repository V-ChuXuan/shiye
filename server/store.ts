import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, Article, ArticleDetail, ArticlePage, Asset, DiscoveredArticle, Job, Summary } from '../shared/types.js';
import { sanitizeCoverUrl } from './source.js';

export interface StoredAsset extends Asset { file?: string; mime?: string; storageDirectory?: string }
export interface JobItem { ordinal: number; articleId: string; status: 'pending' | 'running' | 'complete' | 'failed'; error?: string }
export interface StoredJob extends Job {
  offset: number; pages: number; maxPages: number; pageBudget?: number; autoDownload?: boolean; discoveredIds?: string[];
  maxArticles?: number; articleBudget?: number; inspectedIds?: string[];
  pendingPage?: { entries: DiscoveredArticle[]; nextOffset: number; canContinue: boolean; stopReason: string };
}
export type ArticleInput = Partial<ArticleDetail> & { accountId: string; biz: string; url: string; title: string };
type JsonRow = { data: string };
type ArticleFilter = { accountId?: string; q?: string; since?: string; until?: string; status?: string };
type ReadingPosition = { body: number; gallery: number };
const now = () => new Date().toISOString();
const decode = <T>(row: unknown): T | undefined => row ? JSON.parse((row as JsonRow).data) as T : undefined;

export class Store {
  readonly db: Database.Database;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'archive.sqlite'));
    this.db.function('casefold', { deterministic: true }, (value: unknown) => String(value ?? '').toLocaleLowerCase());
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,biz TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),canonical TEXT UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (url TEXT PRIMARY KEY,article_id TEXT NOT NULL REFERENCES articles(id));
      CREATE TABLE IF NOT EXISTS assets (article_id TEXT NOT NULL REFERENCES articles(id),seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(article_id,seq));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_items (job_id TEXT NOT NULL REFERENCES jobs(id),ordinal INTEGER NOT NULL,article_id TEXT NOT NULL REFERENCES articles(id),status TEXT NOT NULL,error TEXT,PRIMARY KEY(job_id,ordinal));
      CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS articles_account ON articles(account_id);
    `);
    for (const row of this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status') IN ('running','queued') ORDER BY rowid DESC").all()) {
      const job = decode<StoredJob>(row)!;
      this.saveJob({ ...job, status: 'paused', message: '服务曾中断，请确认后继续任务' });
      this.db.prepare("UPDATE job_items SET status='pending' WHERE job_id=? AND status='running'").run(job.id);
    }
    this.db.prepare("UPDATE articles SET data=json_set(data,'$.status','partial','$.error',?) WHERE json_extract(data,'$.status')='downloading'").run('采集中断，可继续补全');
    for (const account of this.accounts()) if (account.connection === 'connected') this.saveAccount({ ...account, connection: 'disconnected' });
  }
  close() { this.db.close(); }
  get imageDirectory(): string | undefined { return (this.db.prepare('SELECT value FROM runtime WHERE key=?').get('image_directory') as { value: string } | undefined)?.value; }
  saveImageDirectory(directory: string) { this.db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)').run('image_directory', directory); }
  get gate(): string | null { return (this.db.prepare('SELECT value FROM runtime WHERE key=?').get('gate') as { value: string } | undefined)?.value || null; }
  set gate(value: string | null) { if (value) this.db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)').run('gate', value); else this.db.prepare('DELETE FROM runtime WHERE key=?').run('gate'); }
  private readingPositions(): Record<string, ReadingPosition> {
    const positions: Record<string, ReadingPosition> = Object.create(null);
    const raw = (this.db.prepare("SELECT value FROM runtime WHERE key='reader_positions'").get() as { value: string } | undefined)?.value;
    if (!raw || raw.length > 100_000) return positions;
    let saved: unknown;
    try { saved = JSON.parse(raw); } catch { return positions; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return positions;
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000_000;
    for (const [id, entry] of Object.entries(saved).slice(-200)) {
      if (!id || id.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const { body, gallery } = entry as Record<string, unknown>;
      if (valid(body) && valid(gallery)) positions[id] = { body, gallery };
    }
    return positions;
  }
  readingPosition(id: string): ReadingPosition | undefined {
    if (!this.db.prepare('SELECT id FROM articles WHERE id=?').get(id)) return;
    return this.readingPositions()[id] || { body: 0, gallery: 0 };
  }
  saveReadingPosition(id: string, mode: keyof ReadingPosition, top: number): ReadingPosition | undefined {
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM articles WHERE id=?').get(id)) return;
      const positions = this.readingPositions(), position = { ...(positions[id] || { body: 0, gallery: 0 }), [mode]: top };
      delete positions[id]; positions[id] = position;
      const entries = Object.entries(positions).slice(-200);
      this.db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)').run('reader_positions', JSON.stringify(Object.fromEntries(entries)));
      return position;
    })();
  }
  account(id: string): Account | undefined { return decode<Account>(this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id)); }
  accountArticleUrl(id: string): string | undefined { return (this.db.prepare("SELECT json_extract(data,'$.url') AS url FROM articles WHERE account_id=? ORDER BY rowid DESC LIMIT 1").get(id) as { url: string } | undefined)?.url; }
  accounts(): Account[] { return this.db.prepare('SELECT data FROM accounts ORDER BY rowid DESC').all().map(row => this.decorateAccount(decode<Account>(row)!)); }
  private decorateAccount(account: Account): Account {
    const avatarSource = sanitizeCoverUrl(account.avatarSource);
    const counts = this.db.prepare(`SELECT COUNT(*) AS articleCount,
      COUNT(CASE WHEN json_extract(data,'$.status')='complete' THEN 1 END) AS archivedCount,
      MIN(NULLIF(json_extract(data,'$.publishedAt'),'')) AS oldest,
      MAX(NULLIF(json_extract(data,'$.publishedAt'),'')) AS newest
      FROM articles WHERE account_id=?`).get(account.id) as { articleCount: number; archivedCount: number; oldest: string | null; newest: string | null };
    return { ...account, avatarSource, avatarUrl: avatarSource ? `/api/accounts/${account.id}/avatar?v=${createHash('sha256').update(avatarSource).digest('hex')}` : undefined, articleCount: counts.articleCount, archivedCount: counts.archivedCount,
      coverage: { ...account.coverage, count: counts.articleCount, oldest: counts.oldest ?? undefined, newest: counts.newest ?? undefined } };
  }
  upsertAccount(biz: string, name: string): Account {
    const old = decode<Account>(this.db.prepare('SELECT data FROM accounts WHERE biz=?').get(biz));
    if (old) return this.decorateAccount(old);
    return this.saveAccount({ id: randomUUID(), biz, name, connection: 'disconnected', articleCount: 0, archivedCount: 0, updatePolicy: 'manual', intervalMinutes: 60, coverage: { count: 0, complete: false } });
  }
  saveAccount(account: Account): Account {
    const saved = { ...account, avatarSource: sanitizeCoverUrl(account.avatarSource), avatarUrl: undefined };
    this.db.prepare('INSERT INTO accounts(id,biz,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(saved.id, saved.biz, JSON.stringify(saved));
    return this.decorateAccount(saved);
  }
  article(id: string): ArticleDetail | undefined {
    const value = decode<ArticleDetail>(this.db.prepare('SELECT data FROM articles WHERE id=?').get(id));
    if (!value) return undefined;
    const assets = this.storedAssets(id).map(({ file: _file, mime: _mime, storageDirectory: _directory, ...asset }) => ({ ...asset, localUrl: asset.status === 'complete' ? `/api/assets/${id}/${asset.seq}` : undefined }));
    const coverSource = sanitizeCoverUrl(value.coverSource);
    return { ...value, coverSource, assets, savedImageCount: assets.filter(x => x.status === 'complete').length,
      coverUrl: assets.find(x => x.status === 'complete')?.localUrl || (coverSource ? `/api/covers/${id}` : undefined) };
  }
  articles(filter: { accountId?: string; q?: string; since?: string; until?: string; status?: string } = {}): ArticleDetail[] {
    const rows = this.db.prepare('SELECT id FROM articles ORDER BY rowid DESC').all() as { id: string }[];
    return rows.map(row => this.article(row.id)!).filter(value => (!filter.accountId || value.accountId === filter.accountId) &&
      (!filter.q || value.title.toLocaleLowerCase().includes(filter.q.toLocaleLowerCase())) && (!filter.status || value.status === filter.status) &&
      (!filter.since || value.publishedAt.slice(0, 10) >= filter.since) && (!filter.until || value.publishedAt.slice(0, 10) <= filter.until))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  articlePage(filter: ArticleFilter & { page?: number; pageSize?: number } = {}): ArticlePage {
    const page = filter.page ?? 1, pageSize = filter.pageSize ?? 50, conditions: string[] = [], params: string[] = [];
    if (filter.accountId) { conditions.push('a.account_id=?'); params.push(filter.accountId); }
    if (filter.q) { conditions.push("instr(casefold(json_extract(a.data,'$.title')),?)>0"); params.push(filter.q.toLocaleLowerCase()); }
    if (filter.status) { conditions.push("json_extract(a.data,'$.status')=?"); params.push(filter.status); }
    if (filter.since) { conditions.push("substr(json_extract(a.data,'$.publishedAt'),1,10)>=?"); params.push(filter.since); }
    if (filter.until) { conditions.push("substr(json_extract(a.data,'$.publishedAt'),1,10)<=?"); params.push(filter.until); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM articles a ${where}`).get(...params) as { total: number };
    const rows = this.db.prepare(`WITH page AS (
      SELECT a.id,a.rowid AS ordinal,json_extract(a.data,'$.publishedAt') AS published_at,
        json_remove(a.data,'$.blocks','$.assets') AS data
      FROM articles a ${where} ORDER BY published_at DESC,a.rowid DESC LIMIT ? OFFSET ?
    ) SELECT page.data,
      COUNT(CASE WHEN json_extract(assets.data,'$.status')='complete' THEN 1 END) AS savedImageCount,
      MIN(CASE WHEN json_extract(assets.data,'$.status')='complete' THEN assets.seq END) AS firstSavedSeq
      FROM page LEFT JOIN assets ON assets.article_id=page.id
      GROUP BY page.id ORDER BY page.published_at DESC,page.ordinal DESC`).all(...params, pageSize, (page - 1) * pageSize) as { data: string; savedImageCount: number; firstSavedSeq: number | null }[];
    const items = rows.map(row => {
      const value = JSON.parse(row.data) as Article, coverSource = sanitizeCoverUrl(value.coverSource);
      return { ...value, coverSource, savedImageCount: row.savedImageCount,
        coverUrl: row.firstSavedSeq !== null ? `/api/assets/${value.id}/${row.firstSavedSeq}` : coverSource ? `/api/covers/${value.id}` : undefined };
    });
    return { items, total, page, pageSize };
  }
  upsertArticle(input: ArticleInput, aliases: string[] = []): ArticleDetail {
    return this.db.transaction(() => {
      const canonical = input.mid ? `${input.biz}:${input.mid}:${input.idx || '1'}` : null;
      const byCanonical = canonical ? this.db.prepare('SELECT id FROM articles WHERE canonical=?').get(canonical) as { id: string } | undefined : undefined;
      const aliasHits = [input.url, ...aliases].map(url => this.db.prepare('SELECT article_id FROM aliases WHERE url=?').get(url) as { article_id: string } | undefined).filter(Boolean);
      let id = byCanonical?.id || aliasHits[0]?.article_id || randomUUID();
      const existing = this.article(id);
      if (existing && existing.accountId !== input.accountId) throw new Error('article_account_conflict');
      for (const hit of aliasHits) if (hit!.article_id !== id) this.mergeArticles(id, hit!.article_id);
      const previous = this.article(id);
      const base: ArticleDetail = { id, accountId: input.accountId, biz: input.biz, title: input.title, url: input.url, publishedAt: '', status: 'discovered', imageCount: 0, savedImageCount: 0, textLength: 0, blocks: [], assets: [] };
      const value = { ...base, ...previous, ...input, coverSource: sanitizeCoverUrl(input.coverSource) || previous?.coverSource,
        mid: input.mid || previous?.mid, idx: input.idx || previous?.idx, id, assets: [] };
      this.db.prepare('INSERT INTO articles(id,account_id,canonical,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical=COALESCE(excluded.canonical,articles.canonical),data=excluded.data').run(id, input.accountId, canonical, JSON.stringify(value));
      for (const url of new Set([input.url, ...aliases])) this.db.prepare('INSERT INTO aliases(url,article_id) VALUES(?,?) ON CONFLICT(url) DO UPDATE SET article_id=excluded.article_id').run(url, id);
      return this.article(id)!;
    })();
  }
  findArticle(input: { biz: string; mid?: string; idx?: string; url: string }): ArticleDetail | undefined {
    const canonical = input.mid ? `${input.biz}:${input.mid}:${input.idx || '1'}` : null;
    const row = (canonical ? this.db.prepare('SELECT id FROM articles WHERE canonical=?').get(canonical) : undefined) as { id: string } | undefined;
    const alias = row ? undefined : this.db.prepare('SELECT article_id FROM aliases WHERE url=?').get(input.url) as { article_id: string } | undefined;
    return row || alias ? this.article(row?.id || alias!.article_id) : undefined;
  }
  private mergeArticles(keep: string, remove: string) {
    const kept = this.article(keep), removed = this.article(remove);
    if (!kept || !removed || kept.accountId !== removed.accountId) throw new Error('article_account_conflict');
    if (!kept.coverSource && removed.coverSource) this.setArticle(keep, { coverSource: removed.coverSource });
    if ((!kept.blocks.length || kept.status !== 'complete') && removed.blocks.length) {
      this.setArticle(keep, { blocks: removed.blocks, status: removed.status, imageCount: removed.imageCount, textLength: removed.textLength });
    }
    for (const asset of this.storedAssets(remove)) if (!this.storedAssets(keep).some(x => x.seq === asset.seq && x.status === 'complete')) this.saveAsset(keep, asset);
    this.db.prepare('UPDATE aliases SET article_id=? WHERE article_id=?').run(keep, remove);
    this.db.prepare('UPDATE job_items SET article_id=? WHERE article_id=?').run(keep, remove);
    this.db.prepare('DELETE FROM assets WHERE article_id=?').run(remove);
    this.db.prepare('DELETE FROM articles WHERE id=?').run(remove);
  }
  setArticle(id: string, patch: Partial<ArticleDetail>): ArticleDetail {
    const old = this.article(id);
    if (!old) throw new Error('article_not_found');
    this.db.prepare('UPDATE articles SET data=? WHERE id=?').run(JSON.stringify({ ...old, ...patch,
      coverSource: sanitizeCoverUrl(patch.coverSource) || old.coverSource, id, accountId: old.accountId, assets: [] }), id);
    return this.article(id)!;
  }
  storedAssets(id: string): StoredAsset[] { return this.db.prepare('SELECT data FROM assets WHERE article_id=? ORDER BY seq').all(id).map(row => decode<StoredAsset>(row)!); }
  saveAsset(id: string, asset: StoredAsset) { this.db.prepare('INSERT INTO assets(article_id,seq,data) VALUES(?,?,?) ON CONFLICT(article_id,seq) DO UPDATE SET data=excluded.data').run(id, asset.seq, JSON.stringify(asset)); }
  pruneAssets(id: string, seqs: number[]) { for (const asset of this.storedAssets(id)) if (!seqs.includes(asset.seq)) this.db.prepare('DELETE FROM assets WHERE article_id=? AND seq=?').run(id, asset.seq); }
  createJob(account: Account, kind: Job['kind'], articleIds: string[] = [], maxPages = 20, autoDownload = false, maxArticles?: number): StoredJob {
    return this.db.transaction(() => {
      const job: StoredJob = { id: randomUUID(), kind, accountId: account.id, accountName: account.name, status: 'queued', total: articleIds.length, completed: 0, failed: 0, progress: 0, message: '等待执行', createdAt: now(), updatedAt: now(), offset: 0, pages: 0, maxPages, pageBudget: maxPages, autoDownload, maxArticles, articleBudget: maxArticles };
      this.saveJob(job);
      articleIds.forEach((articleId, ordinal) => this.db.prepare('INSERT INTO job_items(job_id,ordinal,article_id,status) VALUES(?,?,?,?)').run(job.id, ordinal, articleId, 'pending'));
      return job;
    })();
  }
  job(id: string): StoredJob | undefined { return decode<StoredJob>(this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id)); }
  jobs(): StoredJob[] { return this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC').all().map(row => decode<StoredJob>(row)!); }
  hasActiveJobs(accountId?: string, kind?: Job['kind']): boolean {
    return Boolean((this.db.prepare("SELECT EXISTS(SELECT 1 FROM jobs WHERE json_extract(data,'$.status') IN ('running','queued') AND (? IS NULL OR account_id=?) AND (? IS NULL OR json_extract(data,'$.kind')=?)) AS present")
      .get(accountId ?? null, accountId ?? null, kind ?? null, kind ?? null) as { present: number }).present);
  }
  nextQueuedJob(): StoredJob | undefined { return decode<StoredJob>(this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status')='queued' ORDER BY rowid ASC LIMIT 1").get()); }
  openJobs(): StoredJob[] { return this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status') IS NOT 'completed' ORDER BY rowid DESC").all().map(row => decode<StoredJob>(row)!); }
  jobHistory(page: number, pageSize: number, focus?: string): { items: StoredJob[]; total: number; page: number; pageSize: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE json_extract(data,'$.status')='completed'").get() as { count: number }).count;
    if (focus) {
      const target = this.db.prepare("SELECT rowid FROM jobs WHERE id=? AND json_extract(data,'$.status')='completed'").get(focus) as { rowid: number } | undefined;
      if (target) {
        const newer = (this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE json_extract(data,'$.status')='completed' AND rowid>?").get(target.rowid) as { count: number }).count;
        page = Math.floor(newer / pageSize) + 1;
      }
    }
    const items = this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status')='completed' ORDER BY rowid DESC LIMIT ? OFFSET ?").all(pageSize, (page - 1) * pageSize).map(row => decode<StoredJob>(row)!);
    return { items, total, page, pageSize };
  }
  saveJob(job: StoredJob): StoredJob { const saved = { ...job, updatedAt: now() }; this.db.prepare('INSERT INTO jobs(id,account_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, job.accountId, JSON.stringify(saved)); return saved; }
  jobItems(id: string): JobItem[] { return (this.db.prepare('SELECT ordinal,article_id,status,error FROM job_items WHERE job_id=? ORDER BY ordinal').all(id) as { ordinal: number; article_id: string; status: JobItem['status']; error: string | null }[]).map(row => ({ ordinal: row.ordinal, articleId: row.article_id, status: row.status, error: row.error || undefined })); }
  setJobItem(id: string, ordinal: number, status: JobItem['status'], error?: string) { this.db.prepare('UPDATE job_items SET status=?,error=? WHERE job_id=? AND ordinal=?').run(status, error || null, id, ordinal); }
  summary(): Summary {
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM accounts) AS accountCount,
      (SELECT COUNT(*) FROM articles) AS articleCount,
      (SELECT COUNT(*) FROM articles WHERE json_extract(data,'$.status')='complete') AS archivedCount,
      (SELECT COUNT(*) FROM assets WHERE json_extract(data,'$.status')='complete') AS imageCount,
      (SELECT COUNT(*) FROM jobs WHERE json_extract(data,'$.status') IN ('queued','running')) AS activeJobs,
      (SELECT COUNT(*) FROM jobs WHERE json_extract(data,'$.status')='completed') AS completedJobsCount`).get() as Omit<Summary, 'connectionBlocked'>;
    return { ...counts, connectionBlocked: Boolean(this.gate) };
  }
}
