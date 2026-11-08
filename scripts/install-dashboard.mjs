import { copyFile, cp, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const publicDir = new URL('apps/server/public/', root);
await mkdir(new URL('ultra-account/', publicDir), { recursive: true });
for (const asset of ['ultra-account.html', 'ultra-account.css', 'account-theme.css'])
  await copyFile(
    new URL('apps/account/public/' + asset, root),
    new URL(asset, publicDir),
  );
await cp(
  new URL('apps/account/public/account-assets/', root),
  new URL('account-assets/', publicDir),
  { recursive: true },
);
await copyFile(
  new URL('apps/account/dist/portal.global.js', root),
  new URL('ultra-account/portal.global.js', publicDir),
);
const privateDir = new URL('apps/server/account-public/', root);
await mkdir(new URL('ultra-account/', privateDir), { recursive: true });
for (const asset of [
  'ultra-account.html',
  'ultra-account.css',
  'account-theme.css',
  'simplewebauthn-browser.min.js',
])
  await copyFile(new URL(asset, publicDir), new URL(asset, privateDir));
await cp(new URL('account-assets/', publicDir), new URL('account-assets/', privateDir), {
  recursive: true,
});
await copyFile(
  new URL('ultra-account/portal.global.js', publicDir),
  new URL('ultra-account/portal.global.js', privateDir),
);
