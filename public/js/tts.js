/* 音檔優先 → Edge 神經 TTS（雙 token 重試）→ 瀏覽器 neural 女聲兜底 */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0, edgeAbort = null;
const wait = ms => new Promise(r => setTimeout(r, ms));
const escapeXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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

/* ===== Sec-MS-GEC token（兩種算法變體） ===== */
async function secMsGec(variant){
  const t = Math.floor(Date.now() / 1000);
  const rounded = t + 300 - (t % 300);
  const pre = variant === 0
    ? ((BigInt(rounded) + 11644473600n) * 10000000n).toString()
    : String(rounded);
  const data = pre + '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
  return `${rounded}.${hash}`;
}

/* ===== Edge 神經 TTS（單次嘗試） ===== */
function edgeFetchOnce(text, langCode, token){
  return new Promise(res => {
    const uuid = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : String(Date.now()) + Math.random().toString().slice(2));
    let ws;
    try{
      ws = new WebSocket('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' + uuid + '&Sec-MS-GEC=' + token + '&Sec-MS-GEC-Version=1-131.0.2903.86');
    }catch(e){ return res(null); }
    const chunks = []; let done = false;
    const finish = ok => {
      if (done) return; done = true;
      edgeAbort = null;
      try{ ws.close(); }catch(e){}
      if (!ok || !chunks.length) return res(null);
      const blob = new Blob(chunks, { type:'audio/mp3' });
      const f = new FileReader();
      f.onload = () => res(f.result);
      f.onerror = () => res(null);
      f.readAsDataURL(blob);
    };
    edgeAbort = () => finish(false);
    const now = () => new Date().toString();
    ws.onopen = () => {
      ws.send(`X-Timestamp:${now()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormats":["audio-24khz-48kbitrate-mono-mp3"]}}}}\r\n`);
      ws.send(`X-RequestId:${uuid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now()}\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${langCode}"><voice name="${EDGE_VOICES[langCode] || EDGE_VOICES['en-US']}"><prosody pitch="+0Hz" rate="+0%" volume="+0%">${escapeXml(text)}</prosody></voice></speak>`);
    };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string'){
        if (ev.data.includes('turn.end')) finish(true);
      } else {
        const d = new Uint8Array(ev.data);
        const hl = (d[0] << 8) | d[1];
        chunks.push(d.slice(2 + hl));
      }
    };
    ws.onerror = () => { console.warn('[TTS] Edge WS 連線失敗'); finish(false); };
    ws.onclose = () => finish(chunks.length > 0);
    setTimeout(() => finish(chunks.length > 0), 8000);
  });
}
async function edgeFetch(text, langCode){
  const a = await edgeFetchOnce(text, langCode, await secMsGec(0));
  if (a) return a;
  return await edgeFetchOnce(text, langCode, await secMsGec(1));
}

/* ===== 朗讀文字（快取 → Edge → 瀏覽器 neural 女聲） ===== */
const VOICE_PREF = ['HiuGaai','HiuMaan','Xiaoxiao','Xiaoyi','Aria','Jenny','Online (Natural)','Neural','Natural'];
function speakText(text, langCode){
  return new Promise(res => {
    const my = announceToken;
    if (!text || !text.trim()) return res();
    const ck = 'edgeT4_' + langCode + '_' + text;
    const browserSpeak = () => {
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
      console.warn('[TTS] 瀏覽器聲音：', (v && v.name) || 'default', text);
      u.onend = () => res(); u.onerror = () => res();
      speechSynthesis.speak(u);
    };
    const playSrc = src => {
      if (announceToken !== my) return res();
      const a = new Audio(src);
      currentAudio = a; currentResolve = res;
      a.onended = () => { currentAudio=null; currentResolve=null; res(); };
      a.onerror = () => { currentAudio=null; currentResolve=null; browserSpeak(); };
      a.play().catch(() => browserSpeak());
    };
    const cached = localStorage.getItem(ck);
    if (cached) return playSrc(cached);
    edgeFetch(text, langCode).then(data => {
      if (announceToken !== my) return res();
      if (data){ console.log('[TTS] Edge neural 女聲：', langCode, text); try{ localStorage.setItem(ck, data); }catch(e){} playSrc(data); }
      else { console.warn('[TTS] Edge 失敗 → 瀏覽器兜底：', text); browserSpeak(); }
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
