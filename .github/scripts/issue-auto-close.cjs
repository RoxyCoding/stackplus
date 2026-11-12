const REPOSITORY = 'RoxyCoding/stackplus';
const LABEL = 'needs-info';
const WAIT_DAYS = 30;
const WAIT_MS = WAIT_DAYS * 24 * 60 * 60 * 1000;

function waitingEvent(issue, events, comments, now) {
  if (issue.state !== 'open' || issue.pull_request || issue.number === 3
      || !issue.user?.id || issue.user.type === 'Bot' || issue.locked
      || !issue.labels.some(label => (typeof label === 'string' ? label : label.name) === LABEL)) {
    return null;
  }
  const changes = events.filter(event => ['labeled', 'unlabeled'].includes(event.event)
    && event.label?.name === LABEL).sort((a, b) => a.id - b.id);
  const applied = changes.at(-1);
  if (!applied || applied.event !== 'labeled') return null;
  const start = Date.parse(applied.created_at);
  if (!Number.isFinite(start) || now - start < WAIT_MS) return null;
  // A deliberate reopen must not be undone; reapply needs-info to start a new wait.
  if (events.some(event => event.event === 'reopened' && event.id > applied.id)) return null;
  if (comments.some(comment => comment.user?.id === issue.user.id
      && Math.max(Date.parse(comment.created_at), Date.parse(comment.updated_at || comment.created_at)) >= start)) {
    return null;
  }
  return applied;
}

async function closeUnansweredIssues({ token, repository, request = fetch, now = Date.now(), dryRun = false }) {
  if (repository !== REPOSITORY) throw new Error('Unexpected repository');
  if (!token) throw new Error('GH_TOKEN is required');
  const base = `https://api.github.com/repos/${REPOSITORY}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'issue-auto-close',
  };
  async function api(resource, method = 'GET', body) {
    const response = await request(`${base}${resource}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${resource}: HTTP ${response.status}`);
    return response.json();
  }
  async function all(resource) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const chunk = await api(`${resource}${resource.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...chunk);
      if (chunk.length < 100) return items;
    }
  }
  async function inspect(number) {
    const [issue, events, comments] = await Promise.all([
      api(`/issues/${number}`), all(`/issues/${number}/events`), all(`/issues/${number}/comments`),
    ]);
    return { issue, comments, applied: waitingEvent(issue, events, comments, now) };
  }

  // Collect every page before closing anything, so pagination cannot skip issues.
  const candidates = await all(`/issues?state=open&labels=${LABEL}`);
  const results = [];
  for (const candidate of candidates) {
    if (candidate.pull_request || candidate.number === 3) continue;
    const number = candidate.number;
    const snapshot = await inspect(number);
    if (!snapshot.applied) continue;
    if (dryRun) {
      results.push({ number, status: 'would-close' });
      continue;
    }
    const marker = `<!-- issue-auto-close-bot:${snapshot.applied.id} -->`;
    if (!snapshot.comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(marker))) {
      await api(`/issues/${number}/comments`, 'POST', {
        body: `@${snapshot.issue.user.login}\n\n`
          + `We have not received a follow-up comment from you in the ${WAIT_DAYS} days since this issue was marked \`${LABEL}\`. `
          + 'We are closing it because the requested environment information is still needed.\n\n'
          + 'If you still need help, please attach your `stackplus-issue-report.txt` '
          + '(or the environment details requested in the guidelines) and reopen this issue, '
          + 'or ask a maintainer to reopen it.\n\n'
          + 'This is an automated closure, not a confirmation that the issue has been resolved.\n\n'
          + marker,
      });
    }
    // Recheck replies, labels and reopen events after posting, before changing state.
    const latest = await inspect(number);
    if (latest.applied?.id !== snapshot.applied.id) {
      results.push({ number, status: 'changed-before-close' });
      continue;
    }
    await api(`/issues/${number}`, 'PATCH', { state: 'closed', state_reason: 'not_planned' });
    results.push({ number, status: 'closed' });
  }
  return results;
}

if (require.main === module) {
  closeUnansweredIssues({
    token: process.env.GH_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    dryRun: process.env.DRY_RUN !== 'false',
  }).then(results => console.log(JSON.stringify(results))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { waitingEvent, closeUnansweredIssues, WAIT_MS };
