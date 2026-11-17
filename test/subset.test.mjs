import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { Catalog } from '../src/catalog.mjs';
import {
  interpretCoverage,
  interpretCapabilities,
  planIntake,
  examineChunk,
  mergeCells,
  runSubsetIntake,
  SubsetError,
  VersionConflictError,
  GridMismatchError
} from '../src/subset.mjs';
import { startApplication } from '../src/app.mjs';

const descriptionGrid1 = {
  coverageId: 'park-temp',
  version: 'grid-1',
  axes: [
    { label: 'Lat', unit: 'deg', lower: 30, upper: 31 },
    { label: 'Long', unit: 'deg', lower: 120, upper: 121 },
    { label: 'time', unit: 'ISO8601', lower: '2026-10-12T00:00:00Z', upper: '2026-10-12T02:00:00Z' }
  ],
  grid: { origin: [31, 120], offsets: [[-0.5, 0], [0, 0.5]], low: [0, 0], high: [2, 2] },
  formats: ['application/json'],
  subsettingCRS: ['http://www.opengis.net/def/crs/EPSG/0/4326'],
  nilValues: [-9999]
};

const capabilities = {
  version: '2.0.1', coverageIds: ['park-temp'], profiles: ['core', 'get-kvp'],
  limits: { maxCells: 4 }, trimSupported: true, sliceSupported: false
};

function chunkBody({ version = 'grid-1', origin, rows, columns, values, rowBounds, columnBounds }) {
  return {
    coverageId: 'park-temp',
    version,
    bounds: [rowBounds, columnBounds],
    shape: [rows, columns],
    values,
    origin,
    offsets: [[-0.5, 0], [0, 0.5]]
  };
}

test('规划先读轴名称、方向、单位与网格，物理范围与索引分开处理', () => {
  const coverage = interpretCoverage(descriptionGrid1);
  assert.deepEqual(coverage.spatialAxes.map(axis => ({ label: axis.label, unit: axis.unit, direction: axis.direction })),
    [{ label: 'Lat', unit: 'deg', direction: 'descending' }, { label: 'Long', unit: 'deg', direction: 'ascending' }]);
  assert.equal(coverage.spatialAxes[0].coordinateAt(2), 30);
  assert.equal(coverage.spatialAxes[1].coordinateAt(2), 121);
  assert.deepEqual(coverage.otherAxes.map(axis => axis.label), ['time']);
  assert.deepEqual(coverage.nilValues, [-9999]);

  const ability = interpretCapabilities(capabilities);
  assert.equal(ability.maxCells, 4);
  assert.equal(ability.trimSupported, true);
  assert.equal(ability.sliceSupported, false);

  const plan = planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: { Lat: [30, 31], Long: [120, 121] } });
  assert.equal(plan.expectedCells, 9);
  assert.equal(plan.tileRequests.length, 4);
  assert.ok(plan.tileRequests.every(tile => tile.cellCount <= 4));
  // 分片在索引空间互不重叠，重叠边界不会被领取两次
  const boxes = plan.tileRequests.map(tile => `${tile.indexBox.row.join('-')}:${tile.indexBox.column.join('-')}`);
  assert.equal(new Set(boxes).size, 4);
  for (let i = 0; i < plan.tileRequests.length; i += 1) {
    for (let j = i + 1; j < plan.tileRequests.length; j += 1) {
      const a = plan.tileRequests[i].indexBox;
      const b = plan.tileRequests[j].indexBox;
      const overlapRows = a.row[0] <= b.row[1] && b.row[0] <= a.row[1];
      const overlapColumns = a.column[0] <= b.column[1] && b.column[0] <= a.column[1];
      assert.equal(overlapRows && overlapColumns, false);
    }
  }
});

test('非对齐需求向外对齐并说明多取，出界部分单列而不是悄悄缩小需求', () => {
  const plan = planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: { Lat: [30.2, 30.3], Long: [120.2, 121.6] } });
  const [lat, long] = plan.axisPlans;
  // 30.2~30.3 夹在 30 与 30.5 之间：向外对齐到两个网格点（索引按数值排序）
  assert.deepEqual(lat.selectedIndices, [1, 2]);
  assert.deepEqual([lat.selectedPhysical.low, lat.selectedPhysical.high], [30, 30.5]);
  assert.deepEqual(lat.overfetch.map(part => [part.low, part.high]).sort(), [[30, 30.2], [30.3, 30.5]]);
  // 经度需求越过覆盖上界 121：出界部分保留在 outside
  assert.deepEqual(long.outside.map(part => [part.low, part.high]), [[121, 121.6]]);
  assert.deepEqual([long.selectedPhysical.low, long.selectedPhysical.high], [120.5, 121]);
});

test('与覆盖完全不重叠的需求直接拒绝，不制造空网格', () => {
  assert.throws(() => planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: { Lat: [40, 41], Long: [120, 120.5] } }), /没有重叠/);
});

