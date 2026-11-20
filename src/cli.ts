import { benchmarkCommand } from './klyro/benchmark.ts';
import { main } from './main.ts';

const HELP = `klyro: Iridium Group's web-access and proxy platform

Usage:
  klyro [start] [config-file]     Run the server (default)
  klyro benchmark --target=URL    Measure latency and throughput (see: klyro benchmark --help)
  klyro --version

Settings come from the config file and environment variables; see docs/CONFIGURATION.md.`;

export async function cli(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === '--version' || command === 'version') {
    const { createRequire } = await import('node:module');
    process.stdout.write(`${createRequire(import.meta.url)('../package.json').version}\n`);
    return 0;
  }
  if (command === 'benchmark') return benchmarkCommand(rest, (s) => void process.stdout.write(s));
  if (command === 'start') return main(rest, env);
  return main(argv, env);
}
