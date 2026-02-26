/**
 * In-memory circular (ring) buffer for raw audio data.
 *
 * Layout:
 *   _buf  — fixed-size backing store
 *   _writePos — next byte position to write into
 *   _readPos  — next byte position to read from
 *   _available — how many bytes are currently readable
 *
 * When the buffer is full a write overwrites the oldest data and advances
 * _readPos so that the invariant (_available <= _capacity) always holds.
 *
 * All operations are O(1) amortised (Buffer.copy is a native mem-copy).
 */
export class RingBuffer {
  private readonly _buf: Buffer;
  private readonly _capacity: number;
  private _writePos: number = 0;
  private _readPos: number = 0;
  private _available: number = 0;

  /**
   * @param sizeKB - Capacity of the ring buffer in kilobytes
   */
  constructor(sizeKB: number) {
    if (sizeKB <= 0 || !Number.isInteger(sizeKB)) {
      throw new RangeError(`sizeKB must be a positive integer, got ${sizeKB}`);
    }
    this._capacity = sizeKB * 1024;
    this._buf = Buffer.allocUnsafe(this._capacity);
  }

  /** Total capacity in bytes. */
  get capacity(): number {
    return this._capacity;
  }

  /** Number of bytes currently available to read. */
  get available(): number {
    return this._available;
  }

  /**
   * Writes audio data into the ring buffer.
   * If the incoming chunk is larger than the total capacity, only the last
   * `capacity` bytes of `data` are kept (older audio is discarded).
   * If writing would overflow the remaining space, the oldest readable bytes
   * are overwritten and _readPos is advanced accordingly.
   *
   * @param data - Audio chunk to append
   */
  write(data: Buffer): void {
    if (data.length === 0) return;

    let src = data;
    if (src.length > this._capacity) {
      // Keep only the tail — discard bytes that would overwrite themselves
      src = src.subarray(src.length - this._capacity);
    }

    const len = src.length;
    const firstChunk = Math.min(len, this._capacity - this._writePos);
    src.copy(this._buf, this._writePos, 0, firstChunk);

    if (firstChunk < len) {
      // Wrap around to the start of the buffer
      src.copy(this._buf, 0, firstChunk, len);
    }

    // Advance write pointer
    this._writePos = (this._writePos + len) % this._capacity;

    // Update available; clamp at capacity and fix up the read pointer
    const newAvailable = this._available + len;
    if (newAvailable > this._capacity) {
      const overwritten = newAvailable - this._capacity;
      this._readPos = (this._readPos + overwritten) % this._capacity;
      this._available = this._capacity;
    } else {
      this._available = newAvailable;
    }
  }

  /**
   * Reads up to `bytes` bytes from the ring buffer.
   * Returns null when the buffer is empty, otherwise returns a new Buffer
   * containing the requested data (or fewer bytes if less is available).
   *
   * @param bytes - Maximum number of bytes to read
   * @returns Buffer with data, or null if no data is available
   */
  read(bytes: number): Buffer | null {
    if (this._available === 0) return null;

    const toRead = Math.min(bytes, this._available);
    const out = Buffer.allocUnsafe(toRead);

    const firstChunk = Math.min(toRead, this._capacity - this._readPos);
    this._buf.copy(out, 0, this._readPos, this._readPos + firstChunk);

    if (firstChunk < toRead) {
      // Wrap around
      this._buf.copy(out, firstChunk, 0, toRead - firstChunk);
    }

    this._readPos = (this._readPos + toRead) % this._capacity;
    this._available -= toRead;

    return out;
  }

  /**
   * Resets the ring buffer to an empty state without reallocating memory.
   */
  clear(): void {
    this._writePos = 0;
    this._readPos = 0;
    this._available = 0;
  }
}
