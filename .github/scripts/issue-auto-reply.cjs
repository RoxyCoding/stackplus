const fs = require('node:fs');
const path = require('node:path');

const MARKER = '<!-- issue-auto-reply-bot -->';

async function replyToIssue({ event, token, message, request = fetch }) {
  const issue = event.issue;
  if (event.action !== 'opened' || event.repository?.full_name !== 'RoxyCoding/stackplus'
      || !issue || issue.pull_request || issue.number === 3 || issue.user?.type === 'Bot') {
    return 'skipped';
  }
  if (!token) throw new Error('GH_TOKEN is required');
  if (!message.trim()) throw new Error('Reply message is empty');
  if (!issue.user?.login) throw new Error('Issue author login is missing');

  const url = `https://api.github.com/repos/RoxyCoding/stackplus/issues/${issue.number}/comments`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'issue-auto-reply',
  };
  for (let page = 1; ; page += 1) {
    const response = await request(`${url}?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`Cannot list comments: HTTP ${response.status}`);
    const comments = await response.json();
    if (comments.some(comment => comment.user?.type === 'Bot' && comment.body?.includes(MARKER))) {
      return 'already-replied';
    }
    if (comments.length < 100) break;
  }

  const response = await request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: `@${issue.user.login}\n\n${message.trimEnd()}\n\n${MARKER}\n` }),
  });
  if (!response.ok) throw new Error(`Cannot post reply: HTTP ${response.status}`);
  return 'replied';
}

if (require.main === module) {
  Promise.resolve().then(() => replyToIssue({
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    token: process.env.GH_TOKEN,
    message: fs.readFileSync(path.join(__dirname, '../../messages/stackplus.md'), 'utf8'),
  })).then(result => console.log(result)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { replyToIssue };
