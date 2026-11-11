export const CHUNK_SIZE = 64 * 1024;
export const MAX_IN_MEMORY_FILE_SIZE = 256 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 100;

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export interface QueueFileMeta extends FileMeta {
  id: string;
}

export type QueueItemStatus = 'pending' | 'active' | 'done' | 'error';

export interface TransferQueueItem extends QueueFileMeta {
  status: QueueItemStatus;
  transferred: number;
  error?: string;
}

export interface ReceivedFile {
  meta: FileMeta;
  savedName: string;
  blob?: Blob;
  savedToDisk: boolean;
}

export interface TransferStats {
  bytes: number;
  total: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export type ConnectionRoute = 'unknown' | 'lan' | 'direct' | 'turn' | 'failed';

export type ControlMessage =
  | { type: 'batch-meta'; batchId: string; files: QueueFileMeta[] }
  | { type: 'batch-accept'; batchId: string }
  | { type: 'batch-reject'; batchId: string; reason: string }
  | { type: 'file-meta'; batchId: string; fileId: string; index: number; meta: FileMeta }
  | { type: 'file-accept'; fileId: string }
  | { type: 'file-credit'; fileId: string; credits: number }
  | { type: 'file-complete'; fileId: string; size: number }
  | { type: 'file-ack'; fileId: string }
  | { type: 'file-cancel'; fileId: string; reason: string }
  | { type: 'file-error'; fileId: string; reason: string }
  | { type: 'batch-pause'; batchId: string }
  | { type: 'batch-resume'; batchId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function isFileMeta(value: unknown): value is FileMeta {
  if (!isRecord(value)) return false;
  const name = asString(value.name);
  const size = asNumber(value.size);
  const type = asString(value.type);
  return name !== null && name.length > 0 && name.length <= 255
    && size !== null && size >= 0 && Number.isSafeInteger(size)
    && type !== null && type.length <= 128;
}

function isQueueFileMeta(value: unknown): value is QueueFileMeta {
  return isRecord(value) && isIdentifier(value.id) && isFileMeta(value);
}

export function parseControl(raw: string): ControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'batch-meta': {
      const batchId = asString(value.batchId);
      if (!isIdentifier(batchId) || !Array.isArray(value.files)) return null;
      if (value.files.length < 1 || value.files.length > MAX_FILES_PER_BATCH) return null;
      const files = value.files.filter(isQueueFileMeta);
      if (files.length !== value.files.length) return null;
      if (new Set(files.map((file) => file.id)).size !== files.length) return null;
      return { type: value.type, batchId, files };
    }
    case 'batch-accept':
    case 'batch-pause':
    case 'batch-resume': {
      const batchId = asString(value.batchId);
      return isIdentifier(batchId) ? { type: value.type, batchId } : null;
    }
    case 'batch-reject': {
      const batchId = asString(value.batchId);
      return isIdentifier(batchId)
        ? { type: value.type, batchId, reason: asString(value.reason) || '接收方拒绝接收' }
        : null;
    }
    case 'file-meta': {
      const batchId = asString(value.batchId);
      const fileId = asString(value.fileId);
      const index = asNumber(value.index);
      if (!isIdentifier(batchId) || !isIdentifier(fileId) || index === null || !Number.isInteger(index) || index < 0) return null;
      if (!isFileMeta(value.meta)) return null;
      return { type: value.type, batchId, fileId, index, meta: value.meta };
    }
    case 'file-accept':
    case 'file-ack': {
      const fileId = asString(value.fileId);
      return isIdentifier(fileId) ? { type: value.type, fileId } : null;
    }
    case 'file-credit': {
      const fileId = asString(value.fileId);
      const credits = asNumber(value.credits);
      if (!isIdentifier(fileId) || credits === null || !Number.isInteger(credits) || credits < 1 || credits > 64) return null;
      return { type: value.type, fileId, credits };
    }
    case 'file-complete': {
      const fileId = asString(value.fileId);
      const size = asNumber(value.size);
      if (!isIdentifier(fileId) || size === null || size < 0 || !Number.isSafeInteger(size)) return null;
      return { type: value.type, fileId, size };
    }
    case 'file-cancel':
    case 'file-error': {
      const fileId = asString(value.fileId);
      if (!isIdentifier(fileId)) return null;
      return { type: value.type, fileId, reason: asString(value.reason) || '文件传输失败' };
    }
    default:
      return null;
  }
}

export function createTransferId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function sanitizeFileName(name: string): string {
  const sanitized = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/^\.+$/, '');
  return (sanitized || 'download').slice(0, 255);
}

export function makeUniqueFileNames(files: FileMeta[]): string[] {
  const counts = new Map<string, number>();
  return files.map((file) => {
    const base = sanitizeFileName(file.name);
    const seen = counts.get(base) || 0;
    counts.set(base, seen + 1);
    if (seen === 0) return base;
    const dot = base.lastIndexOf('.');
    return dot > 0
      ? `${base.slice(0, dot)} (${seen})${base.slice(dot)}`
      : `${base} (${seen})`;
  });
}

export function fileMetaOf(file: File): FileMeta {
  return { name: file.name, size: file.size, type: file.type };
}