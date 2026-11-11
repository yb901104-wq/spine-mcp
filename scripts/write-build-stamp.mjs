import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const stableJson = value => {
  const sorted = v => Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().filter(key => v[key] !== undefined).map(key => [key, sorted(v[key])]))
      : v;
  return JSON.stringify(sorted(value));
};
const objectHash = value => hash(stableJson(value));
async function files(dir, suffix, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await files(full, suffix, out);
    else if (!suffix || entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}
const sourceFiles = [
  ...(await files(path.join(root, 'src'), '.ts')),
  path.join(root, 'package.json'),
  path.join(root, 'package-lock.json'),
  path.join(root, 'preview', 'host.html'),
].sort();
const sourceEntries = await Promise.all(sourceFiles.map(async file => ({
  file: path.relative(root, file).replaceAll('\\', '/'),
  hash: hash(await readFile(file)),
})));
const sourceFingerprint = objectHash(sourceEntries);
const compiledFiles = (await files(path.join(root, 'dist'), '.js')).sort();
const compiledEntries = await Promise.all(compiledFiles.map(async file => ({
  file: path.relative(root, file).replaceAll('\\', '/'),
  hash: hash(await readFile(file)),
})));
const compiledBuildFingerprint = objectHash(compiledEntries);
await writeFile(path.join(root, 'dist', 'build-stamp.json'), JSON.stringify({ version: 1, sourceFingerprint, compiledBuildFingerprint, builtAt: new Date().toISOString(), nodeMajorMinor: process.versions.node.split('.').slice(0, 2).join('.') }, null, 2) + '\n');
console.log(JSON.stringify({ sourceFingerprint, compiledBuildFingerprint }));
