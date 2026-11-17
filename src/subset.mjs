import { randomUUID } from 'node:crypto';

/**
 * 按范围领取 WCS 覆盖的规划、核对与合并。
 *
 * 设计原则（对应 docs/资料接口.md 与领取需求）：
 * - 先读取服务公布的轴名称、方向、单位、网格原点/步长、nil 值、格式与能力，
 *   再决定实际可请求的子集；不支持的轴（如时间）不偷偷切片。
 * - 物理范围与网格索引严格区分。服务只按网格点做包含式采样，不能精确落到
 *   网格点上的需求向外对齐，并在结果中说明多取（overfetch）与出界部分。
 * - 大范围按能力表的 maxCells 分块，每块独立核对版本、原点、步长、形状、
 *   无数据标记和物理范围；重叠网格点去重，绝不把同一观测计两次。
 * - 描述更新后版本或原点变化即视为不同网格，旧块与新块不拼成连续数据。
 * - 不做插值、不做地图展示，只保留来源原件与可解释的收件结果。
 */

export class SubsetError extends Error {}
export class VersionConflictError extends SubsetError {}
export class GridMismatchError extends SubsetError {}

const EPSILON = 1e-9;

export function approxEqual(a, b, epsilon = EPSILON) {
  return Math.abs(a - b) <= epsilon;
}

function asNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SubsetError(`${label}必须是有限数值`);
  return number;
}

/** 把物理数值按网格步长量级规整，避免 30.5 变成 30.499999999999996 之类的噪声。 */
function gridNumber(value, step) {
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(Math.abs(step)))));
  return Number(value.toFixed(decimals));
}

/** 有序标量区间（low <= high），统一用 low/high 表达，方向信息另存。 */
function interval(low, high) {
  return { low, high };
}

/** 两个区间的交集，无交集返回 null。 */
function intersect(a, b) {
  const low = Math.max(a.low, b.low);
  const high = Math.min(a.high, b.high);
  return low <= high + EPSILON ? interval(gridNumber(low, 1e-9), gridNumber(high, 1e-9)) : null;
}

/** 从主区间中扣除另一区间，返回剩余的 0..2 段。 */
function subtractInterval(whole, part) {
  const pieces = [];
  if (part.low > whole.low + EPSILON) pieces.push(interval(whole.low, Math.min(whole.high, part.low)));
  if (part.high < whole.high - EPSILON) pieces.push(interval(Math.max(whole.low, part.high), whole.high));
  return pieces;
}

/**
 * 解释 DescribeCoverage：抽出空间轴、方向、单位、网格坐标映射。
 * 本地网关把 WCS 描述规范化为 JSON，这里只认这一种已理解的结构。
 */
