import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { checkUrl, type CheckResult } from './check.ts';

const MAX_REQUEST_BYTES=16*1024;
const SIGNATURE_WINDOW_SECONDS=300;
type Engine=(url:string,options:{previousHash?:string})=>Promise<CheckResult>;
type HttpOptions={secret:string|undefined;engine?:Engine;nowSeconds?:()=>number};

function send(res:ServerResponse,status:number,data:unknown):void {
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));
}
async function readBody(req:IncomingMessage):Promise<Buffer>{
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=part.length;if(size>MAX_REQUEST_BYTES)throw Object.assign(Error('Request body too large'),{status:413});chunks.push(part);}
 return Buffer.concat(chunks,size);
}
function validSignature(secret:string,timestamp:string,body:Buffer,provided:string):boolean{
 if(!/^\d{10}$/.test(timestamp)||! /^[a-f0-9]{64}$/.test(provided))return false;
 const expected=createHmac('sha256',secret).update(timestamp,'utf8').update('\n','utf8').update(body).digest();
 const actual=Buffer.from(provided,'hex');
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
function validTimestamp(timestamp:string,now:number):boolean{
 if(!/^\d{10}$/.test(timestamp))return false;
 const seconds=Number(timestamp);return Number.isSafeInteger(seconds)&&Math.abs(now-seconds)<=SIGNATURE_WINDOW_SECONDS;
}
function validatePayload(value:unknown):{url:string;previousHash?:string}|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const obj=value as Record<string,unknown>;
 if(Object.keys(obj).some(k=>k!=='url'&&k!=='previousHash'))return null;
 if(typeof obj.url!=='string'||obj.url.length<1||obj.url.length>2048)return null;
 if(obj.previousHash!==undefined&&(typeof obj.previousHash!=='string'||! /^[a-f0-9]{64}$/i.test(obj.previousHash)))return null;
 try{const u=new URL(obj.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;}catch{return null;}
 return {url:obj.url,...(typeof obj.previousHash==='string'?{previousHash:obj.previousHash}:{})};
}

/** Internal HTTP server factory; production always uses checkUrl and its protected transport. */
export function createWatchlyServer(options:HttpOptions):Server{
 const engine=options.engine??((url,opts)=>checkUrl(url,opts));
 const now=options.nowSeconds??(()=>Math.floor(Date.now()/1000));
 return createServer(async(req,res)=>{
  const path=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`).pathname;
  if(req.method==='GET'&&path==='/health'){send(res,200,{status:'ok'});return;}
  if(req.method!=='POST'||path!=='/v1/check'){send(res,req.method==='POST'?404:405,{error:'not_found'});return;}
  if(!options.secret){send(res,500,{error:'service_misconfigured'});return;}
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){send(res,415,{error:'content_type_must_be_json'});return;}
  const timestamp=req.headers['x-watchly-timestamp'];const signature=req.headers['x-watchly-signature'];
  if(typeof timestamp!=='string'||typeof signature!=='string'){send(res,401,{error:'unauthorized'});return;}
  if(!validTimestamp(timestamp,now())){send(res,401,{error:'unauthorized'});return;}
  let body:Buffer;
  try{body=await readBody(req);}catch(error){send(res,(error as {status?:number}).status??400,{error:'invalid_request'});return;}
  if(!validSignature(options.secret,timestamp,body,signature)){send(res,401,{error:'unauthorized'});return;}
  let decoded:unknown;
  try{decoded=JSON.parse(body.toString('utf8'));}catch{send(res,400,{error:'invalid_json'});return;}
  const payload=validatePayload(decoded);if(!payload){send(res,400,{error:'invalid_parameters'});return;}
  try{
   const result=await engine(payload.url,{previousHash:payload.previousHash});
   send(res,200,{...result,metrics:{...result.metrics,bytesReceived:result.metrics.bytesReceived}});
  }catch{
   send(res,502,{error:'check_failed'});
  }
 });
}
