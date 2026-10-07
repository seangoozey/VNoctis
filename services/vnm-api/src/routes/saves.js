import { createHash } from 'node:crypto';

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

// Never deserialize Ren'Py saves or write client-supplied paths on the server.
export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.files) || snapshot.files.length > 4096) return false;
  const paths = new Set();
  let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 512 ||
        !file.path || file.path.split('/').some(p => !p || p === '.' || p === '..') ||
        /[\\\x00-\x1f]/.test(file.path) || paths.has(file.path) ||
        !Number.isSafeInteger(file.mtime) || file.mtime < 0 || file.mtime > 8640000000000000 ||
        typeof file.data !== 'string' || file.data.length > MAX_SNAPSHOT_BYTES * 4 / 3 ||
        file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data) ||
        file.data.slice(0, -2).includes('=') ||
        (file.data.at(-2) === '=' && file.data.at(-1) !== '=')) return false;
    paths.add(file.path);
    bytes += Buffer.byteLength(file.data, 'base64');
    if (bytes > MAX_SNAPSHOT_BYTES) return false;
  }
  // A file cannot also be an ancestor directory.
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) return false;
    }
  }
  return true;
}

export default async function savesRoutes(fastify) {
  const options = {
    bodyLimit: 46 * 1024 * 1024,
    schema: { params: { type: 'object', required: ['gameId'], properties: {
      gameId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
    } } },
    preHandler: async (request, reply) => {
      if (!request.user?.userId) return reply.code(401).send({ message: 'Authentication required' });
      // VNoctis shares its library with all authenticated users, including hidden games.
      const game = await fastify.prisma.game.findUnique({ where: { id: request.params.gameId }, select: { id: true } });
      if (!game) return reply.code(404).send({ message: 'Game not found' });
      reply.header('Cache-Control', 'no-store');
    },
  };
  fastify.get('/games/:gameId/saves', options, async request => {
    const state = await fastify.prisma.saveSyncState.findUnique({ where: {
      userId_gameId: { userId: request.user.userId, gameId: request.params.gameId },
    } });
    return state ? { revision: state.revision, checksum: state.checksum, snapshot: JSON.parse(state.payload) }
      : { revision: 0, snapshot: null };
  });
  fastify.put('/games/:gameId/saves', options, async (request, reply) => {
    const { revision, snapshot } = request.body || {};
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2147483647 || !validateSnapshot(snapshot)) {
      return reply.code(400).send({ message: 'Invalid save snapshot' });
    }
    const payload = JSON.stringify({ version: 1, files: snapshot.files.map(({ path, mtime, data }) => ({ path, mtime, data })) });
    const checksum = createHash('sha256').update(payload).digest('hex');
    const key = { userId: request.user.userId, gameId: request.params.gameId };
    try {
      if (revision === 0) {
        await fastify.prisma.saveSyncState.create({ data: { ...key, payload, checksum } });
      } else {
        const result = await fastify.prisma.saveSyncState.updateMany({
          where: { ...key, revision }, data: { payload, checksum, revision: { increment: 1 } },
        });
        if (result.count !== 1) return reply.code(409).send({ message: 'Save conflict. Your browser copy is preserved.' });
      }
    } catch (error) {
      if (error.code === 'P2002') return reply.code(409).send({ message: 'Save conflict. Your browser copy is preserved.' });
      throw error;
    }
    return { revision: revision + 1, checksum };
  });
}
