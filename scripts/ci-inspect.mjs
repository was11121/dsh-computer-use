// Inspect a GitHub Actions run: job conclusions + failed steps (+ optional job log).
// Usage: node ci-inspect.mjs <repo> <run-id> [--log <job-id>]
import { execFileSync } from 'node:child_process'

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
})
  .toString()
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)

const [repo, runId, flag, jobId] = process.argv.slice(2)
const headers = { Authorization: `Bearer ${token}` }

if (flag === '--log' && jobId) {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, { headers, redirect: 'follow' })
  const text = await res.text()
  const lines = text.split('\n').filter((l) => /error|Error|ERESOLVE|EBADPLATFORM|notsup|Failed|fatal|✖|FAIL/i.test(l))
  console.log(lines.slice(-40).join('\n') || text.split('\n').slice(-30).join('\n'))
} else {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=20`, { headers })
  const { jobs } = await res.json()
  for (const job of jobs) {
    console.log(`${job.conclusion?.toUpperCase().padEnd(8)} job=${job.id} ${job.name}`)
    for (const s of job.steps) if (s.conclusion === 'failure') console.log(`         FAILED STEP: ${s.name}`)
  }
}
