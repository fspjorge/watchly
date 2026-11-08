import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPinned, type Address } from './ssrf.ts';

const fixtures=resolve(process.cwd(),'cloud-run/fixtures');
const ca=readFileSync(resolve(fixtures,'ca.pem'));
const pinned:Address={address:'127.0.0.1',family:4};
const servers:https.Server[]=[];

async function startServer(cert:string,key:string){
 let observed:{host?:string;remoteAddress?:string;sni?:string}|undefined;
 const server=https.createServer({cert:readFileSync(resolve(fixtures,cert)),key:readFileSync(resolve(fixtures,key))},(req,res)=>{
  const socket=req.socket as TLSSocket;
  observed={host:req.headers.host,remoteAddress:socket.remoteAddress,sni:socket.servername||undefined};
  res.writeHead(200,{'content-type':'text/plain'});res.end('tls-ok');
 });
 servers.push(server);
 await new Promise<void>((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
 const address=server.address();if(!address||typeof address==='string')throw Error('TLS test server did not bind TCP.');
 return {server,port:address.port,get observed(){return observed;}};
}

afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolveClose=>server.close(()=>resolveClose()))));});

describe('TLS with pinned destination',()=>{
 it('connects to the pinned IP, preserves Host and SNI, and validates watchly.test',async()=>{
  const local=await startServer('server.pem','server-key.pem');
  const response=await requestPinned(new URL(`https://watchly.test:${local.port}/health`),pinned,{timeoutMs:1000,maxBytes:1024,ca});
  expect(response.status).toBe(200);expect(response.body.toString()).toBe('tls-ok');
  expect(local.observed?.host).toBe(`watchly.test:${local.port}`);
  expect(local.observed?.sni).toBe('watchly.test');
  expect(local.observed?.remoteAddress).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
 });

 it('rejects a CA-trusted certificate whose SAN does not match watchly.test',async()=>{
  const local=await startServer('wrong-host.pem','wrong-host-key.pem');
  await expect(requestPinned(new URL(`https://watchly.test:${local.port}/`),pinned,{timeoutMs:1000,maxBytes:1024,ca}))
   .rejects.toMatchObject({code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  expect(local.observed).toBeUndefined();
 });
});
