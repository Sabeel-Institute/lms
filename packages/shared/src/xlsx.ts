import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * A small `.xlsx` writer: the subset of the format the two export workbooks
 * need, and nothing else.
 *
 * WRITTEN HERE RATHER THAN TAKEN FROM A LIBRARY, for two reasons. The only
 * library that does merged group headers, frozen panes, filters, number and
 * date formats AND cell fills is a megabyte that has never been asked to run
 * under Metro on Android; the ones that bundle cleanly stop at merges. And a
 * workbook is a zip of eleven small XML files — the whole writer is shorter
 * than the type definitions it would replace, it runs identically in a
 * browser, on a phone and in a unit test, and a test can unzip its output and
 * read every cell back with a regex.
 *
 * What it does: one style table (fonts, fills, borders, number formats), any
 * number of sheets, inline strings (no shared-string table to keep in step),
 * real numbers, real dates (Excel serials with a date format, so they sort),
 * percentages (numbers with `0%`), merged cells, frozen header rows, an
 * autofilter row, column widths. What it does not do: formulas, charts,
 * anything a reader would not notice.
 */

/** A named look. The table below turns each into a `cellXfs` index. */
export type CellStyle =
  | 'text'
  | 'bold'
  | 'title'
  | 'group'
  | 'head'
  | 'int'
  | 'pct'
  | 'date'
  | 'datetime'
  | 'missed'
  | 'open'
  | 'good'
  | 'dim'
  | 'note'
  | 'missedInt'
  | 'openInt'
  /** A number as written, halves and all: a grade in points. */
  | 'num';

export interface Cell {
  /** Text, a number, a date, or nothing. */
  v: string | number | Date | null;
  style?: CellStyle;
}

export interface SheetSpec {
  /** At most 31 characters, no `[]:*?/\` — Excel refuses the file otherwise. */
  name: string;
  /** Column widths in characters, by column index. */
  widths?: number[];
  rows: Cell[][];
  /** Rows (from the top) and columns (from the left) kept in view. */
  freeze?: { rows: number; cols: number };
  /** The header row the filter buttons sit on (1-based), spanning every column
   *  of the widest row beneath it. */
  filterRow?: number;
  /** Merged ranges, 0-based, inclusive. */
  merges?: { r1: number; c1: number; r2: number; c2: number }[];
}

export interface WorkbookSpec {
  sheets: SheetSpec[];
}

// ------------------------------------------------------------------ styles --

/*
 * The brand's palette, at the strengths the proposal drew: head and group rows
 * in two ivories, a missed cell in raspberry-tinted rose with dark red text,
 * an open cell in a gold wash, a completed cell in sage. Excel takes ARGB.
 */
const FILL_HEAD = 'FFEFE3D2';
const FILL_GROUP = 'FFE7D8C3';
const FILL_MISSED = 'FFF3E1DD';
const FILL_OPEN = 'FFF6EFD9';
const FILL_GOOD = 'FFE4E9DC';
const INK = 'FF3A2F28';
const SECONDARY = 'FF6A5748';
const TAUPE = 'FFA58D7A';
const MISSED = 'FF8A2A2A';
const SAGE_DEEP = 'FF5E6E52';
const RASPBERRY = 'FF83114F';

/** Fonts, by index, as `styles.xml` lists them. */
const FONTS = [
  { color: INK, bold: false, size: 11 }, // 0 body
  { color: INK, bold: true, size: 11 }, // 1 bold
  { color: RASPBERRY, bold: true, size: 14 }, // 2 title
  { color: SECONDARY, bold: false, size: 11 }, // 3 secondary
  { color: TAUPE, bold: false, size: 11 }, // 4 dim
  { color: MISSED, bold: true, size: 11 }, // 5 missed
  { color: SAGE_DEEP, bold: false, size: 11 }, // 6 good
];

/** Fills, by index. 0 and 1 are the two Excel requires first. */
const FILLS = ['none', 'gray125', FILL_HEAD, FILL_GROUP, FILL_MISSED, FILL_OPEN, FILL_GOOD];

/** Custom number formats, from 164 up as the spec requires. */
const NUM_FMTS: Record<string, number> = { date: 164, datetime: 165 };
const NUM_FMT_XML =
  `<numFmts count="2">` +
  `<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>` +
  `<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/>` +
  `</numFmts>`;

interface Xf {
  font: number;
  fill: number;
  numFmt: number;
  align?: 'center' | 'right';
  wrap?: boolean;
  border?: boolean;
}

