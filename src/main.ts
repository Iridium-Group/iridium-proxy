import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '@iridium-group/config';
import { createProxyServer } from './server.ts';
import { UsageMeter, parseSize } from './usage.ts';

/** Load config, start the server, and stop cleanly on SIGINT/SIGTERM. Returns an exit code on failure. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const file = argv[0];
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(file, { env });
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }
  // Hosting platforms hand the port over as PORT.
  const port = env.PORT && !env.IRIDIUM_SERVER__PORT ? Number(env.PORT) : config.server.port;
  // With no static directory of your own, serve the bundled browser client if it is built.
  const bundled = fileURLToPath(new URL('../web/public/', import.meta.url));
  if (!existsSync(config.server.staticDir) && existsSync(bundled)) {
    config = { ...config, server: { ...config.server, staticDir: bundled } };
  }
  // Optional monthly bandwidth cap, e.g. IRIDIUM_MONTHLY_CAP=900MB. Not part of the config file.
  let capBytes: number | null = null;
  if (env.IRIDIUM_MONTHLY_CAP) {
    capBytes = parseSize(env.IRIDIUM_MONTHLY_CAP);
    if (capBytes === null) {
      process.stderr.write(
        `IRIDIUM_MONTHLY_CAP must be a size like 900MB or 2GB, got "${env.IRIDIUM_MONTHLY_CAP}"\n`,
      );
      return 1;
    }
  }
  const usage = new UsageMeter({ capBytes, file: env.IRIDIUM_USAGE_FILE });
  const proxy = createProxyServer(config, { usage });
  await proxy.listen(port);
  const stop = () => void proxy.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}
