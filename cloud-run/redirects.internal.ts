import { resolvePublicAddress, type Address, type PinnedResponse, type Resolver } from './ssrf.ts';

/** @internal Deterministic seam for redirect-flow tests; never exposed by the HTTP service. */
export async function followValidatedRedirects(
 rawUrl:string,
 resolver:Resolver,
 transport:(url:URL,address:Address)=>Promise<PinnedResponse>,
 maxRedirects=5,
):Promise<PinnedResponse & {finalUrl:string}>{
 let url=new URL(rawUrl);
 for(let redirects=0;;redirects++){
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('URL/protocolo inválido.');
  const address=await resolvePublicAddress(url.hostname,resolver);
  const response=await transport(url,address);
  if(![301,302,303,307,308].includes(response.status))return {...response,finalUrl:url.toString()};
  if(redirects>=maxRedirects)throw Error('Demasiados redireccionamentos.');
  const location=response.headers.location;if(!location)throw Error('Redirect sem Location.');
  url=new URL(location,url);
 }
}
