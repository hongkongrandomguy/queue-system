/* 自訂音檔廣播版
   音檔放喺 public/audio/
   播放順序（; 分隔）：
   EN : Ticket;A;0;0;0;please go to counter;1
   YUE: 籌號;A;0;0;0;請到;1;號櫃位
   ZH : 籌號;A;0;0;0;請到;1;號櫃檯
*/
const AUDIO_EXT = '.mp3';   // 如用 .wav／.m4a，改呢度
let currentAudio = null;
const wait = ms => new Promise(r => setTimeout(r, ms));

function playClip(path){
  return new Promise(res => {
    const a = new Audio('audio/' + path + AUDIO_EXT);
    currentAudio = a;
    a.onended = () => { currentAudio = null; res(); };
    a.onerror = () => { currentAudio = null; res(); };   // 缺檔自動跳過
    a.play().catch(() => res());
  });
}
function stopAudio(){ if (currentAudio){ currentAudio.pause(); currentAudio = null; } }
function chime(){ return playClip('chime'); }

/* 依照 ; 格式組出音檔序列 */
function buildPhrase(lang, numLabel, counter){
  const letters = numLabel.replace(/[0-9]/g,'').split('');
  const digits  = numLabel.replace(/[A-Z]/g,'').split('');
  let rawId = '1';
  if (counter){
    rawId = (counter.name || '').replace(/\D/g,'') || '1';
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
      await chime();                      // （提示音）
      await wait(300);
      for (const p of seq){ await playClip(p); await wait(150); }
      await wait(400);
    }
  }
}
