import { describe, expect, it, vi } from 'vitest';
import { createPinnedLookup, type Address } from './ssrf.ts';

const v4: Address = { address: '8.8.8.8', family: 4 };
const v6: Address = { address: '2606:4700:4700::1111', family: 6 };

describe('pinned Node lookup adapter', () => {
 it('supports lookup(hostname, callback)', async () => {
  const cb=vi.fn(); createPinnedLookup(v4)('example.test', cb as never);
  await new Promise(resolve=>setImmediate(resolve)); expect(cb).toHaveBeenCalledExactlyOnceWith(null,v4.address,4);
 });
 it('supports lookup(hostname, options, callback) with all=false', async () => {
  const cb=vi.fn(); createPinnedLookup(v4)('example.test',{all:false},cb as never);
  await new Promise(resolve=>setImmediate(resolve)); expect(cb).toHaveBeenCalledExactlyOnceWith(null,v4.address,4);
 });
 it('supports all=true with the Node address list shape', async () => {
  const cb=vi.fn(); createPinnedLookup(v4)('example.test',{all:true},cb as never);
  await new Promise(resolve=>setImmediate(resolve)); expect(cb).toHaveBeenCalledExactlyOnceWith(null,[v4]);
 });
 it('supports family=4 and returns only the validated address', async () => {
  const cb=vi.fn(); createPinnedLookup(v4)('example.test',{family:4},cb as never);
  await new Promise(resolve=>setImmediate(resolve)); expect(cb).toHaveBeenCalledExactlyOnceWith(null,v4.address,4);
 });
 it('supports family=6 and returns only the validated address', async () => {
  const cb=vi.fn(); createPinnedLookup(v6)('example.test',{family:6},cb as never);
  await new Promise(resolve=>setImmediate(resolve)); expect(cb).toHaveBeenCalledExactlyOnceWith(null,v6.address,6);
 });
 it('propagates family mismatch through callback exactly once', async () => {
  const cb=vi.fn(); createPinnedLookup(v4)('example.test',{family:6},cb as never);
  await new Promise(resolve=>setImmediate(resolve)); expect(cb).toHaveBeenCalledOnce();
  expect(cb.mock.calls[0][0]).toMatchObject({code:'EAI_ADDRFAMILY'});
 });
});
