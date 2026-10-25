export type Connection = 'disconnected' | 'connected' | 'expired' | 'blocked';
export type UpdatePolicy = 'manual' | 'discover' | 'download';
export interface Coverage { count: number; oldest?: string; newest?: string; complete: boolean; stopReason?: string }
export interface Account {
  id: string; biz: string; name: string; connection: Connection;
  avatarSource?: string; avatarUrl?: string;
  articleCount: number; archivedCount: number; updatePolicy: UpdatePolicy; intervalMinutes: number;
  lastCheckedAt?: string; nextCheckAt?: string; coverage: Coverage;
}
export type ArticleStatus = 'discovered' | 'downloading' | 'partial' | 'complete' | 'unavailable';
export interface Article {
  id: string; accountId: string; biz: string; mid?: string; idx?: string; title: string; url: string;
  publishedAt: string; status: ArticleStatus; imageCount: number; savedImageCount: number;
  coverUrl?: string; coverSource?: string; textLength: number; error?: string;
}
export interface ArticlePage { items: Article[]; total: number; page: number; pageSize: number }
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; seq: number };
export interface Asset { seq: number; src: string; localUrl?: string; status: 'pending' | 'complete' | 'failed'; sha256?: string; bytes?: number }
export interface ArticleDetail extends Article { blocks: ContentBlock[]; assets: Asset[] }
export type JobStatus = 'queued' | 'running' | 'paused' | 'waiting_session' | 'blocked' | 'partial' | 'completed' | 'failed';
export interface Job {
  id: string; kind: 'archive' | 'discover'; accountId: string; accountName: string; status: JobStatus;
  total: number; completed: number; failed: number; progress: number; message: string;
  createdAt: string; updatedAt: string; coverage?: Coverage;
}
export interface JobPage { items: Job[]; total: number; page: number; pageSize: number }
export interface Summary { accountCount: number; articleCount: number; archivedCount: number; imageCount: number; activeJobs: number; completedJobsCount: number; connectionBlocked: boolean }
export interface ImportResult { accounts: number; articles: number; images: number; skipped: number; errors: string[] }
export interface AppSettings { imageDirectory: string; defaultImageDirectory: string; dataDirectory: string; canChooseDirectory: boolean }
export interface SettingsUpdateResult { settings: AppSettings; migratedImages: number; warnings: string[] }
export interface AppInfo { name: string; version: string; description: string }
export interface Session { biz: string; uin: string; key: string; passTicket: string }
export interface DiscoveredArticle { url: string; title: string; publishedAt: string; coverUrl?: string; biz?: string; mid?: string; idx?: string }
export interface ParsedArticle {
  biz: string; mid: string; idx: string; title: string; account: string; publishedAt: string; url: string;
  avatarUrl?: string;
  blocks: ContentBlock[]; images: { seq: number; src: string }[]; textLength: number;
}
export interface Collector {
  fetchArticle(url: string, signal?: AbortSignal): Promise<ParsedArticle>;
  fetchImage(url: string, referer: string, signal?: AbortSignal): Promise<{ buffer: Buffer; ext: string; mime: string; sha256: string }>;
  fetchCover?(url: string, referer: string, signal?: AbortSignal): Promise<{ buffer: Buffer; ext: string; mime: string; sha256: string }>;
  captureSession(biz: string): Promise<void>;
  hasSession(biz: string): boolean;
  getGate(): string | null;
  clearGate(): void;
  discoverPage(biz: string, offset: number, signal?: AbortSignal): Promise<{ entries: DiscoveredArticle[]; nextOffset: number; canContinue: boolean }>;
}
