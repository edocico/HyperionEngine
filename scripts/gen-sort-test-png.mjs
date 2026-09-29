#!/usr/bin/env node
// scripts/gen-sort-test-png.mjs — writes ts/public/textures/sort-test-128.png,
// the texture of the transparent-sort scene in the 2D Twins tab (design
// 2026-09-27 §7.3.3): 128 × 128 RGBA, four semi-transparent coloured
// quadrants. A 128-px image lands in tier 1 (an overflow tier on a BC7/ASTC
// device), so every sprite that uses it fills an odd gather region
// (15 + 2 × type). Node built-ins only; run it from anywhere:
//   node scripts/gen-sort-test-png.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
/** RGBA of the quadrants: top-left, top-right, bottom-left, bottom-right. */
const QUADRANTS = [
  [230, 60, 60, 160],
  [60, 200, 90, 160],
  [60, 110, 230, 160],
  [240, 200, 50, 160],
];

/** length, type, data, CRC-32 of type + data (PNG spec §5.3). */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

// Scanlines: filter byte 0 (none), then RGBA per pixel.
const stride = 1 + SIZE * 4;
const raw = Buffer.alloc(SIZE * stride);
for (let y = 0; y < SIZE; y++) {
  raw[y * stride] = 0;
  for (let x = 0; x < SIZE; x++) {
    const quadrant = (y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1);
    raw.set(QUADRANTS[quadrant], y * stride + 1 + x * 4);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); // width
ihdr.writeUInt32BE(SIZE, 4); // height
ihdr[8] = 8; // bits per channel
ihdr[9] = 6; // colour type: RGBA
// bytes 10-12 stay 0: deflate, adaptive filtering, no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'ts', 'public', 'textures', 'sort-test-128.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