/** The style table: each `CellStyle` is an index into this, in this order. */
const XFS: { name: CellStyle; xf: Xf }[] = [
  { name: 'text', xf: { font: 0, fill: 0, numFmt: 0, border: true } },
  { name: 'bold', xf: { font: 1, fill: 0, numFmt: 0, border: true } },
  { name: 'title', xf: { font: 2, fill: 0, numFmt: 0 } },
  { name: 'group', xf: { font: 1, fill: 3, numFmt: 0, align: 'center', border: true } },
  { name: 'head', xf: { font: 1, fill: 2, numFmt: 0, border: true, wrap: true } },
  { name: 'int', xf: { font: 0, fill: 0, numFmt: 1, align: 'right', border: true } },
  { name: 'pct', xf: { font: 0, fill: 0, numFmt: 9, align: 'right', border: true } },
  { name: 'date', xf: { font: 0, fill: 0, numFmt: NUM_FMTS.date, border: true } },
  { name: 'datetime', xf: { font: 0, fill: 0, numFmt: NUM_FMTS.datetime, border: true } },
  { name: 'missed', xf: { font: 5, fill: 4, numFmt: 0, border: true } },
  { name: 'open', xf: { font: 0, fill: 5, numFmt: 0, border: true } },
  { name: 'good', xf: { font: 6, fill: 6, numFmt: 0, border: true } },
  { name: 'dim', xf: { font: 4, fill: 0, numFmt: 0, border: true } },
  { name: 'note', xf: { font: 3, fill: 0, numFmt: 0, wrap: true, border: true } },
  { name: 'missedInt', xf: { font: 5, fill: 4, numFmt: 1, align: 'right', border: true } },
  { name: 'openInt', xf: { font: 0, fill: 5, numFmt: 1, align: 'right', border: true } },
  { name: 'num', xf: { font: 0, fill: 0, numFmt: 0, align: 'right', border: true } },
];
const XF_INDEX = new Map(XFS.map((x, i) => [x.name, i]));

function stylesXml(): string {
  const fonts = FONTS.map(
    (f) =>
      `<font>${f.bold ? '<b/>' : ''}<sz val="${f.size}"/><color rgb="${f.color}"/><name val="Calibri"/><family val="2"/></font>`,
  ).join('');
  const fills = FILLS.map((f) =>
    f === 'none' || f === 'gray125'
      ? `<fill><patternFill patternType="${f}"/></fill>`
      : `<fill><patternFill patternType="solid"><fgColor rgb="${f}"/><bgColor indexed="64"/></patternFill></fill>`,
  ).join('');
  const line = `<left style="thin"><color rgb="FFD9CDBF"/></left><right style="thin"><color rgb="FFD9CDBF"/></right><top style="thin"><color rgb="FFD9CDBF"/></top><bottom style="thin"><color rgb="FFD9CDBF"/></bottom>`;
  const borders = `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${line}<diagonal/></border></borders>`;
  const xfs = XFS.map(({ xf }) => {
    const align =
      xf.align || xf.wrap
        ? `<alignment${xf.align ? ` horizontal="${xf.align}"` : ''}${xf.wrap ? ' wrapText="1"' : ''} vertical="center"/>`
        : '';
    return (
      `<xf numFmtId="${xf.numFmt}" fontId="${xf.font}" fillId="${xf.fill}" borderId="${xf.border ? 1 : 0}" xfId="0"` +
      `${xf.numFmt ? ' applyNumberFormat="1"' : ''} applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1"' : ''}>` +
      `${align}</xf>`
    );
  }).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    NUM_FMT_XML +
    `<fonts count="${FONTS.length}">${fonts}</fonts>` +
    `<fills count="${FILLS.length}">${fills}</fills>` +
    borders +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${XFS.length}">${xfs}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

// ------------------------------------------------------------------- cells --

// XML 1.0 forbids these code points outright; Excel refuses the file if one
// is in a cell (a title pasted from a PDF can carry a form feed): the C0
// controls but tab, newline and return, and the noncharacters U+FFFE and
// U+FFFF. A surrogate with no partner needs nothing here: the encoder writes
// it as U+FFFD.
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g;

/** The most a cell may hold: past it Excel calls the file corrupt and "repairs" it. */
export const MAX_CELL_CHARS = 32_767;

/** Text as a cell may hold it: cut short, and said to be, past Excel's limit. */
const cellText = (s: string) => (s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS - 1)}…` : s);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(XML_FORBIDDEN, '');
}

/** `A`, `B`, … `Z`, `AA`, … — the column letters a reader knows. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * An Excel date serial: days since 1899-12-30, in the date's own calendar
 * fields, so a stamp taken in the institute's zone stays on the day it says.
 * Excel has no time zone; the caller hands over local-looking fields.
 */
export function excelSerial(d: Date): number {
  const utcDays = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000;
  const dayFraction =
    (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86_400;
  return utcDays + 25_569 + dayFraction;
}

function cellXml(cell: Cell, r: number, c: number): string {
  const ref = `${columnLetter(c)}${r + 1}`;
  const style = XF_INDEX.get(cell.style ?? 'text') ?? 0;
  const s = ` s="${style}"`;
  if (cell.v === null || cell.v === undefined || cell.v === '') return `<c r="${ref}"${s}/>`;
  if (cell.v instanceof Date) return `<c r="${ref}"${s}><v>${excelSerial(cell.v)}</v></c>`;
  if (typeof cell.v === 'number') return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cellText(cell.v))}</t></is></c>`;
}

