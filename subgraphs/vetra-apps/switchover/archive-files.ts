import { createZstdDecompress } from "node:zlib";
import type { Readable } from "node:stream";

/** A kept key is 64 characters; anything this size or bigger is not one. */
export const MAX_FILE_BYTES = 64 * 1024;

const BLOCK = 512;

const text = (b: Buffer, from: number, len: number) => {
  const end = b.indexOf(0, from);
  return b.toString(
    "utf8",
    from,
    end >= 0 && end < from + len ? end : from + len,
  );
};

const octal = (b: Buffer, from: number, len: number) => {
  const raw = text(b, from, len).trim();
  return raw === "" ? 0 : Number.parseInt(raw, 8);
};

const normalise = (name: string) =>
  name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");

/** `path=` of a pax extended header ("<len> <key>=<value>\n" records). */
function paxPath(data: Buffer): string | null {
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) return null;
    const len = Number.parseInt(data.toString("utf8", i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) return null;
    const rec = data.toString("utf8", sp + 1, i + len - 1);
    if (rec.startsWith("path=")) return rec.slice(5);
    i += len;
  }
  return null;
}

/**
 * Reads the named regular files out of a tar.zst stream in memory: the bytes
 * of those files are the only thing kept, nothing touches the disk, and the
 * stream is destroyed as soon as every name was found. A file bigger than
 * MAX_FILE_BYTES or a damaged archive throws (the message never contains
 * file content). Names match as stored with any leading "./" removed.
 */
export async function readFilesFromTarZst(
  source: Readable,
  names: string[],
): Promise<Map<string, Buffer>> {
  const wanted = new Set(names.map(normalise));
  const found = new Map<string, Buffer>();
  const zstd = createZstdDecompress();
  const stream = source.pipe(zstd);
  source.on("error", (err) => zstd.destroy(err));
  let buf: Buffer = Buffer.alloc(0);
  // Bytes of the current entry still to skip (data + padding).
  let skip = 0;
  let pending: { name: string | null; want: boolean; size: number } | null =
    null;
  let longName: string | null = null;
  let paxName: string | null = null;
  const done = () => found.size === wanted.size;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          buf = buf.subarray(n);
          skip -= n;
          if (skip > 0) break;
        }
        if (pending) {
          const padded = Math.ceil(pending.size / BLOCK) * BLOCK;
          if (buf.length < padded) break;
          const data = buf.subarray(0, pending.size);
          const p = pending;
          pending = null;
          buf = buf.subarray(padded);
          if (p.name === "L") longName = text(data, 0, data.length);
          else if (p.name === "x") paxName = paxPath(data);
          else if (p.want) found.set(p.name!, Buffer.from(data));
          if (done()) return found;
          continue;
        }
        if (buf.length < BLOCK) break;
        const header = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (header.every((x) => x === 0)) continue;
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const prefix = text(header, 345, 155);
        const stored = text(header, 0, 100);
        const name = normalise(
          longName ?? paxName ?? (prefix ? `${prefix}/${stored}` : stored),
        );
        if (type === "L" || type === "x") {
          pending = { name: type, want: false, size };
          continue;
        }
        longName = null;
        paxName = null;
        const regular = type === "0" || type === "\0";
        if (regular && wanted.has(name) && !found.has(name)) {
          if (size > MAX_FILE_BYTES)
            throw new Error(
              `${name} in the archive is ${size} bytes, too big to be a kept key`,
            );
          pending = { name, want: true, size };
        } else {
          skip = Math.ceil(size / BLOCK) * BLOCK;
        }
      }
    }
  } finally {
    zstd.destroy();
    source.destroy();
  }
  return found;
}
