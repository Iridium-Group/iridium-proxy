import { ConfigError, loadConfig } from '@iridium-group/config';
import { createProxyServer } from './server.ts';

/** Load config, start the server, and stop cleanly on SIGINT/SIGTERM. Returns an exit code on failure. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const file = argv[0];
  let config;
  try {
    config = await loadConfig(file, { env });
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }
  // Hosting platforms hand the port over as PORT.
  const port = env.PORT && !env.IRIDIUM_SERVER__PORT ? Number(env.PORT) : config.server.port;
  const proxy = createProxyServer(config);
  await proxy.listen(port);
  const stop = () => void proxy.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}
