import fs from 'node:fs';
import path from 'node:path';

export function canonicalTarget(value) {
  let candidate = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('无法解析路径');
    tail.unshift(path.basename(candidate)); candidate = parent;
  }
  return path.join(fs.realpathSync(candidate), ...tail);
}
export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function needsApproval(mode, tool, input, cwd) {
  if (mode === 'full') return false;
  if (mode === 'ask') return true;
  if (!['read','write','edit','ls','find','grep'].includes(tool)) return true;
  const raw = typeof input.path === 'string' ? input.path : (['ls','find','grep'].includes(tool) ? '.' : null);
  if (!raw) return true;
  try {
    const target = canonicalTarget(path.resolve(cwd, raw));
    if (!isWithin(fs.realpathSync(cwd), target)) return true;
    const parts = path.relative(cwd, target).split(/[\\/]/);
    return parts.some(part => /^(\.git|\.pi|\.ssh|\.aws|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(part));
  } catch { return true; }
}

export default function saintPermissions(pi) {
  let mode = ['ask','auto','full'].includes(process.env.SAINT_ACCESS_MODE) ? process.env.SAINT_ACCESS_MODE : 'ask';
  pi.registerCommand('saint-access', { description: 'Saint Harness execution permissions', handler: async (args, ctx) => {
    const next = args.trim();
    if (!['ask','auto','full'].includes(next)) throw new Error('Invalid access mode');
    mode = next; ctx.ui.setStatus('saint-access', mode);
  } });
  pi.on('tool_call', async (event, ctx) => {
    if (!needsApproval(mode, event.toolName, event.input ?? {}, ctx.cwd)) return;
    if (!ctx.hasUI) return { block: true, reason: 'Saint Harness 无法显示审批窗口，已停止该操作。' };
    const allowed = await ctx.ui.confirm(`允许执行 ${event.toolName}？`, JSON.stringify(event.input, null, 2).slice(0, 8000));
    if (!allowed) return { block: true, reason: '用户拒绝了本次操作。请调整计划，不要绕过此决定。' };
  });
}
