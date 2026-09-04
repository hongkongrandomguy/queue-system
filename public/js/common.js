const socket = io();
let STATE = null;
const listeners = [];
socket.on('state', s => { STATE = s; listeners.forEach(f => f(s)); });
function onState(f){ listeners.push(f); if (STATE) f(STATE); }
function counterById(id){ return STATE.settings.counters.find(c => c.id === Number(id)) || { name:'Counter '+id, nameZh:'櫃位 '+id }; }
async function api(url, body){ const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) }); return r.json(); }
function toast(msg, ms=2500){ const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'), ms); }
