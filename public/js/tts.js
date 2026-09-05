/* 1:1 移植 Node.js Edge TTS 邏輯 + Google TTS 兜底 */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0, edgeAbort = null;
const wait = ms => new Promise(r => setTimeout(r, ms));

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_VERSION = '1-130.0.2849.68';

const TTS_LANG = { en:'en-US', yue:'zh-HK', zh:'zh-CN' };
const G_LANG = { 'en-US':'en', 'zh-HK':'zh-HK', 'zh-CN':'zh-CN' };
const EDGE_VOICES = { 'en-US':'en-US-AriaNeural', 'zh-HK':'zh-HK-HiuGaaiNeural', 'zh-CN':'zh-CN-XiaoxiaoNeural' };
const TTS_DIG = {
  en:['zero','one','two','three','four','five','six','seven','eight','nine'],
  yue:['零','一','二','三','四','五','六','七','八','九'],
  zh:['零','一','二','三','四','五','六','七','八','九']
};
const TTS_WORDS = {
  en:{ Ticket:'Ticket', counter:'please go to counter' },
  yue:{ ticket:'籌號', goto:'請往', suffix:'號櫃位' },
  zh:{ ticket:'筹号', goto:'请到', suffix:'号柜台' }
};

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function ttsInfoFor(path){
  const i = path.indexOf('/');
  if (i < 0) return null;
  const lang = path.slice(0, i), key = path.slice(i + 1);
  if (/^[0-9]$/.test(key)) return { text: TTS_DIG[lang][+key], lang: TTS_LANG[lang] };
  if (/^[A-Z]$/.test(key)) return { text: key, lang: 'en-US' };
  const w = TTS_WORDS[lang] && TTS_WORDS[lang][key];
  return w ? { text: w, lang: TTS_LANG[lang] } : null;
}

/* ===== 1:1 移植 Node.js secMsGec 算法 ===== */
async function secMsGec() {
  const ticks = Math.floor(Date.now() / 1000 / 300) * 300;
  const data = `${ticks}Z${TOKEN}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ===== Edge TTS WebSocket (單次嘗試) ===== */
function edgeFetchOnce(text, langCode, token) {
  return new Promise(res => {
    const connId = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').toUpperCase() : String(Date.now()) + Math.random().toString().slice(2).toUpperCase());
    const url = `${ENDPOINT}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${EDGE_VERSION}&ConnectionId=${connId}`;
    let ws;
    try { ws = new WebSocket(url); } catch(e) { return res(null); }
    
    const chunks = [];
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      edgeAbort = null;
      try { ws.close(); } catch(e) {}
      if (!ok || !chunks.length) return res(null);
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      const blob = new Blob([merged], { type: 'audio/mp3' });
      const f = new FileReader();
      f.onload = () => res(f.result);
      f.onerror = () => res(null);
      f.readAsDataURL(blob);
    };
    edgeAbort = () => finish(false);
    
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const ts = new Date().toUTCString();
      const format = 'audio-24khz-48kbitrate-mono-mp3';
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${format}"}}}}`);
      const voice = EDGE_VOICES[langCode] || EDGE_VOICES['en-US'];
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${langCode}'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(ev.data);
        let i = -1;
        for (let j = 0; j < buf.length - 3; j++) {
          if (buf[j] === 13 && buf[j+1] === 10 && buf[j+2] === 13 && buf[j+3] === 10) { i = j; break; }
        }
        if (i !== -1 && buf.length > i + 4) chunks.push(buf.slice(i + 4));
      } else if (typeof ev.data === 'string' && ev.data.includes('Path:turn.end')) {
        finish(true);
      }
    };
    
    ws.onerror = () => { console.warn('[TTS] Edge WS 連線失敗 (可能因瀏覽器無法偽裝 Origin Header)'); finish(false); };
    ws.onclose = () => finish(chunks.length > 0);
    setTimeout(() => finish(chunks.length > 0), 10000);
  });
}

async function edgeFetch(text, langCode) {
  const token = await secMsGec();
  return await edgeFetchOnce(text, langCode, token);
}

