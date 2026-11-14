import { readFileSync } from 'node:fs';
import { createGuard } from './server.js';

const env = process.env;
const fromFile = (name: string) => {
  const file = env[`${name}_FILE`];
  const v = file ? readFileSync(file, 'utf8').trim() : env[name];
  if (!v) throw new Error(`${name} (ou ${name}_FILE) requis`);
  return v;
};

const token = fromFile('GUARD_TOKEN');
if (token.length < 32) throw new Error('GUARD_TOKEN trop court (32 caractères minimum)');
const port = Number(env.GUARD_PORT ?? 2375);

const server = createGuard({
  socketPath: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  token,
  sandboxNetwork: env.SANDBOX_NETWORK ?? 'cap-sandbox',
  sandboxUser: env.SANDBOX_USER ?? '10001:10001',
  allowedRuntimes: (env.GUARD_ALLOWED_RUNTIMES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  maxMemoryMb: Number(env.GUARD_MAX_MEMORY_MB ?? 65536),
  maxCpus: Number(env.GUARD_MAX_CPUS ?? 32),
  maxPids: Number(env.GUARD_MAX_PIDS ?? 32768),
});
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'docker_guard_listening', port })));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
