const API = 'http://127.0.0.1:8765';
const MIDI_MIN = 24;
const MIDI_MAX = 95;

const ui = {
  startPage: document.getElementById('startPage'),
  annotPage: document.getElementById('annotPage'),
  enterBtn: document.getElementById('enterBtn'),
  saveDirInput: document.getElementById('saveDirInput'),
  nextBtn: document.getElementById('nextBtn'),
  skipBtn: document.getElementById('skipBtn'),
  audio: document.getElementById('audio'),
  audioVol: document.getElementById('audioVol'),
  noteVol: document.getElementById('noteVol'),
  mixPlayBtn: document.getElementById('mixPlayBtn'),
  status: document.getElementById('status'),
  meta: document.getElementById('meta'),
  text: document.getElementById('text'),
  midi: document.getElementById('midi'),
  spec: document.getElementById('spec'),
  notes: document.getElementById('notes'),
  piano: document.getElementById('piano')
};

const state = {
  started: false,
  current: null,
  audioUrl: null,
  audioBuffer: null,
  notes: [],
  selectedIds: new Set(),
  hoverId: null,
  statusBase: '未开始',
  statusTimer: null,
  audioVolume: 0.85,
  noteVolume: 0.35,
  mixTimer: null,
  mixTriggered: new Set(),
  entering: false
};

let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function setStatus(msg) {
  state.statusBase = msg;
  ui.status.textContent = msg;
}

function applyMixVolumes() {
  ui.audio.volume = clamp(Number(state.audioVolume || 0), 0, 1);
}

async function refreshDownloadStatus() {
  if (!state.started) return;
  try {
    const data = await post('/status', {});
    const states = Object.values(data.worker_states || {});
    const summary = states.slice(0, 3).map((s) => s.phase).join(', ');
    const detail = states.find((s) => s.detail)?.detail || '';
    ui.status.textContent = `${state.statusBase} | 队列 ${data.queue_size}/${data.queue_max}${summary ? ` | 线程: ${summary}` : ''}${detail ? ` | ${detail}` : ''}`;
  } catch {
    ui.status.textContent = `${state.statusBase} | 状态获取失败`;
  }
}