test('未公布的轴、不支持的格式与缺失范围都会被拒绝', () => {
  assert.throws(() => planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: { Elevation: [0, 1] } }), /没有轴/);
  const noJson = { ...descriptionGrid1, formats: ['image/tiff'] };
  assert.throws(() => planIntake({ description: noJson, capabilities,
    coverageId: 'park-temp', trims: { Lat: [30, 30.5], Long: [120, 120.5] } }), /application\/json/);
  assert.throws(() => planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: {} }), /至少/);
  const noTrim = { ...capabilities, trimSupported: false };
  assert.throws(() => planIntake({ description: descriptionGrid1, capabilities: noTrim,
    coverageId: 'park-temp', trims: { Lat: [30, 30.5], Long: [120, 120.5] } }), /trim/);
  assert.throws(() => planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: { Lat: [30, 30.5] } }), /需要给出/);
  assert.throws(() => planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'other-coverage', trims: { Lat: [30, 30.5], Long: [120, 120.5] } }), /coverageId/);
  assert.ok(new SubsetError('x') instanceof Error);
});

test('每块按版本、原点、步长、形状、物理范围和 nil 标记核对', () => {
  const plan = planIntake({ description: descriptionGrid1, capabilities,
    coverageId: 'park-temp', trims: { Lat: [30.5, 31], Long: [120, 120.5] } });
  const tile = plan.tileRequests[0];
  const good = chunkBody({ origin: [31, 120], rows: 2, columns: 2, values: [20, -9999, 22, 23],
    rowBounds: [30.5, 31], columnBounds: [120, 120.5] });
  const examined = examineChunk({ bytes: Buffer.from(JSON.stringify(good)),
    headers: { 'content-type': 'application/json' }, plan, tile });
  assert.equal(examined.cells.length, 4);
  assert.deepEqual(examined.cells.find(cell => cell.nil).indices, [0, 1]);
  assert.deepEqual(examined.cells[0].coordinates, [31, 120]);

  const stale = { ...good, version: 'grid-2' };
  assert.throws(() => examineChunk({ bytes: Buffer.from(JSON.stringify(stale)),
    headers: {}, plan, tile }), VersionConflictError);
  const wrongOrigin = { ...good, origin: [31.1, 120] };
  assert.throws(() => examineChunk({ bytes: Buffer.from(JSON.stringify(wrongOrigin)),
    headers: {}, plan, tile }), /原点/);
  const wrongStep = { ...good, offsets: [[-0.25, 0], [0, 0.5]] };
  assert.throws(() => examineChunk({ bytes: Buffer.from(JSON.stringify(wrongStep)),
    headers: {}, plan, tile }), /步长/);
  const wrongShape = { ...good, shape: [2, 1], values: [1, 2] };
  assert.throws(() => examineChunk({ bytes: Buffer.from(JSON.stringify(wrongShape)),
    headers: {}, plan, tile }), GridMismatchError);
  const wrongBounds = { ...good, bounds: [[30, 30.5], [120, 120.5]] };
  assert.throws(() => examineChunk({ bytes: Buffer.from(JSON.stringify(wrongBounds)),
    headers: {}, plan, tile }), /物理范围/);
});

test('合并时同一网格点只算一次观测，数值冲突拒绝拼接', () => {
  const cell = (row, column, value) => ({ key: `${row}/${column}`, indices: [row, column],
    coordinates: [31 - row * 0.5, 120 + column * 0.5], value, nil: value === -9999 });
  const merged = mergeCells([
    [cell(0, 0, 20), cell(0, 1, -9999)],
    [cell(0, 1, -9999), cell(1, 0, 22)]
  ]);
  assert.equal(merged.cells.length, 3);
  assert.deepEqual(merged.duplicateKeys, ['0/1']);
  assert.throws(() => mergeCells([[cell(0, 0, 20)], [cell(0, 0, 21)]]), /冲突/);
});

test('真实来源整幅范围分四次领取，原件与无数据标记逐块核对', async () => {
  const source = await startSource();
  const client = new SourceClient(source.base);
  try {
    const description = JSON.parse((await client.request('/wcs/describe/park-temp')).bytes);
    const ability = JSON.parse((await client.request('/wcs/capabilities')).bytes);
    const intake = await runSubsetIntake({ client, description, capabilities: ability,
      coverageId: 'park-temp', trims: { Lat: [30, 31], Long: [120, 121] } });
    assert.equal(intake.status, 'complete');
    assert.equal(intake.chunks.length, 4);
    assert.ok(intake.chunks.every(chunk => chunk.status === 'received' && chunk.version === 'grid-1'));
    assert.equal(intake.coverage.expectedCells, 9);
    assert.equal(intake.coverage.receivedCells, 9);
    assert.equal(intake.coverage.nilCells, 3);
    assert.equal(intake.coverage.missingCells.length, 0);
    assert.equal(intake.rawChunks.length, 4);
    assert.ok(intake.rawChunks.every(chunk => Buffer.isBuffer(chunk.bytes)));
    assert.match(intake.notes.join('\n'), /time/);
    const keys = new Set(intake.coverage.cells.map(cell => cell.key));
    assert.equal(keys.size, 9);
  } finally {
    await source.close();
  }
});

