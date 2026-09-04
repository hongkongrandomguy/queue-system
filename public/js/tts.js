/* 自訂音檔廣播版（音檔喺根目錄 /audio/） */
const AUDIO_EXT = '.mp3';
let currentAudio = null;
const wait = ms => new Promise(r => setTimeout(r, ms));

function playClip(path){
  return new Promise(res => {
    const a = new Audio('../audio/' + path + AUDIO_EXT);
    currentAudio = a;
    a.onended = () => { currentAudio = null; res(); };
    a.onerror = () => { currentAudio = null; res(); };
    a.play().catch(() => res());
  });
}
function stopAudio(){ if (currentAudio){ currentAudio.pause(); currentAudio = null; } }
function chime(){ return playClip('chime'); }

/* 依照 ; 格式組出音檔序列 */
function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'').split('');
  const digits  = numLabel.replace(/[A-Z]/g,'').split('');
  /* 櫃位編號：只從名稱 Counter N 抽取數字，絕不使用內部 id */
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
  const reps = (opts && opts.repeat) ? opts.repeat : 1;
  for (const lang of languages){
    const seq = opts.phrases && opts.phrases[lang];
    if (!seq) continue;
    for (let i=0; i<reps; i++){
      await chime();
      await wait(300);
      for (const p of seq){ await playClip(p); await wait(150); }
      await wait(400);
    }
  }
}
