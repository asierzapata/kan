import {readFile} from 'node:fs/promises';
const fixture=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8')),config=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
const response=await fetch('https://kan-staging-realtime.clipdoc.workers.dev/tool',{method:'POST',redirect:'manual',headers:{authorization:`Bearer ${config.secret}`,'content-type':'application/json'},body:JSON.stringify({canvas:fixture.canvas,user:fixture.accounts[0].id,name:'getCanvas',input:{scope:'full'}})});
if(!response.ok)throw Error(`Canvas read ${response.status}`);const state=await response.json();console.log(JSON.stringify({revision:state.revision,shapes:state.shapes.map(s=>({id:s.id,type:s.type,title:s.props.title}))}));
