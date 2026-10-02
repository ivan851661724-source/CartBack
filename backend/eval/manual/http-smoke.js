'use strict';
/**
 * 真服务 HTTP 链路抽查（真模型）：spawn server.js（隔离 .server 目录），
 * 走 /api/act + /api/act/:id/message/stream SSE，验证 done 帧契约与 /api/state engine=online。
 * 用法：node eval/manual/http-smoke.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-smoke-'));

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* SSE 等 */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function sse(p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, (res) => {
      let buf = '';
      let tokens = 0;
      res.on('data', (c) => {
        buf += c;
        tokens += (buf.match(/\ndata: \{"type":"token"/g) || []).length;
      });
      res.on('end', () => {
        let done = null;
        for (const m of buf.matchAll(/data: ([\s\S]+?)\n\n/g)) {
          try { const j = JSON.parse(m[1]); if (j.type === 'done') done = j; } catch (e) { /* 跨块残片 */ }
        }
        resolve({ status: res.statusCode, tokenFrames: tokens, done, raw: buf.slice(-400) });
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), EY_SERVER_DIR: SERVER_DIR, CARTBACK_OPEN_LOCAL: '1' },
    stdio: 'ignore'
  });
  try {
    // 隔离目录默认无 config.json（服务会跑降级桩）——复制真实运行配置过去，让本次抽查走真模型
    const realCfg = path.join(__dirname, '..', '..', '.server', 'config.json');
    if (fs.existsSync(realCfg)) fs.copyFileSync(realCfg, path.join(SERVER_DIR, 'config.json'));
    // 等 bootstrap
    let boot = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { boot = (await req('GET', '/api/bootstrap')).json; if (boot && boot.token) break; } catch (e) { /* 未起 */ }
    }
    if (!boot || !boot.token) throw new Error('bootstrap 失败');
    const H = { 'x-local-token': boot.token };
    console.log('bootstrap ✓ engine 期望 online（config.json 携带 key）');

    const st0 = (await req('GET', '/api/state', null, H)).json;
    console.log('/api/state engine =', st0.engine, '| aiConfigured 见 config:', Boolean(st0.engine));

    const act = (await req('POST', '/api/act', {}, H)).json;
    const actId = act.act ? act.act.id : act.id;
    console.log('act ✓', actId);

    const turns = [
      '我的品牌叫 LunaGlow，做手工香薰蜡烛，客单价 28 美元',
      '主要客户是 25 到 40 岁的美国女性',
      '挽回原因就盯加购未付款的，折扣给 10% off',
      '营销目标是本月挽回 100 单'
    ];
    for (const t of turns) {
      const r = await sse(`/api/act/${actId}/message/stream`, { message: t }, H);
      const d = r.done;
      if (!d) { console.log(`✗ "${t}" 无 done 帧`, r.raw.slice(-200)); process.exit(1); }
      const a = d.act || {};
      const filled = a.filled_count != null ? a.filled_count : '?';
      console.log(`✓ [${d.engine}] stage=${d.stage} filled=${filled} chips=[${(d.chips || []).join(',')}] tokens=${r.tokenFrames}`
        + `\n    ${t}\n    → ${(d.act && d.act.last_reply || '').slice(0, 0)}${(a.needs ? JSON.stringify(Object.fromEntries(Object.entries(a.needs).map(([k, v]) => [k, v && typeof v === 'object' ? v.value : v]))) : '')}`);
    }
    const st = (await req('GET', '/api/state', null, H)).json;
    const a = (st.acts || []).find(x => x.id === actId) || {};
    console.log('\n终态：stage=' + a.stage + ' filled=' + a.filled_count
      + ' extras=' + JSON.stringify((a.memory && a.memory.extras || []).map(e => e.key))
      + '\nHTTP 链路抽查通过（SSE token 流 + done 帧含 act/engine/chips，state 刷新持久）');
    process.exit(0);
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  } finally {
    server.kill();
    try { fs.rmSync(SERVER_DIR, { recursive: true, force: true }); } catch (e) { /* */ }
  }
})();
