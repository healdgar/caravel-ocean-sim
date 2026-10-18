import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeGPUTimestamps} from '../js/profiler.js';

test('GPU window encloses early render stages and overlapping bloom without summing waits',()=>{
  const names=['Waves + effects','Ocean + sky','Bloom down 0','Bloom up 1','Composite'];
  const times=BigUint64Array.from([100,103,10,160,12,170,15,174,165,166],v=>BigInt(v)*1000000n);
  const result=decodeGPUTimestamps(times,names,[1,1,1,1,1]);
  assert.equal(result.windowMs,164); // Endpoint subtraction alone gives 66.
  assert.equal(result.passes['Ocean + sky'],150);
  assert.equal(result.passes.Bloom,162); // Not 158 + 159.
  for(const span of Object.values(result.passes))assert.ok(span<=result.windowMs);
});

test('GPU timing excludes stale disabled queries, accepts quantized zero, and rejects reversed timestamps',()=>{
  const times=BigUint64Array.from([100,100,1,900,101,110],v=>BigInt(v)*1000000n);
  const result=decodeGPUTimestamps(times,['Waves + effects','Bloom down 0','Composite'],[1,0,1]);
  assert.equal(result.windowMs,10);assert.equal(result.passes.Bloom,0);
  assert.equal(result.passes['Waves + effects'],0);
  assert.equal(decodeGPUTimestamps(new BigUint64Array([2n,1n]),['Frame'],[1]),null);
});