export function interpretCoverage(description) {
  if (!description || typeof description !== 'object') throw new SubsetError('覆盖描述不是对象');
  if (!description.coverageId) throw new SubsetError('覆盖描述缺少 coverageId');
  if (!Array.isArray(description.axes) || description.axes.length === 0) throw new SubsetError('覆盖描述缺少轴信息');
  if (!description.grid?.origin || !Array.isArray(description.grid.offsets)) throw new SubsetError('覆盖描述缺少网格原点或步长');
  const { origin, offsets, low, high } = description.grid;
  if (!Array.isArray(low) || !Array.isArray(high) || low.length !== high.length) {
    throw new SubsetError('网格上下界不完整');
  }
  const dimensionCount = low.length;
  if (origin.length !== dimensionCount || offsets.length !== dimensionCount) {
    throw new SubsetError('网格原点、步长与维度数量不一致');
  }

  const axes = description.axes.map(axis => {
    if (!axis?.label || !axis.unit) throw new SubsetError('覆盖轴缺少名称或单位');
    return { label: axis.label, unit: axis.unit, lower: axis.lower, upper: axis.upper };
  });
  const labels = axes.map(axis => axis.label);
  if (new Set(labels).size !== labels.length) throw new SubsetError('覆盖轴标签重复');

  // 维度 i 的步长向量 offsets[i] 只允许在第 i 个分量上非零（轴对齐网格）。
  const spatialAxes = [];
  for (let dimension = 0; dimension < dimensionCount; dimension += 1) {
    const vector = offsets[dimension];
    if (!Array.isArray(vector) || vector.length !== dimensionCount) throw new SubsetError(`第 ${dimension} 维步长向量不合法`);
    const nonZero = vector.map((value, index) => ({ value, index })).filter(item => Math.abs(item.value) > EPSILON);
    if (nonZero.length !== 1 || nonZero[0].index !== dimension) {
      throw new SubsetError(`第 ${dimension} 维不是轴对齐网格，本地收件不支持旋转网格`);
    }
    const step = nonZero[0].value;
    if (!Number.isFinite(step) || approxEqual(step, 0)) throw new SubsetError(`第 ${dimension} 维步长无效`);
    const axis = axes[dimension];
    if (axis === undefined) throw new SubsetError(`第 ${dimension} 维缺少对应的轴描述`);
    const indexLow = low[dimension];
    const indexHigh = high[dimension];
    if (!Number.isInteger(indexLow) || !Number.isInteger(indexHigh) || indexHigh < indexLow) {
      throw new SubsetError(`轴 ${axis.label} 的网格上下界不是包含式整数索引`);
    }
    const coordinateAt = index => origin[dimension] + step * (index - indexLow);
    const coordinates = [];
    for (let index = indexLow; index <= indexHigh; index += 1) coordinates.push(gridNumber(coordinateAt(index), step));
    const coordinateLow = Math.min(...coordinates);
    const coordinateHigh = Math.max(...coordinates);
    if (!approxEqual(axis.lower, coordinateLow) || !approxEqual(axis.upper, coordinateHigh)) {
      // 物理范围与网格索引必须区别：轴公布的物理范围应与网格点包络一致。
      throw new SubsetError(`轴 ${axis.label} 的物理范围与网格点包络不一致`);
    }
    spatialAxes.push({
      label: axis.label,
      unit: axis.unit,
      dimension,
      direction: step < 0 ? 'descending' : 'ascending',
      step,
      indexLow,
      indexHigh,
      origin: origin[dimension],
      coordinateAt,
      coordinates,
      physical: interval(coordinateLow, coordinateHigh)
    });
  }

  const spatialLabels = new Set(spatialAxes.map(axis => axis.label));
  const otherAxes = axes.filter(axis => !spatialLabels.has(axis.label));
  const nilValues = Array.isArray(description.nilValues) ? [...description.nilValues] : [];
  const formats = Array.isArray(description.formats) ? [...description.formats] : [];
  return {
    coverageId: description.coverageId,
    version: description.version,
    grid: { origin: [...origin], offsets: offsets.map(vector => [...vector]), low: [...low], high: [...high] },
    spatialAxes,
    otherAxes,
    nilValues,
    formats
  };
}

/** 能力表核对：只按服务公布的能力发请求。 */
export function interpretCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') throw new SubsetError('能力表不是对象');
  const maxCells = capabilities.limits?.maxCells;
  if (!Number.isInteger(maxCells) || maxCells <= 0) throw new SubsetError('能力表未公布有效的单次网格单元上限');
  return {
    version: capabilities.version,
    coverageIds: Array.isArray(capabilities.coverageIds) ? capabilities.coverageIds : [],
    maxCells,
    trimSupported: capabilities.trimSupported === true,
    sliceSupported: capabilities.sliceSupported === true
  };
}

/**
 * 规划单个空间轴的领取。
 * 返回出界部分、实际生效的物理区间、网格点对齐后的索引区间与多取区间。
 */
