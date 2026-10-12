// Only existing synthetic WorkOS accounts and synthetic migration workspace.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {WorkOS} from '@workos-inc/node';
const origin='https://staging.getkan.dev';
const f=JSON.parse(await readFile('/tmp/kan-web-acceptance-fixture.json','utf8'));
const qa=JSON.parse(await readFile('/tmp/kan-web-qa-user.json','utf8'));
const config=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
process.loadEnvFile('/tmp/kan-m0-development-private.env');
assert.equal(process.env.WORKOS_CLIENT_ID,'client_01M4R7WXNY5K5GQBN0GYE64G7F');
assert.equal(f.accounts[0].id,qa.userId);
async function api(account,path,input,expected=200){const r=await fetch(`${origin}/api/web/${path}`,{method:input?'POST':'GET',redirect:'manual',headers:{cookie:account.cookie,origin,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});assert.equal(r.status,expected,path.split('?')[0]);return r.json();}
async function opened(uri){return new Promise((resolve,reject)=>{const ws=new WebSocket(uri);const timer=setTimeout(()=>{ws.close();reject(Error('Socket open timeout'));},25000);ws.onopen=()=>{clearTimeout(timer);resolve(ws);};ws.onerror=()=>{clearTimeout(timer);reject(Error('Socket rejected'));};});}
async function closed(ws){if(ws.readyState===3)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('Revocation timeout'));},45000);ws.onclose=()=>{clearTimeout(timer);resolve();};});}
const owner=f.accounts[0],member=f.accounts[1];
const ws=await opened((await api(member,`room?canvas=${f.canvas}`)).uri);
await api(owner,'member/role',{workspace:f.workspace,user:member.id,role:'viewer'});
await closed(ws);
await api(member,'canvas/rename',{canvas:f.canvas,name:'Denied'},403);
const readonly=await opened((await api(member,`room?canvas=${f.canvas}`)).uri);
await api(owner,'member/revoke',{workspace:f.workspace,user:member.id});await closed(readonly);
await api(member,`room?canvas=${f.canvas}`,undefined,403);
const workos=new WorkOS(process.env.WORKOS_API_KEY,{clientId:process.env.WORKOS_CLIENT_ID});
const result=await workos.userManagement.authenticateWithPassword({clientId:process.env.WORKOS_CLIENT_ID,email:qa.email,password:qa.password,session:{sealSession:true,cookiePassword:config.cookiePassword}});
const claims=JSON.parse(Buffer.from(result.accessToken.split('.')[1],'base64url'));
const account={cookie:`wos-session=${encodeURIComponent(result.sealedSession)}`};
const sessionSocket=await opened((await api(account,`room?canvas=${f.canvas}`)).uri);
await workos.userManagement.revokeSession({sessionId:claims.sid});
await closed(sessionSocket);
// Allow the explicitly documented 30-second active-session cache to expire.
await new Promise(r=>setTimeout(r,31000));
await api(account,'catalog',undefined,401);
// Old signed ticket cannot reopen a remotely revoked WorkOS session.
const checks=['editor-to-viewer closes existing realtime socket','viewer cannot mutate HTTP','revoked membership closes viewer socket and denies reconnect','remote WorkOS revocation closes realtime socket','revoked WorkOS session denied HTTP after bounded cache'];
await writeFile('/tmp/kan-web-final-security-results.json',JSON.stringify({checks},null,2),{mode:0o600});console.log(JSON.stringify({checks}));
