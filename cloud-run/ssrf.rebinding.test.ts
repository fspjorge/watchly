import { describe, expect, it, vi } from 'vitest';
import { createPinnedLookup, isPublicAddress, resolvePublicAddress, type Address } from './ssrf.ts';

describe('DNS rebinding protection at the TCP lookup boundary', () => {
 it('pins the validated public answer and never asks DNS again during connection setup', async () => {
  const publicAnswer: Address = { address: '8.8.8.8', family: 4 };
  const reboundAnswer: Address = { address: '127.0.0.1', family: 4 };
  let answerIndex = 0;
  const resolver = vi.fn(async () => [answerIndex++ === 0 ? publicAnswer : reboundAnswer]);

  const validated = await resolvePublicAddress('rebinding.test', resolver);
  expect(validated).toEqual(publicAnswer);

  // This is the Node lookup callback consumed by net.connect/TCP. Record exactly
  // the address handed to that layer without opening a socket to 8.8.8.8.
  const lookup = createPinnedLookup(validated);
  const connectedAddress = await new Promise<Address>((resolve, reject) => {
   lookup('rebinding.test', { family: 4, all: false }, (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family: family as 4 });
   });
  });

  expect(connectedAddress).toEqual(publicAnswer);
  expect(connectedAddress).not.toEqual(reboundAnswer);
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(isPublicAddress('127.0.0.1')).toBe(false);
  expect(isPublicAddress('10.0.0.1')).toBe(false);
 });
});