function ensureStatusPolling() {
  if (state.statusTimer) return;
  state.statusTimer = setInterval(refreshDownloadStatus, 1000);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function midiToName(m) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const name = names[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

function yToMidi(y, h) {
  const ratio = 1 - y / h;
  return Math.round(clamp(MIDI_MIN + ratio * (MIDI_MAX - MIDI_MIN), MIDI_MIN, MIDI_MAX));
}

function midiToY(m, h) {
  const ratio = (m - MIDI_MIN) / (MIDI_MAX - MIDI_MIN);
  return (1 - ratio) * h;
}

function tToX(t, dur, w) {
  return dur <= 0 ? 0 : (t / dur) * w;
}

function xToT(x, dur, w) {
  return w <= 0 ? 0 : (x / w) * dur;
}

function parseMidiInput(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => clamp(Math.round(n), 0, 127));
}

function isValidChordText(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  if (text === 'N') return true; // 没有和弦
  if (text === 'M') return true; // 多个和弦
  if (text === 'S') return true; // 微分和弦
  const re = /^(C|C#|D|D#|E|F|F#|G|G#|A|A#|B):(maj|min|dom|dim|aug|N)(?:\/(C|C#|D|D#|E|F|F#|G|G#|A|A#|B))?$/;
  return re.test(text);
}

function syncMidiTextFromNotes() {
  const seq = [...state.notes].map((n) => n.midi).sort((a, b) => a - b);
  ui.midi.value = seq.join(',');
}

function drawPiano() {
  const c = ui.piano;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  const pitchNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 1) {
    const y1 = midiToY(m + 0.5, h);
    const y0 = midiToY(m - 0.5, h);
    const hh = y0 - y1;
    const black = [1, 3, 6, 8, 10].includes(m % 12);
    ctx.fillStyle = black ? '#1f2937' : '#f8fafc';
    ctx.fillRect(0, y1, w, hh);
    ctx.strokeStyle = '#cbd5e1';
    ctx.strokeRect(0, y1, w, hh);
    if (!black && m % 12 === 0) {
      const octave = Math.floor(m / 12) - 1;
      ctx.fillStyle = '#475569';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${pitchNames[m % 12]}${octave}`, 4, y1 + 10);
    }
  }
}

function drawGrid() {
  const c = ui.notes;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  const dur = Math.max(0.5, ui.audio.duration || 0.5);

  ctx.clearRect(0, 0, w, h);
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 1) {
    const y = midiToY(m, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const step = 0.05;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = tToX(t, dur, w);
    ctx.strokeStyle = Math.round(t * 100) % 50 === 0 ? 'rgba(148,163,184,0.45)' : 'rgba(148,163,184,0.22)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawNotes() {
  drawGrid();
  const c = ui.notes;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  const nh = Math.max(5, h / (MIDI_MAX - MIDI_MIN + 1));
  state.notes.forEach((n) => {
    const y = midiToY(n.midi, h);
    const selected = state.selectedIds.has(n.id);
    ctx.fillStyle = selected ? 'rgba(245,158,11,0.88)' : 'rgba(37,99,235,0.85)';
    ctx.fillRect(0, y - nh * 0.5, w, nh);
    ctx.strokeStyle = selected ? '#b45309' : '#1d4ed8';
    ctx.strokeRect(0, y - nh * 0.5, w, nh);
    if (state.hoverId === n.id) {
      const label = midiToName(n.midi);
      ctx.font = '12px sans-serif';
      const tw = ctx.measureText(label).width;
      const tx = Math.max(4, w - tw - 8);
      const ty = Math.max(12, y - nh * 0.5 - 4);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(tx - 4, ty - 11, tw + 8, 14);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(label, tx, ty);
    }
  });
}

function playPreview(midi, sec = 0.22) {
  const ctx = ensureAudioCtx();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = midiToFreq(midi);
  gain.gain.setValueAtTime(clamp(state.noteVolume, 0, 1), now);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + sec);
}

function playSynthNoteAt(midi, startAt, dur) {
  const ctx = ensureAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = midiToFreq(midi);
  const v = clamp(state.noteVolume, 0, 1);
  gain.gain.setValueAtTime(v, startAt);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + Math.max(0.02, dur));
}

function runMixScheduler() {}

function stopMixScheduler() {
  if (state.mixTimer) {
    clearInterval(state.mixTimer);
    state.mixTimer = null;
  }
}

function computeSpecAndDraw(buffer) {
  const c = ui.spec;
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = 1024;
  const hop = 128;
  const frames = Math.max(1, Math.floor((data.length - win) / hop));

  for (let x = 0; x < w; x += 1) {
    const fi = Math.floor((x / w) * frames);
    const off = fi * hop;
    for (let m = MIDI_MIN; m <= MIDI_MAX; m += 1) {
      const freq = midiToFreq(m);
      const k = 2 * Math.PI * freq / sr;
      let re = 0;
      let im = 0;
      for (let n = 0; n < win; n += 1) {
        const s = data[Math.min(data.length - 1, off + n)] || 0;
        const wv = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (win - 1));
        const ang = k * n;
        re += s * wv * Math.cos(ang);
        im -= s * wv * Math.sin(ang);
      }
      const mag = Math.log1p(Math.sqrt(re * re + im * im));
      const v = clamp(mag / 5, 0, 1);
      const y = midiToY(m, h);
      const hh = h / (MIDI_MAX - MIDI_MIN + 1);
      const r = Math.floor(10 + 90 * v);
      const g = Math.floor(20 + 120 * v);
      const b = Math.floor(30 + 230 * v);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y - hh * 0.5, 1, hh + 1);
    }
  }
}

async function post(path, payload = {}) {
  const resp = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}

async function decodeLoadedAudio(blob) {
  const ab = await blob.arrayBuffer();
  const ctx = ensureAudioCtx();
  state.audioBuffer = await ctx.decodeAudioData(ab.slice(0));
  computeSpecAndDraw(state.audioBuffer);
  drawNotes();
}

function newNote(start, end, midi) {
  return {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    start,
    end,
    midi
  };
}

function loadSample(sample) {
  state.current = sample;
  state.notes = [];
  state.selectedIds.clear();
  syncMidiTextFromNotes();
  const bytes = Uint8Array.from(atob(sample.audio_b64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(blob);
  ui.audio.src = state.audioUrl;
  applyMixVolumes();
  ui.meta.textContent = `编号 ${sample.index} | 截取 ${sample.start.toFixed(3)}s ~ ${(sample.start + sample.duration).toFixed(3)}s | ${sample.url}`;
  decodeLoadedAudio(blob).catch((e) => setStatus(e.message || '频谱分析失败'));
}

function canvasMetrics(evt) {
  const rect = ui.notes.getBoundingClientRect();
  const w = ui.notes.width;
  const h = ui.notes.height;
  const dur = Math.max(0.5, ui.audio.duration || 0.5);
  const x = ((evt.clientX - rect.left) / rect.width) * w;
  const y = ((evt.clientY - rect.top) / rect.height) * h;
  return { rect, w, h, dur, x, y };
}

function hitTest(y, h) {
  const nh = Math.max(5, h / (MIDI_MAX - MIDI_MIN + 1));
  const edgePx = 6;
  for (let i = state.notes.length - 1; i >= 0; i -= 1) {
    const n = state.notes[i];
    const yy = midiToY(n.midi, h);
    if (y >= yy - nh * 0.5 - edgePx && y <= yy + nh * 0.5 + edgePx) {
      return { note: n };
    }
  }
  return null;
}

ui.notes.addEventListener('pointerdown', (evt) => {
  if (evt.button === 2) evt.preventDefault();
  const { h, y } = canvasMetrics(evt);
  const hit = hitTest(y, h);
  if (evt.button === 2) {
    if (hit) {
      state.notes = state.notes.filter((n) => n.id !== hit.note.id);
      state.selectedIds.delete(hit.note.id);
      drawNotes();
      syncMidiTextFromNotes();
    }
    return;
  }
  if (evt.button !== 0) return;
  if (hit) {
    state.selectedIds.clear();
    state.selectedIds.add(hit.note.id);
    drawNotes();
    playPreview(hit.note.midi, 0.25);
    return;
  }
  const midi = yToMidi(y, h);
  const note = newNote(0, Math.max(0.5, ui.audio.duration || 0.5), midi);
  state.notes.push(note);
  state.selectedIds.clear();
  state.selectedIds.add(note.id);
  drawNotes();
  syncMidiTextFromNotes();
  playPreview(midi, 0.25);
});

ui.notes.addEventListener('contextmenu', (evt) => {
  evt.preventDefault();
});

ui.notes.addEventListener('pointermove', (evt) => {
  const { h, y } = canvasMetrics(evt);
  const hit = hitTest(y, h);
  const nextHoverId = hit ? hit.note.id : null;
  if (nextHoverId !== state.hoverId) {
    state.hoverId = nextHoverId;
    drawNotes();
  }
});

ui.notes.addEventListener('pointerleave', () => {
  if (state.hoverId !== null) {
    state.hoverId = null;
    drawNotes();
  }
});

ui.midi.addEventListener('change', () => {
  const mids = parseMidiInput(ui.midi.value);
  const dur = Math.max(0.5, ui.audio.duration || 0.5);
  if (!mids.length) {
    state.notes = [];
    state.selectedIds.clear();
    drawNotes();
    return;
  }
  // 文本输入只表示音符集合，首尾时刻不重要：按固定短时值顺序摆放即可。
  state.notes = mids.map((m) => newNote(0, dur, m));
  state.selectedIds.clear();
  drawNotes();
});

if (ui.enterBtn) {
  ui.enterBtn.addEventListener('click', async () => {
    if (state.entering) return;
    try {
      state.entering = true;
      ui.enterBtn.disabled = true;
      ui.enterBtn.textContent = '加载中...';
      const dir = (ui.saveDirInput?.value || '').trim();
      if (!dir) return;
      setStatus('初始化中：正在准备首条候选音频...');
      const data = await post('/start', { save_dir: dir });
      state.started = true;
      ensureStatusPolling();
      ui.startPage?.classList.add('hidden');
      ui.annotPage?.classList.remove('hidden');
      loadSample(data.sample);
      ui.text.value = '';
      setStatus(`已开始，当前编号 ${data.sample.index}`);
    } catch (e) {
      setStatus(e.message || '开始失败');
    } finally {
      state.entering = false;
      if (!state.started) {
        ui.enterBtn.disabled = false;
        ui.enterBtn.textContent = '开始';
      }
    }
  });
}

ui.nextBtn.addEventListener('click', async () => {
  if (!state.started) return setStatus('请先点击开始');
  try {
    const chordText = ui.text.value.trim();
    if (!isValidChordText(chordText)) {
      setStatus('和弦格式错误：仅支持 N、G:maj、D:maj/G');
      return;
    }
    setStatus('保存并下载下一条...');
    const midi = parseMidiInput(ui.midi.value);
    const data = await post('/save_and_next', { text: chordText, midi });
    loadSample(data.sample);
    ui.text.value = '';
    setStatus(`已保存 #${data.saved_index}，当前 #${data.sample.index}`);
    refreshDownloadStatus();
  } catch (e) {
    setStatus(e.message || '保存失败');
  }
});

ui.skipBtn.addEventListener('click', async () => {
  if (!state.started) return setStatus('请先点击开始');
  try {
    setStatus('跳过并下载下一条...');
    const data = await post('/skip_and_next');
    loadSample(data.sample);
    ui.text.value = '';
    setStatus(`已跳过，当前 #${data.sample.index}`);
    refreshDownloadStatus();
  } catch (e) {
    setStatus(e.message || '跳过失败');
  }
});

drawPiano();
drawNotes();

if (ui.audioVol) {
  ui.audioVol.addEventListener('input', () => {
    state.audioVolume = Number(ui.audioVol.value || 0.85);
    applyMixVolumes();
  });
}
if (ui.noteVol) {
  ui.noteVol.addEventListener('input', () => {
    state.noteVolume = Number(ui.noteVol.value || 0.35);
  });
}
if (ui.mixPlayBtn) {
  ui.mixPlayBtn.addEventListener('click', async () => {
    if (!ui.audio.src) return;
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    ui.audio.currentTime = 0;
    const dur = Math.max(0.5, ui.audio.duration || 0.5);
    const when = ctx.currentTime;
    state.notes.forEach((n) => playSynthNoteAt(n.midi, when, dur));
    await ui.audio.play();
  });
}
ui.audio.addEventListener('pause', stopMixScheduler);
ui.audio.addEventListener('ended', stopMixScheduler);
ui.audio.addEventListener('seeking', () => {
  state.mixTriggered.clear();
});
applyMixVolumes();
