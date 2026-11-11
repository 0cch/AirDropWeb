import { describe, expect, it } from 'vitest';
import { extractToken, makeUniqueFileNames, parseControl, sanitizeFileName } from '../lib/transferProtocol';

describe('parseControl', () => {
  it('rejects malformed control messages', () => {
    expect(parseControl('null')).toBeNull();
    expect(parseControl('{"type":"batch-accept"}')).toBeNull();
    expect(parseControl('{"type":"file-credit","fileId":"x","credits":0}')).toBeNull();
    expect(parseControl('{"type":"file-credit","fileId":"x","credits":65}')).toBeNull();
  });

  it('validates batches and file metadata', () => {
    expect(parseControl(JSON.stringify({
      type: 'batch-meta',
      batchId: 'batch-1',
      files: [{ id: 'file-1', name: 'demo.txt', size: 12, type: 'text/plain' }]
    }))).toMatchObject({ type: 'batch-meta', batchId: 'batch-1' });

    expect(parseControl(JSON.stringify({
      type: 'file-meta',
      batchId: 'batch-1',
      fileId: 'file-1',
      index: 0,
      meta: { name: 'demo.txt', size: 12, type: 'text/plain' }
    }))).toMatchObject({ type: 'file-meta', fileId: 'file-1', index: 0 });

    expect(parseControl(JSON.stringify({
      type: 'file-meta',
      batchId: 'batch-1',
      fileId: 'file-1',
      index: 0,
      meta: { name: 'demo.txt', size: -1, type: 'text/plain' }
    }))).toBeNull();
  });

  it('parses flow control and pause messages', () => {
    expect(parseControl('{"type":"file-credit","fileId":"x","credits":4}')).toEqual({
      type: 'file-credit',
      fileId: 'x',
      credits: 4
    });
    expect(parseControl('{"type":"file-complete","fileId":"x","size":1024}')).toEqual({
      type: 'file-complete',
      fileId: 'x',
      size: 1024
    });
    expect(parseControl('{"type":"batch-pause","batchId":"batch-1"}')).toEqual({
      type: 'batch-pause',
      batchId: 'batch-1'
    });
    expect(parseControl('{"type":"resume-state","batchId":"batch-1","fileId":"file-1","offset":4096}')).toEqual({
      type: 'resume-state',
      batchId: 'batch-1',
      fileId: 'file-1',
      offset: 4096
    });
    expect(parseControl('{"type":"resume-state","batchId":"batch-1","fileId":"file-1","offset":-1}')).toBeNull();
  });
});

describe('file name safety', () => {
  it('removes path separators and produces unique names', () => {
    expect(sanitizeFileName('../../evil/file.txt')).toBe('.._.._evil_file.txt');
    expect(makeUniqueFileNames([
      { name: 'photo.jpg', size: 1, type: 'image/jpeg' },
      { name: 'photo.jpg', size: 1, type: 'image/jpeg' }
    ])).toEqual(['photo.jpg', 'photo (1).jpg']);
  });

  it('extracts tokens from manual input and shared links', () => {
    expect(extractToken('ABCD2345')).toBe('ABCD2345');
    expect(extractToken('https://example.com/?token=ABCD2345')).toBe('ABCD2345');
    expect(extractToken('https://example.com/?token=invalid')).toBeNull();
  });
});
