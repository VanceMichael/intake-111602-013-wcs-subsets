function document(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资料不是对象');
  return value;
}

export function decode(bytes) {
  const value = document(bytes);
  if (!value.coverageId || !Array.isArray(value.axes) || !value.grid?.origin) throw new Error('覆盖描述不完整');
  const labels = value.axes.map(axis => axis.label);
  if (new Set(labels).size !== labels.length) throw new Error('覆盖轴标签重复');
  return { coverage: value.coverageId, version: value.version, axes: value.axes,
    grid: value.grid, formats: value.formats, nilValues: value.nilValues || [] };
}
