export function dispatch({ url, phase }) {
  if (url.pathname !== '/wcs/subset') return null;
  const latitude = (url.searchParams.get('Lat') || '').split(',').map(Number);
  const longitude = (url.searchParams.get('Long') || '').split(',').map(Number);
  if (latitude.length !== 2 || longitude.length !== 2 || ![...latitude, ...longitude].every(Number.isFinite)) return { status: 400, json: { error: '应使用能力中公布的轴标签及上下界' } };
  const rows = Math.round((latitude[1] - latitude[0]) / 0.5) + 1;
  const columns = Math.round((longitude[1] - longitude[0]) / 0.5) + 1;
  if (rows * columns > 4) return { status: 413, json: { error: '单次领取超过网格单元上限', maxCells: 4 } };
  return { json: { coverageId: 'park-temp', version: phase ? 'grid-2' : 'grid-1', bounds: [latitude, longitude], shape: [rows, columns],
    origin: [latitude[1] + (phase ? 0.1 : 0), longitude[0] + (phase ? 0.1 : 0)], offsets: [[-0.5, 0], [0, 0.5]],
    values: Array.from({ length: rows * columns }, (_, index) => index === 1 ? -9999 : 20 + index) } };
}
