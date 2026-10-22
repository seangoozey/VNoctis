import { readFile, lstat, open, readdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';

export const patchStorage = () => join(process.env.WEB_BUILDS_PATH || '/web-builds', '.vnm-patches');
const allowed = new Set('rpy rpyc rpym rpymc py png jpg jpeg webp avif gif bmp ico svg ogg opus mp3 wav flac m4a mp4 webm ogv ttf otf woff woff2 json csv xml txt md glsl'.split(' '));
export const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function packageRoots(files) {
  const roots = new Set(['']);
  for (const file of files) {
    const parts = file.source.split('/'); parts.pop();
    while (parts.length) { roots.add(parts.join('/')); parts.pop(); }
  }
  const choices = [...roots].sort();
  const gameRoots = choices.filter(root => root.split('/').at(-1).toLowerCase() === 'game');
  const tops = new Set(files.map(file => file.source.split('/')[0]));
  const wrapper = tops.size === 1 && files.every(file => file.source.includes('/')) ? [...tops][0] : '';
  return { roots: choices, suggestedRoot: gameRoots.length === 1 ? gameRoots[0] : gameRoots.length > 1 ? null : wrapper };
}
export function mapPackage(files, root) {
  const { roots } = packageRoots(files);
  if (!roots.includes(root)) throw Object.assign(new Error('Choose a folder from this package.'), { statusCode: 400 });
  const excluded = [], mapped = [];
  for (const file of files) {
    if (root && !file.source.startsWith(root + '/')) { excluded.push({ source: file.source, reason: 'Outside the selected game folder' }); continue; }
    const relative = root ? file.source.slice(root.length + 1) : file.source;
    if (/^(?:[^/]*(?:readme|instructions|install)[^/]*)\.(?:txt|md)$/i.test(relative)) { excluded.push({ source: file.source, reason: 'Package instructions; shown separately' }); continue; }
    const parts = relative.split('/');
    const extension = posix.extname(relative).slice(1).toLowerCase();
    if (parts.some(part => /^(?:saves|cache|tokens|__pycache__|renpy|lib)$/i.test(part) || part.startsWith('.') || /^_vnm/i.test(part))) {
      excluded.push({ source: file.source, reason: 'Reserved, runtime or engine path' }); continue;
    }
    if (!allowed.has(extension)) { excluded.push({ source: file.source, reason: 'Unsupported file type; installers and packed archives are not applied' }); continue; }
    mapped.push({ ...file, path: 'game/' + relative });
  }
  const paths = new Set(mapped.map(file => file.path.toLowerCase()));
  const selected = mapped.filter(file => {
    if (/\.rpym?c$/i.test(file.path) && paths.has(file.path.slice(0, -1).toLowerCase())) {
      excluded.push({ source: file.source, reason: 'Source script supplied; the SDK will recompile it' }); return false;
    }
    return true;
  });
  return { files: selected, excluded };
}
export async function patchPreview(prisma, game, packageId, root) {
  const folder = join(patchStorage(), game.id, packageId);
  let meta;
  try { meta = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); }
  catch { throw Object.assign(new Error('Patch upload not found. Upload the package again.'), { statusCode: 404 }); }
  const choices = packageRoots(meta.files);
  const selectedRoot = root === undefined ? choices.suggestedRoot : root;
  const mapping = selectedRoot === null ? { files: [], excluded: [] } : mapPackage(meta.files, selectedRoot);
  const installed = await prisma.gamePatch.findMany({ where: { gameId: game.id }, orderBy: { position: 'asc' } });
  const owners = new Map(), directories = new Set(), scriptOwners = new Map(), stats = new Map();
  const scriptKey = path => path.toLowerCase().replace(/(\.rpym?)c$/, '$1');
  const inspect = path => { if (!stats.has(path)) stats.set(path, lstat(path).catch(() => null)); return stats.get(path); };
  for (const patch of installed.filter(p => p.enabled)) {
    for (const file of JSON.parse(patch.manifest).files) {
      const path = file.path.toLowerCase(); owners.set(path, patch.name); scriptOwners.set(scriptKey(path), patch.name);
      const parts = path.split('/'); parts.pop(); while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
    }
  }
  const files = [];
  for (const file of mapping.files) {
    let conflict = null;
    const segments = file.path.toLowerCase().split('/');
    if (directories.has(file.path.toLowerCase()) || segments.some((_, index) => owners.has(segments.slice(0, index).join('/')))) conflict = 'A patch file conflicts with a directory path.';
    let replaces = scriptOwners.has(scriptKey(file.path)) ? 'Patch: ' + scriptOwners.get(scriptKey(file.path)) : null;
    try {
      const target = join(game.directoryPath, ...file.path.split('/'));
      const info = await inspect(target);
      if (info?.isDirectory()) conflict = 'The destination is an existing directory.';
      else if (info?.isFile()) replaces ||= 'Original game file';
    } catch { /* New file. */ }
    if (/\.rpym?$/i.test(file.path) && (await inspect(join(game.directoryPath, file.path) + 'c'))?.isFile()) replaces ||= 'Original compiled script';
    if (/\.rpym?c$/i.test(file.path) && (await inspect(join(game.directoryPath, file.path.slice(0, -1))))?.isFile()) replaces ||= 'Original source script (compiled-only replacement)';
    const parts = file.path.split('/');
    for (let count = 1; count < parts.length; count++) {
      const parent = await inspect(join(game.directoryPath, ...parts.slice(0, count)));
      if (parent && !parent.isDirectory()) conflict = 'A destination parent is a file or link.';
    }
    files.push({ ...file, replaces, conflict });
  }
  const instructions = [];
  for (const file of meta.files.filter(f => /(?:readme|instructions|install)[^/]*\.(?:txt|md)$/i.test(f.source)).slice(0, 5)) {
    const handle = await open(join(folder, 'files', ...file.source.split('/')), 'r');
    try { const buffer = Buffer.alloc(32768); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); instructions.push({ name: file.source, text: buffer.subarray(0, bytesRead).toString('utf8') }); }
    finally { await handle.close(); }
  }
  const nativeProject = (await inspect(join(game.directoryPath, 'game')))?.isDirectory() === true;
  return { packageId, name: meta.name, ...choices, root: selectedRoot, ...mapping, files, instructions,
    revision: game.patchRevision, canInstall: nativeProject && files.length > 0 && !files.some(file => file.conflict),
    warnings: [
      ...(!nativeProject ? ['This entry has no native game/ directory. Patches require a rebuildable Ren’Py project.'] : []),
      'Game and engine compatibility cannot be guaranteed by inspection. Rebuild and test after installation.',
      ...(files.some(file => /\.rpym?c$/i.test(file.path)) ? ['Compiled-only scripts depend on their original engine version.'] : []),
      ...(mapping.excluded.some(file => file.reason.startsWith('Unsupported')) ? ['Some files cannot be installed. Review exclusions and the package instructions.'] : []),
    ] };
}

export async function changePatchSet(prisma, gameId, revision, operation) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw Object.assign(new Error('Reload the patch list before making changes.'), { statusCode: 400 });
  return prisma.$transaction(async tx => {
    const claimed = await tx.game.updateMany({ where: { id: gameId, patchRevision: revision, buildStatus: { notIn: ['queued', 'building'] } }, data: { patchRevision: { increment: 1 } } });
    if (!claimed.count) throw Object.assign(new Error('The patch list changed or a build is running. Reload and try again.'), { statusCode: 409 });
    return operation(tx);
  });
}

export async function cleanPatchDrafts(prisma, gameId) {
  const root = join(patchStorage(), gameId);
  const installed = new Set((await prisma.gamePatch.findMany({ where: { gameId }, select: { id: true } })).map(patch => patch.id));
  let drafts = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !validId(entry.name) || installed.has(entry.name)) continue;
    const folder = join(root, entry.name);
    const info = await lstat(folder);
    if (Date.now() - info.mtimeMs > 86400000) await rm(folder, { recursive: true, force: true });
    else drafts++;
  }
  if (drafts >= 10) throw Object.assign(new Error('There are 10 unfinished patch uploads for this game. Discard previews or wait for the 24-hour cleanup.'), { statusCode: 409 });
}