function planSpatialAxis(axis, requested) {
  const requestLow = Math.min(requested.lower, requested.upper);
  const requestHigh = Math.max(requested.lower, requested.upper);
  const requestInterval = interval(gridNumber(requestLow, axis.step), gridNumber(requestHigh, axis.step));
  const outside = subtractInterval(requestInterval, axis.physical);
  const effective = intersect(requestInterval, axis.physical);
  if (!effective) {
    return { axis: axis.label, unit: axis.unit, direction: axis.direction, requested: requestInterval,
      effective: null, selectedIndices: [], selectedPhysical: null, outside, overfetch: [] };
  }

  // 包含式采样：落在生效区间内的网格点全部选中。
  const inside = axis.coordinates
    .map((coordinate, position) => ({ coordinate, index: axis.indexLow + position }))
    .filter(item => item.coordinate >= effective.low - EPSILON && item.coordinate <= effective.high + EPSILON);

  let chosen;
  let bracketed = false;
  if (inside.length > 0) {
    chosen = inside;
  } else {
    // 需求夹在两个网格点之间：向外对齐到包围需求的最近网格点。
    bracketed = true;
    const positioned = axis.coordinates
      .map((coordinate, position) => ({ coordinate, index: axis.indexLow + position }));
    // coordinates 沿物理值升序：下界取不大于需求下界的最近点，上界取不小于需求上界的最近点。
    const lowerPoint = positioned.reduce((best, item) =>
      (item.coordinate <= effective.low + EPSILON && (!best || item.coordinate > best.coordinate) ? item : best), null);
    const upperPoint = positioned.reduce((best, item) =>
      (item.coordinate >= effective.high - EPSILON && (!best || item.coordinate < best.coordinate) ? item : best), null);
    const chosenMap = new Map();
    for (const point of [lowerPoint, upperPoint]) {
      if (point) chosenMap.set(point.index, point);
    }
    chosen = [...chosenMap.values()];
    if (chosen.length === 0) throw new SubsetError(`轴 ${axis.label} 无法对齐到任何网格点`);
  }

  const indices = chosen.map(item => item.index);
  const indexLow = Math.min(...indices);
  const indexHigh = Math.max(...indices);
  const selectedCoordinates = chosen.map(item => item.coordinate).sort((a, b) => a - b);
  const selectedPhysical = interval(selectedCoordinates[0], selectedCoordinates.at(-1));

  // 多取 = 选中网格点包络相对生效需求多出的物理部分。
  const overfetch = [];
  if (selectedPhysical.low < effective.low - EPSILON) {
    overfetch.push(interval(selectedPhysical.low, effective.low));
  }
  if (selectedPhysical.high > effective.high + EPSILON) {
    overfetch.push(interval(effective.high, selectedPhysical.high));
  }

  return {
    axis: axis.label,
    unit: axis.unit,
    direction: axis.direction,
    requested: requestInterval,
    effective,
    selectedIndices: [indexLow, indexHigh],
    selectedPhysical,
    outside,
    overfetch,
    bracketed
  };
}

/** 把二维索引矩形按 maxCells 切成互不重叠的小块（索引空间，包含式）。 */
function splitTiles(rows, columns, maxCells) {
  const rowBand = Math.max(1, Math.floor(Math.sqrt(maxCells)));
  const columnBand = Math.max(1, Math.floor(maxCells / rowBand));
  const tiles = [];
  for (let row = rows.low; row <= rows.high; row += rowBand) {
    for (let column = columns.low; column <= columns.high; column += columnBand) {
      tiles.push({
        row: [row, Math.min(row + rowBand - 1, rows.high)],
        column: [column, Math.min(column + columnBand - 1, columns.high)]
      });
    }
  }
  return tiles;
}

/**
 * 依据描述与能力规划一次按范围领取。
 * trims: { 轴标签: [下界, 上界] }，只接受描述中公布的空间轴。
 */
