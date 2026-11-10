import type { Message, SelectionQuote } from './types';

export type TreeEntry = { id: string; parentId: string | null; type: string; message?: Message; [key: string]: unknown };
export function branchEntries(entries: TreeEntry[], leafId: string | null): TreeEntry[] {
  const index = new Map(entries.map(e => [e.id, e])), seen = new Set<string>(), branch: TreeEntry[] = [];
  let id = leafId;
  while (id) {
    const entry = index.get(id);
    if (!entry || seen.has(id)) throw new Error('会话树路径不完整，请重新连接会话');
    seen.add(id); branch.push(entry); id = entry.parentId;
  }
  return branch.reverse();
}
// RPC messages are a context projection (compaction may remove older entries).
// Match actual messages on the active path, never a row index or matching text alone.
export function withEntryIds(messages: Message[], entries: TreeEntry[], leafId: string | null) {
  const candidates = branchEntries(entries, leafId).filter(e => e.type === 'message' && e.message);
  let next = 0;
  return messages.map(message => {
    const at = candidates.findIndex((entry, i) => i >= next && entry.message!.role === message.role && entry.message!.timestamp === message.timestamp && JSON.stringify(entry.message!.content) === JSON.stringify(message.content));
    if (at < 0) return { ...message, entryId: undefined };
    next = at + 1; return { ...message, entryId: candidates[at].id };
  });
}
export function quotedPrompt(draft: string, quotes: SelectionQuote[]) {
  if (!quotes.length) return draft;
  const context = quotes.map(q => `引用选区（${q.title.replace(/[\r\n]/g, ' ')}）：\n${q.text.split(/\r?\n/).map(line => '> ' + line).join('\n')}`).join('\n\n');
  return `${context}\n\n${draft.trim() || '请解释这段选中的文字。'}`;
}
// Entry identity survives compaction and reloads. A fixed row count would hide
// new side replies when Pi's projected context becomes shorter after compaction.
export function partitionBranchMessages(messages: Message[], inheritedEntryIds: string[]) {
  const ids = new Set(inheritedEntryIds);
  return { inherited: messages.filter(m => m.entryId && ids.has(m.entryId)), own: messages.filter(m => !m.entryId || !ids.has(m.entryId)) };
}
