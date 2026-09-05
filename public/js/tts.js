/* 純本地 MP3 播放引擎（配合 generate_audio.js 生成嘅音庫） */
const AUDIO_EXT = '.mp3';
let currentAudio = null, currentResolve = null, announceToken = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

const TTS_LANG = { en:'en-US', yue:'zh-HK', zh:'zh-CN' };
const CLIP_WORDS = {
  en:{ 'please go to counter':'en/counter', 'ticket':'en/Ticket' },
  yue:{ '請往':'yue/goto', '號櫃位':'yue/suffix', '籌號':'yue/ticket' },
  zh:{ '请到':'zh/goto', '号柜台':'zh/suffix', '筹号':'zh/ticket' }
};

function ttsInfoFor(path){
  const i = path.indexOf('/');
  if (i < 0) return null;
  return { path };
}

/* 播放 clip */
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
        console.warn('[TTS] 找不到音頻:', path);
        res(); // 找不到就跳過，唔好卡住
      }
    };
    attempt();
  });
}

function stopAudio(){
  announceToken++;
  if (currentAudio) currentAudio.pause();
  const r = currentResolve; currentAudio=null; currentResolve=null;
  if (r) r();
}

function chime(){ return playClip('chime'); }

/* 自定義廣播詞解析 */
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
  const flush = () => { if (buf.trim()){ items.push({ c: lang + '/' + buf.trim() }); buf = ''; } }; // 如果係自定義文本中冇預錄音嘅詞，嘗試當做單個 clip 播（如果冇就跳過）
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
      }
    } else if (part === '{counter}'){
      for (const d of num) seq.push({ c: lang + '/' + d });
    } else if (part === '{name}'){
      seq.push({ c: lang + '/name' }); // 需要預先錄製 name.mp3
    } else if (part === '{nameZh}'){
      seq.push({ c: lang + '/nameZh' }); 
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
    return ['en/Ticket', ...letters.map(l=>'en/'+l), ...digits.map(d=>'en/'+d), 'en/counter', ...cid.map(d=>'en/'+d)];
  }
  if (lang === 'yue'){
    return ['yue/ticket', ...letters.map(l=>'yue/'+l), ...digits.map(d=>'yue/'+d), 'yue/goto', ...cid.map(d=>'yue/'+d), 'yue/suffix'];
  }
  return ['zh/ticket', ...letters.map(l=>'zh/'+l), ...digits.map(d=>'zh/'+d), 'zh/goto', ...cid.map(d=>'zh/'+d), 'zh/suffix'];
}

/* 播放隊列 */
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
        const path = typeof p === 'string' ? p : (p.c || null);
        if (path){
          await playClip(path);
        }
        await wait(150);
      }
      await wait(400);
    }
  }
}
