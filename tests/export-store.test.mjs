import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportFile } from '../export-store.mjs';

test('file output preserves byte order across buffered MP3 packets and direct PCM blocks', () => {
  const writes = [];
  const sink = new ExportFile(null, {
    write(bytes, { at }) {
      writes.push({ at, bytes: bytes.slice() });
      return bytes.byteLength;
    },
  });
  const parts = [
    new Uint8Array(44).fill(11),
    new Uint8Array(200000).fill(22),
    new Uint8Array(120000).fill(33),
    new Uint8Array(300000).fill(44),
    new Uint8Array(77).fill(55),
  ];
  for (const part of parts) sink.append(part);
  sink.flushBuffer();
  let offset = 0;
  for (const write of writes) {
    assert.equal(write.at, offset);
    offset += write.bytes.length;
  }
  assert.deepEqual(Buffer.concat(writes.map((write) => write.bytes)), Buffer.concat(parts));
  assert.equal(sink.buffer.byteLength, 256 * 1024);
});

test('short disk writes fail before acknowledging an incomplete encoded block', () => {
  const sink = new ExportFile(null, {
    write(bytes) {
      return bytes.byteLength - 1;
    },
  });
  assert.throws(() => sink.append(new Uint8Array(300000)), /寫入不完整/);
  assert.equal(sink.position, 0);
});
