import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';
import { runSubsetIntake } from './subset.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks));
}

/** 先理解服务公布的描述与能力，再按范围领取并留存每块来源原件。 */
async function collectSubset(source, input) {
  const client = new SourceClient(source);
  const coverageId = input.coverageId || 'park-temp';
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(coverageId)) throw new Error('coverageId 只能包含字母、数字、点、下划线与连字符');
  const [describeResponse, capabilitiesResponse] = await Promise.all([
    client.request(profile.previewPath.replace('park-temp', coverageId)),
    client.request(profile.capabilitiesPath)
  ]);
  if (describeResponse.status !== 200) throw new Error(`覆盖描述响应：${describeResponse.status}`);
  if (capabilitiesResponse.status !== 200) throw new Error(`能力表响应：${capabilitiesResponse.status}`);
  const description = JSON.parse(describeResponse.bytes.toString('utf8'));
  const capabilities = JSON.parse(capabilitiesResponse.bytes.toString('utf8'));
  return runSubsetIntake({ client, description, capabilities, coverageId, trims: input.trims });
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const input = await readJson(request);
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }
      if (request.method === 'POST' && url.pathname === '/subsets') {
        const input = await readJson(request);
        const intake = await collectSubset(source, input);
        const stored = await catalog.acceptSubset(intake);
        response.statusCode = 201;
        return response.end(JSON.stringify(stored));
      }
      if (request.method === 'GET' && url.pathname === '/subsets') {
        return response.end(JSON.stringify(await catalog.listSubsets()));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/subsets/')) {
        const id = url.pathname.split('/').at(-1);
        return response.end(JSON.stringify(await catalog.subset(id)));
      }
      if (request.method === 'GET' && url.pathname === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
