import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { followValidatedRedirects } from './redirects.internal.ts';

export type Address = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<Address[]>;
export type PinnedResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };
type PinnedLookup = {
	(hostname: string, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
	(hostname: string, options: { family?: number; all?: false }, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void): void;
	(hostname: string, options: { family?: number; all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: Address[]) => void): void;
};

/** Internal transport adapter. It never calls DNS and only returns the already validated address. */
export function createPinnedLookup(validated: Address): PinnedLookup {
	return ((
		_hostname: string,
		optionsOrCallback: number | { family?: number; all?: boolean } | ((error: NodeJS.ErrnoException | null, address: string, family: number) => void),
		maybeCallback?: ((error: NodeJS.ErrnoException | null, address: string, family: number) => void) | ((error: NodeJS.ErrnoException | null, addresses: Address[]) => void),
	) => {
		const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
		const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as
			((error: NodeJS.ErrnoException | null, address: string, family: number) => void) &
			((error: NodeJS.ErrnoException | null, addresses: Address[]) => void);
		if (!callback) throw new TypeError('lookup callback is required');
		if (options && typeof options === 'object' && options.family && options.family !== validated.family) {
			queueMicrotask(() => callback(Object.assign(new Error('Validated address family mismatch'), { code: 'EAI_ADDRFAMILY' }) as NodeJS.ErrnoException, '', 0));
			return;
		}
		queueMicrotask(() => {
			if (options && typeof options === 'object' && options.all) {
				(callback as unknown as (error: null, addresses: Address[]) => void)(null, [{ ...validated }]);
			} else {
				(callback as (error: null, address: string, family: number) => void)(null, validated.address, validated.family);
			}
		});
	}) as PinnedLookup;
}

const V4_DENY: Array<[number, number]> = [
 [0x00000000,0x00ffffff],[0x0a000000,0x0affffff],[0x64400000,0x647fffff],
 [0x7f000000,0x7fffffff],[0xa9fe0000,0xa9feffff],[0xac100000,0xac1fffff],
 [0xc0000000,0xc00000ff],[0xc0000200,0xc00002ff],[0xc01fc400,0xc01fc7ff],
 [0xc0586300,0xc05863ff],[0xc0a80000,0xc0a8ffff],[0xc6120000,0xc613ffff],
 [0xc6336400,0xc63364ff],[0xcb007100,0xcb0071ff],[0xe0000000,0xffffffff],
];
const toV4=(s:string)=>s.split('.').map(Number).reduce((n,x)=>((n<<8)|x)>>>0,0);
function groups6(s:string):number[]{
 let v=s.toLowerCase().split('%')[0];
 if(v.includes('.')){const i=v.lastIndexOf(':');const n=toV4(v.slice(i+1));v=`${v.slice(0,i)}:${(n>>>16).toString(16)}:${(n&65535).toString(16)}`;}
 const p=v.split('::');if(p.length>2)throw Error('IPv6 inválido');
 const l=p[0]?p[0].split(':'):[],r=p.length===2&&p[1]?p[1].split(':'):[], gap=p.length===2?8-l.length-r.length:0;
 if((p.length===1&&l.length!==8)||(p.length===2&&gap<1)||gap<0)throw Error('IPv6 inválido');
 const out=[...l,...Array(gap).fill('0'),...r].map(x=>parseInt(x,16));if(out.length!==8||out.some(x=>!Number.isInteger(x)||x<0||x>65535))throw Error('IPv6 inválido');return out;
}
export function isPublicAddress(ip:string):boolean{
 const family=isIP(ip);if(family===4){const n=toV4(ip);return !V4_DENY.some(([a,b])=>n>=a&&n<=b);}
 if(family!==6)return false;
 const g=groups6(ip);
 // Only global unicast 2000::/3; reject documentation, special purpose,
 // 6to4, Teredo and IPv4-mapped/translated ranges.
 if((g[0]&0xe000)!==0x2000)return false;
 if(g[0]===0x2001&&(g[1]===0x0db8||(g[1]&0xfff0)===0x0010||g[1]===0))return false;
 if(g[0]===0x2002||g[0]===0x0064&&g[1]===0xff9b)return false;
 return true;
}
export const systemResolver:Resolver=async host=>{
	const literal=host.startsWith('[')&&host.endsWith(']')?host.slice(1,-1):host;
	const family=isIP(literal);if(family)return [{address:literal,family:family as 4|6}];
	const records=await lookup(literal,{all:true,verbatim:true});return records.map(x=>({address:x.address,family:x.family as 4|6}));
};
export async function resolvePublicAddress(host:string,resolver:Resolver=systemResolver):Promise<Address>{
 const answers=await resolver(host);
 if(!answers.length||answers.some(x=>isIP(x.address)!==x.family||!isPublicAddress(x.address)))throw Error('DNS devolveu um destino não público ou inválido.');
 return answers[0];
}

/** Liga ao IP escolhido sem nova resolução; URL hostname continua a determinar Host, SNI e validação do certificado. */
export function requestPinned(url:URL,address:Address,options:{timeoutMs:number;maxBytes:number;signal?:AbortSignal;ca?:Buffer}):Promise<PinnedResponse>{
 return new Promise((resolve,reject)=>{
  const transport=url.protocol==='https:'?https:url.protocol==='http:'?http:null;
  if(!transport)return reject(Error('Protocolo inválido.'));
	  const lookupPinned = createPinnedLookup(address) as http.RequestOptions['lookup'];
	  const req=transport.request({protocol:url.protocol,hostname:url.hostname,port:url.port||undefined,path:url.pathname+url.search,method:'GET',headers:{host:url.host,'user-agent':'Watchly/CloudRun/1.0','accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'},lookup:lookupPinned,servername:url.protocol==='https:'&&!isIP(url.hostname)?url.hostname:undefined,rejectUnauthorized:true,ca:options.ca,signal:options.signal,agent:url.protocol==='https:'?new https.Agent({lookup:lookupPinned,servername:url.hostname, rejectUnauthorized:true,ca:options.ca}):new http.Agent({lookup:lookupPinned}),timeout:options.timeoutMs},res=>{
   const chunks:Buffer[]=[];let size=0;const cl=Number(res.headers['content-length']);
   if(Number.isFinite(cl)&&cl>options.maxBytes){res.destroy(Error('Resposta excede o limite configurado.'));return;}
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>options.maxBytes){res.destroy(Error('Resposta excede o limite configurado.'));return;}chunks.push(chunk);});
   res.on('end',()=>resolve({status:res.statusCode??0,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);
  });
  req.on('timeout',()=>req.destroy(Error('Timeout HTTP.')));req.on('error',reject);req.end();
 });
}

export async function fetchPublic(rawUrl:string, options:{resolver?:Resolver;timeoutMs?:number;maxBytes?:number;maxRedirects?:number}={}):Promise<PinnedResponse & {finalUrl:string}>{
 const resolver=options.resolver??systemResolver, timeoutMs=options.timeoutMs??8000,maxBytes=options.maxBytes??2*1024*1024,maxRedirects=options.maxRedirects??5;
 return followValidatedRedirects(rawUrl,resolver,(url,address)=>requestPinned(url,address,{timeoutMs,maxBytes,signal:AbortSignal.timeout(timeoutMs)}),maxRedirects);
}
