'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_VERSION = '1-130.0.2849.68';

function secMsGec() {
  const ticks = Math.floor(Date.now() / 1000 / 300) * 300;
  return crypto.createHash('sha256').update(`${ticks}Z${TOKEN}`).digest('hex').toUpperCase();
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function synthesize(text, voice, lang) {
  return new Promise((resolve, reject) => {
    const connId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
    const url = `${ENDPOINT}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${EDGE_VERSION}&ConnectionId=${connId}`;
    const ws = new WebSocket(url);
    const chunks = [];
    const timer = setTimeout(() => { try { ws.terminate(); } catch (e) {} reject(new Error('TTS timeout')); }, 25000);
    const finish = (err, buf) => { clearTimeout(timer); try { ws.terminate(); } catch (e) {} err ? reject(err) : resolve(buf); };

    ws.on('open', () => {
      const ts = new Date().toUTCString();
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}`);
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const i = buf.indexOf('\r\n\r\n');
        if (i !== -1 && buf.length > i + 4) chunks.push(buf.subarray(i + 4));
      } else if (String(data).includes('Path:turn.end')) {
        finish(null, Buffer.concat(chunks));
      }
    });
    ws.on('error', (e) => finish(e));
  });
}

async function generateAll() {
  const outDir = path.join(__dirname, 'public', 'audio');
  const voices = {
    en: { voice: 'en-US-AriaNeural', lang: 'en-US' },
    yue: { voice: 'zh-HK-HiuGaaiNeural', lang: 'zh-HK' }, // 純正粵語女聲
    zh: { voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN' }  // 純正普通話女聲
  };

  const words = {
    en: { Ticket: 'Ticket', counter: 'please go to counter' },
    yue: { ticket: '籌號', goto: '請往', suffix: '號櫃位' },
    zh: { ticket: '筹号', goto: '请到', suffix: '号柜台' }
  };

  const digits = {
    en: ['zero','one','two','three','four','five','six','seven','eight','nine'],
    yue: ['零','一','二','三','四','五','六','七','八','九'],
    zh: ['零','一','二','三','四','五','六','七','八','九']
  };

  for (const [langKey, cfg] of Object.entries(voices)) {
    const dir = path.join(outDir, langKey);
    fs.mkdirSync(dir, { recursive: true });

    for (const [key, text] of Object.entries(words[langKey])) {
      const file = path.join(dir, `${key}.mp3`);
      if (!fs.existsSync(file)) {
        console.log(`Generating ${langKey}/${key}.mp3 (${text})`);
        const buf = await synthesize(text, cfg.voice, cfg.lang);
        fs.writeFileSync(file, buf);
      }
    }

    for (let i = 0; i < 10; i++) {
      const file = path.join(dir, `${i}.mp3`);
      if (!fs.existsSync(file)) {
        console.log(`Generating ${langKey}/${i}.mp3`);
        const buf = await synthesize(digits[langKey][i], cfg.voice, cfg.lang);
        fs.writeFileSync(file, buf);
      }
    }

    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const file = path.join(dir, `${letter}.mp3`);
      if (!fs.existsSync(file)) {
        console.log(`Generating ${langKey}/${letter}.mp3`);
        // 字母統一用英語發音最自然
        const buf = await synthesize(letter, 'en-US-AriaNeural', 'en-US');
        fs.writeFileSync(file, buf);
      }
    }
  }
  console.log('✅ 所有音頻生成成功！請將 public/audio 資料夾 commit 到 GitHub。');
}

generateAll().catch(console.error);
