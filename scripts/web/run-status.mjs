import {readFile} from 'node:fs/promises';
import {Client} from 'eve/client';
const fixture=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8')),config=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
const response=await fetch(`https://staging.getkan.dev/api/web/history?canvas=${fixture.canvas}`,{headers:{cookie:fixture.accounts[0].cookie}});const history=await response.json();
const client=new Client({host:'https://staging.getkan.dev',auth:{bearer:config.secret},redirect:'manual'});
for(const run of history.runs||[]){let snapshot;try{snapshot=run.session_id?await client.sessions.attach(run.session_id).snapshot():null;}catch{snapshot=null;}console.log(JSON.stringify({id:run.id,status:run.status,events:snapshot?.events.map(e=>e.type),usage:snapshot?.events.filter(e=>e.type==='step.completed').map(e=>e.data.usage)}));}
