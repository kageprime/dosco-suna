// The daemon owns its tool builders; keep the documented command as a thin process wrapper.
const child = Bun.spawn(['bun', 'apps/kortix-sandbox-agent-server/scripts/qualiloop-knowledge.ts', ...process.argv.slice(2)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
