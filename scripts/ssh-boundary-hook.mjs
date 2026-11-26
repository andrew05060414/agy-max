import { evaluateSshBoundaryHook } from '../lib/ssh-boundary.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const cliEvent = process.argv[2] || '';
  const fallback = () => (cliEvent === 'PreToolUse' ? { decision: 'allow' } : {});
  let result = fallback();
  try {
    const payload = JSON.parse(raw || '{}');
    if (!payload.hookEventName && cliEvent) payload.hookEventName = cliEvent;
    result = evaluateSshBoundaryHook(payload) || fallback();
    if ((payload.hookEventName === 'PreToolUse' || cliEvent === 'PreToolUse') && !result.decision) {
      result = { decision: 'allow' };
    }
  } catch (error) {
    process.stderr.write(`SSH boundary hook: ${error?.message || error}\n`);
    result = fallback();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
