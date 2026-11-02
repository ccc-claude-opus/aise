#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from '../src/index.ts';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`aise: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
