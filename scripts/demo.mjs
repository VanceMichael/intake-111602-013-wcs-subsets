import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);

  process.stdout.write('\n按范围领取：整幅 3x3 网格（单次上限 4 格，分块返回）\n');
  const full = await fetch(`${app.base}/subsets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ coverageId: 'park-temp', trims: { Lat: [30, 31], Long: [120, 121] } })
  }).then(response => response.json());
  process.stdout.write(JSON.stringify({
    id: full.id,
    status: full.status,
    version: full.version,
    tiles: full.planning.tileCount,
    receivedCells: full.coverage.receivedCells,
    nilCells: full.coverage.nilCells,
    missingCells: full.coverage.missingCells.length
  }, null, 2));
  process.stdout.write('\n');

  process.stdout.write('\n按范围领取：非对齐需求与出界范围（说明多取与未取得部分）\n');
  const partial = await fetch(`${app.base}/subsets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      coverageId: 'park-temp',
      trims: { Lat: [30.2, 30.3], Long: [120.2, 121.6], time: ['2026-10-12T01:00:00Z', '2026-10-12T03:00:00Z'] }
    })
  }).then(response => response.json());
  process.stdout.write(JSON.stringify({
    id: partial.id,
    status: partial.status,
    axes: partial.axes,
    time: partial.time,
    notes: partial.notes
  }, null, 2));
  process.stdout.write('\n');

  const subsets = await fetch(`${app.base}/subsets`).then(response => response.json());
  process.stdout.write(`\n子集收件凭据共 ${subsets.length} 份，原件仍可经 /objects/<摘要> 回读\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
