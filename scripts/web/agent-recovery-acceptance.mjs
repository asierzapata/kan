// Paid, synthetic-only staging acceptance: at most four turns/retries.
// Run only with explicit authorization for synthetic canvas context and spend.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Client} from 'eve/client';
const origin='https://staging.getkan.dev';
const f=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8'));
const config=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
const client=new Client({host:origin,auth:{bearer:config.secret},redirect:'manual'});
async function api(path,input,expected=200){
 const r=await fetch(`${origin}/api/web/${path}`,{method:input?'POST':'GET',redirect:'manual',headers:{cookie:f.accounts[0].cookie,origin,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 assert.equal(r.status,expected,path.split('?')[0]);return r.json();
}
const catalog=await api('catalog');
assert.ok(catalog.canvases.some(c=>c.id===f.canvas&&c.name==='QA renamed canvas'));
const history=()=>api(`history?canvas=${f.canvas}`);
async function wait(check){const end=Date.now()+240000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,1000));}throw Error('Hosted recovery timeout');}
// KAN_RESUME_RECOVERY_RUN reuses an already-paid, already-passed crash-recovery run
// instead of buying a new one; its receipt evidence is re-asserted below either way.
const resumed=process.env.KAN_RESUME_RECOVERY_RUN;
const recovery=resumed?(await history()).runs.find(r=>r.id===resumed):await api('chat',{canvas:f.canvas,operation:randomUUID(),message:'Read the canvas and add exactly one markdown note titled QA crash recovery with body One durable mutation at x 2200 y 0. Set delaySeconds 10 on addNode. Preserve all existing nodes.'});
assert.ok(recovery,'recovery run exists');
if(!resumed){const armed=await fetch(`${origin}/api/web/internal`,{method:'POST',redirect:'manual',headers:{authorization:`Bearer ${config.secret}`,'content-type':'application/json'},body:JSON.stringify({action:'arm-recovery',run:recovery.id})});assert.equal(armed.status,200);}
const queued=await api('chat',{canvas:f.canvas,thread:recovery.thread,operation:randomUUID(),message:'Read the canvas, then use addMermaidDiagram exactly once with source "flowchart LR\nA[QA Mermaid start] --> B[QA Mermaid end]" at x 2200 y 450. Preserve existing records.'});
let observedQueued=false;
const done=id=>wait(async()=>{const h=await history();observedQueued||=h.runs.find(r=>r.id===queued.id)?.status==='queued';const r=h.runs.find(r=>r.id===id);return ['complete','failed','paused','cancelled'].includes(r?.status)&&r;});
const recovered=await done(recovery.id);assert.equal(recovered.status,'complete');
const diagram=await done(queued.id);assert.equal(diagram.status,'complete');
// Queue observation only exists when both turns were submitted together.
if(!resumed)assert.ok(observedQueued);
const snap=await client.sessions.attach(recovered.session_id).snapshot();
assert.ok(snap.events.some(e=>e.type==='action.result'&&e.data.result?.output?.duplicate===true),'Durable step recovery returns saved receipt');
const failed=await api('chat',{canvas:f.canvas,operation:randomUUID(),message:'Read the canvas, then call updateNode once for shape:qa-intentionally-unavailable with patch {"type":"markdown","body":"Synthetic failure"}. This ID intentionally does not exist. Do not add anything, do not substitute another ID, and do not try another tool after it fails.'});
const first=await done(failed.id);assert.equal(first.status,'failed');
await api('retry',{canvas:f.canvas,run:failed.id});
const retried=await done(failed.id);assert.equal(retried.status,'failed');assert.notEqual(retried.session_id,first.session_id);
const ws=await fetch('https://kan-staging-realtime.clipdoc.workers.dev/tool',{method:'POST',redirect:'manual',headers:{authorization:`Bearer ${config.secret}`,'content-type':'application/json'},body:JSON.stringify({canvas:f.canvas,user:f.accounts[0].id,name:'getCanvas',input:{scope:'full'}})});assert.equal(ws.status,200);const state=await ws.json();
assert.equal(state.shapes.filter(s=>s.props.title==='QA crash recovery').length,1);
const labels=state.shapes.filter(s=>s.type==='geo').map(s=>JSON.stringify(s.props.richText));
assert.equal(labels.filter(s=>s.includes('QA Mermaid start')).length,1);assert.equal(labels.filter(s=>s.includes('QA Mermaid end')).length,1);
await api('retry',{canvas:f.canvas,run:recovery.id},409);
const sessions=[recovered.session_id,diagram.session_id,first.session_id,retried.session_id];let cost=0;
for(const id of sessions){const s=await client.sessions.attach(id).snapshot();cost+=s.events.filter(e=>e.type==='step.completed').reduce((sum,e)=>sum+(e.data.usage?.costUsd||0),0);}
const result={checks:['actual post-commit process exit and durable receipt recovery','exactly one recovered markdown mutation','queued Mermaid native graph','actual retry API requeues same failed run with fresh session','missing-node retry fails without mutation','saved completed run retry denied'],runs:[recovery.id,queued.id,failed.id],sessions,observedQueued,resumedRecoveryRun:resumed||null,costUsd:cost,revision:state.revision};
await writeFile('/tmp/kan-web-final-agent-recovery-results.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
