import { clipboard } from 'electron';
import { fileURLToPath } from 'node:url';
import type { AttachmentSource } from './attachments';

// Read only in response to an explicit paste. Electron maps Windows CF_HDROP
// to text/uri-list, including multiple files and Unicode names.
export async function readComposerClipboard(textOnly = false): Promise<{ sources: AttachmentSource[]; text: string }> {
  const items = await clipboard.read();
  const paths: string[] = [];
  if (!textOnly) {
    for (const item of items) {
      if (!item.types.includes('text/uri-list')) continue;
      const list = await item.getType('text/uri-list');
      if (list.size > 64 * 1024) throw new Error('复制的文件列表过长，请分批添加');
      for (const line of (await list.text()).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
        const url = new URL(line);
        if (url.protocol === 'file:') paths.push(fileURLToPath(url));
      }
    }
    // A copied image file can also expose a bitmap. Prefer its original file.
    if (paths.length) return { sources: [...new Set(paths)], text: '' };
    const images: AttachmentSource[] = [];
    let bytes = 0;
    for (const item of items) {
      const type = (['image/png', 'image/jpeg', 'image/webp'] as const).find(t => item.types.includes(t));
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob.size > 100 * 1024 * 1024) throw new Error('剪贴板图片超过 100 MB，请缩小后添加');
      bytes += blob.size;
      if (bytes > 250 * 1024 * 1024) throw new Error('一条消息的附件总大小不能超过 250 MB');
      images.push({ name: `剪贴板图片-${Date.now()}-${images.length + 1}.${type.split('/')[1]}`, data: Buffer.from(await blob.arrayBuffer()) });
      if (images.length > 10) throw new Error('一条消息最多添加 10 个附件');
    }
    if (images.length) return { sources: images, text: '' };
    if (items.some(i => i.types.some(t => /FileGroupDescriptor|FileContents/i.test(t)))) throw new Error('请先将此文件保存到本机，再复制或拖入');
  }
  for (const item of items) {
    if (item.types.includes('text/plain')) return { sources: [], text: await (await item.getType('text/plain')).text() };
  }
  return { sources: [], text: '' };
}
