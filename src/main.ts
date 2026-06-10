import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { runBootstrap } from '@rebus-industries/prism-shared';

const PORT = Number(process.env.PORT ?? 8766);
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } },
    },
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: true,
  });

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    app.log.warn('SESSION_SECRET is not set');
  }
  await app.register(cookie, { secret: sessionSecret ?? 'unsafe-dev-only-do-not-use-in-prod' });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (process.env.NODE_ENV !== 'production') return cb(null, true);
      const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      cb(null, allowed.includes(origin));
    },
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 32 },
  });

  app.get('/health', async () => ({ status: 'ok', service: 'prism-materials' }));

  await app.register(import('./api/textures.js'), { prefix: '/api/textures' });
  await app.register(import('./api/materials.js'), { prefix: '/api/materials' });

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await runBootstrap(app.log);
  } catch (err) {
    app.log.error({ err }, 'bootstrap failed');
    process.exit(1);
  }
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      app.log.info({ sig }, 'shutdown');
      await app.close();
      process.exit(0);
    });
  }
}

main();
