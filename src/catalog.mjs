import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export class Catalog {
  constructor(root) {
    this.root = root;
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(join(this.root, 'objects'), { recursive: true });
    await mkdir(join(this.root, 'receipts'), { recursive: true });
    await mkdir(join(this.root, 'subsets'), { recursive: true });
    return this;
  }

  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async accept({ source, bytes, mediaType, preview }) {
    if (!source || !Buffer.isBuffer(bytes)) throw new TypeError('来源与原始字节不能为空');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.serial.then(async () => {
      await this.initialize();
      const objectPath = join(this.root, 'objects', digest);
      try {
        const existing = await readFile(objectPath);
        if (!existing.equals(bytes)) throw new Error('内容摘要冲突');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.atomic(objectPath, bytes);
      }
      const receipt = { id: randomUUID(), source, digest, bytes: bytes.length,
        mediaType, preview, receivedAt: new Date().toISOString() };
      await this.atomic(join(this.root, 'receipts', `${receipt.id}.json`),
        Buffer.from(JSON.stringify(receipt, null, 2)));
      return receipt;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async list() {
    await this.initialize();
    const files = (await readdir(join(this.root, 'receipts'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.root, 'receipts', name), 'utf8').then(JSON.parse)));
  }

  /**
   * 保存一次按范围领取：每块来源原件按内容摘要存入 objects，
   * 收件凭据单独存入 subsets，凭据只引用摘要而不复制原件内容。
   */
  async acceptSubset(receipt) {
    if (!receipt || typeof receipt !== 'object' || !receipt.id) throw new TypeError('子集收件结果不完整');
    if (!Array.isArray(receipt.rawChunks)) throw new TypeError('缺少来源原件分块');
    const operation = this.serial.then(async () => {
      await this.initialize();
      const storedChunks = [];
      for (const chunk of receipt.rawChunks) {
        if (!Buffer.isBuffer(chunk.bytes)) throw new TypeError('来源原件必须是原始字节');
        const digest = createHash('sha256').update(chunk.bytes).digest('hex');
        const objectPath = join(this.root, 'objects', digest);
        try {
          const existing = await readFile(objectPath);
          if (!existing.equals(chunk.bytes)) throw new Error('内容摘要冲突');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await this.atomic(objectPath, chunk.bytes);
        }
        storedChunks.push({ sequence: chunk.sequence, source: chunk.source,
          mediaType: chunk.mediaType, digest, bytes: chunk.bytes.length });
      }
      const stored = { ...receipt, chunks: receipt.chunks.map((chunk, index) => {
        const raw = receipt.rawChunks.find(item => item.sequence === chunk.sequence);
        return raw ? { ...chunk, digest: storedChunks.find(item => item.sequence === chunk.sequence).digest } : chunk;
      }), rawChunks: storedChunks, storedAt: new Date().toISOString() };
      await this.atomic(join(this.root, 'subsets', `${stored.id}.json`),
        Buffer.from(JSON.stringify(stored, null, 2)));
      return stored;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async listSubsets() {
    await this.initialize();
    const files = (await readdir(join(this.root, 'subsets'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.root, 'subsets', name), 'utf8').then(JSON.parse)));
  }

  async subset(id) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('无效的收件编号');
    return JSON.parse(await readFile(join(this.root, 'subsets', `${id}.json`), 'utf8'));
  }

  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('无效的内容摘要');
    const bytes = await readFile(join(this.root, 'objects', digest));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('原件校验失败');
    return bytes;
  }
}
