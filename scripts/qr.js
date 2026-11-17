import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const origin = new URL(baseUrl);
if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash)
  throw new Error('BASE_URL must be an http(s) origin without a path or query');
const urls = [
  ['washer-1', `${baseUrl}/machine/washer-1`],
  ['dryer-1', `${baseUrl}/machine/dryer-1`]
];
for (const [slug, url] of urls) console.log(`${slug}: ${url}`);

if (process.argv.includes('--generate')) {
  const { default: QRCode } = await import('qrcode');
  const folder = resolve('qr');
  await mkdir(folder, { recursive: true });
  for (const [slug, url] of urls) {
    const path = resolve(folder, `${slug}.svg`);
    await QRCode.toFile(path, url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4,
      color: { dark: '#123d32', light: '#ffffff' } });
    console.log(`Created ${path}`);
  }
  console.log('Print each code beside its matching machine, then scan both with a phone before the pilot.');
}