export function planIntake({ description, capabilities, coverageId, trims }) {
  const coverage = interpretCoverage(description);
  const ability = interpretCapabilities(capabilities);
  if (coverageId !== coverage.coverageId) throw new SubsetError('请求的 coverageId 与描述不一致');
  if (ability.coverageIds.length > 0 && !ability.coverageIds.includes(coverage.coverageId)) {
    throw new SubsetError('能力表未公布该覆盖');
  }
  if (!ability.trimSupported) throw new SubsetError('来源未公布 trim（裁切）能力，无法按范围领取');

  const format = coverage.formats.find(value => /^application\/json\b/i.test(value));
  if (!format) throw new SubsetError(`来源公布的格式 ${coverage.formats.join(', ') || '(空)'} 中没有本地可解释的 application/json`);

  if (!trims || typeof trims !== 'object') throw new SubsetError('缺少按轴给出的领取范围 trims');
  const requestedLabels = Object.keys(trims);
  if (requestedLabels.length === 0) throw new SubsetError('至少需要给出一个轴的领取范围');
  const byLabel = new Map(coverage.spatialAxes.map(axis => [axis.label, axis]));
  const otherLabels = new Set(coverage.otherAxes.map(axis => axis.label));
  const unknown = requestedLabels.filter(label => !byLabel.has(label) && !otherLabels.has(label));
  if (unknown.length > 0) {
    const supported = coverage.spatialAxes.map(axis => `${axis.label}(${axis.unit})`).join('、');
    throw new SubsetError(`来源描述没有轴 ${unknown.join('、')}；可用空间轴为 ${supported}`);
  }
  if (!requestedLabels.some(label => byLabel.has(label))) {
    throw new SubsetError('至少需要给出一个空间轴的领取范围');
  }

  const axisPlans = coverage.spatialAxes.map(axis => {
    const requested = trims[axis.label];
    if (!Array.isArray(requested) || requested.length !== 2) {
      throw new SubsetError(`轴 ${axis.label} 需要给出 [下界, 上界]`);
    }
    return planSpatialAxis(axis, { lower: asNumber(requested[0], `轴 ${axis.label} 下界`),
      upper: asNumber(requested[1], `轴 ${axis.label} 上界`) });
  });

  const noOverlap = axisPlans.filter(plan => plan.selectedIndices.length === 0);
  if (noOverlap.length > 0) {
    throw new SubsetError(`领取范围与覆盖在轴 ${noOverlap.map(plan => plan.axis).join('、')} 上没有重叠的网格点`);
  }

  // 非空间轴（本地为 time）：能力表 sliceSupported=false 且子集入口不接受该轴，
  // 不能精确裁切，只能整段携带，必须在结果中说明。比较运算对数值与 ISO8601 字串都成立。
  const timePlans = coverage.otherAxes.map(axis => {
    const requested = trims[axis.label];
    const timePlan = { axis: axis.label, unit: axis.unit, subsetSupported: false,
      requested: null, served: [axis.lower, axis.upper], outside: [], overfetch: [] };
    if (requested === undefined) return timePlan;
    if (!Array.isArray(requested) || requested.length !== 2) {
      throw new SubsetError(`轴 ${axis.label} 需要给出 [下界, 上界]`);
    }
    const [wantLow, wantHigh] = [...requested].sort();
    const servedLow = axis.lower;
    const servedHigh = axis.upper;
    timePlan.requested = [wantLow, wantHigh];
    if (wantLow < servedLow) timePlan.outside.push([wantLow, wantHigh < servedLow ? wantHigh : servedLow]);
    if (wantHigh > servedHigh) timePlan.outside.push([wantLow > servedHigh ? wantLow : servedHigh, wantHigh]);
    if (servedLow < wantLow) timePlan.overfetch.push([servedLow, wantLow]);
    if (servedHigh > wantHigh) timePlan.overfetch.push([wantHigh, servedHigh]);
    return timePlan;
  });

  const rows = axisPlans[0].selectedIndices;
  const columns = axisPlans[1].selectedIndices;
  const rowCount = rows[1] - rows[0] + 1;
  const columnCount = columns[1] - columns[0] + 1;
  const tiles = splitTiles({ low: rows[0], high: rows[1] }, { low: columns[0], high: columns[1] }, ability.maxCells);

  const requests = tiles.map(tile => {
    const rowAxis = coverage.spatialAxes[0];
    const columnAxis = coverage.spatialAxes[1];
    const rowCoordinates = [
      gridNumber(rowAxis.coordinateAt(tile.row[0]), rowAxis.step),
      gridNumber(rowAxis.coordinateAt(tile.row[1]), rowAxis.step)
    ].sort((a, b) => a - b);
    const columnCoordinates = [
      gridNumber(columnAxis.coordinateAt(tile.column[0]), columnAxis.step),
      gridNumber(columnAxis.coordinateAt(tile.column[1]), columnAxis.step)
    ].sort((a, b) => a - b);
    const params = new URLSearchParams();
    // WCS KVP 子集按物理值从小到大给出，与网格方向无关。
    params.set(rowAxis.label, `${rowCoordinates[0]},${rowCoordinates[1]}`);
    params.set(columnAxis.label, `${columnCoordinates[0]},${columnCoordinates[1]}`);
    return {
      path: `/wcs/subset?${params.toString()}`,
      indexBox: { row: tile.row, column: tile.column },
      physical: { row: rowCoordinates, column: columnCoordinates },
      cellCount: (tile.row[1] - tile.row[0] + 1) * (tile.column[1] - tile.column[0] + 1)
    };
  });

  return {
    coverage,
    ability,
    format,
    axisPlans,
    timePlans,
    tileRequests: requests,
    expectedCells: rowCount * columnCount
  };
}

