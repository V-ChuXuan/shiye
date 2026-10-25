const { isAbsolute, join, resolve, dirname } = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function libraryPaths(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || /[\0-\x1f]/.test(root)) throw new Error('文库路径必须是完整文件夹路径');
  return { root: resolve(root), data: join(resolve(root), 'data'), pictures: join(resolve(root), 'pictures') };
}
function existingLibrary(root) {
  try {
    const paths = libraryPaths(root), database = join(paths.data, 'archive.sqlite');
    if (!fs.statSync(database).isFile()) throw new Error('not a database file');
    fs.accessSync(database, fs.constants.R_OK);
    return paths.root;
  } catch (error) { throw new Error('无法读取所选文库，请选择包含 data/archive.sqlite 的已有拾页文库。', { cause: error }); }
}
function readLibraryRoot(file) {
  let original;
  try { original = fs.readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw Object.assign(new Error('文库记录无法读取，请选择已有文库或退出。'), { code: 'library_config_invalid', cause: error });
  }
  try { return existingLibrary(JSON.parse(original.toString('utf8')).root); }
  catch (error) { throw Object.assign(new Error('文库记录无效或原文库不可用，请选择已有文库或退出。'), { code: 'library_config_invalid', original, cause: error }); }
}
function saveLibraryRoot(file, root, issue) {
  const value = JSON.stringify({ root: libraryPaths(root).root }, null, 2);
  fs.mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(temp, 'wx'); created = true;
    fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    if (issue) {
      if (!Buffer.isBuffer(issue.original)) throw new Error('无法保留原文库记录，请检查文件读取权限后重试。');
      if (!fs.readFileSync(file).equals(issue.original)) throw new Error('文库记录已变化，请重新打开拾页后重试。');
      fs.copyFileSync(file, `${file}.invalid-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(temp, file); created = false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) fs.unlinkSync(temp);
  }
}
function argument(argv, name) {
  const prefix = `--${name}=`;
  return argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}
function readWindowState(file, workAreas) {
  let saved;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')), bounds = value?.bounds;
    if (bounds && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key])) && bounds.width > 0 && bounds.height > 0 && typeof value.maximized === 'boolean') saved = value;
  } catch { /* Window preferences must never prevent opening the library. */ }
  const bounds = saved?.bounds;
  const area = bounds && workAreas.find(area => bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y) || workAreas[0];
  const minWidth = Math.min(760, area.width), minHeight = Math.min(600, area.height);
  const width = Math.min(area.width, Math.max(minWidth, bounds?.width || 1380)), height = Math.min(area.height, Math.max(minHeight, bounds?.height || 940));
  const x = Math.max(area.x, Math.min(area.x + area.width - width, bounds?.x ?? area.x + Math.round((area.width - width) / 2)));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, bounds?.y ?? area.y + Math.round((area.height - height) / 2)));
  return { x, y, width, height, minWidth, minHeight, maximized: saved?.maximized || false };
}
function saveWindowState(file, bounds, maximized) {
  try { fs.writeFileSync(file, JSON.stringify({ bounds, maximized })); }
  catch { /* A missing or read-only preference file does not affect library data. */ }
}
function externalLink(input) {
  try {
    if (typeof input !== 'string' || /[\s\\]/.test(input)) return false;
    const url = new URL(input);
    // Compare the original authority/path too: URL normalizes default ports and dot segments.
    if (url.protocol !== 'https:' || input.split(/[?#]/, 1)[0] !== `https://${url.hostname}${url.pathname}` || /%(?:2e|2f|5c)/i.test(url.pathname)) return false;
    if (url.hostname === 'mp.weixin.qq.com') return /^\/s(?:\/|$)/.test(url.pathname);
    return ['https://github.com/shadcn-ui/ui', 'https://github.com/lucide-icons/lucide', 'https://github.com/pmndrs/zustand',
      'https://github.com/motiondivision/motion', 'https://github.com/bvaughn/react-resizable-panels'].includes(input);
  } catch { return false; }
}
function mainPage(input, origin) {
  try { const url = new URL(input); return url.origin === origin && input === `${origin}/${url.hash}`; } catch { return false; }
}
module.exports = { libraryPaths, existingLibrary, readLibraryRoot, saveLibraryRoot, readWindowState, saveWindowState, argument, externalLink, mainPage };
