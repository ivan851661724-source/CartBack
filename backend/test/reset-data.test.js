'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {Store}=require('../lib/store');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cartback-reset-'));const s=new Store({dbFile:path.join(dir,'db.sqlite')});s.init();t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return s;}
function seed(s){
 for(const table of ['acts','drafts','campaigns','audience','agent_profiles','strategy_cards','competitor_sources','blackouts','notifications','products','todos']) s._write(table,[{id:'a-'+table,user_id:'a',created_at:1},{id:'b-'+table,user_id:'b',created_at:1},{id:'legacy-'+table,user_id:null,created_at:1}]);
 s._write('audience_tags',[{id:'tag-a',audience_id:'a-audience'},{id:'tag-b',audience_id:'b-audience'}]);
 s._write('events',[{id:'event-a',user_id:'a',draft_id:'a-drafts'},{id:'event-b',user_id:'b',draft_id:'b-drafts'},{id:'event-legacy-a',draft_id:'a-drafts'}]);
 for(const table of ['sends','holdouts'])s._write(table,[{id:table+'a',campaign_id:'a-campaigns',act_id:'a-acts'},{id:table+'b',campaign_id:'b-drafts',act_id:'b-acts'}]);
 s._write('jobs',[{id:'job-a',type:'send_campaign',payload:{campaignId:'a-campaigns'},status:'pending',run_after:Date.now()+86400000},{id:'receipt-a',type:'receipt_24h',payload:{userId:'a',draftId:'deleted-draft'},status:'pending'},{id:'job-b',payload:{draftId:'b-drafts'},status:'pending'}]);
 s._write('users',[{id:'a'},{id:'b'}]);s._write('sessions',[{id:'session-a',user_id:'a'},{id:'session-b',user_id:'b'}]);
 s.setUserPrefs('a',{tone:'warm'});s.setUserPrefs('b',{tone:'formal'});s.setMeta('opp_last_seen:a','10');s.setMeta('global_paused','1');s.setMeta('metrics','{"send_real":20}');s.setMeta('quota:a','5');s.setMeta('benchmark_lib','{"rows":[{"sample":100}]}');
}
test('account reset clears all linked business data and scheduled jobs, preserving other users and global settings',t=>{
 const s=fixture(t);seed(s);assert.equal(s.resetUserData('a').ok,true);
 for(const table of ['acts','drafts','campaigns','audience','agent_profiles','strategy_cards','competitor_sources','blackouts','notifications','products','todos'])assert.deepEqual(s._read(table).map(r=>r.user_id),['b',null],table);
 for(const table of ['events','audience_tags','sends','holdouts'])assert.equal(s._read(table).length,1,table);
 assert.deepEqual(s._read('jobs').map(j=>j.id),['job-b']);assert.equal(s.getUserPrefs('a').tone,undefined);assert.equal(s.getUserPrefs('b').tone,'formal');
 assert.equal(s._read('users').length,2);assert.equal(s._read('sessions').length,2);assert.equal(s.getMeta('global_paused'),'1');assert.equal(s.getMeta('metrics'),'{"send_real":20}');assert.equal(s.getMeta('quota:a'),'5');assert.equal(s.getMeta('benchmark_lib'),null);
});
test('local reset includes unowned history without deleting other accounts or sessions',t=>{const s=fixture(t);seed(s);assert.equal(s.resetUserData('a',{includeUnowned:true}).ok,true);assert.deepEqual(s._read('acts').map(a=>a.user_id),['b']);assert.deepEqual(s._read('audience').map(a=>a.user_id),['b']);assert.equal(s._read('users').length,2);assert.equal(s._read('sessions').length,2);});
test('reset rejects an owned running job before changing any data',t=>{const s=fixture(t);seed(s);const jobs=s._read('jobs');jobs[0].status='running';s._write('jobs',jobs);const before=JSON.stringify(s._read('acts'));assert.equal(s.resetUserData('a').busy,true);assert.equal(JSON.stringify(s._read('acts')),before);assert.equal(s.getUserPrefs('a').tone,'warm');});
test('account reset rolls back every table when a write fails',t=>{
 const s=fixture(t);seed(s);const before=JSON.stringify(s._read('acts'));const write=s.b.writeTable;
 s.b.writeTable=function(table,rows){if(table==='audience')throw new Error('disk failure');return write.call(this,table,rows);};
 assert.throws(()=>s.resetUserData('a'),/disk failure/);assert.equal(JSON.stringify(s._read('acts')),before);assert.equal(s.getUserPrefs('a').tone,'warm');
});
test('JSON fallback resets the same account scope in one persisted snapshot',t=>{
 const Module=require('node:module');const original=Module._load;
 Module._load=function(name,...args){if(name==='node:sqlite')throw new Error('forced JSON fallback');return original.call(this,name,...args);};
 let s;try{s=fixture(t);}finally{Module._load=original;}
 assert.equal(s.b.kind,'json');seed(s);assert.equal(s.resetUserData('a').ok,true);
 const persisted=JSON.parse(fs.readFileSync(s.file.replace(/\.sqlite$/,'.json'),'utf8'));
 assert.deepEqual(persisted.acts.map(a=>a.user_id),['b',null]);assert.equal(persisted.users.length,2);assert.deepEqual(persisted.jobs.map(j=>j.id),['job-b']);
});
test('another account running task does not block the current account reset',t=>{
 const s=fixture(t);seed(s);const jobs=s._read('jobs');jobs[2].status='running';s._write('jobs',jobs);
 assert.equal(s.resetUserData('a').ok,true);assert.equal(s._read('jobs')[0].status,'running');
});
