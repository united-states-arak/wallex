// Pipe filter: replaces any configured secret value in stdin with <REDACTED>.
const secrets = [process.env.AI_API_KEY, process.env.WALLEX_API_KEY].filter((s): s is string => !!s && s.length >= 6)
let text = await Bun.stdin.text()
for (const s of secrets) text = text.split(s).join('<REDACTED>')
process.stdout.write(text)
