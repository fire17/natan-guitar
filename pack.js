/* Guitar — .hsong pack reader. Self-contained, no dependencies: window.GuitarPack in the page, module.exports in node
   (guitar/tools/test_pack.js).
   A .hsong is a plain zip: every entry STORED, pack.json first, sizes in the local headers (tools/make-pack.sh). The
   checks mirror the Android importer (SongPacks.kt / PackZip.kt), all before anything is used:
   - the first local header is pack.json (else: not a song pack at all);
   - the end record sits at the very end (no comment) and its central directory checks out: STORED, compressed size =
     size, the local header's name = the directory's, data inside the file, no duplicate names;
   - pack.json: CRC, format 1, id [a-z0-9-], 1..4000 files, each a safe relative path listed once with bytes + sha256,
     song.json listed;
   - every entry: a safe path, not a symlink / directory, and one it may have (pack.json, a listed song file, user.json,
     takes/<take>/<file>); every listed file present (a pack holding only the user's part has no song: refused);
   - every entry: size = listed, CRC32, and sha256 for the song files.
   Nothing is extracted: an entry is a byte range of the file (a Blob slice in the page). minApp is Android's version
   gate and is not checked here. */
(function (root) {
  'use strict';

  const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
  const FORMAT = 1, MAX_PACK_JSON = 2 << 20, MAX_FILES = 4000, MAX_FILE_BYTES = 256 * 1048576, MAX_CD = 64 << 20;
  const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const SEG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  const HEX64 = /^[0-9a-f]{64}$/;
  const TAKE_FILE = /^takes\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

  const MSG = {
    notpack: 'הקובץ הזה אינו קובץ שיר (‎.hsong‎).',
    corrupt: 'הקובץ פגום או לא שלם. כדאי להוריד או לשלוח אותו שוב.',
    unsafe: 'הקובץ מכיל נתיבים לא בטוחים, לכן לא נפתח.',
    format: 'הקובץ בפורמט שהגרסה הזו לא מכירה.',
    nosong: 'בקובץ הזה אין שיר (רק הקלטות והגדרות).',
    io: 'לא הצלחתי לקרוא את הקובץ.',
  };
  class PackError extends Error {
    constructor(code, why) { super(MSG[code] || MSG.corrupt); this.code = code; this.why = why || code; }
  }
  const fail = (code, why) => { throw new PackError(code, why); };

  /** Relative path of plain segments: no leading "/", no "..", ".", empty segment, backslash or colon. */
  function safePath(p) {
    if (typeof p !== 'string' || !p || p.length > 512 || p[0] === '/' || p.includes('\\') || p.includes(':')) return false;
    return p.split('/').every((s) => s !== '.' && s !== '..' && SEG.test(s));
  }
  const isUser = (name) => name === 'user.json' || name.startsWith('takes/');

  let CRC_T = null;
  function crc32(bytes, c) {
    if (!CRC_T) {
      CRC_T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let x = n; for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1; CRC_T[n] = x >>> 0; }
    }
    c = (c === undefined ? 0 : c) ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function sha256hex(bytes) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) fail('io', 'no crypto.subtle (open the page over http://localhost, not file://)');
    const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
    let s = ''; for (let i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16);
    return s;
  }
  const utf8 = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b);

  /** A byte source over a Blob / File: { size, name, read(off, len) -> Promise<Uint8Array> }. */
  function fromBlob(blob) {
    return {
      size: blob.size, name: blob.name || '',
      read: async (off, len) => new Uint8Array(await blob.slice(off, off + len).arrayBuffer()),
      blob: (off, len, type) => blob.slice(off, off + len, type),
    };
  }

  /** Opens and fully verifies a pack. src: a byte source (fromBlob, or { size, read } in node). opts.progress(done, total)
   *  is called while hashing. Resolves to { pack, id, title, artist, entries: Map(name -> entry), has, bytes, text, json,
   *  blob }; rejects with a PackError (code: notpack | corrupt | unsafe | format | nosong | io). */
  async function open(src, opts) {
    opts = opts || {};
    const size = src.size;
    const rd = async (off, len) => {
      if (off < 0 || len < 0 || off + len > size) fail('corrupt', 'range');
      let b; try { b = await src.read(off, len); } catch (e) { fail('io', String(e && e.message)); }
      if (!b || b.length !== len) fail('corrupt', 'short read');
      return b;
    };
    const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

    // the first bytes: a local header whose name is pack.json
    if (size < 39) fail('notpack', 'too small');
    const h = await rd(0, 39), hv = dv(h);
    if (hv.getUint32(0, true) !== SIG_LOCAL || hv.getUint16(26, true) !== 9 || String.fromCharCode(...h.subarray(30, 39)) !== 'pack.json') fail('notpack', 'first entry');

    // the end record (no comment, one disk) and its central directory
    const e = dv(await rd(size - 22, 22));
    if (e.getUint32(0, true) !== SIG_END || e.getUint16(4, true) || e.getUint16(6, true) || e.getUint16(20, true)) fail('corrupt', 'end record');
    const n = e.getUint16(10, true), cdSize = e.getUint32(12, true), cdOff = e.getUint32(16, true);
    if (e.getUint16(8, true) !== n || cdOff + cdSize !== size - 22) fail('corrupt', 'end fields');
    if (cdSize > MAX_CD) fail('corrupt', 'central directory too big');
    const cdb = await rd(cdOff, cdSize), cd = dv(cdb);
    const entries = new Map();
    let i = 0;
    for (let k = 0; k < n; k++) {
      if (i + 46 > cdSize || cd.getUint32(i, true) !== SIG_CENTRAL) fail('corrupt', 'central entry');
      const host = cd.getUint16(i + 4, true) >> 8, method = cd.getUint16(i + 10, true), crc = cd.getUint32(i + 16, true);
      const cs = cd.getUint32(i + 20, true), us = cd.getUint32(i + 24, true);
      const nl = cd.getUint16(i + 28, true), el = cd.getUint16(i + 30, true), cl = cd.getUint16(i + 32, true);
      const ext = cd.getUint32(i + 38, true), lo = cd.getUint32(i + 42, true);
      if (method !== 0 || cs !== us) fail('corrupt', 'not stored');
      if (i + 46 + nl > cdSize) fail('corrupt', 'central name');
      const nb = cdb.subarray(i + 46, i + 46 + nl);
      let name; try { name = utf8(nb); } catch (x) { fail('unsafe', 'name encoding'); }
      if (lo + 30 > cdOff) fail('corrupt', 'local offset');
      const lh = await rd(lo, 30 + nl), lv = dv(lh);
      if (lv.getUint32(0, true) !== SIG_LOCAL || lv.getUint16(26, true) !== nl || lv.getUint16(8, true) !== 0) fail('corrupt', 'local header');
      for (let j = 0; j < nl; j++) if (lh[30 + j] !== nb[j]) fail('corrupt', 'local name differs');
      const dataOff = lo + 30 + nl + lv.getUint16(28, true);
      if (dataOff + cs > cdOff) fail('corrupt', 'data range');
      if (entries.has(name)) fail('corrupt', 'duplicate name');
      // a symlink or a directory: unix mode in the external attributes, the DOS directory bit, or a "/" name
      const mode = (ext >>> 16) & 0xf000;
      const special = name.endsWith('/') || (ext & 0x10) !== 0 || (host === 3 && (mode === 0xa000 || mode === 0x4000));
      entries.set(name, { name, localOff: lo, dataOff, size: cs, crc, special });
      i += 46 + nl + el + cl;
    }
    if (i !== cdSize) fail('corrupt', 'central directory size');

    // pack.json
    const pjE = entries.get('pack.json');
    if (!pjE || pjE.localOff !== 0) fail('notpack', 'pack.json');
    if (pjE.size > MAX_PACK_JSON) fail('corrupt', 'pack.json too big');
    const pj = await rd(pjE.dataOff, pjE.size);
    if (crc32(pj) !== pjE.crc) fail('corrupt', 'pack.json crc');
    let pack; try { pack = JSON.parse(utf8(pj)); } catch (x) { fail('corrupt', 'pack.json'); }
    if (!pack || typeof pack !== 'object') fail('corrupt', 'pack.json');
    if (pack.format !== FORMAT) fail('format', 'format ' + pack.format);
    const id = pack.id;
    if (typeof id !== 'string' || !ID.test(id)) fail('corrupt', 'id');
    const arr = pack.files;
    if (!Array.isArray(arr) || !arr.length || arr.length > MAX_FILES) fail('corrupt', 'files');
    const want = new Map();
    for (const f of arr) {
      if (!f || typeof f !== 'object') fail('corrupt', 'file entry');
      const p = f.path, b = f.bytes, sh = f.sha256;
      if (!safePath(p)) fail('unsafe', 'listed path');
      if (p === 'pack.json' || isUser(p) || want.has(p) || !Number.isInteger(b) || b < 0 || b > MAX_FILE_BYTES || typeof sh !== 'string' || !HEX64.test(sh)) fail('corrupt', 'file entry ' + p);
      want.set(p, { bytes: b, sha256: sh });
    }
    if (!want.has('song.json')) fail('corrupt', 'no song.json');

    // every entry: a safe name it may have; every listed file present
    for (const en of entries.values()) {
      if (!safePath(en.name) || en.special) fail('unsafe', 'entry ' + en.name);
      if (en.name !== 'pack.json' && !want.has(en.name) && !(en.name === 'user.json' || TAKE_FILE.test(en.name))) fail('corrupt', 'unlisted ' + en.name);
    }
    let present = 0; want.forEach((_, p) => { if (entries.has(p)) present++; });
    if (!present) fail('nosong', 'stub');
    if (present !== want.size) fail('corrupt', 'missing files');

    // sizes, CRC32, sha256
    let total = 0, done = 0;
    entries.forEach((en) => { total += en.size; });
    for (const en of entries.values()) {
      if (en.name === 'pack.json') { done += en.size; continue; }
      const w = want.get(en.name);
      if (w && en.size !== w.bytes) fail('corrupt', 'size ' + en.name);
      const b = await rd(en.dataOff, en.size);
      if (crc32(b) !== en.crc) fail('corrupt', 'crc ' + en.name);
      if (w && (await sha256hex(b)) !== w.sha256) fail('corrupt', 'sha256 ' + en.name);
      done += en.size;
      if (opts.progress) opts.progress(done, total);
    }

    const get = (name) => { const en = entries.get(name); if (!en) throw new PackError('corrupt', 'no ' + name); return en; };
    const out = {
      pack, id, title: typeof pack.title === 'string' ? pack.title : id, artist: typeof pack.artist === 'string' ? pack.artist : '',
      entries, size,
      has: (name) => entries.has(name),
      bytes: (name) => { const en = get(name); return rd(en.dataOff, en.size); },
      text: async (name) => utf8(await out.bytes(name)),
      json: async (name) => JSON.parse(await out.text(name)),
      /** An ArrayBuffer of its own (decodeAudioData detaches what it gets). */
      buffer: async (name) => { const b = await out.bytes(name); return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer; },
    };
    if (src.blob) out.blob = (name, type) => { const en = get(name); return src.blob(en.dataOff, en.size, type); };
    return out;
  }

  const GuitarPack = { version: '0.1.0', open, fromBlob, safePath, crc32, PackError, MSG, _: { TAKE_FILE, ID, isUser } };
  if (typeof module === 'object' && module.exports) module.exports = GuitarPack;
  else root.GuitarPack = GuitarPack;
})(typeof globalThis !== 'undefined' ? globalThis : this);
