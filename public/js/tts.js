/* 音檔優先 → Edge 神經 TTS（最新 Sec-MS-GEC 算法）→ Chrome 語音兜底 */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0, edgeAbort = null;
const wait = ms => new Promise(r => setTimeout(r, ms));
const escapeXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const TTS_LANG = { en:'en-US', yue:'zh-HK', zh:'zh-CN' };
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
const EDGE_VOICES = { 'en-US':'en-US-AriaNeural', 'zh-HK':'zh-HK-HiuGaaiNeural', 'zh-CN':'zh-CN-XiaoxiaoNeural' };
const CLIP_WORDS = {
  en:{ 'please go to counter':'en/counter', 'ticket':'en/Ticket' },
  yue:{ '請往':'yue/goto', '號櫃位':'yue/suffix', '籌號':'yue/ticket' },
  zh:{ '请到':'zh/goto', '号柜台':'zh/suffix', '筹号':'zh/ticket' }
};

function ttsInfoFor(path){
  const i = path.indexOf('/');
  if (i < 0) return null;
  const lang = path.slice(0, i), key = path.slice(i + 1);
  if (/^[0-9]$/.test(key)) return { text: TTS_DIG[lang][+key], lang: TTS_LANG[lang] };
  if (/^[A-Z]$/.test(key)) return { text: key, lang: 'en-US' };
  const w = TTS_WORDS[lang] && TTS_WORDS[lang][key];
  return w ? { text: w, lang: TTS_LANG[lang] } : null;
}

/* ===== 音檔存在檢查 ===== */
const clipCache = {};
async function clipExists(path){
  if (path in clipCache) return clipCache[path];
  let v = false;
  try{
    const r = await fetch('audio/' + path + AUDIO_EXT, { method:'HEAD' });
    if (r.ok) v = true;
    else {
      const r2 = await fetch('../audio/' + path + AUDIO_EXT, { method:'HEAD' });
      v = r2.ok;
    }
  }catch(e){ v = false; }
  clipCache[path] = v;
  return v;
}

/* ===== Sec-MS-GEC token（1:1 移植 Node.js 成功算法） ===== */
async function secMsGec() {
  const ticks = Math.floor(Date.now() / 1000 / 300) * 300;
  const data = `${ticks}Z6A5AA1D4EAFF4E9FB37E23D68491D6F4`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ===== Edge 神經 TTS（單次嘗試） ===== */
function edgeFetchOnce(text, langCode, token) {
  return new Promise(res => {
    const connId = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').toUpperCase() : String(Date.now()) + Math.random().toString().slice(2).toUpperCase());
    const EDGE_VERSION = '1-130.0.2849.68';
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${EDGE_VERSION}&ConnectionId=${connId}`;
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
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${format}"}}}}`
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${langCode}'>` +
        `<voice name='${EDGE_VOICES[langCode] || EDGE_VOICES['en-US']}'>` +
        `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody>` +
        `</voice></speak>`;
      ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(ev.data);
        let i = -1;
        for (let j = 0; j < buf.length - 3; j++) {
          if (buf[j] === 13 && buf[j+1] === 10 && buf[j+2] === 13 && buf[j+3] === 10) {
            i = j;
            break;
          }
        }
        if (i !== -1 && buf.length > i + 4) {
          chunks.push(buf.slice(i + 4));
        }
      } else if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) {
          finish(true);
        }
      }
    };
    
    ws.onerror = () => { console.warn('[TTS] Edge WS 連線失敗'); finish(false); };
    ws.onclose = () => finish(chunks.length > 0);
    setTimeout(() => finish(chunks.length > 0), 10000);
  });
}

async function edgeFetch(text, langCode) {
  const token = await secMsGec();
  return await edgeFetchOnce(text, langCode, token);
}

/* ===== 朗讀文字（快取 → Edge → Chrome 兜底） ===== */
const VOICE_PREF = ['Google','HiuGaai','Xiaoxiao','Aria','Online (Natural)','Neural','Natural'];
function browserSpeak(text, langCode) {
  return new Promise(res => {
    const my = announceToken;
    if (announceToken !== my) return res();
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode; u.rate = 0.95; u.volume = 1;
    const vs = speechSynthesis.getVoices();
    const lang2 = langCode.slice(0,2).toLowerCase();
    let v = null;
    for (const p of VOICE_PREF){ if (!v) v = vs.find(x => x.name.includes(p) && x.lang.toLowerCase().startsWith(lang2)); }
    for (const p of VOICE_PREF){ if (!v) v = vs.find(x => x.name.includes(p)); }
    if (!v) v = vs.find(x => x.lang.toLowerCase().replace('-','_') === langCode.toLowerCase().replace('-','_'));
    if (!v) v = vs.find(x => x.lang.toLowerCase().startsWith(lang2));
    if (v) u.voice = v;
    console.warn('[TTS] Chrome 聲音：', (v && v.name) || 'default', text);
    u.onend = () => res(); u.onerror = () => res();
    speechSynthesis.speak(u);
  });
}

