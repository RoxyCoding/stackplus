const REPOSITORY = 'RoxyCoding/stackplus';
const LABEL = 'needs-info';
const WAIT_DAYS = 30;
const WAIT_MS = WAIT_DAYS * 24 * 60 * 60 * 1000;
const DEVELOPERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function isDeveloper(comment) {
  return comment?.user?.type === 'User' && DEVELOPERS.has(comment.author_association);
}

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
  const developerReply = comments.filter(isDeveloper).sort((a, b) => b.id - a.id)[0];
  if (!developerReply) return null;
  const start = Date.parse(developerReply.created_at);
  if (!Number.isFinite(start) || now - start < WAIT_MS) return null;
  // A deliberate reopen must not be undone until a developer replies again.
  if (events.some(event => event.event === 'reopened' && Date.parse(event.created_at) >= start)) return null;
  if (comments.some(comment => comment.user?.id === issue.user.id
      && Math.max(Date.parse(comment.created_at), Date.parse(comment.updated_at || comment.created_at)) >= start)) {
    return null;
  }
  return { id: applied.id, replyId: developerReply.id };
}

function createApi({ token, repository, request = fetch }) {
  if (repository !== REPOSITORY) throw new Error('Unexpected repository');
  if (!token) throw new Error('GH_TOKEN is required');
  const base = `https://api.github.com/repos/${REPOSITORY}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'issue-auto-close',
  };
  async function api(resource, method = 'GET', body, allowMissing = false) {
    const response = await request(`${base}${resource}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) return null;
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
  return { api, all };
}

async function markNeedsInfo({ event, token, request = fetch }) {
  const issue = event.issue;
  if (event.repository?.full_name !== REPOSITORY || event.action !== 'created'
      || !issue || issue.pull_request || issue.number === 3 || !isDeveloper(event.comment)) {
    return 'skipped';
  }
  const { api } = createApi({ token, repository: event.repository.full_name, request });
  const current = await api(`/issues/${issue.number}`);
  if (current.state !== 'open' || current.locked || current.user?.type === 'Bot') return 'skipped';
  if (current.labels.some(label => label.name === LABEL)) return 'already-labeled';
  if (!await api(`/labels/${LABEL}`, 'GET', undefined, true)) {
    try {
      await api('/labels', 'POST', { name: LABEL, color: 'D876E3', description: 'Waiting for information from the issue author' });
    } catch (error) {
      // Another issue's workflow may have created the label concurrently.
      if (!await api(`/labels/${LABEL}`, 'GET', undefined, true)) throw error;
    }
  }
  await api(`/issues/${issue.number}/labels`, 'POST', { labels: [LABEL] });
  return 'labeled';
}

async function closeUnansweredIssues({ token, repository, request = fetch, now = Date.now(), dryRun = false }) {
  const { api, all } = createApi({ token, repository, request });
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
    const marker = `<!-- issue-auto-close-bot:${snapshot.applied.id}:${snapshot.applied.replyId} -->`;
    if (!snapshot.comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(marker))) {
      await api(`/issues/${number}/comments`, 'POST', {
        body: `@${snapshot.issue.user.login}\n\n`
          + `Since the issue creator did not respond within ${WAIT_DAYS} days of the developer's reply, this issue has been automatically closed.\n\n`
          + 'If you are still experiencing this issue, please feel free to reopen it or submit a new issue with additional information.\n\n'
          + '---\n\n'
          + '🤖 **This issue was automatically closed due to prolonged inactivity.**\n\n'
          + marker,
      });
    }
    // Recheck replies, labels and reopen events after posting, before changing state.
    const latest = await inspect(number);
    if (latest.applied?.id !== snapshot.applied.id || latest.applied?.replyId !== snapshot.applied.replyId) {
      results.push({ number, status: 'changed-before-close' });
      continue;
    }
    await api(`/issues/${number}`, 'PATCH', { state: 'closed', state_reason: 'not_planned' });
    results.push({ number, status: 'closed' });
  }
  return results;
}

if (require.main === module) {
  Promise.resolve().then(() => process.env.GITHUB_EVENT_NAME === 'issue_comment' ? markNeedsInfo({
    event: JSON.parse(require('node:fs').readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    token: process.env.GH_TOKEN,
  }) : closeUnansweredIssues({
    token: process.env.GH_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    dryRun: process.env.DRY_RUN !== 'false',
  })).then(results => console.log(JSON.stringify(results))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { waitingEvent, closeUnansweredIssues, markNeedsInfo, WAIT_MS };
