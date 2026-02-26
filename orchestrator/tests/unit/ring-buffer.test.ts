import { describe, it, expect, beforeEach } from 'vitest';
import { RingBuffer } from '../../src/audio/ring-buffer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBuffer(bytes: number, fill = 0xab): Buffer {
  return Buffer.alloc(bytes, fill);
}

function sequentialBuffer(length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) {
    buf[i] = i % 256;
  }
  return buf;
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('RingBuffer — constructor', () => {
  it('creates a buffer with the correct capacity in bytes', () => {
    const rb = new RingBuffer(4); // 4 KB
    expect(rb.capacity).toBe(4 * 1024);
  });

  it('starts with zero bytes available', () => {
    const rb = new RingBuffer(1);
    expect(rb.available).toBe(0);
  });

  it('throws RangeError when sizeKB is zero', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });

  it('throws RangeError when sizeKB is negative', () => {
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
  });
});

// ── Write / Read ──────────────────────────────────────────────────────────────

describe('RingBuffer — write and read', () => {
  let rb: RingBuffer;

  beforeEach(() => {
    rb = new RingBuffer(1); // 1 KB = 1024 bytes
  });

  it('write then read returns the same data', () => {
    const src = makeBuffer(64, 0x42);
    rb.write(src);
    const out = rb.read(64);
    expect(out).not.toBeNull();
    expect(out).toEqual(src);
  });

  it('available reflects written bytes before reading', () => {
    rb.write(makeBuffer(100));
    expect(rb.available).toBe(100);
  });

  it('available decreases after reading', () => {
    rb.write(makeBuffer(200));
    rb.read(80);
    expect(rb.available).toBe(120);
  });

  it('read returns null when buffer is empty', () => {
    expect(rb.read(10)).toBeNull();
  });

  it('read returns fewer bytes when less data is available than requested', () => {
    rb.write(makeBuffer(10, 0x01));
    const out = rb.read(500);
    expect(out).not.toBeNull();
    expect(out!.byteLength).toBe(10);
  });

  it('preserves byte-level data integrity for sequential values', () => {
    const src = sequentialBuffer(256);
    rb.write(src);
    const out = rb.read(256);
    expect(out).toEqual(src);
  });
});

// ── Circular (wrap-around) behaviour ─────────────────────────────────────────

describe('RingBuffer — circular behaviour', () => {
  it('overwrites oldest data when the buffer is full', () => {
    // 1 KB ring buffer; fill it completely then write 100 more bytes
    const rb = new RingBuffer(1);
    const capacity = rb.capacity; // 1024

    // Fill to capacity with 0xAA; writePos=0, readPos=0, available=1024
    rb.write(makeBuffer(capacity, 0xaa));
    expect(rb.available).toBe(capacity);

    // Write 100 bytes of 0xBB — the oldest 100 bytes are evicted.
    // After write: writePos=100, readPos=100, available=1024 (still full)
    rb.write(makeBuffer(100, 0xbb));
    expect(rb.available).toBe(capacity); // still full

    // Read order starting at readPos=100:
    //   bytes [100..1023] → 924 bytes of 0xAA  (the surviving old data)
    //   bytes [0..99]     → 100 bytes of 0xBB  (the newly written data)
    const out = rb.read(capacity);
    expect(out).not.toBeNull();
    expect(out!.subarray(0, 924).every((b) => b === 0xaa)).toBe(true);
    expect(out!.subarray(924).every((b) => b === 0xbb)).toBe(true);
  });

  it('handles multiple write-wrap cycles without data corruption', () => {
    const rb = new RingBuffer(1); // 1024 bytes
    const chunk = sequentialBuffer(300);

    // Write three 300-byte chunks; total 900 bytes — fits in 1024
    rb.write(chunk);
    rb.write(chunk);
    rb.write(chunk);

    // Read 900 bytes; each 300-byte segment must match the source chunk
    const out = rb.read(900);
    expect(out).not.toBeNull();
    for (let seg = 0; seg < 3; seg++) {
      const slice = out!.subarray(seg * 300, (seg + 1) * 300);
      expect(slice).toEqual(chunk);
    }
  });

  it('write pointer wraps and subsequent reads are correct', () => {
    const rb = new RingBuffer(1); // 1024 bytes
    const half = 512;

    // Write half, read half — write pointer is at 512, read pointer at 512 but available=0
    rb.write(makeBuffer(half, 0x01));
    rb.read(half);
    expect(rb.available).toBe(0);

    // Write 600 bytes — this wraps past the end of the backing store
    const src = makeBuffer(600, 0x02);
    rb.write(src);
    expect(rb.available).toBe(600);

    const out = rb.read(600);
    expect(out).toEqual(src);
  });

  it('a single write larger than capacity keeps only the last capacity bytes', () => {
    const rb = new RingBuffer(1); // 1024 bytes
    const oversized = sequentialBuffer(2048); // 2× capacity
    rb.write(oversized);
    expect(rb.available).toBe(rb.capacity);

    const out = rb.read(rb.capacity);
    // Should equal the last 1024 bytes of oversized
    expect(out).toEqual(oversized.subarray(1024));
  });
});

// ── Clear ─────────────────────────────────────────────────────────────────────

describe('RingBuffer — clear', () => {
  it('clear resets available to zero', () => {
    const rb = new RingBuffer(1);
    rb.write(makeBuffer(256));
    rb.clear();
    expect(rb.available).toBe(0);
  });

  it('read returns null after clear', () => {
    const rb = new RingBuffer(1);
    rb.write(makeBuffer(256));
    rb.clear();
    expect(rb.read(10)).toBeNull();
  });

  it('buffer can be used normally after clear', () => {
    const rb = new RingBuffer(1);
    rb.write(makeBuffer(256, 0xff));
    rb.clear();

    const fresh = makeBuffer(64, 0x77);
    rb.write(fresh);
    expect(rb.available).toBe(64);
    expect(rb.read(64)).toEqual(fresh);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('RingBuffer — edge cases', () => {
  it('write of empty buffer is a no-op', () => {
    const rb = new RingBuffer(1);
    rb.write(Buffer.alloc(0));
    expect(rb.available).toBe(0);
  });

  it('read of 0 bytes returns an empty Buffer', () => {
    const rb = new RingBuffer(1);
    rb.write(makeBuffer(10));
    const out = rb.read(0);
    // 0 bytes requested but buffer has data — returns empty Buffer (not null)
    expect(out).not.toBeNull();
    expect(out!.byteLength).toBe(0);
    expect(rb.available).toBe(10); // nothing consumed
  });
});
