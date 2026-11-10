import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import type { Attachment } from '../shared/types';

export type StagedAttachment = { info: Attachment; path: string };
const textExtensions = new Set('txt md markdown json jsonl csv tsv ts tsx js jsx mjs cjs py html htm css scss yml yaml xml log ini cfg conf toml sql sh ps1 bat c cpp h hpp cs java kt go rs rb php r swift vue svelte env'.split(' '));
const maxFile = 100 * 1024 * 1024;
const maxBatch = 250 * 1024 * 1024;
export function discardAttachment(item: StagedAttachment, cacheDir: string) {
  const file = path.resolve(item.path), directory = path.dirname(file);
  // Only remove the individual cache file we created, never the user's source.
  if (path.dirname(directory) !== path.resolve(cacheDir)) return;
  try { fs.unlinkSync(file); fs.rmdirSync(directory); } catch { /* Keep locked cache files; never block session shutdown. */ }
}
export async function prepareAttachments(paths: string[], existing: StagedAttachment[], cacheDir: string): Promise<StagedAttachment[]> {
  if (paths.length + existing.length > 10) throw new Error('一条消息最多添加 10 个附件，请先移除部分附件');
  const selections = paths.map(file => {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('请拖入文件，文件夹请先压缩后添加');
    if (stat.size > maxFile) throw new Error(`${path.basename(file)} 超过 100 MB，请缩小文件后添加`);
    return { file, bytes: stat.size };
  });
  if (selections.reduce((n, f) => n + f.bytes, 0) + existing.reduce((n, f) => n + f.info.bytes, 0) > maxBatch) throw new Error('一条消息的附件总大小不能超过 250 MB');
  const staged: StagedAttachment[] = [];
  try {
    for (const selection of selections) {
      const id = randomUUID(), name = path.basename(selection.file), directory = path.join(cacheDir, id);
      fs.mkdirSync(directory, { recursive: true });
      const destination = path.join(directory, name);
      const item: StagedAttachment = { path: destination, info: { id, name, bytes: selection.bytes, image: false, kind: 'file' } };
      staged.push(item);
      await fs.promises.copyFile(selection.file, destination, fs.constants.COPYFILE_EXCL);
      if (fs.statSync(destination).size !== selection.bytes) throw new Error(`${name} 在添加时发生变化，请重新添加`);
      const ext = path.extname(name).slice(1).toLowerCase();
      if (['png','jpg','jpeg','webp'].includes(ext) && selection.bytes <= 10 * 1024 * 1024) {
        const bitmap = nativeImage.createFromPath(destination);
        if (!bitmap.isEmpty()) {
          const size = bitmap.getSize(), scale = Math.min(120 / size.width, 90 / size.height, 1);
          item.info.image = true; item.info.kind = 'image';
          item.info.preview = bitmap.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toDataURL();
        }
      } else if (textExtensions.has(ext) && selection.bytes <= 256000) {
        const data = fs.readFileSync(destination);
        try { if (!data.includes(0)) { new TextDecoder('utf-8', { fatal: true }).decode(data); item.info.kind = 'text'; } } catch { /* Non-UTF-8 data stays a local file attachment. */ }
      }
    }
    return staged;
  } catch (error) { staged.forEach(item => discardAttachment(item, cacheDir)); throw error; }
}