/** 解析一块来源响应并与规划逐项核对。 */
export function examineChunk({ bytes, headers, plan, tile }) {
  let body;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new GridMismatchError('返回内容不是合法 JSON');
  }
  const coverage = plan.coverage;
  const nilValues = coverage.nilValues;
  const [rowAxis, columnAxis] = coverage.spatialAxes;
  const errors = [];

  if (body.coverageId !== coverage.coverageId) errors.push(`coverageId 不符（收到 ${body.coverageId}）`);
  if (body.version !== coverage.version) {
    throw new VersionConflictError(`来源版本已从 ${coverage.version} 变为 ${body.version}，新旧网格不能拼接`);
  }
  if (!Array.isArray(body.origin) || body.origin.length !== 2) errors.push('原点缺失或维度不对');
  if (!Array.isArray(body.offsets) || body.offsets.length !== 2) errors.push('步长缺失或维度不对');
  if (!Array.isArray(body.shape) || body.shape.length !== 2) errors.push('形状缺失或维度不对');
  if (!Array.isArray(body.values)) errors.push('数值数组缺失');

  const expectedRows = tile.indexBox.row[1] - tile.indexBox.row[0] + 1;
  const expectedColumns = tile.indexBox.column[1] - tile.indexBox.column[0] + 1;
  if (errors.length === 0) {
    if (body.shape[0] !== expectedRows || body.shape[1] !== expectedColumns) {
      errors.push(`形状 ${body.shape.join('x')} 与规划 ${expectedRows}x${expectedColumns} 不符`);
    }
    if (body.values.length !== expectedRows * expectedColumns) {
      errors.push(`数值数量 ${body.values.length} 与网格单元数 ${expectedRows * expectedColumns} 不符`);
    }
    if (!approxEqual(body.offsets[0][0], rowAxis.step) || !approxEqual(body.offsets[1][1], columnAxis.step)
      || !approxEqual(body.offsets[0][1], 0) || !approxEqual(body.offsets[1][0], 0)) {
      errors.push(`步长 ${JSON.stringify(body.offsets)} 与描述 ${JSON.stringify(coverage.grid.offsets)} 不符`);
    }
    const expectedOrigin = [
      gridNumber(rowAxis.coordinateAt(tile.indexBox.row[0]), rowAxis.step),
      gridNumber(columnAxis.coordinateAt(tile.indexBox.column[0]), columnAxis.step)
    ];
    if (!approxEqual(body.origin[0], expectedOrigin[0]) || !approxEqual(body.origin[1], expectedOrigin[1])) {
      errors.push(`原点 ${JSON.stringify(body.origin)} 与索引推算原点 ${JSON.stringify(expectedOrigin)} 不符`);
    }
    if (!Array.isArray(body.bounds) || body.bounds.length !== 2) {
      errors.push('返回缺少物理范围 bounds');
    } else {
      const [rowBounds, columnBounds] = body.bounds;
      if (!Array.isArray(rowBounds) || !Array.isArray(columnBounds)
        || !approxEqual(Math.min(...rowBounds), tile.physical.row[0])
        || !approxEqual(Math.max(...rowBounds), tile.physical.row[1])
        || !approxEqual(Math.min(...columnBounds), tile.physical.column[0])
        || !approxEqual(Math.max(...columnBounds), tile.physical.column[1])) {
        errors.push(`物理范围 ${JSON.stringify(body.bounds)} 与请求 ${JSON.stringify([tile.physical.row, tile.physical.column])} 不符`);
      }
    }
    if (body.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push('数值数组中存在非有限数值');
    }
  }
  if (errors.length > 0) throw new GridMismatchError(`网格核对失败：${errors.join('；')}`);

  // 行优先展开为带全局索引、物理坐标、nil 标记的观测；nil 值以描述公布为准。
  const cells = [];
  let position = 0;
  for (let rowOffset = 0; rowOffset < expectedRows; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < expectedColumns; columnOffset += 1) {
      const rowIndex = tile.indexBox.row[0] + rowOffset;
      const columnIndex = tile.indexBox.column[0] + columnOffset;
      const value = body.values[position];
      position += 1;
      cells.push({
        key: `${rowIndex}/${columnIndex}`,
        indices: [rowIndex, columnIndex],
        coordinates: [
          gridNumber(rowAxis.coordinateAt(rowIndex), rowAxis.step),
          gridNumber(columnAxis.coordinateAt(columnIndex), columnAxis.step)
        ],
        value,
        nil: nilValues.includes(value)
      });
    }
  }
  return { body, cells, mediaType: headers['content-type'] || plan.format };
}

