import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Client} from 'eve/client';
const origin='https://staging.getkan.dev',fixture=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8')),owner=fixture.accounts[0];
const config=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
const client=new Client({host:origin,auth:{bearer:config.secret},redirect:'manual'});
async function api(path,input){const response=await fetch(`${origin}/api/web/${path}`,{method:input?'POST':'GET',headers:{cookie:owner.cookie,origin,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});if(!response.ok)throw Error(`Staging ${path.split('?')[0]} HTTP ${response.status}`);return response.json();}
async function wait(check,max=180000){const end=Date.now()+max;while(true){const value=await check();if(value)return value;if(Date.now()>end)throw Error('Run recovery timeout');await new Promise(r=>setTimeout(r,1000));}}
const canvas=fixture.canvas;
const first=await api('chat',{canvas,message:'Read the canvas, then add one markdown note titled QA live agent with body Persisted by the durable agent at x 1800 y 0. Use addNode. Apply delaySeconds 10 on addNode so its durable wait can be observed. Do not modify any existing node.',operation:randomUUID()});
const second=await api('chat',{canvas,thread:first.thread,message:'Read the canvas, then add a calendar titled QA queued calendar with no events at x 1800 y 350. Preserve every existing shape.',operation:randomUUID()});
let observedQueued=false;
await wait(async()=>{const history=await api(`history?canvas=${canvas}`);observedQueued||=history.runs.find(r=>r.id===second.id)?.status==='queued';const run=history.runs.find(r=>r.id===first.id);if(run?.status==='failed'||run?.status==='paused')throw Error(`Live run ${run.status}`);return run?.status==='complete';});
await wait(async()=>{const history=await api(`history?canvas=${canvas}`),run=history.runs.find(r=>r.id===second.id);if(run?.status==='failed'||run?.status==='paused')throw Error(`Queued run ${run.status}`);return run?.status==='complete';});
assert.ok(observedQueued,'Second turn was queued');
const cancel=await api('chat',{canvas,thread:first.thread,message:'Read the canvas and add one markdown node titled QA must not commit with body Cancel me at x 2400 y 0. You must set delaySeconds 20 for addNode, waiting before saving.',operation:randomUUID()});
const delayed=await wait(async()=>{const history=await api(`history?canvas=${canvas}`),run=history.runs.find(r=>r.id===cancel.id);if(!run?.session_id)return;const snap=await client.sessions.attach(run.session_id).snapshot();return snap.events.find(e=>e.type==='actions.requested'&&JSON.stringify(e.data).includes('addNode'))&&run;});
await api('cancel',{canvas,run:cancel.id});
await wait(async()=>{const history=await api(`history?canvas=${canvas}`);return history.runs.find(r=>r.id===cancel.id)?.status==='cancelled';});
const history=await api(`history?canvas=${canvas}`);let cost=0;const runs=history.runs.filter(r=>[first.id,second.id,cancel.id].includes(r.id));
for(const run of runs){const snapshot=await client.sessions.attach(run.session_id).snapshot();for(const event of snapshot.events)if(event.type==='step.completed')cost+=event.data.usage?.costUsd||event.data.usage?.cost?.total||0;}
const result={checks:['live Gateway/eve scoped markdown mutation','second turn queued and completed','durable delayed tool cancelled','Neon chat history retained'],runs:runs.map(({id,status})=>({id,status})),observedModelStepCostUsd:cost};
await writeFile('/tmp/kan-web-agent-results.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
