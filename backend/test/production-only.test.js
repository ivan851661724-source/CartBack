const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function isolated(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartback-production-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_OPTIONS: '', EY_SERVER_DIR: dir }, encoding: 'utf8' }));
}
test('production store starts and resets with an empty audience', t => {
  const result = isolated(t, `const { Store } = require('./lib/store'); const s = new Store(); s.init(); const before = s.getAudience().length; s.reset(); console.log(JSON.stringify({before, after:s.getAudience().length}));`);
  assert.deepEqual(result, { before: 0, after: 0 });
});
test('legacy demo configuration and environment cannot enable a send mode', t => {
  const result = isolated(t, `const c = require('./lib/config'); require('fs').writeFileSync(c.CONFIG_FILE, JSON.stringify({mode:'demo',stores:[{type:'mock'}],shopCartUrl:'https://cartback.demo'})); process.env.CARTBACK_MODE='demo'; const cfg=c.load(); console.log(JSON.stringify({hasMode:'mode' in cfg,statusMode:'mode' in c.status(cfg),cart:cfg.shopCartUrl,stores:cfg.stores}));`);
  assert.deepEqual(result, {hasMode:false,statusMode:false,cart:'',stores:[]});
});
test('production connector factory rejects test-only mock stores', t => {
  const result = isolated(t, `const c=require('./lib/storeConnector'); let rejected=false; try{c.buildConnectors({stores:[{type:'mock'}]});}catch{rejected=true;} console.log(JSON.stringify({rejected,mockExport:'MockConnector' in c}));`);
  assert.deepEqual(result, {rejected:true,mockExport:false});
});

test('weekly revenue uses attributed conversions rather than draft estimates', t => {
  const result = isolated(t, `const {Store}=require('./lib/store'); const s=new Store();s.init();s.upsertDraft({id:'d',status:'sent',sent_at:Date.now(),estGmv:9999,cost:2});s.addEvent({type:'convert',draft_id:'d',value:25,ts:Date.now()});console.log(JSON.stringify(s.getKpisWeek(null)));`);
  assert.equal(result.gmv, 25);
  assert.equal(result.roi, 12.5);
});
test('legacy seeded audience remains stored but is excluded from production audiences', t => {
  const result = isolated(t, `const {Store}=require('./lib/store');const s=new Store();s.init();s.addAudience([{id:'sample',source:'seed',email:'sample@example.com'},{id:'real',source:'import',email:'real@example.com'}]);console.log(JSON.stringify({visible:s.getAudience().map(a=>a.id),stored:s._read('audience').length}));`);
  assert.deepEqual(result, {visible:['real'],stored:2});
});
test('legacy simulated delivery is excluded from revenue and trend calculations', t => {
  const result = isolated(t, `const {Store}=require('./lib/store');const s=new Store();s.init();s.upsertDraft({id:'old',status:'sent',sent_at:Date.now(),esp_message_id:'sim_old',cost:1});s.addEvent({type:'convert',draft_id:'old',value:999,ts:Date.now()});console.log(JSON.stringify({gmv:s.getKpis().gmv,week:s.getKpisWeek().gmv,trend:s.getTrend().reduce((n,d)=>n+d.gmv,0)}));`);
  assert.deepEqual(result,{gmv:0,week:0,trend:0});
});
test('production HTTP refuses unconfigured ESP even with legacy demo config', async t => {
  const {spawn} = require('node:child_process');
  const net = require('node:net');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartback-send-real-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({mode:'demo',espKey:'',espFrom:'',aiKey:''}));
  const env={...process.env,NODE_OPTIONS:'',EY_SERVER_DIR:dir,CARTBACK_OPEN_LOCAL:'1',CARTBACK_ESP_KEY:'',CARTBACK_ESP_FROM:'',CARTBACK_AI_KEY:''};
  execFileSync(process.execPath,['-e',`const {Store}=require('./lib/store');const s=new Store();s.init();s.addAudience([{id:'real',email:'buyer@example.com',intent:'加购未付'}]);s.upsertDraft({id:'ready',status:'draft',audience:'加购未付'});s.close();`],{cwd:path.resolve(__dirname,'..'),env});
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...env,PORT:String(port)},stdio:'ignore'});
  t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const base=`http://127.0.0.1:${port}`;let token;
  for(let i=0;i<60&&!token;i++){try{token=(await(await fetch(base+'/api/bootstrap')).json()).token;}catch{}if(!token)await new Promise(r=>setTimeout(r,50));}
  assert.ok(token,'isolated production server booted');
  const headers={'x-local-token':token,'Content-Type':'application/json'};
  const response=await fetch(base+'/api/draft/ready/send',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,400);const body=await response.json();assert.ok(body.problems.some(p=>p.type==='esp_not_configured'));
  const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.drafts[0].status,'draft');assert.equal(state.kpis.sent,0);assert.equal(state.kpis.gmv,0);
});
