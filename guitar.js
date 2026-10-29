/* Harmony — guitar view (lane G). Self-contained, no dependencies: window.Guitar in the page, module.exports in node
   (guitar/tools/test_guitar.js).
   - shapes      a chord-shape DB for standard tuning: open shapes + movable forms (root on the 6th / 5th / 4th string),
                 frets and fingers 1-4 per string (-1 = muted, 0 = open); barres are derived (one finger, several strings)
   - capoOptions capo 0..7 ranked by a playability score (shape difficulty, weighted by how long each chord sounds)
   - subs        in-key alternatives per chord: diatonic relatives (a third up / down), sus2 / sus4 / add9 / the diatonic
                 7th, the dominant 7 at the V, simpler forms, other fingerings
   - prefs       the per-song choices (capo, substitutions, picked fingering) + the user's own voicings
                 ("teacher variations": data model + API only)
   - mount       an SVG fretboard with a hand: the fingers move to the next chord's shape over the last ~150 ms before
                 its t0 (snap at t0 with prefers-reduced-motion)
   Labels are the analysis ones (tools/analyze.py: C Db D Eb E F F# G Ab A Bb B, '' / 'm'); richer ones parse too
   ("Cmaj7", "G/B", BTC's "A:min7"). Strings are indexed 0 = low E .. 5 = high e. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- names / parsing / transposition
  const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SPELL = { // 'neutral' = the analysis' (and app.js trName's) spelling: flats except F#
    neutral: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
    sharp: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    flat: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
  };
  const GMAJ = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']; // how a guitarist names a shape
  const GMIN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const mod12 = (n) => ((n % 12) + 12) % 12;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r2 = (x) => Math.round(x * 100) / 100;
  function pcOf(n) {
    const m = /^([A-G])([#b]?)$/.exec(String(n || '').replace('♯', '#').replace('♭', 'b'));
    return m ? mod12(NAT[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)) : null;
  }

  const IV = { // intervals over the root
    '': [0, 4, 7], m: [0, 3, 7], 5: [0, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], mmaj7: [0, 3, 7, 11],
    6: [0, 4, 7, 9], m6: [0, 3, 7, 9], sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], add9: [0, 2, 4, 7],
    madd9: [0, 2, 3, 7], 9: [0, 2, 4, 7, 10], m9: [0, 2, 3, 7, 10], maj9: [0, 2, 4, 7, 11], 11: [0, 2, 5, 7, 10],
    13: [0, 4, 7, 9, 10], dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], aug: [0, 4, 8],
  };
  const ALIAS = { // exact spellings first (M7 is not m7) ...
    '': '', maj: '', M: '', major: '', m: 'm', min: 'm', mi: 'm', '-': 'm', minor: 'm', 5: '5', 7: '7', dom7: '7',
    m7: 'm7', min7: 'm7', mi7: 'm7', '-7': 'm7', maj7: 'maj7', M7: 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', ma7: 'maj7', j7: 'maj7',
    mmaj7: 'mmaj7', mM7: 'mmaj7', minmaj7: 'mmaj7', 'm(maj7)': 'mmaj7', 6: '6', maj6: '6', m6: 'm6', min6: 'm6',
    sus2: 'sus2', 2: 'sus2', sus4: 'sus4', sus: 'sus4', '7sus4': '7sus4', '7sus': '7sus4', add9: 'add9', add2: 'add9',
    madd9: 'madd9', minadd9: 'madd9', 'm(add9)': 'madd9', 9: '9', m9: 'm9', min9: 'm9', maj9: 'maj9', M9: 'maj9',
    11: '11', 13: '13', dim: 'dim', '°': 'dim', o: 'dim', dim7: 'dim7', '°7': 'dim7', o7: 'dim7', m7b5: 'm7b5', 'ø': 'm7b5',
    'ø7': 'm7b5', hdim7: 'm7b5', min7b5: 'm7b5', 'm7-5': 'm7b5', aug: 'aug', '+': 'aug', '#5': 'aug',
  };
  const ALIAS_LC = {}; // ... then case-insensitive for the long words (MAJ7, Min, SUS4, ...)
  Object.keys(ALIAS).forEach((k) => { if (k.length > 2 && !(k.toLowerCase() in ALIAS_LC)) ALIAS_LC[k.toLowerCase()] = ALIAS[k]; });
  function qualOf(raw) {
    const r = String(raw).replace(/\s/g, '');
    if (r in ALIAS) return ALIAS[r];
    const u = r.replace(/[()]/g, '');
    if (u in ALIAS) return ALIAS[u];
    const l = u.toLowerCase();
    return l in ALIAS_LC ? ALIAS_LC[l] : null;
  }
  // "Abm", "F#", "Cmaj7", "G/B", "A:min7" (BTC), "N" / "X" / "" -> null
  function parse(label) {
    if (label == null) return null;
    const s = String(label).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
    if (!s || /^(N|X|NC|N\.C\.?)$/i.test(s)) return null;
    const m = /^([A-G])([#b]?):?([^/]*)(?:\/(.+))?$/.exec(s);
    if (!m) return null;
    const q = qualOf(m[3]);
    if (q == null) return null;
    const rootPc = mod12(NAT[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0));
    let bassPc = m[4] ? pcOf(m[4]) : null; // a BTC interval bass ("/3") is ignored
    if (bassPc === rootPc) bassPc = null;
    return { root: m[1] + m[2], rootPc, q, bassPc, iv: IV[q] };
  }
  const isMinorQ = (q) => /^m(?!aj)/.test(q) || q === 'dim' || q === 'dim7';
  function nameOf(pc, q, bassPc, spell) {
    const T = spell === 'guitar' ? (isMinorQ(q) ? GMIN : GMAJ) : SPELL[spell] || SPELL.neutral;
    const B = spell === 'guitar' ? GMAJ : T;
    return T[mod12(pc)] + q + (bassPc != null ? '/' + B[mod12(bassPc)] : '');
  }
  // like app.js trChord: the suffix is kept verbatim, root (and bass) move by n semitones in the given spelling
  function transpose(label, n, spell) {
    n = n | 0;
    if (!label || (!n && !spell)) return label;
    const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(label);
    if (!m) return label;
    const p = parse(label);
    const T = spell === 'guitar' ? (p && isMinorQ(p.q) ? GMIN : GMAJ) : SPELL[spell] || SPELL.neutral;
    return T[mod12(pcOf(m[1]) + n)] + m[2] + (m[3] ? '/' + (spell === 'guitar' ? GMAJ : T)[mod12(pcOf(m[3]) + n)] : '');
  }
  // keys: "Em" | "E minor" | {key:'E', mode:'minor'} | an analysis keySections array (first section)
  function parseKey(k) {
    if (!k) return null;
    if (Array.isArray(k)) k = k[0];
    if (k && typeof k === 'object') { const pc = pcOf(k.key); return pc == null ? null : { pc, mode: k.mode === 'minor' ? 'minor' : 'major' }; }
    const m = /^([A-G][#b]?)\s*(m|min|minor|maj|major|M)?$/.exec(String(k).trim());
    if (!m) return null;
    return { pc: pcOf(m[1]), mode: m[2] && /^m(in(or)?)?$/.test(m[2]) ? 'minor' : 'major' };
  }
  // app.js spellOf: flats in F Bb Eb Ab Db Gb major (and their relative minors), sharps in G D A E B, else neutral
  function keySpell(k) {
    k = k && Number.isInteger(k.pc) ? k : parseKey(k); if (!k) return 'neutral';
    const maj = k.mode === 'minor' ? mod12(k.pc + 3) : k.pc;
    return [5, 10, 3, 8, 1, 6].includes(maj) ? 'flat' : [7, 2, 9, 4, 11].includes(maj) ? 'sharp' : 'neutral';
  }
  const keyLabel = (k) => SPELL[keySpell(k)][k.pc] + (k.mode === 'minor' ? 'm' : '');

  // ---------------------------------------------------------------- the shape DB
  const OPEN_PC = [4, 9, 2, 7, 11, 4]; // E A D G B e
  const CORE = new Set(['C', 'A', 'G', 'E', 'D', 'Am', 'Em', 'Dm']); // the first chords anyone learns
  // open shapes: [chord, frets low E..high e ('x' muted), fingers]
  const OPEN = [
    ['C', 'x32010', 'x32010'], ['A', 'x02220', 'x01230'], ['G', '320003', '210003'], ['E', '022100', '023100'],
    ['D', 'xx0232', 'xx0132'], ['F', 'xx3211', 'xx3211'],
    ['Am', 'x02210', 'x02310'], ['Em', '022000', '023000'], ['Dm', 'xx0231', 'xx0231'],
    ['C7', 'x32310', 'x32410'], ['A7', 'x02020', 'x02030'], ['G7', '320001', '320001'], ['E7', '020100', '020100'],
    ['D7', 'xx0212', 'xx0213'], ['B7', 'x21202', 'x21304'],
    ['Am7', 'x02010', 'x02010'], ['Em7', '022030', '012030'], ['Dm7', 'xx0211', 'xx0211'],
    ['Cmaj7', 'x32000', 'x32000'], ['Fmaj7', 'xx3210', 'xx3210'], ['Amaj7', 'x02120', 'x02130'], ['Dmaj7', 'xx0222', 'xx0111'],
    ['Gmaj7', '320002', '320001'], ['Emaj7', '021100', '031200'],
    ['Asus2', 'x02200', 'x01200'], ['Dsus2', 'xx0230', 'xx0130'],
    ['Asus4', 'x02230', 'x01230'], ['Dsus4', 'xx0233', 'xx0134'], ['Esus4', '022200', '023400'], ['Csus4', 'x33011', 'x34011'],
    ['Cadd9', 'x32030', 'x21030'], ['Eadd9', '024100', '024100'],
    ['C6', 'x32210', 'x42310'], ['G6', '320000', '210000'], ['D6', 'xx0202', 'xx0103'], ['A6', 'x02222', 'x01111'], ['E6', '022120', '023140'],
    ['Am6', 'x02212', 'x02314'], ['Em6', '022020', '012030'], ['Dm6', 'xx0201', 'xx0201'],
    ['Caug', 'x32110', 'x43120'],
    ['E5', '022xxx', '012xxx'], ['A5', 'x022xx', 'x012xx'], ['D5', 'xx023x', 'xx013x'],
    ['G/B', 'x20003', 'x10003'], ['C/G', '332010', '342010'], ['D/F#', '200232', '100243'], ['C/E', '032010', '032010'], ['Am/G', '302210', '402310'],
  ];
  // movable forms: rs = the string holding the root (0 = 6th, 1 = 5th, 2 = 4th); off = fret over the root fret r (null =
  // muted); f = fingers. r = 0 turns a form into an open shape (offset-0 strings ring open, fingers renumbered).
  const X = null;
  const F = (rs, off, f) => ({ rs, off, f });
  const FORMS = {
    '': [F(0, [0, 2, 2, 1, 0, 0], [1, 3, 4, 2, 1, 1]), F(1, [X, 0, 2, 2, 2, 0], [0, 1, 2, 3, 4, 1]), F(2, [X, X, 0, 2, 3, 2], [0, 0, 1, 2, 4, 3])],
    m: [F(0, [0, 2, 2, 0, 0, 0], [1, 3, 4, 1, 1, 1]), F(1, [X, 0, 2, 2, 1, 0], [0, 1, 3, 4, 2, 1]), F(2, [X, X, 0, 2, 3, 1], [0, 0, 1, 3, 4, 2])],
    7: [F(0, [0, 2, 0, 1, 0, 0], [1, 3, 1, 2, 1, 1]), F(1, [X, 0, 2, 0, 2, 0], [0, 1, 3, 1, 4, 1]), F(2, [X, X, 0, 2, 1, 2], [0, 0, 1, 3, 2, 4])],
    m7: [F(0, [0, 2, 0, 0, 0, 0], [1, 3, 1, 1, 1, 1]), F(1, [X, 0, 2, 0, 1, 0], [0, 1, 3, 1, 2, 1]), F(2, [X, X, 0, 2, 1, 1], [0, 0, 1, 3, 2, 2])],
    maj7: [F(0, [0, X, 1, 1, 0, X], [2, 0, 3, 4, 1, 0]), F(1, [X, 0, 2, 1, 2, 0], [0, 1, 3, 2, 4, 1]), F(2, [X, X, 0, 2, 2, 2], [0, 0, 1, 3, 3, 3])],
    sus2: [F(0, [0, 2, 4, 4, 0, 0], [1, 2, 3, 4, 1, 1]), F(1, [X, 0, 2, 2, 0, 0], [0, 1, 3, 4, 1, 1]), F(2, [X, X, 0, 2, 3, 0], [0, 0, 1, 3, 4, 1])],
    sus4: [F(0, [0, 2, 2, 2, 0, 0], [1, 2, 3, 4, 1, 1]), F(1, [X, 0, 2, 2, 3, 0], [0, 1, 2, 3, 4, 1]), F(2, [X, X, 0, 2, 3, 3], [0, 0, 1, 2, 3, 4])],
    '7sus4': [F(0, [0, 2, 0, 2, 0, 0], [1, 3, 1, 4, 1, 1]), F(1, [X, 0, 2, 0, 3, 0], [0, 1, 3, 1, 4, 1])],
    add9: [F(0, [0, 2, 4, 1, 0, 0], [1, 3, 4, 2, 1, 1]), F(1, [X, 0, 2, 4, 2, 0], [0, 1, 2, 4, 3, 1])],
    6: [F(0, [0, 2, 2, 1, 2, 0], [1, 3, 3, 2, 4, 1]), F(1, [X, 0, 2, 2, 2, 2], [0, 1, 3, 3, 3, 3])],
    m6: [F(0, [0, 2, 2, 0, 2, 0], [1, 2, 3, 1, 4, 1]), F(1, [X, 0, X, 2, 1, 2], [0, 1, 0, 3, 2, 4])],
    dim: [F(0, [0, 1, 2, 0, X, X], [1, 2, 3, 1, 0, 0]), F(1, [X, 0, 1, 2, 1, X], [0, 1, 2, 4, 3, 0])],
    dim7: [F(1, [X, 0, 1, -1, 1, X], [0, 2, 3, 1, 4, 0]), F(2, [X, X, 0, 1, 0, 1], [0, 0, 1, 3, 2, 4])],
    m7b5: [F(0, [0, X, 0, 0, -1, X], [2, 0, 3, 4, 1, 0]), F(1, [X, 0, 1, 0, 1, X], [0, 1, 2, 1, 3, 0])],
    aug: [F(0, [0, X, 2, 1, 1, X], [1, 0, 4, 2, 3, 0]), F(1, [X, 0, 3, 2, 2, X], [0, 1, 4, 2, 3, 0])],
    5: [F(0, [0, 2, 2, X, X, X], [1, 3, 4, 0, 0, 0]), F(1, [X, 0, 2, 2, X, X], [0, 1, 3, 4, 0, 0])],
  };
  const FALLBACK = { mmaj7: 'm', madd9: 'm', 9: '7', m9: 'm7', maj9: 'maj7', 11: '7sus4', 13: '7' }; // no shape: play the core
  const MAX_FRET = 15; // highest fret (capo included) a shape may reach

  const fretStr = (fr) => fr.map((f) => (f < 0 ? 'x' : f > 9 ? '(' + f + ')' : String(f))).join('');
  function barresOf(frets, fingers) { // one finger on several strings at the same fret
    const out = [];
    for (let k = 1; k <= 4; k++) {
      const ss = []; for (let i = 0; i < 6; i++) if (fingers[i] === k && frets[i] > 0) ss.push(i);
      if (ss.length > 1 && ss.every((i) => frets[i] === frets[ss[0]])) out.push({ finger: k, fret: frets[ss[0]], s0: ss[0], s1: ss[ss.length - 1] });
    }
    return out;
  }
  function difficulty(s) {
    const fr = s.frets.filter((f) => f > 0);
    if (!fr.length) return 0.5;
    const nf = new Set(s.fingers.filter((f) => f > 0)).size;
    const big = s.barres.find((b) => b.s1 - b.s0 >= 3);
    let d = 1 + 0.3 * nf + Math.max(0, s.hi - s.lo - 2);
    if (big) d += 2.2 + (big.s1 - big.s0 >= 5 ? 0.6 : 0.3);
    else if (s.barres.length) d += 0.6;
    const snd = s.frets.map((f) => f >= 0), a = snd.indexOf(true), b = snd.lastIndexOf(true);
    for (let i = a + 1; i < b; i++) if (!snd[i]) d += 0.7; // a muted string between sounding ones has to be damped
    d += Math.max(0, s.lo - 5) * 0.35; // far up the neck
    if (s.kind !== 'open' && a >= 2) d += 0.5; // a thin movable shape with no bass under it
    if (s.kind === 'open' && CORE.has(s.chord)) d -= 0.4;
    return r2(d);
  }
  // frets are relative to the capo (0 = the capo / the nut)
  function mkShape(chord, frets, fingers, kind, extra) {
    const fr = frets.filter((f) => f > 0);
    const s = Object.assign({ chord, frets, fingers, kind: kind, barres: barresOf(frets, fingers), lo: fr.length ? Math.min(...fr) : 0, hi: fr.length ? Math.max(...fr) : 0 }, extra);
    if (s.kind === 'movable' && s.barres.some((b) => b.s1 - b.s0 >= 3)) s.kind = 'barre';
    s.id = 'db:' + fretStr(frets);
    s.diff = difficulty(s);
    return s;
  }
  const OPEN_BY = new Map(); // "pc|q|bassPc" -> [shape]
  OPEN.forEach(([chord, frets, fingers]) => {
    const p = parse(chord);
    const fr = frets.split('').map((c) => (c === 'x' ? -1 : +c)), fg = fingers.split('').map((c) => (c === 'x' ? 0 : +c));
    const k = p.rootPc + '|' + p.q + '|' + (p.bassPc == null ? '' : p.bassPc);
    if (!OPEN_BY.has(k)) OPEN_BY.set(k, []);
    OPEN_BY.get(k).push(mkShape(chord, fr, fg, 'open'));
  });
  const hasShape = (q) => q in FORMS || [...OPEN_BY.keys()].some((k) => k.split('|')[1] === q);

  // every shape that plays `label` (the sounding chord) with a capo on `capo`, easiest first
  function shapes(label, capo) {
    const p = typeof label === 'object' && label ? label : parse(label);
    if (!p) return [];
    capo = clamp(capo | 0, 0, 11);
    let q = p.q; const asked = q;
    while (!hasShape(q) && FALLBACK[q] != null) q = FALLBACK[q];
    const y = mod12(p.rootPc - capo); // the shape's own root
    const yb = p.bassPc == null ? null : mod12(p.bassPc - capo);
    const name = nameOf(y, asked, yb, 'guitar'), approx = q !== asked ? nameOf(y, q, null, 'guitar') : null;
    const out = [], seen = new Set();
    const add = (s) => { const k = fretStr(s.frets); if (seen.has(k)) return; seen.add(k); out.push(Object.assign({}, s, { name, approx, capo, id: 'db:' + k })); };
    if (yb != null) (OPEN_BY.get(y + '|' + q + '|' + yb) || []).forEach(add);
    (OPEN_BY.get(y + '|' + q + '|') || []).forEach((s) => add(yb != null ? Object.assign({}, s, { noBass: true }) : s));
    for (const f of FORMS[q] || []) {
      const offs = f.off.filter((o) => o != null), lo = Math.min(...offs), hi = Math.max(...offs);
      const r0 = mod12(y - OPEN_PC[f.rs]);
      for (const r of [r0, r0 + 12]) {
        if (r + lo < 0 || capo + r + hi > MAX_FRET) continue;
        const frets = f.off.map((o) => (o == null ? -1 : r + o));
        let fingers = f.f.slice();
        if (r === 0 || r + lo === 0) { // open strings: drop their fingers, renumber the rest 1..n
          fingers = fingers.map((g, i) => (frets[i] === 0 ? 0 : g));
          const used = [...new Set(fingers.filter((g) => g > 0))].sort();
          fingers = fingers.map((g) => (g > 0 ? used.indexOf(g) + 1 : 0));
        }
        const s = mkShape(nameOf(y, q, null, 'guitar'), frets, fingers, r === 0 ? 'open' : 'movable', { form: ['E', 'A', 'D'][f.rs] });
        add(yb != null ? Object.assign(s, { noBass: true }) : s);
      }
    }
    if (!out.length && q !== '' && q !== 'm') { // nothing fits under the capo: the plain triad, marked as approximate
      const core = IV[q].includes(3) ? 'm' : '';
      return shapes(Object.assign({}, p, { q: core, iv: IV[core] }), capo).map((s) => Object.assign(s, { name, approx: nameOf(y, core, null, 'guitar') }));
    }
    return out.sort((a, b) => a.diff - b.diff || a.lo - b.lo);
  }
  const shape = (label, capo) => shapes(label, capo)[0] || null;
  function notesOf(s) { // pitch classes a shape sounds (for tests / a future audio preview)
    return s.frets.map((f, i) => (f < 0 ? null : mod12(OPEN_PC[i] + (s.capo || 0) + f)));
  }

  // ---------------------------------------------------------------- capo ranking
  // chords: [{t0, t1, label}] or ["G", "C", ...] (sounding at semi 0); opts.semi transposes first
  function capoOptions(chords, key, opts) {
    opts = opts || {};
    const semi = opts.semi | 0, maxC = opts.max != null ? opts.max : 7;
    const w = new Map();
    for (const c of chords || []) {
      const lab = typeof c === 'string' ? c : c && c.label;
      if (!parse(lab)) continue;
      const k = transpose(lab, semi);
      const dur = c && typeof c === 'object' && Number.isFinite(c.t1 - c.t0) ? Math.max(0.05, c.t1 - c.t0) : 1;
      w.set(k, (w.get(k) || 0) + dur);
    }
    const k0 = parseKey(key), res = [];
    for (let capo = 0; capo <= maxC; capo++) {
      let sw = 0, sd = 0, worst = 0, barre = 0, miss = 0; const playAs = {};
      for (const [lab, wt] of w) {
        const s = shape(lab, capo);
        if (!s) { miss++; continue; }
        sw += wt; sd += wt * s.diff; worst = Math.max(worst, s.diff); if (s.kind === 'barre') barre += wt;
        playAs[lab] = s.name;
      }
      const avg = sw ? sd / sw : 0, bs = sw ? barre / sw : 0;
      const score = clamp(Math.round(100 - Math.max(0, avg - 1.2) * 22 - bs * 12 - capo * 1.2 - miss * 10), 0, 100);
      res.push({ capo, score, avg: r2(avg), worst: r2(worst), barreShare: r2(bs), missing: miss, playAs,
        keyAs: k0 ? nameOf(mod12(k0.pc + semi - capo), k0.mode === 'minor' ? 'm' : '', null, 'guitar') : null });
    }
    return res.sort((a, b) => b.score - a.score || a.capo - b.capo);
  }

  // ---------------------------------------------------------------- in-key substitutions
  const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
  const TRIAD = { major: ['', 'm', 'm', '', '', 'm', 'dim'], minor: ['m', 'dim', '', 'm', 'm', '', ''] };
  const SEVENTH = { major: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'], minor: ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'] };
  const KIND_HE = { rel: 'קרוב', dom7: 'דומיננטה', dom: 'דומיננטה', color: 'צבע', simple: 'פשוט יותר', voicing: 'אצבוע אחר' };
  // the notes a chord may use in a key: the scale (+ the leading tone in minor, for V / V7 / vii°)
  function fitsKey(rootPc, q, k) {
    const sc = SCALE[k.mode].map((d) => mod12(k.pc + d));
    const deg = mod12(rootPc - k.pc);
    if (k.mode === 'minor' && (deg === 7 || deg === 11)) sc.push(mod12(k.pc + 11));
    return IV[q].every((i) => sc.includes(mod12(rootPc + i)));
  }
  // label, key in the same (analysis) space; opts.capo / opts.semi only weigh "easier" (the shape actually played)
  function subs(label, key, opts) {
    opts = opts || {};
    const p = parse(label), k = parseKey(key);
    if (!p) return [];
    const capo = opts.capo | 0, semi = opts.semi | 0, sp = k ? keySpell(k) : 'neutral';
    const diffOf = (lab) => { const s = shape(transpose(lab, semi), capo); return s ? s.diff : 99; };
    const base = diffOf(label), out = [], seen = new Set([nameOf(p.rootPc, p.q, p.bassPc, 'neutral')]);
    const push = (pc, q, kind, extra) => {
      const lab = nameOf(pc, q, null, sp), id = nameOf(pc, q, null, 'neutral');
      if (seen.has(id)) return; seen.add(id);
      const d = diffOf(lab);
      out.push(Object.assign({ label: lab, kind, he: KIND_HE[kind], diff: d, easier: d < base - 0.4, inKey: k ? fitsKey(pc, q, k) : null }, extra));
    };
    if (k) {
      const scale = SCALE[k.mode], rel = mod12(p.rootPc - k.pc), deg = scale.indexOf(rel);
      if (deg >= 0) { // diatonic relatives: a third below, then a third above (two common tones)
        for (const d of [(deg + 5) % 7, (deg + 2) % 7]) {
          const q = TRIAD[k.mode][d];
          if (q !== 'dim') push(k.pc + scale[d], q, 'rel');
        }
      }
      if (rel === 7) { // the V: its dominant 7 (in minor also the major V, harmonic minor)
        if (k.mode === 'minor' && p.q === 'm') push(p.rootPc, '', 'dom');
        push(p.rootPc, '7', 'dom7');
      }
      const colors = ['sus2', 'sus4', p.q === 'm' ? 'madd9' : 'add9'];
      if (deg >= 0 && TRIAD[k.mode][deg] === (IV[p.q].includes(3) ? 'm' : '')) colors.push(SEVENTH[k.mode][deg]); // same quality only
      for (const q of colors) if (fitsKey(p.rootPc, q, k)) push(p.rootPc, q, 'color');
    }
    if (p.q !== '' && p.q !== 'm' && p.q !== '5') push(p.rootPc, IV[p.q].includes(3) ? 'm' : '', 'simple'); // drop the colour
    if (base >= 3.5 && p.q !== '5') push(p.rootPc, '5', 'simple'); // a power chord when the real one is a barre
    // other fingerings of the same chord (the default is the easiest one)
    shapes(transpose(label, semi), capo).slice(1, 3).forEach((s) => {
      out.push({ label: nameOf(p.rootPc, p.q, p.bassPc, sp), kind: 'voicing', he: s.kind === 'barre' ? 'ברה' : KIND_HE.voicing, voicing: s.id, frets: fretStr(s.frets), diff: s.diff, easier: false, inKey: null });
    });
    return out;
  }

  // ---------------------------------------------------------------- per-song choices + the user's own voicings
  // localStorage "guitar.song.v1.<songId>" (or the given store {get, set}). Labels are in the analysis' space (semi 0)
  // so a key change keeps every choice. Doc:
  //   { v: 1, capo: null | 0..11 (null = the top-ranked option),
  //     subs:    { "<label>": "<sub label>" }                       every occurrence of that chord
  //     at:      { "<chord index>": { sub: "<label>", t0: <s> } }   one occurrence (ignored if its t0 moved: re-analysis)
  //     voicing: { "<label>": "db:<frets>" | "<user voicing id>" }   the fingering picked for that chord
  //     user:    { "<label>": [ { id, name, frets[6], fingers[6], capo, semi, by: 'user' | 'teacher', at } ] } }
  const lsStore = {
    get(k) { try { return JSON.parse(root.localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) root.localStorage.removeItem(k); else root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } },
  };
  const blankDoc = () => ({ v: 1, capo: null, subs: {}, at: {}, voicing: {}, user: {} });
  function validVoicing(v) {
    if (!v || !Array.isArray(v.frets) || v.frets.length !== 6 || !Array.isArray(v.fingers) || v.fingers.length !== 6) return false;
    if (!v.frets.every((f) => Number.isInteger(f) && f >= -1 && f <= 24)) return false;
    if (!v.fingers.every((g, i) => Number.isInteger(g) && g >= 0 && g <= 4 && (g === 0 || v.frets[i] > 0))) return false;
    return v.frets.some((f) => f >= 0);
  }
  function normDoc(d) {
    const o = blankDoc();
    if (!d || typeof d !== 'object' || d.v !== 1) return o;
    if (Number.isInteger(d.capo) && d.capo >= 0 && d.capo <= 11) o.capo = d.capo;
    for (const [k, v] of Object.entries(d.subs || {})) if (parse(k) && parse(v)) o.subs[k] = v;
    for (const [k, v] of Object.entries(d.at || {})) if (/^\d+$/.test(k) && v && parse(v.sub) && Number.isFinite(v.t0)) o.at[k] = { sub: v.sub, t0: v.t0 };
    for (const [k, v] of Object.entries(d.voicing || {})) if (parse(k) && typeof v === 'string') o.voicing[k] = v;
    for (const [k, list] of Object.entries(d.user || {})) if (parse(k) && Array.isArray(list)) { const l = list.filter(validVoicing); if (l.length) o.user[k] = l; }
    return o;
  }
  function prefs(songId, store) {
    store = store || lsStore;
    const KEY = 'guitar.song.v1.' + songId;
    let d = normDoc(store.get(KEY));
    const save = () => store.set(KEY, d);
    const api = {
      key: KEY,
      doc: () => JSON.parse(JSON.stringify(d)),
      replace(doc) { d = normDoc(doc); save(); }, // a pack's user part restored
      capo(c) { if (c === undefined) return d.capo; d.capo = c == null ? null : clamp(c | 0, 0, 11); save(); return d.capo; },
      setSub(label, sub, at) { // at = {index, t0}: this occurrence only
        const same = !sub || sub === label;
        if (at && Number.isInteger(at.index)) { if (same && !d.subs[label]) delete d.at[at.index]; else d.at[at.index] = { sub: sub || label, t0: at.t0 }; }
        else if (same) delete d.subs[label]; else d.subs[label] = sub; // one-offs (at) win over this
        save();
      },
      subFor(label, index, t0) {
        const a = index != null && d.at[index];
        if (a && (t0 == null || Math.abs(a.t0 - t0) < 0.05)) return a.sub;
        return d.subs[label] || null;
      },
      effective(label, index, t0) { return api.subFor(label, index, t0) || label; },
      setVoicing(label, id) { if (id) d.voicing[label] = id; else delete d.voicing[label]; save(); },
      voicingFor(label) { return d.voicing[label] || null; },
      voicings(label) { return (d.user[label] || []).slice(); },
      addVoicing(label, v) { // -> the new id, or null (invalid)
        if (!parse(label) || !validVoicing(v)) return null;
        const id = 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        const rec = { id, name: String(v.name || '').slice(0, 40), frets: v.frets.slice(), fingers: v.fingers.slice(), capo: v.capo | 0, semi: v.semi | 0, by: v.by === 'teacher' ? 'teacher' : 'user', at: Date.now() };
        (d.user[label] = d.user[label] || []).push(rec); save();
        return id;
      },
      removeVoicing(label, id) {
        const l = (d.user[label] || []).filter((v) => v.id !== id);
        if (l.length) d.user[label] = l; else delete d.user[label];
        if (d.voicing[label] === id) delete d.voicing[label];
        save();
      },
    };
    return api;
  }
  // a stored voicing as a shape for the current semi / capo: moved along the neck when nothing rings open, else null
  function voicingShape(v, semi, capo) {
    if (!validVoicing(v)) return null;
    const dlt = ((semi | 0) - (v.semi | 0)) - ((capo | 0) - (v.capo | 0));
    if (dlt && v.frets.some((f) => f === 0)) return null;
    const frets = v.frets.map((f) => (f <= 0 ? f : f + dlt));
    if (frets.some((f) => f > 0 && (f < 1 || f + (capo | 0) > 20))) return null;
    return Object.assign(mkShape(v.name || '', frets, v.fingers.slice(), 'user'), { id: v.id, by: v.by, capo: capo | 0 });
  }

  // ---------------------------------------------------------------- hand pose (pure; the view draws it)
  const lastLE = (arr, t, key) => {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };
  const TRANS = 0.15; // s: the hand moves to the next shape over this long before its t0
  // where the timeline is: the chord sounding (ci, -1 before the first), the next one, the move's progress 0..1
  function frameState(chords, t, reduced, tr) {
    tr = tr || TRANS;
    const ci = lastLE(chords, t, 't0');
    const gap = ci >= 0 && t >= chords[ci].t1;
    const ni = ci + 1 < chords.length ? ci + 1 : -1;
    let p = 0;
    if (ni >= 0 && !reduced) { const dt = chords[ni].t0 - t; if (dt < tr) p = clamp(1 - dt / tr, 0, 1); }
    return { ci, ni, p, gap };
  }
  // finger k -> { f: fret, s0, s1 (strings it holds: a barre when they differ), lift 0..1 }
  function poseOf(s, lift) {
    const F = { 1: null, 2: null, 3: null, 4: null };
    if (!s) return { F, marks: ['', '', '', '', '', ''], none: true };
    for (let i = 0; i < 6; i++) {
      const g = s.fingers[i], f = s.frets[i];
      if (g < 1 || g > 4 || f <= 0) continue;
      const c = F[g];
      if (!c) F[g] = { f, s0: i, s1: i, lift: lift || 0 };
      else if (c.f === f) { c.s0 = Math.min(c.s0, i); c.s1 = Math.max(c.s1, i); }
    }
    return { F, marks: s.frets.map((f) => (f < 0 ? 'x' : f === 0 ? 'o' : '')), lo: s.lo, hi: s.hi };
  }
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  const lerp = (a, b, p) => a + (b - a) * p;
  function lerpPose(A, B, p) {
    if (p <= 0) return A;
    if (p >= 1) return B;
    const e = ease(p), F = {};
    for (let k = 1; k <= 4; k++) {
      const a = A.F[k], b = B.F[k];
      if (a && b) {
        const moves = a.f !== b.f || a.s0 !== b.s0 || a.s1 !== b.s1;
        F[k] = { f: lerp(a.f, b.f, e), s0: lerp(a.s0, b.s0, e), s1: lerp(a.s1, b.s1, e), lift: lerp(a.lift, b.lift, e) + (moves ? Math.sin(Math.PI * e) * 0.45 : 0) };
      } else if (a) F[k] = Object.assign({}, a, { lift: lerp(a.lift, 1, e) });
      else if (b) F[k] = Object.assign({}, b, { lift: lerp(1, b.lift, e) });
      else F[k] = null;
    }
    return { F, marks: e < 0.5 ? A.marks : B.marks };
  }

  // ---------------------------------------------------------------- the view
  const SVGNS = 'http://www.w3.org/2000/svg';
  const VB_W = 360, VB_H = 184, X0 = 32, X1 = 352, Y0 = 20, SP = 17, PALM_Y = 166;
  const yOf = (s) => Y0 + (5 - s) * SP; // high e on top (like tab)
  const CSS = `
.gtr{--g-teal:var(--teal,#3fb8b0);--g-soft:var(--teal-soft,#7fdccf);--g-amber:var(--amber,#f2c46d);--g-text:var(--text,#e8ecff);
 --g-muted:var(--muted,#9aa6d6);--g-glass:var(--glass,rgba(255,255,255,.055));--g-line:var(--line,rgba(255,255,255,.10));
 width:100%;max-width:100%;min-width:0;box-sizing:border-box;color:var(--g-text);font:inherit;padding:10px 12px 12px;
 background:var(--g-glass);border:1px solid var(--g-line);border-radius:var(--radius,22px);overflow:hidden}
.gtr *{box-sizing:border-box}
.gtr button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.gtr button:focus-visible{outline:2px solid var(--g-soft);outline-offset:2px}
.gtr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:52px}
.gtr-now{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.gtr-name{min-height:48px;min-width:64px;padding:0 12px;border-radius:14px;border:1px solid var(--g-line);background:rgba(63,184,176,.14);
 font-size:28px;font-weight:700;line-height:1}
.gtr-name[data-sub]{border-color:var(--g-amber)}
.gtr-name.gap{opacity:.5}
.gtr-sub{display:flex;flex-direction:column;gap:2px;font-size:13px;color:var(--g-muted);min-width:0}
.gtr-tag{display:inline-block;font-size:12px;padding:1px 7px;border-radius:9px;background:rgba(242,196,109,.16);color:var(--g-amber);width:max-content}
.gtr-next{font-size:14px;color:var(--g-muted);text-align:end;white-space:nowrap}
.gtr-next bdi{font-size:20px;color:var(--g-text);font-weight:600;margin-inline-start:6px}
.gtr-svg{display:block;width:100%;height:auto;margin:4px 0 2px;touch-action:pan-y}
.gtr-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}
.gtr-row>span{font-size:13px;color:var(--g-muted);margin-inline-end:2px}
.gtr-chip{min-height:40px;padding:4px 11px;border-radius:20px;border:1px solid var(--g-line);background:transparent;font-size:14px;
 display:inline-flex;align-items:center;gap:5px;max-width:100%}
.gtr-chip[aria-pressed=true]{background:var(--g-teal);border-color:var(--g-teal);color:#04121a;font-weight:600}
.gtr-chip small{font-size:11px;opacity:.75}
.gtr-sheet{margin-top:8px;padding:10px;border-radius:16px;border:1px solid var(--g-line);background:rgba(7,10,34,.6)}
.gtr-sheet h3{margin:0 0 6px;font-size:15px;font-weight:600}
.gtr-opts{display:flex;flex-wrap:wrap;gap:6px}
.gtr-opt{min-height:48px;padding:4px 10px;border-radius:14px;border:1px solid var(--g-line);background:transparent;display:flex;
 flex-direction:column;align-items:center;justify-content:center;min-width:64px;max-width:100%}
.gtr-opt bdi{font-size:18px;font-weight:600}
.gtr-opt small{font-size:11px;color:var(--g-muted)}
.gtr-opt[aria-pressed=true]{border-color:var(--g-amber);background:rgba(242,196,109,.14)}
.gtr-opt .easy{color:var(--g-soft)}
.gtr-foot{display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;margin-top:8px}
.gtr-n{font:700 10px/1 system-ui,sans-serif;fill:#08101e;text-anchor:middle;dominant-baseline:central;pointer-events:none}
.gtr-fn{font:10px/1 system-ui,sans-serif;fill:var(--g-muted);text-anchor:middle}
.gtr-mk{font:700 12px/1 system-ui,sans-serif;fill:var(--g-muted);text-anchor:middle;dominant-baseline:central}
.gtr-capo-t{font:700 10px/1 system-ui,sans-serif;fill:var(--g-amber)}
@media (prefers-reduced-motion:reduce){.gtr *{transition:none!important;animation:none!important}}
`;
  const FCOL = ['', '#7fdccf', '#f2c46d', '#b9a6ff', '#ff9bb0']; // index .. pinky
  const SKIN = 'rgba(236,214,190,.36)';
  function injectStyle(doc) {
    if (doc.getElementById('gtr-style')) return;
    const st = doc.createElement('style'); st.id = 'gtr-style'; st.textContent = CSS; doc.head.append(st);
  }
  function sv(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  }
  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function bdi(text) { const b = h('bdi', null, text); b.dir = 'ltr'; return b; }
  const capoHe = (c) => (c ? 'קאפו ' + c : 'בלי קאפו');

  // el: the container. o: { getTime() -> song seconds (optional: else call handle.frame(t)), chords [{t0,t1,label,unsure}],
  // key: analysis keySections | {key,mode} | "Em", semi, rtl (default true), songId + store (per-song choices),
  // onChange(ev) (ev.type: 'capo' | 'sub' | 'voicing') }
  function mount(el, o) {
    o = o || {};
    const doc = el.ownerDocument || document;
    injectStyle(doc);
    const mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const S = { chords: [], secs: [], semi: 0, capo: 0, opts: [], showAll: false, rows: [], N: 5, ci: -9, ni: -9, gap: null, sheet: null, here: false, raf: 0, dead: false, last: null };
    let P = o.songId != null ? prefs(o.songId, o.store) : null;

    const rootEl = h('div', 'gtr'); rootEl.dir = o.rtl === false ? 'ltr' : 'rtl';
    const head = h('div', 'gtr-head'), now = h('div', 'gtr-now');
    const nameB = h('button', 'gtr-name'); nameB.type = 'button';
    nameB.setAttribute('aria-haspopup', 'true');
    const sub = h('div', 'gtr-sub'), next = h('div', 'gtr-next');
    now.append(nameB, sub); head.append(now, next);
    const svg = sv('svg', { class: 'gtr-svg', viewBox: `0 0 ${VB_W} ${VB_H}`, role: 'img' });
    const capoRow = h('div', 'gtr-row'); capoRow.setAttribute('role', 'group'); capoRow.setAttribute('aria-label', 'קאפו');
    const sheet = h('div', 'gtr-sheet'); sheet.hidden = true;
    rootEl.append(head, svg, capoRow, sheet);
    el.append(rootEl);

    // ---- static board (redrawn when the capo / window changes)
    const defs = sv('defs', {}, svg);
    const clipId = 'gtrclip' + Math.floor(Math.random() * 1e9).toString(36);
    sv('rect', { x: X0 - 1, y: 0, width: X1 - X0 + 2, height: VB_H }, sv('clipPath', { id: clipId }, defs));
    sv('rect', { x: X0, y: Y0 - 8, width: X1 - X0, height: SP * 5 + 16, rx: 6, fill: 'rgba(120,80,60,.16)', stroke: 'rgba(255,255,255,.08)' }, svg);
    const clip = sv('g', { 'clip-path': `url(#${clipId})` }, svg);
    const board = sv('g', {}, clip); // frets, inlays, numbers + the hand: panned with the window
    const fixed = sv('g', {}, svg);  // nut / capo, open / muted marks
    const strings = sv('g', {}, svg);
    for (let s = 0; s < 6; s++) sv('line', { x1: X0, x2: X1, y1: yOf(s), y2: yOf(s), stroke: '#d6dcff', 'stroke-opacity': 0.55, 'stroke-width': (2.3 - s * 0.28).toFixed(2) }, strings);
    const hand = sv('g', {}, clip);
    const palm = sv('ellipse', { rx: 50, ry: 17, cy: PALM_Y, fill: SKIN }, hand);
    const thumb = sv('rect', { width: 26, height: 10, rx: 5, y: 2, fill: SKIN }, hand);
    const fingerEls = [null];
    for (let k = 1; k <= 4; k++) {
      const g = sv('g', {}, hand);
      fingerEls.push({
        g,
        line: sv('line', { stroke: SKIN, 'stroke-width': 9, 'stroke-linecap': 'round' }, g),
        bar: sv('rect', { width: 13, rx: 6.5, fill: FCOL[k], 'fill-opacity': 0.9 }, g),
        dot: sv('circle', { r: 8.5, fill: FCOL[k] }, g),
        num: Object.assign(sv('text', { class: 'gtr-n' }, g), { textContent: String(k) }),
      });
    }
    const marks = [];
    for (let s = 0; s < 6; s++) marks.push(Object.assign(sv('text', { class: 'gtr-mk', x: 15, y: yOf(s) }, fixed), { textContent: '' }));
    let nutEl = null, capoT = null;

    const fw = () => (X1 - X0) / S.N;
    const fx = (f) => X0 + (f - 0.5) * fw() + fw() * 0.12; // a finger sits just behind its fret wire
    function drawBoard() {
      board.replaceChildren();
      const W = fw();
      for (let f = 1; f <= MAX_FRET; f++) {
        const x = X0 + f * W;
        sv('line', { x1: x, x2: x, y1: Y0 - 4, y2: yOf(0) + 4, stroke: 'rgba(255,255,255,.30)', 'stroke-width': 2 }, board);
        const abs = f + S.capo;
        if ([3, 5, 7, 9, 15, 17].includes(abs)) sv('circle', { cx: x - W / 2, cy: Y0 + SP * 2.5, r: 3.5, fill: 'rgba(255,255,255,.16)' }, board);
        if (abs === 12) { sv('circle', { cx: x - W / 2, cy: Y0 + SP * 1.5, r: 3.5, fill: 'rgba(255,255,255,.16)' }, board); sv('circle', { cx: x - W / 2, cy: Y0 + SP * 3.5, r: 3.5, fill: 'rgba(255,255,255,.16)' }, board); }
        Object.assign(sv('text', { class: 'gtr-fn', x: x - W / 2, y: yOf(0) + 18 }, board), { textContent: String(abs) });
      }
      if (nutEl) nutEl.remove(); if (capoT) capoT.remove();
      nutEl = sv('rect', { x: X0 - 4, y: Y0 - 7, width: 6, height: SP * 5 + 14, rx: 2, fill: S.capo ? 'var(--g-amber)' : '#e9e4d8', 'fill-opacity': S.capo ? 0.95 : 0.8 }, fixed);
      capoT = sv('text', { class: 'gtr-capo-t', x: X0 + 4, y: 9 }, fixed); capoT.textContent = S.capo ? 'קאפו ' + S.capo : '';
      svg.setAttribute('aria-label', 'צוואר הגיטרה' + (S.capo ? ', ' + capoHe(S.capo) : ''));
    }
    const winOf = (s) => (!s || s.hi <= S.N ? 0 : clamp(s.lo - 1, 0, MAX_FRET - S.N));

    // ---- model: what each chord plays (after semi, the chosen substitution and fingering, at the capo)
    const keyAt = (t) => S.secs[Math.max(0, lastLE(S.secs, t, 't0'))] || null;
    const sounding = (lab, t) => { if (!S.semi) return lab; const k = keyAt(t); return transpose(lab, S.semi, k ? keySpell({ key: SPELL.neutral[mod12(pcOf(k.key) + S.semi)], mode: k.mode }) : 'neutral'); };
    function shapeFor(alabel, eff, t0) {
      const snd = sounding(eff, t0);
      const pick = P && eff === alabel ? P.voicingFor(alabel) : null;
      if (pick) {
        if (pick[0] === 'u') { const v = P.voicings(alabel).find((x) => x.id === pick); const s = v && voicingShape(v, S.semi, S.capo); if (s) return Object.assign(s, { name: shape(snd, S.capo) ? shape(snd, S.capo).name : snd }); }
        else { const s = shapes(snd, S.capo).find((x) => x.id === pick); if (s) return s; }
      }
      return shape(snd, S.capo);
    }
    function prepare() {
      S.rows = S.chords.map((c, i) => {
        const eff = P ? P.effective(c.label, i, c.t0) : c.label;
        return { a: c.label, eff, snd: sounding(eff, c.t0), shape: parse(eff) ? shapeFor(c.label, eff, c.t0) : null, sub: eff !== c.label };
      });
      let hi = 0; S.rows.forEach((r) => { if (r.shape) hi = Math.max(hi, r.shape.hi); });
      S.N = hi <= 5 ? 5 : hi <= 7 ? hi : 7;
      drawBoard(); S.ci = -9; S.last = null;
    }
    function rank() {
      S.opts = capoOptions(S.chords, S.secs.length ? S.secs : o.key, { semi: S.semi });
      const saved = P ? P.capo() : null;
      S.capo = saved != null ? saved : o.capo != null ? o.capo : S.opts.length ? S.opts[0].capo : 0;
    }
    function capoUI() {
      capoRow.replaceChildren(h('span', null, 'קאפו'));
      const best = S.opts[0] ? S.opts[0].capo : 0;
      let list = S.showAll ? S.opts.slice() : S.opts.slice(0, 3);
      if (!list.some((x) => x.capo === S.capo)) { const cur = S.opts.find((x) => x.capo === S.capo); if (cur) list.push(cur); }
      list.forEach((x) => {
        const b = h('button', 'gtr-chip'); b.type = 'button';
        b.setAttribute('aria-pressed', String(x.capo === S.capo));
        b.append((x.capo === best ? '★ ' : '') + capoHe(x.capo), h('small', null, String(x.score)));
        b.title = (x.keyAs ? 'מנגנים בצורות של ' + x.keyAs + ' · ' : '') + 'נוחות ' + x.score + ' מתוך 100';
        b.setAttribute('aria-label', capoHe(x.capo) + ', נוחות ' + x.score + (x.capo === best ? ', הכי נוח' : ''));
        b.addEventListener('click', () => api.setCapo(x.capo));
        capoRow.append(b);
      });
      if (S.opts.length > 3) {
        const m = h('button', 'gtr-chip', S.showAll ? 'פחות' : 'עוד'); m.type = 'button';
        m.setAttribute('aria-expanded', String(S.showAll));
        m.addEventListener('click', () => { S.showAll = !S.showAll; capoUI(); });
        capoRow.append(m);
      }
    }

    // ---- the substitution sheet (for the chord under the hand, or the given index)
    function sheetUI() {
      const i = S.sheet;
      if (i == null || !S.rows[i]) { sheet.hidden = true; nameB.setAttribute('aria-expanded', 'false'); return; }
      const c = S.chords[i], row = S.rows[i], k = keyAt(c.t0);
      sheet.hidden = false; nameB.setAttribute('aria-expanded', 'true');
      const t = h('h3', null, 'חלופות ל־'); t.append(bdi(sounding(c.label, c.t0)));
      const opts = h('div', 'gtr-opts');
      const cur = P ? P.subFor(c.label, i, c.t0) : null, vpick = P ? P.voicingFor(c.label) : null;
      const addOpt = (lab, small, pressed, onPick, easy) => {
        const b = h('button', 'gtr-opt'); b.type = 'button'; b.setAttribute('aria-pressed', String(!!pressed));
        const s = parse(lab) ? shape(sounding(lab, c.t0), S.capo) : null;
        b.append(bdi(sounding(lab, c.t0)));
        const sm = h('small', null, small + (S.capo && s ? ' · ' : '')); if (S.capo && s) sm.append(bdi(s.name));
        b.append(sm);
        if (easy) { const e = h('small', 'easy', 'קל יותר'); b.append(e); }
        b.addEventListener('click', onPick);
        opts.append(b);
      };
      addOpt(c.label, 'מקורי', !cur && !vpick, () => choose(i, null));
      subs(c.label, k ? { key: k.key, mode: k.mode } : null, { capo: S.capo, semi: S.semi }).forEach((x) => {
        if (x.kind === 'voicing') {
          const b = h('button', 'gtr-opt'); b.type = 'button'; b.setAttribute('aria-pressed', String(vpick === x.voicing));
          b.append(bdi(x.frets), h('small', null, x.he));
          b.addEventListener('click', () => { if (!P) return; P.setVoicing(c.label, vpick === x.voicing ? null : x.voicing); refreshModel({ type: 'voicing', label: c.label, voicing: P.voicingFor(c.label) }); });
          opts.append(b);
        } else addOpt(x.label, x.he, cur && parse(cur) && nameOf(parse(cur).rootPc, parse(cur).q, null, 'neutral') === nameOf(parse(x.label).rootPc, parse(x.label).q, null, 'neutral'), () => choose(i, x.label), x.easier);
      });
      (P ? P.voicings(c.label) : []).forEach((v) => {
        const b = h('button', 'gtr-opt'); b.type = 'button'; b.setAttribute('aria-pressed', String(vpick === v.id));
        b.append(bdi(v.name || fretStr(v.frets)), h('small', null, v.by === 'teacher' ? 'אצבוע של המורה' : 'אצבוע שלי'));
        b.addEventListener('click', () => { P.setVoicing(c.label, vpick === v.id ? null : v.id); refreshModel({ type: 'voicing', label: c.label, voicing: P.voicingFor(c.label) }); });
        opts.append(b);
      });
      const foot = h('div', 'gtr-foot');
      const scope = h('button', 'gtr-chip', S.here ? 'רק במקום הזה' : 'בכל השיר'); scope.type = 'button';
      scope.setAttribute('aria-pressed', String(S.here)); scope.title = 'איפה להחליף את האקורד';
      scope.addEventListener('click', () => { S.here = !S.here; sheetUI(); });
      const close = h('button', 'gtr-chip', 'סגירה'); close.type = 'button';
      close.addEventListener('click', () => api.closeSubs());
      foot.append(scope, close);
      sheet.replaceChildren(t, opts, foot);
    }
    function choose(i, lab) {
      const c = S.chords[i];
      if (P) {
        if (lab == null) { P.setSub(c.label, null, S.here ? { index: i, t0: c.t0 } : null); if (!S.here) P.setVoicing(c.label, null); }
        else P.setSub(c.label, lab, S.here ? { index: i, t0: c.t0 } : null);
      }
      refreshModel({ type: 'sub', label: c.label, sub: lab, index: S.here ? i : null });
    }
    function refreshModel(ev) { prepare(); sheetUI(); if (S.lastT != null) draw(S.lastT); if (o.onChange && ev) o.onChange(ev); }

    // ---- per frame
    function headUI(st) {
      const cur = st.ci >= 0 && !st.gap ? S.rows[st.ci] : null, nx = st.ni >= 0 ? S.rows[st.ni] : null;
      const nm = (r) => (r.shape ? (S.capo ? r.shape.name : r.snd) : r.snd);
      nameB.replaceChildren(bdi(cur ? nm(cur) : '–'));
      nameB.classList.toggle('gap', !cur);
      if (cur && cur.sub) nameB.dataset.sub = '1'; else delete nameB.dataset.sub;
      nameB.setAttribute('aria-label', cur ? 'אקורד ' + nm(cur) + ', חלופות' : 'אין אקורד');
      nameB.disabled = !cur;
      const lines = [];
      if (cur && S.capo) { const d = h('div', null, 'נשמע '); d.append(bdi(cur.snd)); lines.push(d); }
      if (cur && cur.sub) { const d = h('span', 'gtr-tag', 'חלופה ל־'); d.append(bdi(sounding(cur.a, S.chords[st.ci].t0))); lines.push(d); }
      if (cur && S.chords[st.ci].unsure) lines.push(h('span', 'gtr-tag', 'לא בטוח'));
      if (cur && cur.shape && cur.shape.approx) { const d = h('span', 'gtr-tag', 'בקירוב '); d.append(bdi(cur.shape.approx)); lines.push(d); }
      sub.replaceChildren(...lines);
      next.replaceChildren();
      if (nx) next.append('הבא:', bdi(nm(nx)));
    }
    function draw(t) {
      S.lastT = t;
      const reduced = !!(mq && mq.matches);
      const st = frameState(S.chords, t, reduced);
      if (st.ci !== S.ci || st.gap !== S.gap || st.ni !== S.ni) { S.ci = st.ci; S.gap = st.gap; S.ni = st.ni; headUI(st); }
      const cur = st.ci >= 0 ? S.rows[st.ci] : null, nx = st.ni >= 0 ? S.rows[st.ni] : null;
      // before the first chord / in a gap the hand hovers (lifted) over the shape it comes from or goes to
      const A = cur ? poseOf(cur.shape, st.gap ? 0.55 : 0) : poseOf(nx && nx.shape, 1);
      const B = nx ? poseOf(nx.shape, 0) : A;
      const pose = st.p > 0 && !B.none ? lerpPose(A.none ? poseOf(nx.shape, 1) : A, B, st.p) : A;
      const wA = winOf(cur ? cur.shape : nx && nx.shape), wB = winOf(nx && nx.shape);
      const win = st.p > 0 ? lerp(wA, wB, ease(st.p)) : wA;
      const key = win.toFixed(3) + JSON.stringify(pose.F) + pose.marks.join('');
      if (key === S.last) return; // nothing moved
      S.last = key;
      const dx = -win * fw();
      board.setAttribute('transform', `translate(${dx.toFixed(2)} 0)`);
      nutEl.style.opacity = win > 0.05 ? 0 : 1; capoT.style.opacity = win > 0.05 ? 0 : 1;
      for (let s = 0; s < 6; s++) marks[s].textContent = pose.marks[s] === 'x' ? '×' : pose.marks[s] === 'o' ? '○' : '';
      // the hand: the palm under the active fingers, knuckles spread index (toward the nut) .. pinky
      let sx = 0, n = 0;
      for (let k = 1; k <= 4; k++) { const f = pose.F[k]; if (f && f.lift < 0.9) { sx += fx(f.f) + dx; n++; } }
      const palmX = n ? sx / n : S.palmX != null ? S.palmX : X0 + fw() * 2;
      S.palmX = palmX;
      palm.setAttribute('cx', palmX.toFixed(1));
      thumb.setAttribute('x', (palmX - 13).toFixed(1));
      hand.style.opacity = pose.F[1] || pose.F[2] || pose.F[3] || pose.F[4] ? 1 : 0.35;
      for (let k = 1; k <= 4; k++) {
        const E = fingerEls[k], f = pose.F[k];
        const kx = palmX + (k - 2.5) * 16, ky = PALM_Y - 14;
        let tx, ty, lift = 1, y0 = 0, y1 = 0;
        if (f) { tx = fx(f.f) + dx; y0 = yOf(f.s1); y1 = yOf(f.s0); ty = y1; lift = clamp(f.lift, 0, 1); }
        else { tx = kx; ty = ky - 26; }
        // a lifted finger curls back toward the palm
        const px = lerp(tx, kx, lift * 0.45), py = lerp(ty, ky - 20, lift * 0.55);
        E.line.setAttribute('x1', kx.toFixed(1)); E.line.setAttribute('y1', ky.toFixed(1));
        E.line.setAttribute('x2', px.toFixed(1)); E.line.setAttribute('y2', py.toFixed(1));
        const isBar = f && Math.abs(f.s1 - f.s0) > 0.05 && lift < 0.5;
        E.bar.style.display = isBar ? '' : 'none';
        if (isBar) { E.bar.setAttribute('x', (px - 6.5).toFixed(1)); E.bar.setAttribute('y', (y0 - 7).toFixed(1)); E.bar.setAttribute('height', (y1 - y0 + 14).toFixed(1)); }
        E.dot.setAttribute('cx', px.toFixed(1)); E.dot.setAttribute('cy', py.toFixed(1));
        E.dot.setAttribute('r', (8.5 - lift * 3).toFixed(2));
        E.dot.setAttribute('fill-opacity', (1 - lift * 0.7).toFixed(2));
        E.num.setAttribute('x', px.toFixed(1)); E.num.setAttribute('y', py.toFixed(1));
        E.num.style.opacity = lift > 0.5 ? 0 : 1;
        E.g.style.opacity = f ? 1 : 0.35;
      }
    }
    function loop() {
      if (S.dead) return;
      if (!rootEl.isConnected) { S.dead = true; return; }
      if (!doc.hidden) { try { draw(o.getTime()); } catch (e) { /* a bad time source: next frame */ } }
      S.raf = root.requestAnimationFrame(loop);
    }

    nameB.addEventListener('click', () => { if (S.ci >= 0) { S.sheet = S.sheet === S.ci ? null : S.ci; sheetUI(); } });

    const api = {
      frame(t) { draw(t); },
      setCapo(c) {
        S.capo = clamp(c | 0, 0, 11);
        if (P) P.capo(S.capo);
        prepare(); capoUI(); sheetUI(); if (S.lastT != null) draw(S.lastT);
        if (o.onChange) o.onChange({ type: 'capo', capo: S.capo });
      },
      // new song data / key change: { chords, key, semi, songId, store }
      update(u) {
        u = u || {};
        if (u.chords) S.chords = u.chords.filter((c) => c && Number.isFinite(c.t0)).map((c) => ({ t0: c.t0, t1: Number.isFinite(c.t1) ? c.t1 : c.t0 + 1, label: c.label, unsure: !!c.unsure }));
        if (u.key !== undefined) o.key = u.key;
        const k = o.key;
        S.secs = Array.isArray(k) && k.length ? k.filter((x) => x && pcOf(x.key) != null).map((x) => ({ t0: x.t0 || 0, key: x.key, mode: x.mode })) : parseKey(k) ? [{ t0: 0, key: SPELL.neutral[parseKey(k).pc], mode: parseKey(k).mode }] : [];
        if (u.semi !== undefined) S.semi = u.semi | 0;
        if (u.songId !== undefined) P = u.songId != null ? prefs(u.songId, u.store || o.store) : null;
        rank(); prepare(); capoUI(); S.sheet = null; sheetUI();
        if (S.lastT != null) draw(S.lastT);
      },
      openSubs(i) { S.sheet = i != null ? i : S.ci >= 0 ? S.ci : 0; sheetUI(); },
      closeSubs() { S.sheet = null; sheetUI(); nameB.focus(); },
      prefs: () => P,
      state: () => ({ ci: S.ci, capo: S.capo, window: S.N, options: S.opts.slice(), rows: S.rows.map((r) => ({ label: r.a, eff: r.eff, sounding: r.snd, play: r.shape ? r.shape.name : null, frets: r.shape ? fretStr(r.shape.frets) : null })) }),
      destroy() { S.dead = true; if (S.raf) root.cancelAnimationFrame(S.raf); rootEl.remove(); },
      el: rootEl,
    };
    S.semi = o.semi | 0;
    api.update({ chords: o.chords || [] });
    if (typeof o.getTime === 'function') S.raf = root.requestAnimationFrame(loop);
    else draw(0);
    return api;
  }

  const Guitar = {
    version: '0.1.0',
    parse, transpose, parseKey, keySpell, keyLabel: (k) => { const p = parseKey(k); return p ? keyLabel(p) : null; },
    shape, shapes, notesOf, capoOptions, subs, prefs, voicingShape, mount,
    _: { OPEN, FORMS, OPEN_PC, IV, FALLBACK, MAX_FRET, difficulty, fretStr, frameState, poseOf, lerpPose, fitsKey, nameOf, normDoc, TRANS },
  };
  if (typeof module === 'object' && module.exports) module.exports = Guitar;
  if (typeof window !== 'undefined') window.Guitar = Guitar;
})(typeof window !== 'undefined' ? window : globalThis);
