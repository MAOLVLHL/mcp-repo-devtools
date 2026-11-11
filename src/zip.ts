/**
 * Minimal ZIP reader. GitHub serves Actions job logs as a redirect to a zip
 * archive and Node ships no unzip, so this parses the central directory and
 * inflates each entry with node:zlib. Only the two compression methods the
 * API actually uses are supported; anything else is skipped rather than thrown.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const MAX_ENTRIES = 512;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const EOCD_MIN_SIZE = 22;

export interface ZipEntry {
  name: string;
  text: string;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - (EOCD_MIN_SIZE + 0xffff));
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/**
 * Extract every entry as UTF-8 text, in archive order. Returns an empty array
 * for anything that is not a zip we understand; callers treat that as "no log".
 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < EOCD_MIN_SIZE) {
    return [];
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    return [];
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0 || entryCount > MAX_ENTRIES || directoryOffset >= buffer.length) {
    return [];
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  let budget = MAX_UNCOMPRESSED_BYTES;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      break;
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nextCursor = nameStart + nameLength + extraLength + commentLength;

    if (nameStart + nameLength > buffer.length || nextCursor > buffer.length) {
      break;
    }
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    cursor = nextCursor;

    if (uncompressedSize > budget || localOffset + 30 > buffer.length) {
      continue;
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      continue;
    }
    const raw = buffer.subarray(dataStart, dataEnd);

    let text: string;
    if (method === METHOD_STORED) {
      text = raw.toString("utf8");
    } else if (method === METHOD_DEFLATED) {
      try {
        text = inflateRawSync(raw, { maxOutputLength: uncompressedSize + 1024 }).toString("utf8");
      } catch {
        continue;
      }
    } else {
      continue;
    }

    budget -= Math.min(uncompressedSize, budget);
    entries.push({ name, text });
    if (budget <= 0) {
      break;
    }
  }

  return entries;
}

/**
 * Decode whatever GitHub served for a job log. The logs endpoint redirects to
 * either a zip archive or, since 2026, plain text with a BOM and CRLF endings;
 * both shapes reach the model as one string.
 */
export function decodeLogArchive(buffer: Buffer): string {
  const isZip = buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;
  if (isZip) {
    const entries = readZipEntries(buffer);
    if (entries.length > 0) {
      return entries.map((entry) => entry.text).join("\n");
    }
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}