/* ===== Google TTS 兜底 (港普) ===== */
function googleSpeak(text, langCode) {
  return new Promise(res => {
    const my = announceToken;
    if (announceToken !== my) return res(false);
    const tl = G_LANG[langCode] || 'en';
    const clients = ['gtx', 'tw-ob'];
    let i = 0;
    const attempt = () => {
      if (announceToken !== my) return res(false);
      if (i >= clients.length) return res(false);
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=${clients[i++]}&tl=${tl}&q=${encodeURIComponent(text)}`;
      const a = new Audio(url);
      currentAudio = a; currentResolve = () => res(true);
      a.onended = () => { currentAudio = null; currentResolve = null; res(true); };
      a.onerror = () => { currentAudio = null; currentResolve = null; attempt(); };
      a.play().catch(() => attempt());
    };
    attempt();
  });
}

/* ===== 朗讀文字：Edge → Google ===== */
async function speakText(text, langCode){
  const my = announceToken;
  if (!text || !text.trim()) return;
  const edgeData = await edgeFetch(text, langCode);
  if (edgeData && announceToken === my) {
    console.log('[TTS] Edge 成功:', langCode, text);
    const a = new Audio(edgeData);
    currentAudio = a;
    return new Promise(res => {
      currentResolve = res;
      a.onended = () => { currentAudio=null; currentResolve=null; res(); };
      a.play().catch(() => res());
    });
  }
  if (announceToken === my) {
    console.warn('[TTS] Edge 失敗，跌落 Google TTS:', text);
    await googleSpeak(text, langCode);
  }
}

/* ===== 播放 clip ===== */
function playClip(path){
  const my = announceToken;
  return new Promise(res => {
    const tries = ['audio/' + path + AUDIO_EXT, '../audio/' + path + AUDIO_EXT];
    let i = 0;
    const attempt = () => {
      if (announceToken !== my) return res();
      if (i < tries.length){
        const a = new Audio(tries[i++]);
        currentAudio = a; currentResolve = res;
        a.onended = () => { currentAudio=null; currentResolve=null; res(); };
        a.onerror = () => { currentAudio=null; currentResolve=null; attempt(); };
        a.play().catch(() => attempt());
      } else {
        const info = ttsInfoFor(path);
        if (!info) return res();
        speakText(info.text, info.lang).then(res);
      }
    };
    attempt();
  });
}
function stopAudio(){
  announceToken++;
  if (currentAudio) currentAudio.pause();
  if (edgeAbort) edgeAbort();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const r = currentResolve; currentAudio=null; currentResolve=null;
  if (r) r();
}
function chime(){ return playClip('chime'); }

function counterNum(counter){
  let raw = '1';
  if (counter && counter.name){ const n = String(counter.name).replace(/\D/g,''); if (n) raw = n; }
  return raw;
}

function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'').split('');
  const digits  = numLabel.replace(/[A-Z]/g,'').split('');
  const cid = counterNum(counter).split('');
  if (lang === 'en'){
    return ['en/Ticket', ...letters.map(l=>'en/'+l), ...digits.map(d=>'en/'+d), 'en/counter', ...cid.map(d=>'en/'+d)];
  }
  if (lang === 'yue'){
    return ['yue/ticket', ...letters.map(l=>'yue/'+l), ...digits.map(d=>'yue/'+d), 'yue/goto', ...cid.map(d=>'yue/'+d), 'yue/suffix'];
  }
  return ['zh/ticket', ...letters.map(l=>'zh/'+l), ...digits.map(d=>'zh/'+d), 'zh/goto', ...cid.map(d=>'zh/+d'), 'zh/suffix'];
}

async function announce(languages, opts, cancel){
  if (cancel) stopAudio();
  const my = announceToken;
  const reps = (opts && opts.repeat) ? opts.repeat : 1;
  for (const lang of languages){
    const seq = opts.phrases && opts.phrases[lang];
    if (!seq) continue;
    for (let i=0; i<reps; i++){
      if (announceToken !== my) return;
      await chime();
      if (announceToken !== my) return;
      await wait(300);
      for (const p of seq){
        if (announceToken !== my) return;
        await playClip(p);
        await wait(150);
      }
      await wait(400);
    }
  }
}
