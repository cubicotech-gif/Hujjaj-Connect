// Billoo Travels hujjaj list parser.
//
// Source format (Excel + printed/photo'd version) always uses these columns:
//   SR-NO | BOOKED BY | Passenger Name | MAK HTL | PKG CODE | MED HTL | MOBIL NO
// With an optional banner row above containing "BUS NO - 01", train info, etc.
//
// For XLSX we parse columns directly. For text (paste / PDF / OCR) we strip
// known noise tokens around the phone number so only the name remains.

export type ParsedRow = {
  sel: boolean;
  name: string;
  phone: string;
  hotel: string;
  grp: string;
  bus: string;
  notes: string;
};

// Two-to-three letter agent / booked-by codes seen in the sheets.
const BOOKED_BY = new Set([
  "AB", "HS", "QB", "FR", "OR", "OB", "FA", "JA", "IIS", "IHS",
  "IH", "BL", "SB", "QR", "QO", "OQ",
]);

// Madinah-side hotels. Single tokens, scanned case-insensitively.
const MED_HOTELS = [
  "DAR AL TAQWA", "ANWAR AL MADINAH", "MADINAH HILTON", "MOVENPICK MADINAH",
  "TAQWA", "TAIBAH", "ANWAR", "MOVENPICK", "PULLMAN",
];

// Makkah-side hotels. Order matters — longest first so "SWISSOTEL MAKKAH"
// matches before "SWISSOTEL".
const MAK_HOTELS = [
  "SWISSOTEL MAKKAH", "SWISSOTEL MAQAM", "FAIRMOUNT CLOCK", "FAIRMONT CLOCK",
  "PULLMAN ZAMZAM", "HILTON MAKKAH", "CONRAD MAKKAH", "MOVENPICK MAKKAH",
  "JABAL OMAR", "CLOCK TOWER", "SWISS MAQAM", "SWISS MAKAM",
  "SWISSOTEL", "FAIRMOUNT", "FAIRMONT", "AZIZIYA", "AZIZIA",
  "SOFITEL", "RAFFLES",
].sort((a, b) => b.length - a.length);

// PKG codes: UB-004-A, UHS-15-B, UB 023 A, etc.
const PKG_RE = /\bU[BH][SAB]?[\s\-_]?\d{1,3}[\s\-_]?[A-Z]?\b/i;

// Matches a phone-like blob anywhere in a line. We validate digit count
// in extractPhone() — banner rows like "1130 1345" (train times) must not
// be misread as phones.
const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/;

function extractPhone(line: string): { phone: string; idx: number; len: number } | null {
  let from = 0;
  while (from < line.length) {
    const m = line.slice(from).match(PHONE_RE);
    if (!m || m.index == null) return null;
    const start = from + m.index;
    const digits = m[1].replace(/\D/g, "");
    const hasPlus = m[1].trim().startsWith("+");
    if (digits.length >= 10 || (hasPlus && digits.length >= 8)) {
      return { phone: hasPlus ? "+" + digits : digits, idx: start, len: m[0].length };
    }
    from = start + m[0].length;
  }
  return null;
}

