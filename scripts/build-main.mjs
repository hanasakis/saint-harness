import { build } from 'esbuild';
await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron', bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron'], target: 'node24', sourcemap: true });