function speakText(text, langCode){
  return new Promise(res => {
    const my = announceToken;
    if (!text || !text.trim()) return res();
    const ck = 'edgeT5_' + langCode + '_' + text;
    const playSrc = src => {
      if (announceToken !== my) return res();
      const a = new Audio(src);
      currentAudio = a; currentResolve = res;
      a.onended = () => { currentAudio=null; currentResolve=null; res(); };
      a.onerror = () => { currentAudio=null; currentResolve=null; browserSpeak(text, langCode).then(res); };
      a.play().catch(() => browserSpeak(text, langCode).then(res));
    };
    const cached = localStorage.getItem(ck);
    if (cached) return playSrc(cached);
    edgeFetch(text, langCode).then(data => {
      if (announceToken !== my) return res();
      if (data){ console.log('[TTS] Edge neural 女聲：', langCode, text); try{ localStorage.setItem(ck, data); }catch(e){} playSrc(data); }
      else { console.warn('[TTS] Edge 失敗 → Chrome 兜底：', text); browserSpeak(text, langCode).then(res); }
    });
  });
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

/* ===== 自定義廣播詞解析 ===== */
function counterNum(counter){
  let raw = '1';
  if (counter && counter.name){ const n = String(counter.name).replace(/\D/g,''); if (n) raw = n; }
  return raw;
}
function literalSeq(lang, text){
  const items = []; let buf = '';
  const words = CLIP_WORDS[lang] || {};
  const keys = Object.keys(words).sort((a,b) => b.length - a.length);
  const lower = text.toLowerCase();
  const flush = () => { if (buf.trim()){ items.push({ t: buf.trim() }); buf = ''; } };
  let i = 0;
  while (i < text.length){
    const ch = text[i];
    if (/[0-9]/.test(ch)){ flush(); items.push({ c: lang + '/' + ch }); i++; continue; }
    let matched = null;
    for (const k of keys){ if (lower.startsWith(k.toLowerCase(), i)){ matched = k; break; } }
    if (matched){ flush(); items.push({ c: words[matched] }); i += matched.length; continue; }
    if (/[A-Za-z]/.test(ch)){
      const standalone = !/[A-Za-z]/.test(text[i-1] || '') && !/[A-Za-z]/.test(text[i+1] || '');
      if (standalone){ flush(); items.push({ c: lang + '/' + ch.toUpperCase() }); i++; continue; }
      buf += ch; i++; continue;
    }
    buf += ch; i++;
  }
  flush();
  return items;
}
function parseCustom(lang, tpl, label, counter){
  const num = counterNum(counter);
  const parts = tpl.split(/(\{label\}|\{counter\}|\{name\}|\{nameZh\})/);
  const seq = [];
  for (const part of parts){
    if (!part) continue;
    if (part === '{label}'){
      for (const ch of label){
        if (/[0-9]/.test(ch)) seq.push({ c: lang + '/' + ch });
        else if (/[A-Za-z]/.test(ch)) seq.push({ c: lang + '/' + ch.toUpperCase() });
        else seq.push({ t: ch });
      }
    } else if (part === '{counter}'){
      for (const d of num) seq.push({ c: lang + '/' + d });
    } else if (part === '{name}'){
      seq.push({ t: counter ? counter.name : '' });
    } else if (part === '{nameZh}'){
      seq.push({ t: counter ? counter.nameZh : '' });
    } else {
      seq.push(...literalSeq(lang, part));
    }
  }
  return seq;
}

function buildPhrase(lang, numLabel, counter, ttsCfg){
  const t = ttsCfg || (STATE && STATE.settings && STATE.settings.tts) || {};
  const custom = t.custom || {};
  if (t.mode === 'custom' && custom[lang] && custom[lang].trim()){
    return parseCustom(lang, custom[lang], numLabel, counter);
  }
  const letters = numLabel.replace(/[0-9]/g,'').split('');
  const digits  = numLabel.replace(/[A-Z]/g,'').split('');
  const cid = counterNum(counter).split('');
  if (lang === 'en'){
    return ['en/Ticket', ...letters.map(l=>'en/'+l), ...digits.map(d=>'en/'+d),
            'en/counter', ...cid.map(d=>'en/'+d)];
  }
  if (lang === 'yue'){
    return ['yue/ticket', ...letters.map(l=>'yue/'+l), ...digits.map(d=>'yue/'+d),
            'yue/goto', ...cid.map(d=>'yue/'+d), 'yue/suffix'];
  }
  return ['zh/ticket', ...letters.map(l=>'zh/'+l), ...digits.map(d=>'zh/'+d),
          'zh/goto', ...cid.map(d=>'zh/'+d), 'zh/suffix'];
}

/* ===== 播放：有錄音播錄音；缺檔合併成整句 TTS ===== */
async function announce(languages, opts, cancel){
  if (cancel) stopAudio();
  const my = announceToken;
  const reps = (opts && opts.repeat) ? opts.repeat : 1;
  for (const lang of languages){
    const seq = opts.phrases && opts.phrases[lang];
    if (!seq) continue;
    const langCode = TTS_LANG[lang];
    const isCJK = c => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(c);
    for (let i=0; i<reps; i++){
      if (announceToken !== my) return;
      await chime();
      if (announceToken !== my) return;
      await wait(300);
      let buf = '';
      const appendBuf = t => {
        if (!t) return;
        if (!buf){ buf = t; return; }
        buf += (isCJK(buf.slice(-1)) || isCJK(t[0])) ? t : ' ' + t;
      };
      const flush = async () => {
        if (buf.trim()){
          const t = buf.trim(); buf = '';
          await speakText(t, langCode);
        }
      };
      for (const p of seq){
        if (announceToken !== my) return;
        const path = typeof p === 'string' ? p : (p.c || null);
        if (path){
          if (await clipExists(path)){
            await flush();
            if (announceToken !== my) return;
            await playClip(path);
          } else {
            const info = ttsInfoFor(path);
            if (info) appendBuf(info.text);
          }
        } else if (p.t){
          appendBuf(p.t);
        }
        await wait(80);
      }
      await flush();
      await wait(400);
    }
  }
}
