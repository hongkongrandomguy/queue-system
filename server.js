const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 預設設定（可於 /admin 修改） ---------------- */
let state = {
  settings: {
    title: 'Queue Up',
    subtitle: '請排队取號',
    note: 'Please keep your ticket and watch the display. 請保留籌號並留意大屏幕。',
    counters: [
      { id: 1, name: 'Counter 1', nameZh: '一號櫃位' },
      { id: 2, name: 'Counter 2', nameZh: '二號櫃位' }
    ],
    tts: { languages: ['en', 'yue', 'zh'], rate: 1, volume: 1, repeat: 1 }
  },
  session: { prefix: 'A', next: 1 },   // 時段：A001 開始，轉時段自動 B、C…
  tickets: [],                          // {no, label, time, status, counter}
  lastCall: null
};

function load() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE))); } catch (e) {}
}
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
function nowLabel() { return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function waiting() { return state.tickets.filter(t => t.status === 'waiting'); }
function label(n) { return state.session.prefix + String(n).padStart(3, '0'); }
function broadcast() { io.emit('state', state); }
function change() { save(); broadcast(); }
load();

/* ---------------- API ---------------- */
app.get('/api/state', (req, res) => res.json(state));

// 取號
app.post('/api/ticket', (req, res) => {
  const n = state.session.next++;
  const t = { no: n, label: label(n), time: nowLabel(), status: 'waiting', counter: null };
  state.tickets.push(t);
  state.lastCall = null;               // 出新籌時清除大屏「請稍候」
  change();
  res.json(t);
});

// 櫃位：呼叫下一位
app.post('/api/counter/:id/next', (req, res) => {
  const id = Number(req.params.id);
  const t = waiting().sort((a, b) => a.no - b.no)[0];
  if (!t) return res.json({ ok: false, reason: 'empty' });
  t.status = 'called'; t.counter = id;
  state.lastCall = { ticket: t, counter: id, at: Date.now(), seq: (state.lastCall?.seq || 0) + 1 };
  change();
  res.json({ ok: true, ticket: t });
});

// 櫃位：重新呼叫
app.post('/api/counter/:id/recall', (req, res) => {
  const id = Number(req.params.id);
  const t = state.tickets.find(t => t.status === 'called' && t.counter === id);
  if (!t) return res.json({ ok: false });
  state.lastCall = { ticket: t, counter: id, at: Date.now(), seq: (state.lastCall?.seq || 0) + 1 };
  change();
  res.json({ ok: true, ticket: t });
});

// 櫃位：指定號碼
app.post('/api/counter/:id/call', (req, res) => {
  const id = Number(req.params.id);
  const raw = String(req.body.no || '').toUpperCase().trim();
  const num = Number(raw.replace(/^[A-Z]+/, ''));
  const t = state.tickets.find(t => t.no === num && t.status !== 'done');
  if (!t) return res.status(404).json({ ok: false, reason: 'not found' });
  t.status = 'called'; t.counter = id;
  state.lastCall = { ticket: t, counter: id, at: Date.now(), seq: (state.lastCall?.seq || 0) + 1 };
  change();
  res.json({ ok: true, ticket: t });
});

// 櫃位：完成
app.post('/api/counter/:id/complete', (req, res) => {
  const id = Number(req.params.id);
  const t = state.tickets.find(t => t.status === 'called' && t.counter === id);
  if (!t) return res.json({ ok: false });
  t.status = 'done';
  change();
  res.json({ ok: true });
});

// 管理：設定時段前綴並重設號碼（例如手動由 A 轉 B）
app.post('/api/session/prefix', (req, res) => {
  const p = String(req.body.prefix || 'A').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'A';
  state.session = { prefix: p, next: 1 };
  state.lastCall = null;
  change();
  res.json(state.session);
});

// 管理：進入下一時段（A→B→C，號碼自動重設）
app.post('/api/session/advance', (req, res) => {
  const cur = state.session.prefix;
  const nextChar = cur.length === 1 ? String.fromCharCode(cur.charCodeAt(0) + 1) : cur + 'A';
  state.session = { prefix: nextChar, next: 1 };
  state.lastCall = null;
  change();
  res.json(state.session);
});

// 管理：更新設定（標題、櫃位、TTS 等）
app.post('/api/settings', (req, res) => {
  state.settings = { ...state.settings, ...req.body };
  change();
  res.json(state.settings);
});

/* ---------------- Socket.IO ---------------- */
io.on('connection', (socket) => socket.emit('state', state));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Queue system running at http://localhost:${PORT}`);
});
