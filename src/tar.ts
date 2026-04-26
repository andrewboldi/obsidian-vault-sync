// Minimal streaming tar parser for the POSIX ustar format produced by GitHub.
// Yields { name, type, content } entries from a ReadableStream<Uint8Array>.
// No dependencies. Browser-safe.
//
// Tar layout (USTAR):
//   bytes  0–100   filename (NUL-terminated, may overflow into prefix)
//   bytes 100–108  mode
//   bytes 108–116  uid
//   bytes 116–124  gid
//   bytes 124–136  size in octal ASCII (NUL-terminated)
//   bytes 136–148  mtime
//   bytes 148–156  checksum
//   byte  156      typeflag ('0' or '\0' = file, '5' = dir, others ignored v1)
//   bytes 157–257  linkname
//   bytes 257–263  ustar magic ("ustar\0")
//   bytes 265–297  uname
//   bytes 297–329  gname
//   bytes 329–337  devmajor
//   bytes 337–345  devminor
//   bytes 345–500  prefix (prepended to name with "/" if non-empty)
// Header is 512 bytes; data follows, padded up to a 512-byte boundary.
// End of archive = two consecutive 512-byte zero blocks.

export interface TarEntry {
    name: string;
    type: "file" | "dir";
    content: Uint8Array; // empty for dir
}

const BLOCK = 512;

function readCString(buf: Uint8Array, off: number, len: number): string {
    let end = off;
    const lim = off + len;
    while (end < lim && buf[end] !== 0) end++;
    return new TextDecoder("utf-8").decode(buf.subarray(off, end));
}

function parseOctal(buf: Uint8Array, off: number, len: number): number {
    // Trim trailing NUL/space; ignore leading spaces.
    let s = "";
    for (let i = off; i < off + len; i++) {
        const c = buf[i];
        if (c === 0 || c === 0x20) {
            if (s.length > 0) break;
            continue;
        }
        s += String.fromCharCode(c);
    }
    if (!s) return 0;
    return parseInt(s, 8) | 0;
}

function isAllZero(buf: Uint8Array, off: number, len: number): boolean {
    for (let i = off; i < off + len; i++) if (buf[i] !== 0) return false;
    return true;
}

/**
 * A small append-only buffer that lets us peek at the head and shift consumed
 * bytes without copying everything every time. We grow by doubling and shift
 * down only when the consumed prefix exceeds half the buffer.
 */
class ChunkBuffer {
    private buf: Uint8Array = new Uint8Array(0);
    private start = 0; // first valid byte
    private end = 0;   // one past last valid byte

    get length(): number {
        return this.end - this.start;
    }

    push(chunk: Uint8Array): void {
        const need = this.length + chunk.length;
        if (need > this.buf.length - this.start) {
            // Either grow or shift to make room.
            if (this.start > 0 && need <= this.buf.length) {
                this.buf.copyWithin(0, this.start, this.end);
                this.end -= this.start;
                this.start = 0;
            } else {
                let cap = Math.max(this.buf.length * 2, 64 * 1024);
                while (cap < need) cap *= 2;
                const next = new Uint8Array(cap);
                next.set(this.buf.subarray(this.start, this.end), 0);
                this.end -= this.start;
                this.start = 0;
                this.buf = next;
            }
        }
        this.buf.set(chunk, this.end);
        this.end += chunk.length;
    }

    /** Returns a view of the next `n` bytes without consuming. Caller must ensure length >= n. */
    peek(n: number): Uint8Array {
        return this.buf.subarray(this.start, this.start + n);
    }

    /** Consume `n` bytes, returning a copy (safe to keep). */
    take(n: number): Uint8Array {
        const out = this.buf.slice(this.start, this.start + n);
        this.start += n;
        if (this.start > this.buf.length / 2) {
            // Compact occasionally to bound memory.
            this.buf.copyWithin(0, this.start, this.end);
            this.end -= this.start;
            this.start = 0;
        }
        return out;
    }

    /** Discard `n` bytes (e.g. padding). */
    skip(n: number): void {
        this.start += n;
        if (this.start > this.buf.length / 2) {
            this.buf.copyWithin(0, this.start, this.end);
            this.end -= this.start;
            this.start = 0;
        }
    }
}

/**
 * Parse a tar stream and yield entries. The stream is assumed uncompressed
 * (gzip decompression must happen upstream via DecompressionStream).
 */
export async function* parseTar(
    stream: ReadableStream<Uint8Array>
): AsyncGenerator<TarEntry, void, void> {
    const reader = stream.getReader();
    const buf = new ChunkBuffer();
    let zeroBlocks = 0;
    let done = false;

    async function fillTo(n: number): Promise<boolean> {
        while (buf.length < n) {
            if (done) return false;
            const { value, done: d } = await reader.read();
            if (d) {
                done = true;
                return buf.length >= n;
            }
            if (value && value.length) buf.push(value);
        }
        return true;
    }

    while (true) {
        if (!(await fillTo(BLOCK))) break;

        const header = buf.peek(BLOCK);
        if (isAllZero(header, 0, BLOCK)) {
            buf.skip(BLOCK);
            zeroBlocks++;
            if (zeroBlocks >= 2) break; // end-of-archive marker
            continue;
        }
        zeroBlocks = 0;

        const namePart = readCString(header, 0, 100);
        const size = parseOctal(header, 124, 12);
        const typeflagByte = header[156];
        const typeflag = typeflagByte === 0 ? "0" : String.fromCharCode(typeflagByte);

        // ustar prefix for long names.
        const ustar = readCString(header, 257, 6);
        let prefix = "";
        if (ustar === "ustar" || ustar.startsWith("ustar")) {
            prefix = readCString(header, 345, 155);
        }
        const name = prefix ? `${prefix}/${namePart}` : namePart;

        buf.skip(BLOCK); // header consumed

        const padded = size > 0 ? Math.ceil(size / BLOCK) * BLOCK : 0;

        // Skip non-file/dir entries (long-link records, symlinks, etc.).
        if (typeflag !== "0" && typeflag !== "5" && typeflag !== "\0") {
            // Drain the data + padding without keeping it.
            let remaining = padded;
            while (remaining > 0) {
                if (!(await fillTo(Math.min(remaining, BLOCK)))) {
                    return; // truncated
                }
                const take = Math.min(remaining, buf.length);
                buf.skip(take);
                remaining -= take;
            }
            continue;
        }

        if (typeflag === "5") {
            // Directory entry — no data, but padded is 0 anyway.
            yield { name, type: "dir", content: new Uint8Array(0) };
            continue;
        }

        // File entry: read `size` bytes (and skip padding to next block boundary).
        if (!(await fillTo(padded))) {
            // Truncated file — best-effort: yield what we have, then stop.
            const have = Math.min(buf.length, size);
            yield { name, type: "file", content: buf.take(have) };
            return;
        }
        const content = buf.take(size);
        if (padded > size) buf.skip(padded - size);
        yield { name, type: "file", content };
    }
}
