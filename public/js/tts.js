/* 音檔優先 → 缺檔調用 VoiceRSS 外接 TTS → 最後瀏覽器 TTS 兜底 */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ===== 外接 TTS 設定 ===== */
const VOICERSS_KEY = '38df71ac2202487f818f87902d693a20';   // ← 貼上 VoiceRSS 免費 key（留空＝直接用瀏覽器 TTS）
const VR_LANG = { 'en-US':'en-us', 'zh-HK':'zh-hk', 'zh-CN':'zh-cn' };

/* ===== 文字映射（clip 路徑 → 朗讀文字＋語言） ===== */
const TTS_LANG = { en:'en-US', yue:'zh-HK', zh:'zh-CN' };
const TTS_DIG = {
  en:['zero','one','two','three','four','five','six','seven','eight','nine'],
  yue:['零','一','二','三','四','五','六','七','八','九'],
  zh:['零','一','二','三','四','五','六','七','八','九']
};
const TTS_WORDS = {
  en:{ Ticket:'Ticket', counter:'please go to counter' },
  yue:{ ticket:'籌號', goto:'請到', suffix:'號櫃位' },
  zh:{ ticket:'筹号', goto:'请到', suffix:'号柜台' }
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

/* ===== VoiceRSS：先嘗試 fetch 快取，失敗就直接串流播放 ===== */
async function vrSource(path){
  const info = ttsInfoFor(path);
  if (!info || !VOICERSS_KEY) return null;
  const ck = 'vr_' + path;
  const cached = localStorage.getItem(ck);
  if (cached) return cached;
  const url = `https://api.voicerss.org/?key=${VOICERSS_KEY}&hl=${VR_LANG[info.lang]}&c=MP3&b=64&src=${encodeURIComponent(info.text)}`;
  try{
    const r = await fetch(url);
    if (r.ok){
      const blob = await r.blob();
      const data = await new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(blob); });
      try{ localStorage.setItem(ck, data); }catch(e){}
      return data;
    }
  }catch(e){ /* CORS 或網絡問題 → 直接串流 */ }
  return url;
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

/* ===== 播放鏈：本地音檔 → VoiceRSS → 瀏覽器 TTS ===== */
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
          const src = await vrSource(path);
          if (announceToken !== my) return res();
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
