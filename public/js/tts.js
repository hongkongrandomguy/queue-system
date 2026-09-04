/* Web Speech API 三語廣播：English / 粵語 / 普通話 */
let voices = [];
function loadVoices(){ voices = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

const DIGIT_EN = ['zero','one','two','three','four','five','six','seven','eight','nine'];
const DIGIT_ZH = ['零','一','二','三','四','五','六','七','八','九'];

/* 英文字母讀法（要調整就改呢度，例如想還原 A 做 'ay'） */
const LETTER_EN = {
  A:'ay', B:'bee', C:'see', D:'dee', E:'ee', F:'ef', G:'jee', H:'aitch',
  I:'eye', J:'jay', K:'kay', L:'el', M:'em', N:'en', O:'oh', P:'pee',
  Q:'cue', R:'ar', S:'ess', T:'tee', U:'you', V:'vee', W:'double you',
  X:'ex', Y:'why', Z:'zed'
};

function pickVoice(want){
  if (!voices.length) return null;
  const score = v => {
    const l = v.lang.toLowerCase().replace('_','-');
    switch (want) {
      case 'yue': return l.startsWith('yue') ? 3 : (l==='zh-hk' ? 2 : 0);
      case 'zh':  return l.startsWith('zh-cn') ? 3 : l.startsWith('zh') ? 1 : 0;
      case 'en':  return l.startsWith('en-hk') ? 3 : l.startsWith('en-gb') ? 2 : l.startsWith('en') ? 1 : 0;
    }
    return 0;
  };
  const m = voices.map(v => [score(v), v]).filter(x => x[0] > 0)
    .sort((a,b) => b[0]-a[0] || (b[1].localService?0:1)-(a[1].localService?0:1));
  return m.length ? m[0][1] : null;
}

function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'');
  const digits  = numLabel.replace(/[A-Z]/g,'');
  if (lang === 'en'){
    const spokenLetters = letters.split('').map(ch => LETTER_EN[ch] || ch).join(' ');
    const spokenDigits  = digits.split('').map(ch => DIGIT_EN[+ch]).join(' ');
    return `${spokenLetters} ${spokenDigits}, please proceed to ${counter.name}.`;
  }
  const spokenDigits = digits.split('').map(ch => DIGIT_ZH[+ch]).join('');
  if (lang === 'yue'){
    return `請${letters}${spokenDigits}，到${counter.nameZh}。`;   // 粵語照舊「櫃位」
  }
  // 普通話：「櫃位」→「櫃檯」
  const zhName = (counter.nameZh || '').replace(/櫃位/g, '櫃檯');
  return `請${letters}${spokenDigits}，前往${zhName}。`;
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
