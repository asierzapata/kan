// Read-only completed-step usage for the existing synthetic staging identity.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Client} from 'eve/client';
const f=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8'));
const qa=JSON.parse(await readFile('/tmp/kan-web-qa-user.json','utf8'));
assert.equal(f.accounts[0].id,qa.userId);
const c=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
const origin='https://staging.getkan.dev';
async function api(path){const r=await fetch(`${origin}/api/web/${path}`,{headers:{cookie:f.accounts[0].cookie},redirect:'manual'});assert.equal(r.status,200);return r.json();}
const client=new Client({host:origin,auth:{bearer:c.secret},redirect:'manual'});
const catalog=await api('catalog'),seen=new Set(),runs=[];
for(const canvas of catalog.canvases){
 assert.ok(canvas.name.startsWith('QA '),'Synthetic account canvas required');
 const h=await api(`history?canvas=${canvas.id}`);
 for(const run of h.runs){
  if(!run.session_id||seen.has(run.session_id))continue;seen.add(run.session_id);
  const snap=await client.sessions.attach(run.session_id).snapshot();
  const costUsd=snap.events.filter(e=>e.type==='step.completed').reduce((sum,e)=>sum+(e.data.usage?.costUsd||0),0);
  const toolFailures=snap.events.filter(e=>e.type==='action.result'&&e.data.result?.isError).length;
  runs.push({run:run.id,status:run.status,costUsd,toolFailures});
 }
}
const result={runs,costUsd:runs.reduce((sum,r)=>sum+r.costUsd,0),scope:'synthetic account completed-step model usage; excludes real-browser account and M0'};
await writeFile('/tmp/kan-web-final-usage.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