function sheetXml(sheet: SheetSpec): string {
  const width = sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';
  const rows = sheet.rows
    .map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => cellXml(cell, r, c)).join('')}</row>`)
    .join('');
  let views = '';
  if (sheet.freeze && (sheet.freeze.rows > 0 || sheet.freeze.cols > 0)) {
    const { rows: fr, cols: fc } = sheet.freeze;
    const topLeft = `${columnLetter(fc)}${fr + 1}`;
    const pane = fr > 0 && fc > 0 ? 'bottomRight' : fr > 0 ? 'bottomLeft' : 'topRight';
    views =
      `<sheetViews><sheetView workbookViewId="0">` +
      `<pane${fc > 0 ? ` xSplit="${fc}"` : ''}${fr > 0 ? ` ySplit="${fr}"` : ''} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/>` +
      `</sheetView></sheetViews>`;
  }
  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges
        .map((m) => `<mergeCell ref="${columnLetter(m.c1)}${m.r1 + 1}:${columnLetter(m.c2)}${m.r2 + 1}"/>`)
        .join('')}</mergeCells>`
    : '';
  const filter =
    sheet.filterRow && width > 0 && sheet.rows.length >= sheet.filterRow
      ? `<autoFilter ref="A${sheet.filterRow}:${columnLetter(width - 1)}${sheet.rows.length}"/>`
      : '';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    views +
    cols +
    `<sheetData>${rows}</sheetData>` +
    // Order matters to Excel: autoFilter before mergeCells.
    filter +
    merges +
    `</worksheet>`
  );
}

/** A sheet name Excel accepts: 31 characters, none of the forbidden ones. */
export function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
}

// ---------------------------------------------------------------- package --

export function buildXlsx(workbook: WorkbookSpec): Uint8Array {
  const sheets = workbook.sheets.map((s, i) => ({ ...s, name: sheetName(s.name), id: i + 1 }));
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets
        .map(
          (s) =>
            `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      `</Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  // The filter needs a defined name too, or Excel shows the buttons without
  // remembering the range.
  const definedNames = sheets
    .map((s, i) => {
      if (!s.filterRow) return '';
      const width = s.rows.reduce((w, row) => Math.max(w, row.length), 0);
      if (!width || s.rows.length < s.filterRow) return '';
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(s.name).replace(/'/g, "''")}'!$A$${s.filterRow}:$${columnLetter(width - 1)}$${s.rows.length}</definedName>`;
    })
    .join('');
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheets.map((s) => `<sheet name="${escapeXml(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join('')}</sheets>` +
      (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
      `</workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (s) =>
            `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(stylesXml());
  for (const s of sheets) files[`xl/worksheets/sheet${s.id}.xml`] = strToU8(sheetXml(s));
  return zipSync(files, { level: 6 });
}

/**
 * A filename the share sheet and every filesystem accept. Not `#` or `%`
 * either: on a phone the file is handed over as a URI, where `#` starts a
 * fragment and `%` an escape, and "Arabic #2" went out as "Arabic " with no
 * extension.
 */
export function workbookFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|#%\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
  return `${safe || 'export'}.xlsx`;
}

/**
 * Read back what `buildXlsx` wrote — sheet names and cell text — so a test,
 * unit or browser, can open the file it downloaded and check a cell. Not a
 * general reader: it understands inline strings and plain values, which is
 * all this writer emits, and returns numbers as their decimal text.
 */
export function readXlsx(bytes: Uint8Array): { name: string; rows: string[][] }[] {
  const files = unzipSync(bytes);
  const workbook = strFromU8(files['xl/workbook.xml']);
  const sheets = [...workbook.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"/g)].map((m) => ({
    name: m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'),
    id: m[2],
  }));
  return sheets.map(({ name, id }) => {
    const xml = strFromU8(files[`xl/worksheets/sheet${id}.xml`]);
    const rows: string[][] = [];
    // `s` flags throughout: a grid header carries a newline in its text, and
    // a reader that skipped that row would hide the header it is there to check.
    for (const row of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
      const cells: string[] = [];
      for (const cell of row[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/gs)) {
        const text = cell[2]?.match(/<t[^>]*>(.*?)<\/t>/s)?.[1] ?? cell[2]?.match(/<v>(.*?)<\/v>/s)?.[1] ?? '';
        cells.push(text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
      }
      rows.push(cells);
    }
    return { name, rows };
  });
}
