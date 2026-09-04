firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const stateRef = db.ref('queue');

const DEFAULTS = {
  settings: {
    title: 'Queue Up', subtitle: '請排队取號',
    note: 'Please keep your ticket and watch the display. 請保留籌號並留意大屏幕。',
    counters: [
      { id: 1, name: 'Counter 1', nameZh: '一號櫃位' },
      { id: 2, name: 'Counter 2', nameZh: '二號櫃位' }
    ],
    tts: { languages: ['en','yue','zh'], rate: 1, volume: 1, repeat: 1 }
  },
  session: { prefix: 'A', next: 1 }, tickets: {}, lastCall: null
};

let STATE = null; const listeners = [];
stateRef.on('value', s => { STATE = s.val() || JSON.parse(JSON.stringify(DEFAULTS)); listeners.forEach(f => f(STATE)); });
stateRef.once('value').then(s => { if (!s.exists()) stateRef.set(DEFAULTS); });

function onState(f){ listeners.push(f); if (STATE) f(STATE); }
function nowLabel(){
  const d=new Date(), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function ticketsArr(){ return Object.entries(STATE.tickets||{}).map(([key,t])=>({key,...t})); }
function waiting(){ return ticketsArr().filter(t=>t.status==='waiting').sort((a,b)=>a.no-b.no); }
function currentOf(id){ return ticketsArr().find(t=>t.status==='called'&&String(t.counter)===String(id)); }
function counterById(id){ return (STATE.settings.counters||[]).find(c=>String(c.id)===String(id))||{name:'Counter '+id,nameZh:'櫃位 '+id}; }
function toast(m,ms=2500){ const t=document.getElementById('toast'); if(!t)return; t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),ms); }

async function takeTicket(){
  let no; const pre = STATE.session.prefix;
  await stateRef.child('session/next').transaction(c => { no = c||1; return no+1; });
  const t = { no, label: pre+String(no).padStart(3,'0'), time: nowLabel(), status:'waiting', counter:null };
  await stateRef.child('tickets').push(t);
  await stateRef.child('lastCall').set(null);
  return t;
}
async function callNext(id){
  const w = waiting()[0]; if (!w) return null;
  await stateRef.update({
    ['tickets/'+w.key+'/status']: 'called',
    ['tickets/'+w.key+'/counter']: Number(id),
    lastCall: { ticket:{label:w.label,no:w.no}, counter:Number(id), at:Date.now(), seq:(STATE.lastCall?.seq||0)+1 }
  });
  return w;
}
async function recall(id){
  const t = currentOf(id); if (!t) return;
  await stateRef.child('lastCall').set({ ticket:{label:t.label,no:t.no}, counter:Number(id), at:Date.now(), seq:(STATE.lastCall?.seq||0)+1 });
}
async function complete(id){ const t = currentOf(id); if (t) await stateRef.child('tickets/'+t.key+'/status').set('done'); }
async function callNumber(id, raw){
  const num = Number(String(raw).toUpperCase().replace(/^[A-Z]+/,''));
  const t = ticketsArr().find(t=>t.no===num && t.status!=='done'); if (!t) return null;
  await stateRef.update({
    ['tickets/'+t.key+'/status']: 'called',
    ['tickets/'+t.key+'/counter']: Number(id),
    lastCall: { ticket:{label:t.label,no:t.no}, counter:Number(id), at:Date.now(), seq:(STATE.lastCall?.seq||0)+1 }
  });
  return t;
}
async function setPrefix(p){
  const ups = {};
  ticketsArr().forEach(t => { if (t.status==='waiting') ups['tickets/'+t.key+'/status'] = 'expired'; });
  ups['session'] = { prefix: p, next: 1 }; ups['lastCall'] = null;
  await stateRef.update(ups);
}
async function advance(){
  const c = STATE.session.prefix;
  await setPrefix(c.length===1 ? String.fromCharCode(c.charCodeAt(0)+1) : c+'A');
}
async function saveSettings(s){ await stateRef.child('settings').set(s); }
