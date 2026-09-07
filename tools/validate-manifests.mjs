import { readFile } from 'node:fs/promises';

for (const file of ['manifest.json', 'manifests/firefox.json']) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error(`${file}: требуется Manifest V3`);
  if (!manifest.version || !manifest.name) throw new Error(`${file}: отсутствуют name или version`);
  if (!manifest.content_scripts?.length) throw new Error(`${file}: нет content_scripts`);
}

console.log('Manifest files: OK');