/**
 * 合并多块网格：同一全局索引（即同一物理网格点）只保留一次。
 * 重复出现且数值冲突时报错——重叠边界不能被当成不同观测，也不能静默取舍。
 */
export function mergeCells(chunkLists) {
  const byKey = new Map();
  const duplicates = [];
  for (const [chunkIndex, cells] of chunkLists.entries()) {
    for (const cell of cells) {
      const existing = byKey.get(cell.key);
      if (!existing) {
        byKey.set(cell.key, { ...cell, chunks: [chunkIndex] });
      } else {
        duplicates.push(cell.key);
        if (existing.value !== cell.value || existing.nil !== cell.nil) {
          throw new GridMismatchError(`网格点 ${cell.key} 在不同块中数值冲突，拒绝拼接`);
        }
        existing.chunks.push(chunkIndex);
      }
    }
  }
  const merged = [...byKey.values()].sort((a, b) => {
    const [ar, ac] = a.indices;
    const [br, bc] = b.indices;
    return ar - br || ac - bc;
  });
  return { cells: merged, duplicateKeys: [...new Set(duplicates)] };
}

function axisSummary(plan) {
  return plan.axisPlans.map(item => ({
    axis: item.axis,
    unit: item.unit,
    direction: item.direction,
    requested: [item.requested.low, item.requested.high],
    effective: item.effective ? [item.effective.low, item.effective.high] : null,
    selectedIndices: item.selectedIndices,
    selectedPhysical: item.selectedPhysical ? [item.selectedPhysical.low, item.selectedPhysical.high] : null,
    outsideCoverage: item.outside.map(part => [part.low, part.high]),
    overfetch: item.overfetch.map(part => [part.low, part.high])
  }));
}

