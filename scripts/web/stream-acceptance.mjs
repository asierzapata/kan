// Read-only replay of existing paid synthetic runs. Does not start inference.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const f=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8'));
const origin='https://staging.getkan.dev';
async function get(path,expected=200){const r=await fetch(`${origin}/api/web/${path}`,{redirect:'manual',headers:{cookie:f.accounts[0].cookie},signal:AbortSignal.timeout(45000)});assert.equal(r.status,expected);return r;}
const catalog=await(await get('catalog')).json();let target;
for(const canvas of catalog.canvases){const h=await(await get(`history?canvas=${canvas.id}`)).json();const run=h.runs.find(r=>r.id==='88c76f28-2bbf-4d92-8dfe-3d50c991cc3f');if(run)target={canvas:canvas.id,run};}
assert.ok(target,'Existing corrected calendar run required');
const response=await get(`stream?canvas=${target.canvas}&run=${target.run.id}`);
const events=(await response.text()).trim().split('\n').map(JSON.parse);
assert.ok(events.some(e=>e.type==='turn.started'));
assert.ok(events.some(e=>e.type==='message.appended'));
assert.ok(events.some(e=>e.type==='actions.requested'));
assert.ok(events.some(e=>e.type==='action.result'));
assert.ok(events.some(e=>e.type==='turn.completed'));
await get(`stream?canvas=${f.foreign}&run=${target.run.id}`,404);
const result={checks:['authenticated NDJSON replay includes text deltas and tool activity','stream follows actual turn to completion','cross-canvas run stream denied'],eventCount:events.length};
await writeFile('/tmp/kan-web-final-stream-results.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
