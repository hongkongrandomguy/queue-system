/* 音檔優先 → Edge 神經網絡 TTS → 瀏覽器 TTS 兜底 */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0, edgeAbort = null;
const wait = ms => new Promise(r => setTimeout(r, ms));
const escapeXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ===== 文字映射 ===== */
const TTS_LANG = { en:'en-US', yue:'zh-HK', zh:'zh-CN' };
const TTS_DIG = {
  en:['zero','one','two','three','four','five','six','seven','eight','nine'],
  yue:['零','一','二','三','四','五','六','七','八','九'],
  zh:['零','一','二','三','四','五','六','七','八','九']
};
const TTS_WORDS = {
  en:{ Ticket:'Ticket number', counter:'please go to counter' },
  yue:{ ticket:'籌號', goto:'請到', suffix:'號櫃位' },
  zh:{ ticket:'号码', goto:'请到', suffix:'号柜台' }
};
const EDGE_VOICES = { 'en-US':'en-US-AriaNeural', 'zh-HK':'zh-HK-HiuGaaiNeural', 'zh-CN':'zh-CN-XiaoxiaoNeural' };
function ttsInfoFor(path){
  const i = path.indexOf('/');
  if (i < 0) return null;
  const lang = path.slice(0, i), key = path.slice(i + 1);
  if (/^[0-9]$/.test(key)) return { text: TTS_DIG[lang][+key], lang: TTS_LANG[lang] };
  if (/^[A-Z]$/.test(key)) return { text: key, lang: 'en-US' };
  const w = TTS_WORDS[lang] && TTS_WORDS[lang][key];
  return w ? { text: w, lang: TTS_LANG[lang] } : null;
}

/* ===== Edge 神經網絡 TTS（WebSocket，免 key） ===== */
function edgeTTS(path){
  return new Promise(res => {
    const info = ttsInfoFor(path);
    if (!info) return res(null);
    const ck = 'edge_' + path;
    const cached = localStorage.getItem(ck);
    if (cached) return res(cached);

    const uuid = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : String(Date.now()) + Math.random().toString().slice(2));
    let ws;
    try{
      ws = new WebSocket('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' + uuid);
    }catch(e){ return res(null); }

    const chunks = [];
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      edgeAbort = null;
      try{ ws.close(); }catch(e){}
      if (!ok || !chunks.length) return res(null);
      const blob = new Blob(chunks, { type:'audio/mp3' });
      const f = new FileReader();
      f.onload = () => { try{ localStorage.setItem(ck, f.result); }catch(e){} res(f.result); };
      f.onerror = () => res(null);
      f.readAsDataURL(blob);
    };
    edgeAbort = () => finish(false);           // 俾 stopAudio 即時中止
    const now = () => new Date().toString();

    ws.onopen = () => {
      ws.send(`X-Timestamp:${now()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormats":["audio-24khz-48kbitrate-mono-mp3"]}}}}\r\n`);
      ws.send(`X-RequestId:${uuid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now()}\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${info.lang}"><voice name="${EDGE_VOICES[info.lang]}"><prosody pitch="+0Hz" rate="+0%" volume="+0%">${escapeXml(info.text)}</prosody></voice></speak>`);
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
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(chunks.length > 0);
    setTimeout(() => finish(chunks.length > 0), 8000);   // 超時保護
  });
}

/* ===== 瀏覽器 TTS 兜底 ===== */
function speakFallback(path, res){
  const info = ttsInfoFor(path);
  if (!info || !('speechSynthesis' in window)) return res();
  const u = new SpeechSynthesisUtterance(info.text);
  u.lang = info.lang; u.rate = 0.95; u.volume = 1;
  const vs = speechSynthesis.getVoices();
  const want = info.lang.toLowerCase().replace('-','_');
  const v = vs.find(x => x.lang.toLowerCase().replace('-','_') === want)
         || vs.find(x => x.lang.toLowerCase().startsWith(info.lang.slice(0,2).toLowerCase()));
  if (v) u.voice = v;
  u.onend = () => res();
  u.onerror = () => res();
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window){ speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); }

/* ===== 播放鏈：本地音檔 → Edge TTS → 瀏覽器 TTS ===== */
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
        (async () => {
          const src = await edgeTTS(path);
          if (announceToken !== my) return res();        // 已被取消 → 靜默
          if (src){
            const a = new Audio(src);
            currentAudio = a; currentResolve = res;
            a.onended = () => { currentAudio=null; currentResolve=null; res(); };
            a.onerror = () => { currentAudio=null; currentResolve=null; speakFallback(path, res); };
            a.play().catch(() => speakFallback(path, res));
          } else {
            speakFallback(path, res);
          }
        })();
      }
    };
    attempt();
  });
}
function stopAudio(){
  announceToken++;
  if (currentAudio) currentAudio.pause();
  if (edgeAbort) edgeAbort();                            // 中止 Edge 合成
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const r = currentResolve; currentAudio=null; currentResolve=null;
  if (r) r();
}
function chime(){ return playClip('chime'); }

function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'').split('');
  const digits  = numLabel.replace(/[A-Z]/g,'').split('');
  let rawId = '1';
  if (counter && counter.name){
    const n = String(counter.name).replace(/\D/g,'');
    if (n) rawId = n;
  }
  const cid = rawId.split('');
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
