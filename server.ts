import fs from 'node:fs';

if (process.env.NODE_ENV === 'production' && fs.existsSync(new URL('./server/dist/index.js', import.meta.url))) {
  await import('./server/dist/index.js');
} else {
  // @ts-ignore
  await import('./server/src/index.ts');
}
