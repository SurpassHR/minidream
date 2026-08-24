import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DraftRecord {
  id: string;
  taskId?: string;
  kind: 'image' | 'video' | 'text';
  filename: string;
  path: string;
  mime?: string;
  size: number;
  createdAt: number;
}

export interface DraftStoreOptions {
  indexFile: string;
  outputDir: string;
}

export interface SaveDraftInput {
  taskId?: string;
  kind: DraftRecord['kind'];
  sourceName: string;
  mime?: string;
  data: Buffer;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
};

export function inferMimeType(filename: string, kind?: DraftRecord['kind']): string | undefined {
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const byExtension = MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  if (kind === 'video') return 'video/mp4';
  if (kind === 'image') return 'image/png';
  if (kind === 'text') return 'text/plain; charset=utf-8';
  return undefined;
}

function inferredMime(record: DraftRecord): string | undefined {
  return inferMimeType(record.filename, record.kind);
}

export class DraftStore {
  private readonly indexFile: string;
  private outputDir: string;
  private records: DraftRecord[];

  constructor(options: DraftStoreOptions) {
    if (!isAbsolute(options.outputDir)) {
      throw new Error('产物存储目录必须是绝对路径');
    }
    this.indexFile = options.indexFile;
    this.outputDir = options.outputDir;
    this.records = this.readIndex();
  }

  public setOutputDir(outputDir: string): void {
    if (!isAbsolute(outputDir)) {
      throw new Error('产物存储目录必须是绝对路径');
    }
    this.outputDir = outputDir;
    mkdirSync(this.outputDir, { recursive: true });
  }

  public list(): DraftRecord[] {
    return [...this.records].sort((a, b) => b.createdAt - a.createdAt);
  }

  public get(id: string): DraftRecord | undefined {
    return this.records.find(record => record.id === id);
  }

  public async saveFromBuffer(input: SaveDraftInput): Promise<DraftRecord> {
    mkdirSync(this.outputDir, { recursive: true });
    const sourceBase = basename(input.sourceName || 'output.bin');
    const extension = sourceBase.includes('.') ? sourceBase.slice(sourceBase.lastIndexOf('.')) : '';
    const id = `draft-${randomUUID().slice(0, 12)}`;
    const filename = `${id}${extension}`;
    const path = join(this.outputDir, filename);
    writeFileSync(path, input.data);

    const record: DraftRecord = {
      id,
      taskId: input.taskId,
      kind: input.kind,
      filename,
      path,
      mime: input.mime,
      size: input.data.byteLength,
      createdAt: Date.now(),
    };
    this.records.push(record);
    this.persist();
    return record;
  }

  public filePath(id: string): string | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    // 以当前 outputDir + filename 为准解析文件位置，而不是信任索引里存的绝对 path：
    // 项目目录迁移/改名后旧记录的绝对路径会失效，但文件通常已随目录一起移动。
    return join(this.outputDir, record.filename);
  }

  public contentType(id: string): string | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    // Some ComfyUI/custom executors omit the MIME or report octet-stream;
    // browsers need the real media type to decode video reliably.
    if (record.mime && !/^application\/octet-stream(?:;|$)/i.test(record.mime)) return record.mime;
    return inferredMime(record) ?? record.mime;
  }

  public isWritable(): boolean {
    try {
      mkdirSync(this.outputDir, { recursive: true });
      const probe = join(this.outputDir, `.write-test-${randomUUID()}`);
      writeFileSync(probe, '');
      unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  public delete(id: string): boolean {
    const index = this.records.findIndex(record => record.id === id);
    if (index < 0) return false;
    const [record] = this.records.splice(index, 1);
    // 与 filePath 一致：按当前 outputDir + filename 定位物理文件
    const file = record ? join(this.outputDir, record.filename) : undefined;
    if (file && existsSync(file)) {
      unlinkSync(file);
    }
    this.persist();
    return true;
  }

  private readIndex(): DraftRecord[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const data = JSON.parse(readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(data)
        ? data
          .filter(item => item && typeof item.id === 'string')
          .map(item => {
            const record = item as DraftRecord;
            const inferred = inferMimeType(record.filename);
            const kind = record.mime?.startsWith('video/') || inferred?.startsWith('video/')
              ? 'video'
              : record.mime?.startsWith('image/') || inferred?.startsWith('image/')
                ? 'image'
                : record.kind;
            return { ...record, kind } as DraftRecord;
          })
        : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.indexFile), { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
    renameSync(tmp, this.indexFile);
  }
}
