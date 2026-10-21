import { crc32 } from 'node:zlib';
import { buildXlsx } from '@sabeel/shared';

/**
 * Office files for the attachment tests, built in memory under the repo's
 * "never add a binary" rule. The server decides a document's type from its
 * leading bytes and, for the Office Open XML family, from the parts its zip
 * holds, so each sample is the same structure the real application writes.
 */

/** A zip whose entries are stored uncompressed, in the order given. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const path = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, path, data);
    central.push(entry, path);
    offset += local.length + path.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A one-paragraph Word document: the three parts Word needs to open one. */
export const WORD = zip({
  '[Content_Types].xml':
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
  '_rels/.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>',
  'word/document.xml':
    `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    '<w:body><w:p><w:r><w:t>Week 2 notes</w:t></w:r></w:p></w:body></w:document>',
});

/** A register as the app itself exports one, which a teacher may attach. */
export const SPREADSHEET = buildXlsx({ sheets: [{ name: 'Register', rows: [[{ v: 'Aminah' }, { v: 'Present' }]] }] });

/**
 * The 512-byte header every Office 97-2003 file (.doc, .xls, .ppt) begins
 * with, a compound file. The server reads no further than its signature, so
 * the header alone takes the same path a full Word 97 file does.
 */
export const OFFICE_97 = (() => {
  const header = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x003e, 24); // minor version
  header.writeUInt16LE(0x0003, 26); // major version 3: 512-byte sectors
  header.writeUInt16LE(0xfffe, 28); // little-endian
  header.writeUInt16LE(9, 30); // sector size 2^9
  header.writeUInt16LE(6, 32); // mini sector size 2^6
  return new Uint8Array(header);
})();
