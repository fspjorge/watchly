import { describe,it,expect,vi } from 'vitest';
import { isPublicAddress, resolvePublicAddress, type Resolver, type Address, type PinnedResponse } from './ssrf.ts';
import { followValidatedRedirects } from './redirects.internal.ts';

const resolver=(answers:Record<string,string[]>):Resolver=>async host=>(answers[host]??[]).map(address=>({address,family:address.includes(':')?6:4}));
const response=(status:number,location?:string):PinnedResponse=>({status,headers:location?{location}: {},body:Buffer.alloc(0)});
const publicDns=(host:string):Address[]=>[{address:host==='a.test'?'8.8.8.8':host==='b.test'?'1.1.1.1':'9.9.9.9',family:4}];

describe('SSRF address policy',()=>{
 it.each(['10.0.0.1','127.0.0.1','169.254.1.1','192.168.1.2','224.0.0.1','0.0.0.0','192.0.2.1'])('blocks IPv4 %s',ip=>expect(isPublicAddress(ip)).toBe(false));
 it('allows public IPv4',()=>expect(isPublicAddress('8.8.8.8')).toBe(true));
 it.each(['::1','fc00::1','fe80::1','ff02::1','2001:db8::1','::ffff:127.0.0.1','::ffff:8.8.8.8'])('blocks IPv6 %s',ip=>expect(isPublicAddress(ip)).toBe(false));
 it('allows public IPv6',()=>expect(isPublicAddress('2606:4700:4700::1111')).toBe(true));
 it('accepts multiple public DNS answers, pins the first',async()=>expect(await resolvePublicAddress('site.test',resolver({'site.test':['8.8.8.8','1.1.1.1']}))).toEqual({address:'8.8.8.8',family:4}));
 it('rejects mixed public and private DNS answers',async()=>await expect(resolvePublicAddress('site.test',resolver({'site.test':['8.8.8.8','10.0.0.1']}))).rejects.toThrow(/não público/));
 it('surfaces DNS failures',async()=>await expect(resolvePublicAddress('bad.test',async()=>{throw Error('DNS failure');})).rejects.toThrow('DNS failure'));
});

describe('validated redirect transport',()=>{
 it('redirects between public domains and pins each resolved address',async()=>{
  const resolve=vi.fn(async(host:string)=>publicDns(host));const sent:Array<[string,string]>=[];
  const transport=vi.fn(async(url:URL,ip:Address)=>{sent.push([url.hostname,ip.address]);return url.hostname==='a.test'?response(302,'https://b.test/end'):response(200);});
  const result=await followValidatedRedirects('https://a.test/start',resolve,transport);
  expect(result.finalUrl).toBe('https://b.test/end');expect(sent).toEqual([['a.test','8.8.8.8'],['b.test','1.1.1.1']]);expect(resolve.mock.calls.map(c=>c[0])).toEqual(['a.test','b.test']);
 });
 it.each(['http://10.0.0.1/admin','http://127.0.0.1/admin','http://[::1]/admin'])('rejects private redirect %s before another transport call',async location=>{
  const transport=vi.fn(async()=>response(302,location));
  const dns:Resolver=async(host)=>{
   if(host==='a.test')return [{address:'8.8.8.8',family:4}];
   if(host==='[::1]'||host==='::1')return [{address:'::1',family:6}];
   return host==='10.0.0.1'?[{address:'10.0.0.1',family:4}]:[{address:'127.0.0.1',family:4}];
  };
  await expect(followValidatedRedirects('https://a.test/',dns,transport)).rejects.toThrow(/não público/);
  expect(transport).toHaveBeenCalledTimes(1);
 });
 it('validates every hop in a redirect chain and never reuses the previous IP',async()=>{
  const resolve=vi.fn(async(host:string)=>publicDns(host));const sent:Array<[string,string]>=[];
  const transport=vi.fn(async(url:URL,ip:Address)=>{sent.push([url.hostname,ip.address]);if(url.hostname==='a.test')return response(302,'https://b.test/');if(url.hostname==='b.test')return response(307,'https://c.test/final');return response(200);});
  await followValidatedRedirects('https://a.test/',resolve,transport);
  expect(sent).toEqual([['a.test','8.8.8.8'],['b.test','1.1.1.1'],['c.test','9.9.9.9']]);expect(resolve).toHaveBeenCalledTimes(3);
 });
 it('rejects mixed public/private DNS answers and DNS failures before transport',async()=>{
  const transport=vi.fn(async()=>response(302,'https://mixed.test/'));
  await expect(followValidatedRedirects('https://a.test/',async host=>host==='a.test'?publicDns(host):[{address:'8.8.4.4',family:4},{address:'192.168.1.2',family:4}],transport)).rejects.toThrow(/não público/);
  expect(transport).toHaveBeenCalledTimes(1);
  const failed=vi.fn(async()=>{throw Error('DNS failure');});const noTransport=vi.fn(async()=>response(200));
  await expect(followValidatedRedirects('https://a.test/',failed,noTransport)).rejects.toThrow('DNS failure');expect(noTransport).not.toHaveBeenCalled();
 });
 it('rejects invalid redirect URLs and circular/excess redirects',async()=>{
  const invalidTransport=vi.fn(async()=>response(302,'javascript:alert(1)'));
  await expect(followValidatedRedirects('https://a.test/',resolver({'a.test':['8.8.8.8']}),invalidTransport)).rejects.toThrow(/URL\/protocolo/);
  const circular=vi.fn(async()=>response(302,'https://a.test/'));
  await expect(followValidatedRedirects('https://a.test/',resolver({'a.test':['8.8.8.8']}),circular,2)).rejects.toThrow(/Demasiados/);
  expect(circular).toHaveBeenCalledTimes(3);
 });
});
