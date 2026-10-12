// Private staging HTTP integration fixture. This exercises real WorkOS password
// authentication and SDK-sealed sessions, not an interactive callback/browser flow.
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {WorkOS} from '@workos-inc/node';
process.loadEnvFile('/tmp/kan-m0-development-private.env');
if(process.env.WORKOS_CLIENT_ID!=='client_01M4R7WXNY5K5GQBN0GYE64G7F')throw Error('Wrong WorkOS application');
const config=JSON.parse(await readFile('/tmp/kan-staging-private.json','utf8'));
const fixture=JSON.parse(await readFile('/tmp/kan-web-qa-user.json','utf8'));
const workos=new WorkOS(process.env.WORKOS_API_KEY,{clientId:process.env.WORKOS_CLIENT_ID});
const viewerPassword=randomBytes(32).toString('base64url')+'A9!';
const viewer=await workos.userManagement.createUser({email:'kan-migration-viewer-20261012@example.test',password:viewerPassword,emailVerified:true,firstName:'Synthetic',lastName:'Viewer'});
await workos.userManagement.updateUser({userId:fixture.userId,emailVerified:true});
const accounts=[];
for(const account of [{email:fixture.email,password:fixture.password,id:fixture.userId},{email:viewer.email,password:viewerPassword,id:viewer.id}]){
 const result=await workos.userManagement.authenticateWithPassword({clientId:process.env.WORKOS_CLIENT_ID,email:account.email,password:account.password,session:{sealSession:true,cookiePassword:config.cookiePassword}});
 if(!result.sealedSession)throw Error('Session seal unavailable');accounts.push({id:account.id,email:account.email,cookie:`wos-session=${encodeURIComponent(result.sealedSession)}`});
}
await writeFile('/tmp/kan-web-qa-sessions.json',JSON.stringify(accounts),{mode:0o600});
console.log('Created two real WorkOS sandbox sessions; credentials remain private.');
