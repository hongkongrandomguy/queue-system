/* Web Speech API 三語廣播：English / 粵語 / 普通話
   使用設備內置語音，無需費用；如需更高質素，可於 admin 頁改用外置 TTS API */
let voices = [];
function loadVoices(){ voices = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

const DIGIT_EN = ['zero','one','two','three','four','five','six','seven','eight','nine'];
const DIGIT_ZH = ['零','一','二','三','四','五','六','七','八','九'];

function pickVoice(want){
  if (!voices.length) return null;
  const score = v => {
    const l = v.lang.toLowerCase().replace('_','-');
    switch (want) {
      case 'yue': return l.startsWith('yue') ? 3 : (l==='zh-hk' ? 2 : 0);
      case 'zh':  return (l==='zh-cn'||l==='zh_cn') ? 3 : l.startsWith('zh') ? 1 : 0;
      case 'en':  return l.startsWith('en-hk') ? 3 : l.startsWith('en-gb') ? 2 : l.startsWith('en') ? 1 : 0;
    }
    return 0;
  };
  return voices.map(v => [score(v), v]).filter(x => x[0] > 0)
    .sort((a,b) => b[0]-a[0] || (b[1].localService?0:1)-(a[1].localService?0:1))[0][1];
}

function spellDigits(str, mode){
  return str.split('').map(ch => /\d/.test(ch) ? (mode==='en' ? DIGIT_EN[+ch] : DIGIT_ZH[+ch]) : ch).join(mode==='en' ? ' ' : '');
}
function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'');
  const digits  = numLabel.replace(/[A-Z]/g,'');
  const spokenNum = spellDigits(digits, lang==='en' ? 'en' : 'zh');
  const spokenCode = lang==='en'
    ? letters.split('').join(' ') + ' ' + spokenNum
    : letters + spokenNum;
  const c = counter;
  if (lang==='en')  return `${spokenCode}, please proceed to ${c.name}.`;
  if (lang==='yue') return `請${spokenCode}，到${c.nameZh}。`;
  return `請${spokenCode}，前往${c.nameZh}。`;
}

function speak(text, langKey, opts){
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const map = { en:'en', yue:'zh-HK', zh:'zh-CN' };
    u.lang = map[langKey] || 'en';
    const v = pickVoice(langKey); if (v) u.voice = v;
    u.rate = opts.rate ?? 1; u.volume = opts.volume ?? 1;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 「叮當」提示音（WebAudio 合成，無需音檔） */
let actx;
function chime(){
  try{
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    const t = actx.currentTime;
    [880, 660].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type='sine'; o.frequency.value=f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t+i*0.35);
      g.gain.exponentialRampToValueAtTime(0.5, t+i*0.35+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t+i*0.35+0.32);
      o.start(t+i*0.35); o.stop(t+i*0.35+0.35);
    });
  }catch(e){}
}

/* 廣播一組語言；cancel=true 會打斷正在播放的內容 */
async function announce(languages, opts, cancel){
  if (!('speechSynthesis' in window)) return;
  if (cancel) speechSynthesis.cancel();
  const reps = opts.repeat ?? 1;
  for (const lang of languages){
    if (!opts.phrases[lang]) continue;
    for (let i=0; i<reps; i++){
      chime();
      await wait(900);
      await speak(opts.phrases[lang], lang, opts);
      await wait(400);
    }
  }
}
