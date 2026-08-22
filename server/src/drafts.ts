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
    return this.get(id)?.path;
  }

  public contentType(id: string): string | undefined {
    return this.get(id)?.mime;
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
    if (record && existsSync(record.path)) {
      unlinkSync(record.path);
    }
    this.persist();
    return true;
  }

  private readIndex(): DraftRecord[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const data = JSON.parse(readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(data) ? data.filter(item => item && typeof item.id === 'string') : [];
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
