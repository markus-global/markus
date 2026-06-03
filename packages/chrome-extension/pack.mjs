/**
 * Pack the Chrome extension into a zip file ready for distribution.
 * Includes only the files needed to load the extension in Chrome.
 *
 * Output: dist/markus-browser-extension.zip
 */
import { createWriteStream, readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeflateRaw } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'dist', 'markus-browser-extension.zip');

const FILES = [
  'manifest.json',
  'popup.html',
  'popup.js',
  'dist/background.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// Verify all files exist
for (const f of FILES) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`Missing file: ${f}. Run "pnpm run build" first.`);
    process.exit(1);
  }
}

// Minimal zip writer (no external deps)
class ZipWriter {
  constructor(outPath) {
    this.entries = [];
    this.stream = createWriteStream(outPath);
    this.offset = 0;
  }

  async addFile(archivePath, content) {
    const header = Buffer.alloc(30);
    const nameBytes = Buffer.from(archivePath, 'utf8');
    const compressed = await this._deflate(content);
    const crc = this._crc32(content);

    // Local file header
    header.writeUInt32LE(0x04034b50, 0);  // signature
    header.writeUInt16LE(20, 4);           // version needed
    header.writeUInt16LE(0, 6);            // flags
    header.writeUInt16LE(8, 8);            // compression: deflate
    header.writeUInt16LE(0, 10);           // mod time
    header.writeUInt16LE(0, 12);           // mod date
    header.writeUInt32LE(crc, 14);         // crc-32
    header.writeUInt32LE(compressed.length, 18); // compressed size
    header.writeUInt32LE(content.length, 22);    // uncompressed size
    header.writeUInt16LE(nameBytes.length, 26);  // filename length
    header.writeUInt16LE(0, 28);           // extra field length

    const localOffset = this.offset;
    this._write(header);
    this._write(nameBytes);
    this._write(compressed);

    this.entries.push({ archivePath, nameBytes, crc, compressedSize: compressed.length, uncompressedSize: content.length, localOffset });
  }

  finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);   // signature
      cdh.writeUInt16LE(20, 4);            // version made by
      cdh.writeUInt16LE(20, 6);            // version needed
      cdh.writeUInt16LE(0, 8);             // flags
      cdh.writeUInt16LE(8, 10);            // compression
      cdh.writeUInt16LE(0, 12);            // time
      cdh.writeUInt16LE(0, 14);            // date
      cdh.writeUInt32LE(e.crc, 16);
      cdh.writeUInt32LE(e.compressedSize, 20);
      cdh.writeUInt32LE(e.uncompressedSize, 24);
      cdh.writeUInt16LE(e.nameBytes.length, 28);
      cdh.writeUInt16LE(0, 30);            // extra
      cdh.writeUInt16LE(0, 32);            // comment
      cdh.writeUInt16LE(0, 34);            // disk
      cdh.writeUInt16LE(0, 36);            // internal attrs
      cdh.writeUInt32LE(0, 38);            // external attrs
      cdh.writeUInt32LE(e.localOffset, 42);
      this._write(cdh);
      this._write(e.nameBytes);
    }
    const cdSize = this.offset - cdStart;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    this._write(eocd);
    this.stream.end();
  }

  _write(buf) {
    this.stream.write(buf);
    this.offset += buf.length;
  }

  _deflate(data) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const deflater = createDeflateRaw();
      deflater.on('data', c => chunks.push(c));
      deflater.on('end', () => resolve(Buffer.concat(chunks)));
      deflater.on('error', reject);
      deflater.end(data);
    });
  }

  _crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
}

const zip = new ZipWriter(OUT);
for (const f of FILES) {
  const content = readFileSync(join(ROOT, f));
  await zip.addFile(f, content);
}
zip.finish();

const size = statSync(OUT).size;
console.log(`Packed ${FILES.length} files → ${OUT} (${(size / 1024).toFixed(1)} KB)`);
