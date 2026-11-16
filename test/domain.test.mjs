import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('覆盖领取具有单次范围约束且网格版本会变更', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    assert.equal((await client.request('/wcs/subset?Lat=30,31&Long=120,121')).status, 413);
    const path = '/wcs/subset?Lat=30,30.5&Long=120,120.5';
    const first = JSON.parse((await client.request(path)).bytes);
    assert.deepEqual(first.shape, [2, 2]); assert.ok(first.values.includes(-9999));
    await client.control({ action: 'advance' });
    const changed = JSON.parse((await client.request(path)).bytes);
    assert.notEqual(changed.version, first.version);
    assert.notDeepEqual(changed.origin, first.origin);
  } finally { await source.close(); }
});
