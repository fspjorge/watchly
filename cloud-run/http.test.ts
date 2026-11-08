import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWatchlyServer } from './http.ts';
import type { CheckResult } from './check.ts';

const secret='test-only-secret-not-for-production';const current=Math.floor(Date.now()/1000);
const result:CheckResult={outcome:'initial',message:'Reference created',content:'hello',contentHash:'a'.repeat(64),httpStatus:200,contentType:'text/html',metrics:{durationMs:3,fetchMs:1,extractMs:1,normalizeMs:0,hashMs:1,bytesReceived:42}};
const servers:Server[]=[];
async function start(options:{secret?:string;engine?: (url:string,opts:{previousHash?:string})=>Promise<CheckResult>;now?:number}={}){
 const server=createWatchlyServer({secret:options.secret??secret,engine:options.engine,nowSeconds:()=>options.now??current});servers.push(server);
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const addr=server.address() as AddressInfo;return `http://127.0.0.1:${addr.port}`;
}
function signed(body:Buffer,timestamp=String(current),key=secret){return createHmac('sha256',key).update(timestamp).update('\n').update(body).digest('hex');}
async function post(base:string,body:Buffer,options:{timestamp?:string;signature?:string;contentType?:string}={}){
 return fetch(`${base}/v1/check`,{method:'POST',headers:{'content-type':options.contentType??'application/json',...(options.timestamp===undefined?{'x-watchly-timestamp':String(current)}:{'x-watchly-timestamp':options.timestamp}),...(options.signature===undefined?{'x-watchly-signature':signed(body,options.timestamp??String(current))}:{'x-watchly-signature':options.signature})},body});
}
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));});

describe('Cloud Run HTTP and HMAC',()=>{
 it('accepts an authenticated request and returns engine result and metrics',async()=>{
  const engine=vi.fn(async()=>result);const base=await start({engine});const body=Buffer.from(JSON.stringify({url:'https://example.test/page',previousHash:'b'.repeat(64)}));
  const response=await post(base,body);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({outcome:'initial',httpStatus:200,contentType:'text/html',contentHash:'a'.repeat(64),metrics:{bytesReceived:42}});expect(engine).toHaveBeenCalledWith('https://example.test/page',{previousHash:'b'.repeat(64)});
 });
 it('rejects malformed signature and missing authentication headers',async()=>{
  const base=await start();const body=Buffer.from('{"url":"https://example.test"}');
  expect((await post(base,body,{signature:'xyz'})).status).toBe(401);
  const noHeaders=await fetch(`${base}/v1/check`,{method:'POST',headers:{'content-type':'application/json'},body});expect(noHeaders.status).toBe(401);
 });
 it.each([current-301,current+301])('rejects timestamp outside the five-minute window: %s',async timestamp=>{
  const base=await start();const body=Buffer.from('{"url":"https://example.test"}');expect((await post(base,body,{timestamp:String(timestamp)})).status).toBe(401);
 });
 it('rejects a body altered after signing',async()=>{
  const base=await start();const signedBody=Buffer.from('{"url":"https://example.test"}');const changed=Buffer.from('{"url":"https://other.test"}');
  expect((await post(base,changed,{signature:signed(signedBody)})).status).toBe(401);
 });
 it('reports missing server secret as misconfiguration',async()=>{
  const absent=await start({secret:''});const body=Buffer.from('{"url":"https://example.test"}');expect((await post(absent,body)).status).toBe(500);
 });
 it('rejects malformed JSON and required/invalid parameters',async()=>{
  const base=await start();
  const malformed=Buffer.from('{');expect((await post(base,malformed)).status).toBe(400);
  for(const payload of [{},{url:1},{url:'file:///etc/passwd'},{url:'https://u:p@example.test'},{url:'https://example.test',resolver:'x'},{url:'https://example.test',ca:'x'},{url:'https://example.test',ip:'8.8.8.8'}]){
   const response=await post(base,Buffer.from(JSON.stringify(payload)));expect(response.status).toBe(400);
  }
 });
 it('health is unauthenticated and performs no check',async()=>{
  const engine=vi.fn(async()=>result);const base=await start({engine});const response=await fetch(`${base}/health`);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({status:'ok'});expect(engine).not.toHaveBeenCalled();
 });
 it('returns a generic structured error if the engine throws',async()=>{
  const base=await start({engine:async()=>{throw Error('secret stack detail');}});const body=Buffer.from('{"url":"https://example.test"}');
  const response=await post(base,body);expect(response.status).toBe(502);expect(await response.json()).toEqual({error:'check_failed'});
 });
 it('does not pass client options capable of changing the protected transport',async()=>{
  const engine=vi.fn(async()=>result);const base=await start({engine});const body=Buffer.from(JSON.stringify({url:'https://example.test',resolver:{},timeoutMs:1,maxBytes:1,ca:'fake',ip:'127.0.0.1'}));
  expect((await post(base,body)).status).toBe(400);expect(engine).not.toHaveBeenCalled();
 });
});
