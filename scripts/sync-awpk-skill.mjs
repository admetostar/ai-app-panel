import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'docs', 'app-develop.skill-v0.3.md');
const packageFile = path.join(root, 'docs', 'awpk-app-develop.skill');
const zipFile = path.join(root, 'docs', 'awpk-app-develop.zip');
const markdownFile = path.join(root, 'docs', 'awpk-app-develop.md');
const assetsDir = path.join(root, 'apps', 'server', 'assets');
const source = fs.readFileSync(sourceFile);
const sourceZip = new AdmZip(packageFile);
const entries = sourceZip.getEntries();

if (entries.length === 0) {
  throw new Error(`${packageFile} contains no files`);
}

const names = entries.map((entry) => entry.entryName.replace(/\\/g, '/').replace(/\/$/, ''));
const firstSegment = names[0].split('/')[0];
const hasCommonRoot = names.every((name) => name.startsWith(`${firstSegment}/`) || name === firstSegment);
const rootPrefix = hasCommonRoot ? `${firstSegment}/` : '';
const files = entries
  .map((entry) => ({
    entry,
    name: entry.entryName.replace(/\\/g, '/').replace(/\/$/, ''),
  }))
  .filter(({ entry }) => !entry.isDirectory)
  .map(({ entry, name }) => ({
    entry,
    name: rootPrefix && name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : name,
  }));
const skillEntries = files.filter(({ name }) => name === 'SKILL.md');

if (skillEntries.length !== 1) {
  throw new Error(`Expected exactly one SKILL.md in ${packageFile}, found ${skillEntries.length}`);
}

const outputZip = new AdmZip();
for (const { entry, name } of files) {
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw new Error(`Unsafe path in ${packageFile}: ${entry.entryName}`);
  }
  outputZip.addFile(name, name === 'SKILL.md' ? source : entry.getData(), entry.comment, entry.attr);
}
outputZip.writeZip(packageFile);
fs.copyFileSync(packageFile, zipFile);

const generatedNames = new AdmZip(packageFile)
  .getEntries()
  .filter((entry) => !entry.isDirectory)
  .map((entry) => entry.entryName.replace(/\\/g, '/'));
if (!generatedNames.includes('SKILL.md') || generatedNames.some((name) => name.startsWith('awpk-app-develop/'))) {
  throw new Error(`Generated ${packageFile} must have SKILL.md at the archive root`);
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(sourceFile, markdownFile);
for (const file of [packageFile, zipFile, markdownFile]) {
  fs.copyFileSync(file, path.join(assetsDir, path.basename(file)));
}
fs.copyFileSync(sourceFile, path.join(assetsDir, path.basename(sourceFile)));

console.log(`Updated ${packageFile}, ${zipFile}, and ${markdownFile}; copied skill downloads and source to ${assetsDir}`);
