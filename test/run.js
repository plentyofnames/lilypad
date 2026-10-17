// deno run --allow-read test/run.js
import { runTests } from './core.test.js';

const root = new URL('../', import.meta.url);
const failed = await runTests((path) => Deno.readFile(new URL(path, root)).catch(() => null));
Deno.exit(failed ? 1 : 0);
