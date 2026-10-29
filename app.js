/* Guitar — the standalone app shell: pick a song (.hsong pack, or a folder of unpacked songs), play its stems, and show
   the fretboard + hand (guitar.js) on the song's chord timeline, with the capo and substitutions per song.
   Storage: the per-song choices live under "guitar.song.v1.<songId>" (guitar.js prefs); the app's own toggles under
   "guitar.app.v1". Nothing is shared with any other app.
   Playback mirrors the song format (song.json): each stem is cut into Opus chunks of chunkFrames, decoded with a
   margin of marginFrames before the cut and crossfaded over xfadeFrames; cal.opus measures this decoder's offset.
   Chunks under the playhead + LOOKAHEAD are decoded and scheduled on the audio clock; the rest are dropped. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LOOKAHEAD = 2;   // chunks decoded + scheduled beyond the one under the playhead
  const SAFETY = 0.06;   // s: the earliest a start / late chunk is put on the audio clock
  const FADE = 0.012;    // s: stop / seek fade
  const APP_KEY = 'guitar.app.v1';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  const appPrefs = (() => {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(APP_KEY)) || {}; } catch (e) { d = {}; }
    return { get: (k) => d[k], set: (k, v) => { d[k] = v; try { localStorage.setItem(APP_KEY, JSON.stringify(d)); } catch (e) { /* private mode */ } } };
  })();

  // ---- song sources: a verified pack, or a folder served next to the page (songs/<id>/…, songs/index.json)
  function packSource(pk) {
    return { id: pk.id, title: pk.title, artist: pk.artist, json: (n) => pk.json(n), buffer: (n) => pk.buffer(n), has: (n) => pk.has(n) };
  }
  function folderSource(base, item) {
    const dir = base + encodeURIComponent(item.id) + '/';
    const get = async (n) => { const r = await fetch(dir + n); if (!r.ok) throw new Error(n + ' ' + r.status); return r; };
    return { id: item.id, title: item.title || item.id, artist: item.artist || '', json: async (n) => (await get(n)).json(), buffer: async (n) => (await get(n)).arrayBuffer(), has: () => true };
  }

  // ---- audio engine
  const E = { ctx: null, master: null, song: null, src: null, chunks: new Map(), run: null, runSeq: 0, playing: false, pausedF: 0,
    SR: 48000, Lf: 0, Xf: 0, Mf: 0, durF: 0, D: 0, stemGains: [], timer: 0, silent: false, silentT0: 0, gen: 0 };

  function ensureCtx() {
    if (E.ctx) return E.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    E.ctx = new AC({ latencyHint: 'playback' });
    E.master = E.ctx.createGain(); E.master.connect(E.ctx.destination);
    E.SR = E.ctx.sampleRate;
    return E.ctx;
  }
  function decode(ab) {
    return new Promise((res, rej) => { const p = E.ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
  }
  const chunkAt = (f) => clamp(Math.floor(f / E.Lf), 0, E.song.chunks - 1);
  const ctxF = () => Math.round(E.ctx.currentTime * E.SR);
  function posF() {
    if (E.silent && E.playing) return clamp(E.pausedF + (performance.now() - E.silentT0) / 1000 * E.SR, 0, E.durF);
    const r = E.run;
    if (!E.playing || !r || r.T0F == null) return E.pausedF;
    return clamp(ctxF() - r.T0F, r.startF, E.durF);
  }
  /** Song seconds as heard: the render clock minus the output latency (what the fretboard follows). */
  function audibleSec() {
    if (!E.song) return 0;
    if (E.silent || !E.playing || !E.run || E.run.T0F == null) return posF() / E.SR;
    const lat = E.ctx.outputLatency || E.ctx.baseLatency || 0;
    return clamp((E.ctx.currentTime - lat) * E.SR - E.run.T0F, E.run.startF, E.durF) / E.SR;
  }

  async function calibrate(gen) {
    E.D = 0;
    const cal = E.song.cal;
    if (!cal || !cal.file || !E.src.has(cal.file)) return;
    try {
      const b = await decode(await E.src.buffer(cal.file));
      if (gen !== E.gen) return;
      const x = b.getChannelData(0), exp = Math.round(cal.peakFrame * E.SR / E.song.sampleRate);
      let at = 0, m = 0;
      for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) { m = a; at = i; } }
      E.D = m > 0.1 && Math.abs(at - exp) < E.Mf / 2 ? at - exp : 0;
    } catch (e) { E.D = 0; }
  }

  function loadChunk(k) {
    let c = E.chunks.get(k);
    if (c) return c.promise;
    c = { k, ready: false, bufs: null };
    E.chunks.set(k, c);
    const kk = String(k).padStart(2, '0'), gen = E.gen;
    c.promise = Promise.all(E.song.stems.map((s) => E.src.buffer(`${s.id}-${kk}.${E.song.ext}`).then(decode)))
      .then((bufs) => { if (gen === E.gen && E.chunks.get(k) === c) { c.bufs = bufs; c.ready = true; } return c; },
        (err) => { if (E.chunks.get(k) === c) E.chunks.delete(k); throw err; });
    return c.promise;
  }
  function evict(from, to) { E.chunks.forEach((c, k) => { if (k < from || k > to) E.chunks.delete(k); }); }

  // chunk k of run r from song frame fromF on; all stems share `when`
  function schedule(r, k, fromF) {
    const c = E.chunks.get(k);
    const { Lf, Xf, Mf, SR } = E;
    const cF = k ? k * Lf - Xf : 0, eF = Math.min((k + 1) * Lf, E.durF), sF = Math.max(0, k * Lf - Mf);
    const f0 = Math.max(cF, fromF);
    r.scheduled.add(k);
    if (f0 >= eF) return;
    const t = (f) => (r.T0F + f) / SR;
    const when = t(f0), off = Math.max(0, f0 - sF + E.D) / SR, len = (eF - f0) / SR;
    const fadeIn = k > 0 && f0 < k * Lf, fadeOut = eF < E.durF;
    c.bufs.forEach((buf, i) => {
      if (!buf) return;
      const src = E.ctx.createBufferSource(), fade = E.ctx.createGain(), g = fade.gain;
      src.buffer = buf;
      if (fadeIn) { g.setValueAtTime((f0 - cF) / Xf, when); g.linearRampToValueAtTime(1, t(k * Lf)); } else g.setValueAtTime(1, when);
      if (fadeOut) {
        const a = Math.max(f0, eF - Xf);
        if (a > f0 || !fadeIn) g.setValueAtTime(a > f0 ? 1 : (eF - f0) / Xf, t(a));
        g.linearRampToValueAtTime(0, t(eF));
      }
      src.connect(fade); fade.connect(r.gain[i]);
      src.onended = () => { r.sources.delete(src); try { fade.disconnect(); } catch (e) { /* gone */ } };
      r.sources.add(src);
      src.start(when, off, len);
    });
  }

  function tick() {
    if (!E.song) return;
    const p = posF();
    if (E.playing && p >= E.durF - 1) { pause(); E.pausedF = 0; ui(); return; }
    if (E.silent) { ui(); return; }
    const c = chunkAt(p), last = Math.min(E.song.chunks - 1, c + LOOKAHEAD);
    evict(c, last);
    const r = E.run;
    for (let k = c; k <= last; k++) {
      const ch = E.chunks.get(k);
      if (!ch || !ch.ready) { loadChunk(k).then(tick, () => {}); continue; }
      if (r && r.T0F != null && E.playing && !r.scheduled.has(k)) {
        const earliest = Math.round(ctxF() - r.T0F + SAFETY * E.SR); // a late chunk joins in progress: a dropout, never a drift
        schedule(r, k, Math.max(r.startF, earliest));
      }
    }
    ui();
  }

  function stopRun(r) {
    if (!r) return;
    const now = E.ctx.currentTime;
    r.out.gain.cancelScheduledValues(now); r.out.gain.setValueAtTime(r.out.gain.value, now); r.out.gain.linearRampToValueAtTime(0, now + FADE);
    r.sources.forEach((s) => { try { s.stop(now + FADE + 0.01); } catch (e) { /* not started */ } });
    setTimeout(() => { try { r.out.disconnect(); } catch (e) { /* gone */ } }, (FADE + 0.1) * 1000);
  }
  async function startAt(f) {
    const r = { id: ++E.runSeq, T0F: null, startF: f, sources: new Set(), scheduled: new Set(), gain: [], out: E.ctx.createGain() };
    r.out.connect(E.master);
    r.gain = E.song.stems.map((st, i) => { const g = E.ctx.createGain(); g.gain.value = E.stemGains[i]; g.connect(r.out); return g; });
    E.run = r;
    const resumed = E.ctx.state === 'running' ? null : E.ctx.resume(); // inside the tap's gesture
    const c = chunkAt(f);
    try { await Promise.all([loadChunk(c), c + 1 < E.song.chunks ? loadChunk(c + 1) : null, resumed]); }
    catch (e) { if (E.run === r) audioFailed(e); return; }
    if (E.run !== r || !E.playing) return;
    r.T0F = ctxF() + Math.round(SAFETY * E.SR) - f;
    schedule(r, c, f);
    tick();
  }
  function play() {
    if (!E.song || E.playing) return;
    if (E.pausedF >= E.durF - E.SR * 0.05) E.pausedF = 0;
    E.playing = true;
    if (E.silent) { E.silentT0 = performance.now(); ui(); return; }
    startAt(E.pausedF);
    ui();
  }
  function pause() {
    if (!E.playing) return;
    E.pausedF = posF();
    E.playing = false;
    if (!E.silent) { stopRun(E.run); E.run = null; }
    ui();
  }
  function seek(sec) {
    if (!E.song) return;
    const f = clamp(Math.round(sec * E.SR), 0, E.durF);
    if (E.playing) { pause(); E.pausedF = f; play(); } else { E.pausedF = f; tick(); }
  }
  function audioFailed(e) {
    // no Opus decoding here: the timeline still runs on a silent clock, so the fretboard keeps working
    const f = posF();
    if (E.run) { stopRun(E.run); E.run = null; }
    E.silent = true; E.pausedF = f;
    if (E.playing) E.silentT0 = performance.now();
    msg('audioMsg', 'לא הצלחתי לנגן את השמע בדפדפן הזה. אפשר להמשיך בלי צליל: הגיטרה זזה לפי השעון.', true);
    if (e) console.warn('guitar audio', e);
  }
  function setStemGains() {
    const mute = !!appPrefs.get('muteGuitar');
    E.stemGains = E.song.stems.map((st) => (mute && st.id === 'guitar' ? 0 : 1));
    if (E.run) E.run.gain.forEach((g, i) => g.gain.setTargetAtTime(E.stemGains[i], E.ctx.currentTime, 0.02));
  }

  // ---- UI
  let G = null;
  const fmt = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function msg(id, text, err) { const m = $(id); m.textContent = text || ''; m.classList.toggle('err', !!err); }
  let seeking = false;
  function ui() {
    if (!E.song) return;
    const s = posF() / E.SR, dur = E.durF / E.SR;
    const pb = $('play');
    pb.setAttribute('aria-label', E.playing ? 'עצירה' : 'ניגון');
    pb.firstElementChild.textContent = E.playing ? '❚❚' : '▶';
    if (!seeking) $('seek').value = s.toFixed(1);
    $('pos').textContent = fmt(s); $('dur').textContent = fmt(dur);
  }

  async function loadSong(src) {
    if (E.playing) pause();
    E.gen++; E.chunks.clear(); E.run = null; E.silent = false; E.pausedF = 0;
    const gen = E.gen;
    msg('audioMsg', '');
    let song, an;
    try { [song, an] = await Promise.all([src.json('song.json'), src.json('analysis.json')]); }
    catch (e) { msg('pickMsg', 'בשיר הזה חסר ניתוח אקורדים (analysis.json), לכן אי אפשר לפתוח אותו כאן.', true); return false; }
    if (gen !== E.gen) return false;
    if (!song || song.format !== 1 || !(song.chunks > 0) || !(song.chunkFrames > 0) || !Array.isArray(song.stems) || !song.stems.length || !(song.sampleRate > 0) || !(song.frames > 0)) {
      msg('pickMsg', 'קובץ השיר לא תקין (song.json).', true); return false;
    }
    const chords = Array.isArray(an && an.chords) ? an.chords.filter((c) => c && typeof c.label === 'string' && isFinite(c.t0) && isFinite(c.t1)) : [];
    if (!chords.length) { msg('pickMsg', 'בשיר הזה אין אקורדים בניתוח.', true); return false; }

    E.song = song; E.src = src;
    const ctx = ensureCtx();
    const r = E.SR / song.sampleRate, sec = (f) => Math.round(f * r);
    E.Lf = sec(song.chunkFrames); E.Xf = Math.max(1, sec(song.xfadeFrames || 0)); E.Mf = sec(song.marginFrames || 0);
    E.durF = Math.floor(song.frames * r);
    setStemGains();
    if (!ctx) audioFailed(null); else calibrate(gen);

    $('title').textContent = src.title || song.title || src.id;
    const artist = src.artist || song.artist || '';
    $('artist').textContent = artist; $('artist').hidden = !artist;
    document.title = (src.title || song.title || src.id) + ' · גיטרה';
    const key = an.keySections && an.keySections.length ? an.keySections : { key: an.key, mode: an.mode };
    const keyTxt = an.key ? 'סולם ' + Guitar.keyLabel({ key: an.key, mode: an.mode }) : '';
    $('meta').textContent = [keyTxt, an.bpm ? 'קצב ' + Math.round(an.bpm) : ''].filter(Boolean).join(' · ');
    $('noGtr').hidden = !song.stems.some((st) => st.id === 'guitar');
    $('noGtr').setAttribute('aria-pressed', String(!!appPrefs.get('muteGuitar')));
    $('seek').max = (E.durF / E.SR).toFixed(1);
    $('pick').hidden = true; $('player').hidden = false; $('gtrHost').hidden = false;
    if (!G) G = Guitar.mount($('gtrHost'), { getTime: audibleSec, chords, key, semi: 0, rtl: true, songId: src.id });
    else G.update({ chords, key, semi: 0, songId: src.id });
    window.__guitar = { G, E, audibleSec, seek, play, pause };
    msg('pickMsg', '');
    ui(); tick();
    return true;
  }

  async function openFile(file) {
    if (!file) return;
    msg('pickMsg', 'בודק את הקובץ…');
    try {
      const pk = await GuitarPack.open(GuitarPack.fromBlob(file), {
        progress: (d, t) => msg('pickMsg', 'בודק את הקובץ… ' + Math.round(d / t * 100) + '%'),
      });
      await loadSong(packSource(pk));
    } catch (e) {
      msg('pickMsg', e instanceof GuitarPack.PackError ? e.message : 'לא הצלחתי לפתוח את הקובץ.', true);
      if (!(e instanceof GuitarPack.PackError)) console.warn('guitar open', e);
    }
  }

  async function listFolder() {
    const base = new URLSearchParams(location.search).get('songs') || 'songs/';
    const dir = base.endsWith('/') ? base : base + '/';
    let idx;
    try { const r = await fetch(dir + 'index.json'); if (!r.ok) return; idx = await r.json(); } catch (e) { return; }
    const songs = idx && Array.isArray(idx.songs) ? idx.songs.filter((s) => s && typeof s.id === 'string' && GuitarPack._.ID.test(s.id)) : [];
    if (!songs.length) return;
    const ul = $('folderList'); ul.textContent = '';
    for (const s of songs) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      const t = document.createElement('span'); t.className = 't'; t.textContent = s.title || s.id;
      const a = document.createElement('span'); a.className = 'a'; a.textContent = s.artist || '';
      b.append(t, a);
      b.addEventListener('click', () => { msg('pickMsg', 'פותח…'); loadSong(folderSource(dir, s)); });
      li.append(b); ul.append(li);
    }
    $('folder').hidden = false;
    const want = new URLSearchParams(location.search).get('song');
    const pre = want && songs.find((s) => s.id === want);
    if (pre) loadSong(folderSource(dir, pre));
  }

  $('file').addEventListener('change', (e) => { openFile(e.target.files && e.target.files[0]); e.target.value = ''; });
  $('play').addEventListener('click', () => (E.playing ? pause() : play()));
  const sk = $('seek');
  sk.addEventListener('input', () => { seeking = true; $('pos').textContent = fmt(+sk.value); if (!E.playing) { E.pausedF = Math.round(+sk.value * E.SR); } });
  sk.addEventListener('change', () => { seeking = false; seek(+sk.value); });
  $('noGtr').addEventListener('click', () => {
    const v = !appPrefs.get('muteGuitar'); appPrefs.set('muteGuitar', v);
    $('noGtr').setAttribute('aria-pressed', String(v)); if (E.song) setStemGains();
  });
  $('other').addEventListener('click', () => { pause(); $('pick').hidden = false; $('player').hidden = true; $('gtrHost').hidden = true; $('title').textContent = 'בחירת שיר'; $('artist').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !E.song || /^(INPUT|BUTTON)$/.test(e.target.tagName)) return;
    e.preventDefault(); E.playing ? pause() : play();
  });
  E.timer = setInterval(tick, 200);
  listFolder();
})();
