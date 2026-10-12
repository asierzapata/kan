import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Store} from '@tldraw/store';
import {atom} from '@tldraw/state';
import {TLSyncClient,ClientWebSocketAdapter} from '@tldraw/sync-core';
import {createTLSchema,defaultShapeSchemas} from '@tldraw/tlschema';
import {draftToShapePartial} from '../../apps/desktop/src/nodes/draft.ts';
import * as props from '../../apps/desktop/src/nodes/shapes/types.ts';
const fixture=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8'));
const origin='https://staging.getkan.dev',canvas=fixture.canvas;
const schema=createTLSchema({shapes:{...defaultShapeSchemas,...Object.fromEntries(['markdown','chart','table','image','map','logo','timeline','calendar'].map(type=>[`kan-${type}`,{props:props[`${type}ShapeProps`]}]))}});
globalThis.window??={addEventListener(){},removeEventListener(){},devicePixelRatio:1};globalThis.document??={addEventListener(){},removeEventListener(){},hidden:false};globalThis.requestAnimationFrame??=cb=>setTimeout(cb,16);globalThis.cancelAnimationFrame??=clearTimeout;
async function wait(check,max=25000){const end=Date.now()+max;while(!check()){if(Date.now()>end)throw Error('Convergence timeout');await new Promise(r=>setTimeout(r,100));}}
async function client(account){const store=new Store({schema,props:{}}),socket=new ClientWebSocketAdapter(async()=>{const response=await fetch(`${origin}/api/web/room?canvas=${canvas}`,{headers:{cookie:account.cookie}});assert.equal(response.status,200);return (await response.json()).uri;});let sync;await Promise.race([new Promise((resolve,reject)=>{sync=new TLSyncClient({store,socket,presence:atom('presence',null),onLoad:resolve,onSyncError:reject});}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Socket startup timeout')),25000))]);return {store,close(){sync.close();socket.close();}};}
const clients=[];
try{
 const a=await client(fixture.accounts[0]);clients.push(a);const b=await client(fixture.accounts[1]);clients.push(b);
 const drafts=[{type:'markdown',title:'QA shared note',body:'Saved across reconnect'},{type:'chart',title:'QA chart',spec:{kind:'bar',x:'x',series:[{key:'y'}]},data:[{x:'A',y:2}]},{type:'table',title:'QA table',columns:['A'],rows:[[1]]},{type:'map',title:'QA map',markers:[{lat:40,lng:-3,label:'Madrid'}]},{type:'logo',domain:'example.com'},{type:'timeline',title:'QA timeline',events:[{id:'a',title:'Event',start:'2026-10-12'}]},{type:'calendar',title:'QA calendar',events:[{id:'a',title:'Event',start:'2026-10-12'}],selectedDate:'2026-10-12'},{type:'image',title:'QA private image',src:fixture.src,alt:'Synthetic pixel'}];
 const records=drafts.map((draft,i)=>schema.types.shape.create({rotation:0,isLocked:false,opacity:1,parentId:'page:page',index:`a${i+1}`,meta:{},...draftToShapePartial(draft,`shape:qa-web-${i}`,{x:(i%3)*600,y:Math.floor(i/3)*650})}));
 a.store.put(records);await wait(()=>records.every(record=>b.store.get(record.id)));
 const calendar=b.store.get('shape:qa-web-6');b.store.put([{...calendar,props:{...calendar.props,selectedDate:'2026-10-13'}}]);await wait(()=>a.store.get(calendar.id)?.props.selectedDate==='2026-10-13');
 b.close();const refreshed=await client(fixture.accounts[1]);clients.push(refreshed);assert.equal(refreshed.store.get(calendar.id).props.selectedDate,'2026-10-13');assert.equal(refreshed.store.get('shape:qa-web-7').props.src,fixture.src);
 await new Promise(r=>setTimeout(r,65000));await wait(()=>a.store.get(calendar.id)?.props.selectedDate==='2026-10-13');
 const note=refreshed.store.get('shape:qa-web-0');refreshed.store.put([{...note,props:{...note.props,body:'Edited after expiring ticket reconnect'}}]);await wait(()=>a.store.get(note.id)?.props.body==='Edited after expiring ticket reconnect');
 const result={checks:['two real TLSync clients over hosted Cloudflare/Neon','eight rich types committed','peer interactive state edit','fresh client reconstruction','expired ticket reconnect preserves records and resumes edits'],canvas};await writeFile('/tmp/kan-web-realtime-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{clients.forEach(client=>client.close());}
process.exit(0);