// "BUS NO - 01" / "BUS NO: 1" / "BUS#03"
const BUS_RE = /BUS\s*(?:NO|#)?\s*[-:#]?\s*(\d{1,3})/i;

function stripFirstMatch(s: string, re: RegExp): { out: string; hit: string } {
  const m = s.match(re);
  if (!m || m.index == null) return { out: s, hit: "" };
  return {
    out: (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(),
    hit: m[0],
  };
}

function stripKeyword(s: string, kw: string): { out: string; hit: string } {
  const up = s.toUpperCase();
  const i = up.indexOf(kw);
  if (i < 0) return { out: s, hit: "" };
  return {
    out: (s.slice(0, i) + " " + s.slice(i + kw.length)).replace(/\s+/g, " ").trim(),
    hit: kw,
  };
}

export function detectBus(text: string): string {
  const m = text.match(BUS_RE);
  return m ? String(parseInt(m[1], 10)).padStart(2, "0") : "";
}

// Per-line parser for paste / OCR / PDF text. Strips noise around the phone.
function parseLine(raw: string, busHint: string): ParsedRow | null {
  // Normalise separators that OCR loves to insert
  let s = raw
    .replace(/[|\[\]{}]+/g, " ")
    .replace(/[─━–—]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;

  // 1) Phone (anchor) — must have ≥10 digits (or ≥8 with leading +)
  const ph = extractPhone(s);
  if (!ph) return null;
  const phone = ph.phone;
  s = (s.slice(0, ph.idx) + " " + s.slice(ph.idx + ph.len))
    .replace(/\s+/g, " ")
    .trim();

  // 2) PKG CODE
  const pkg = stripFirstMatch(s, PKG_RE);
  s = pkg.out;
  const grp = pkg.hit ? pkg.hit.toUpperCase().replace(/[\s_]+/g, "-") : "";

  // 3) MED HTL (longest match first)
  let medHtl = "";
  for (const h of MED_HOTELS) {
    const r = stripKeyword(s, h);
    if (r.hit) {
      medHtl = r.hit;
      s = r.out;
      break;
    }
  }

  // 4) MAK HTL
  let hotel = "";
  for (const h of MAK_HOTELS) {
    const r = stripKeyword(s, h);
    if (r.hit) {
      hotel = r.hit;
      s = r.out;
      break;
    }
  }

  // 5) Leading SR-NO (1-3 digits)
  s = s.replace(/^\s*\d{1,3}\b[.\-)]?\s*/, "").trim();

  // 6) Leading BOOKED BY (2-3 letter uppercase token from known set)
  const toks = s.split(/\s+/);
  while (toks.length > 1 && /^[A-Z]{2,3}$/.test(toks[0]) && BOOKED_BY.has(toks[0])) {
    toks.shift();
  }

  // 7) Trim trailing stray punctuation / single letters left by OCR ("h", ",", "-")
  let name = toks.join(" ").replace(/[\s,;\-|]+$/, "").trim();
  name = name.replace(/\s+\b[A-Za-z]\b$/, "").trim(); // dangling single letter
  name = name.replace(/\s{2,}/g, " ");

  if (!name && !phone) return null;

  return {
    sel: true,
    name: name || "(no name)",
    phone,
    hotel: titleCase(hotel),
    grp,
    bus: busHint,
    notes: medHtl ? `MED: ${titleCase(medHtl)}` : "",
  };
}

function titleCase(s: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parseBilooText(text: string): { rows: ParsedRow[]; bus: string } {
  const bus = detectBus(text);
  const rows: ParsedRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const r = parseLine(line, bus);
    if (r) rows.push(r);
  }
  return { rows, bus };
}

// XLSX parser — uses read-excel-file (lazy-loaded by caller).
// `sheets` is an array of [sheetName, rows[][]] from readXlsxFile.
type Cell = string | number | Date | boolean | null;
type SheetData = { name: string; rows: Cell[][] };

function norm(v: Cell): string {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

function findHeaderRow(rows: Cell[][]): { idx: number; map: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i] || [];
    const map: Record<string, number> = {};
    row.forEach((cell, j) => {
      const s = norm(cell).toUpperCase().replace(/\s+/g, " ");
      if (!s) return;
      if (s.includes("PASSENGER NAME") || s === "NAME") map.name = j;
      else if (s.includes("MOBIL") || s.includes("PHONE") || s === "CELL") map.phone = j;
      else if (s.includes("MAK HTL") || s.includes("MAKKAH HOTEL") || s.includes("MAK HOTEL"))
        map.hotel = j;
      else if (s.includes("MED HTL") || s.includes("MADINA HTL") || s.includes("MADINAH HTL") || s.includes("MEDINA HOTEL"))
        map.medhtl = j;
      else if (s.includes("PKG") || s.includes("PACKAGE")) map.pkg = j;
      else if (s.includes("SR-NO") || s.includes("SR NO") || s.includes("S.NO") || s === "SR")
        map.sr = j;
      else if (s.includes("BOOKED")) map.bookedby = j;
      else if (s.includes("ROOM")) map.room = j;
    });
    if (map.name != null && map.phone != null) return { idx: i, map };
  }
  return null;
}

export function parseBilooSheets(sheets: SheetData[]): { rows: ParsedRow[]; bus: string } {
  const out: ParsedRow[] = [];
  let globalBus = "";

  for (const sheet of sheets) {
    const header = findHeaderRow(sheet.rows);
    if (!header) continue;

    // Bus number can live in the banner rows above the header
    let bus = "";
    for (let i = 0; i < header.idx; i++) {
      for (const cell of sheet.rows[i] || []) {
        const b = detectBus(norm(cell));
        if (b) { bus = b; break; }
      }
      if (bus) break;
    }
    if (!globalBus && bus) globalBus = bus;

    const { map } = header;
    for (let i = header.idx + 1; i < sheet.rows.length; i++) {
      const row = sheet.rows[i] || [];
      const name = norm(row[map.name]);
      const phoneRaw = norm(row[map.phone]);
      if (!phoneRaw) continue;
      const ph = extractPhone(phoneRaw);
      if (!ph) continue; // skip "NA", blanks, etc.

      out.push({
        sel: true,
        name: name || "(no name)",
        phone: ph.phone,
        hotel: titleCase(norm(row[map.hotel ?? -1])),
        grp: norm(row[map.pkg ?? -1]).toUpperCase().replace(/[\s_]+/g, "-"),
        bus,
        notes: map.medhtl != null && norm(row[map.medhtl])
          ? `MED: ${titleCase(norm(row[map.medhtl]))}`
          : "",
      });
    }
  }

  return { rows: out, bus: globalBus };
}