test('领取途中描述更新会中止，旧网格与新网格不拼成连续数据', async () => {
  const source = await startSource({ scenario: 'transition' });
  const raw = new SourceClient(source.base);
  try {
    const description = JSON.parse((await raw.request('/wcs/describe/park-temp')).bytes);
    const ability = JSON.parse((await raw.request('/wcs/capabilities')).bytes);
    let subsetCalls = 0;
    const client = {
      async request(path) {
        const result = await raw.request(path);
        if (path.startsWith('/wcs/subset')) {
          subsetCalls += 1;
          if (subsetCalls === 2) await raw.control({ action: 'advance' });
        }
        return result;
      }
    };
    const intake = await runSubsetIntake({ client, description, capabilities: ability,
      coverageId: 'park-temp', trims: { Lat: [30, 31], Long: [120, 121] } });
    assert.equal(intake.status, 'aborted-version-conflict');
    assert.equal(intake.aborted.reason, 'version');
    const received = intake.chunks.filter(chunk => chunk.status === 'received');
    assert.ok(received.length >= 1 && received.length < 4);
    assert.ok(received.every(chunk => chunk.version === 'grid-1'));
    assert.equal(intake.chunks.at(-1).status, 'version-conflict');
    assert.ok(intake.coverage.missingCells.length > 0);
    assert.equal(intake.coverage.receivedCells + intake.coverage.missingCells.length, intake.coverage.expectedCells);
  } finally {
    await source.close();
  }
});

test('传输失败时保留已收块并逐项列出未取得部分', async () => {
  const source = await startSource();
  const raw = new SourceClient(source.base);
  try {
    const description = JSON.parse((await raw.request('/wcs/describe/park-temp')).bytes);
    const ability = JSON.parse((await raw.request('/wcs/capabilities')).bytes);
    const client = {
      async request(path) {
        if (path.includes('Lat=30%2C30')) throw new Error('连接被来源断开');
        return raw.request(path);
      }
    };
    const intake = await runSubsetIntake({ client, description, capabilities: ability,
      coverageId: 'park-temp', trims: { Lat: [30, 31], Long: [120, 121] } });
    assert.equal(intake.status, 'incomplete');
    assert.ok(intake.chunks.some(chunk => chunk.status === 'transport-error'));
    assert.ok(intake.coverage.missingCells.length > 0);
    assert.match(intake.notes.join('\n'), /未取得/);
  } finally {
    await source.close();
  }
});

test('HTTP 入口交付可解释的收件结果，来源原件按摘要留存且可回读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subset-e2e-'));
  const source = await startSource();
  const app = await startApplication({ source: source.base, root: directory });
  try {
    const response = await fetch(`${app.base}/subsets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Lat 30.2~30.3 夹在两个网格点之间（产生多取），Long 越过覆盖上界（产生出界说明）
      body: JSON.stringify({ coverageId: 'park-temp', trims: { Lat: [30.2, 30.3], Long: [120, 121.6] } })
    });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.status, 'complete');
    assert.ok(receipt.axes.some(axis => axis.overfetch.length > 0));
    assert.ok(receipt.axes.find(axis => axis.axis === 'Long').outsideCoverage.length > 0);
    assert.ok(receipt.rawChunks.every(chunk => /^[a-f0-9]{64}$/.test(chunk.digest)));
    const listed = await fetch(`${app.base}/subsets`).then(result => result.json());
    assert.equal(listed.length, 1);
    const fetched = await fetch(`${app.base}/subsets/${receipt.id}`).then(result => result.json());
    assert.equal(fetched.id, receipt.id);
    for (const chunk of receipt.rawChunks) {
      const bytes = Buffer.from(await fetch(`${app.base}/objects/${chunk.digest}`).then(result => result.arrayBuffer()));
      assert.equal(bytes.length, chunk.bytes);
      const parsed = JSON.parse(bytes);
      assert.equal(parsed.coverageId, 'park-temp');
    }
    const reopened = await new Catalog(directory).subset(receipt.id);
    assert.equal(reopened.version, 'grid-1');

    const invalid = await fetch(`${app.base}/subsets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coverageId: '../escape', trims: { Lat: [30, 30.5], Long: [120, 120.5] } })
    });
    assert.equal(invalid.status, 422);
    assert.match((await invalid.json()).error, /coverageId/);
  } finally {
    await app.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