/**
 * 执行一次完整的按范围领取。
 * client 只需实现 request(path) -> { status, bytes, headers, url }。
 * 返回可直接存档解释的收件结果；任何已收下的块都保留原件并在结果中列明。
 */
export async function runSubsetIntake({ client, description, capabilities, coverageId, trims }) {
  const plan = planIntake({ description, capabilities, coverageId, trims });
  const receiptId = randomUUID();
  const chunks = [];
  const chunkCellLists = [];
  const notes = [];
  let aborted = null;

  for (let index = 0; index < plan.tileRequests.length; index += 1) {
    const tile = plan.tileRequests[index];
    const chunk = { sequence: index, request: tile.path, indexBox: tile.indexBox,
      requestedCells: tile.cellCount, status: 'pending' };
    let response;
    try {
      response = await client.request(tile.path);
    } catch (error) {
      chunk.status = 'transport-error';
      chunk.error = error.message;
      chunks.push(chunk);
      aborted = { reason: 'transport', message: error.message, atSequence: index };
      notes.push(`第 ${index + 1} 块传输失败，剩余 ${plan.tileRequests.length - index - 1} 块未领取：${error.message}`);
      break;
    }
    chunk.httpStatus = response.status;
    chunk.source = response.url;
    if (response.status !== 200) {
      chunk.status = 'http-error';
      chunk.error = `来源 HTTP ${response.status}`;
      chunks.push(chunk);
      aborted = { reason: 'http', message: chunk.error, atSequence: index };
      notes.push(`第 ${index + 1} 块被来源拒绝（${response.status}），停止后续领取`);
      break;
    }
    try {
      const examined = examineChunk({ bytes: response.bytes, headers: response.headers, plan, tile });
      chunk.status = 'received';
      chunk.mediaType = examined.mediaType;
      chunk.version = examined.body.version;
      chunk.origin = examined.body.origin;
      chunk.offsets = examined.body.offsets;
      chunk.shape = examined.body.shape;
      chunk.nilValues = plan.coverage.nilValues;
      chunk.bytes = response.bytes;
      chunks.push(chunk);
      chunkCellLists.push(examined.cells);
    } catch (error) {
      chunk.status = error instanceof VersionConflictError ? 'version-conflict' : 'grid-mismatch';
      chunk.error = error.message;
      chunks.push(chunk);
      aborted = {
        reason: error instanceof VersionConflictError ? 'version' : 'grid',
        message: error.message,
        atSequence: index
      };
      notes.push(error.message);
      break;
    }
  }

  if (!aborted) {
    // 全部块成功后再核对一次来源描述，防止领取期间描述更新。
    try {
      const refresh = await client.request(`/wcs/describe/${coverageId}`);
      if (refresh.status !== 200) {
        notes.push(`领取后描述复核返回 ${refresh.status}，无法确认来源期间是否更新，按已核对版本留存`);
      } else {
        const latest = JSON.parse(refresh.bytes.toString('utf8'));
        if (latest.version !== plan.coverage.version
          || JSON.stringify(latest.grid?.origin) !== JSON.stringify(plan.coverage.grid.origin)) {
          aborted = { reason: 'version', message: `领取期间来源描述更新为 ${latest.version}`, atSequence: null };
          notes.push(aborted.message);
        }
      }
    } catch (error) {
      notes.push(`领取后描述复核失败：${error.message}，按已核对版本留存`);
    }
  }

  let merged = { cells: [], duplicateKeys: [] };
  try {
    merged = mergeCells(chunkCellLists);
  } catch (error) {
    aborted = aborted || { reason: 'grid', message: error.message, atSequence: null };
    notes.push(error.message);
  }
  if (merged.duplicateKeys.length > 0) {
    notes.push(`重叠网格点已按同一观测去重：${merged.duplicateKeys.join('、')}`);
  }

  const receivedChunks = chunks.filter(chunk => chunk.status === 'received');
  const missingChunks = plan.tileRequests.length - receivedChunks.length;
  for (const axis of plan.axisPlans) {
    for (const part of axis.outside) {
      notes.push(`轴 ${axis.axis} 需求区间 [${part.low}, ${part.high}] ${axis.unit} 超出覆盖公布范围，未取得`);
    }
    for (const part of axis.overfetch) {
      notes.push(`来源只支持网格点包含式采样，轴 ${axis.axis} 多取了 [${part.low}, ${part.high}] ${axis.unit}`);
    }
  }
  for (const time of plan.timePlans) {
    notes.push(`轴 ${time.axis}（${time.unit}）不支持切片/裁切，本次返回来源整段 [${time.served.join(', ')}]，未按时间精确收窄`);
    for (const part of time.outside) notes.push(`轴 ${time.axis} 需求 [${part.join(', ')}] 超出来源公布时段，未取得`);
    for (const part of time.overfetch) notes.push(`轴 ${time.axis} 多携带了 [${part.join(', ')}] 的资料`);
  }
  if (missingChunks > 0) {
    notes.push(`规划 ${plan.tileRequests.length} 块、${plan.expectedCells} 个网格点；实收 ${receivedChunks.length} 块，${missingChunks} 块未取得`);
  }

  const observedKeys = new Set(merged.cells.map(cell => cell.key));
  const [rowAxis, columnAxis] = plan.coverage.spatialAxes;
  const [rowRange, columnRange] = plan.axisPlans.map(item => item.selectedIndices);
  const missingCells = [];
  for (let row = rowRange[0]; row <= rowRange[1]; row += 1) {
    for (let column = columnRange[0]; column <= columnRange[1]; column += 1) {
      const key = `${row}/${column}`;
      if (!observedKeys.has(key)) {
        missingCells.push({
          key,
          indices: [row, column],
          coordinates: [
            gridNumber(rowAxis.coordinateAt(row), rowAxis.step),
            gridNumber(columnAxis.coordinateAt(column), columnAxis.step)
          ]
        });
      }
    }
  }

  const status = aborted
    ? (aborted.reason === 'version' ? 'aborted-version-conflict' : 'incomplete')
    : 'complete';
  const nilCellCount = merged.cells.filter(cell => cell.nil).length;

  return {
    id: receiptId,
    coverageId: plan.coverage.coverageId,
    version: plan.coverage.version,
    status,
    format: plan.format,
    aborted,
    axes: axisSummary(plan),
    request: { coverageId, trims: Object.fromEntries(
      Object.entries(trims).map(([label, value]) => [label, Array.isArray(value) ? [...value] : value])) },
    planning: {
      tileCount: plan.tileRequests.length,
      maxCellsPerRequest: plan.ability.maxCells,
      expectedCells: plan.expectedCells,
      tiles: plan.tileRequests.map(tile => ({ indexBox: tile.indexBox, physical: tile.physical, cellCount: tile.cellCount }))
    },
    time: plan.timePlans,
    chunks: chunks.map(({ bytes, ...rest }) => rest),
    rawChunks: chunks.filter(chunk => Buffer.isBuffer(chunk.bytes)).map(chunk => ({
      sequence: chunk.sequence, source: chunk.source, mediaType: chunk.mediaType, bytes: chunk.bytes
    })),
    coverage: {
      expectedCells: plan.expectedCells,
      receivedCells: merged.cells.length,
      nilCells: nilCellCount,
      validObservationCells: merged.cells.length - nilCellCount,
      missingCells,
      grid: {
        origin: plan.coverage.grid.origin,
        offsets: plan.coverage.grid.offsets,
        indexRange: { row: rowRange, column: columnRange },
        nilValues: plan.coverage.nilValues
      },
      cells: merged.cells.map(cell => ({ key: cell.key, indices: cell.indices, coordinates: cell.coordinates,
        value: cell.value, nil: cell.nil, chunks: cell.chunks }))
    },
    notes
  };
}
