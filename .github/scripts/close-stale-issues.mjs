#!/usr/bin/env node
// 指定した期間を過ぎた GitHub Issue を自動的に close するスクリプト
//
// 判定基準 (--basis):
//   label   : ラベル (既定 auto-close) を付けた時点から N 日経過した Issue を close (既定)
//             ラベル名を auto-close:7d のようにすると Issue ごとに日数を指定できる
//             (auto-close のみの場合は --days の日数を使う)
//   updated : 最終更新から N 日経過した Issue を close
//   created : 作成から N 日経過した Issue を close
//
// 使い方:
//   GITHUB_TOKEN=... node close-stale-issues.mjs --repo owner/name --days 30
//   node close-stale-issues.mjs --repo owner/name --dry-run   (token 不要: 対象の一覧表示のみ)
//
// オプションは CLI 引数と環境変数のどちらでも指定できます (CLI 引数が優先)。
//   --repo, -r          対象リポジトリ owner/name        (env: GITHUB_REPOSITORY)
//   --token, -t         GitHub トークン (issues: write)   (env: GITHUB_TOKEN)
//   --days, -d          既定の日数                        (env: STALE_DAYS, default: 30)
//   --basis             label | updated | created         (env: STALE_BASIS, default: label)
//   --label             起点となるラベル名                (env: AUTO_CLOSE_LABEL, default: auto-close)
//   --exempt-label      このラベルが付いた Issue は除外 (複数指定可) (env: EXEMPT_LABELS, カンマ区切り)
//   --comment           close 前に投稿するコメント (空なら投稿しない) (env: CLOSE_COMMENT)
//                       {days} {label} {number} が置き換えられます
//   --dry-run           close せず対象を表示するだけ      (env: DRY_RUN=true)
//   --help, -h          ヘルプ表示

import { parseArgs } from "node:util";

const API = "https://api.github.com";
const PER_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const MUTATION_INTERVAL_MS = 1000; // secondary rate limit 回避のため書き込み間に待機

function usage() {
  console.log(`Usage: node close-stale-issues.mjs --repo owner/name [--days N] [--basis label|updated|created]
       [--label NAME] [--exempt-label L ...] [--comment TEXT] [--dry-run]

Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, STALE_DAYS, STALE_BASIS, AUTO_CLOSE_LABEL,
             EXEMPT_LABELS, CLOSE_COMMENT, DRY_RUN`);
}

function loadConfig() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", short: "r" },
      token: { type: "string", short: "t" },
      days: { type: "string", short: "d" },
      basis: { type: "string" },
      label: { type: "string" },
      "exempt-label": { type: "string", multiple: true },
      comment: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  const env = process.env;
  const repo = values.repo ?? env.GITHUB_REPOSITORY;
  const token = values.token ?? env.GITHUB_TOKEN;
  const days = Number(values.days ?? env.STALE_DAYS ?? "30");
  const basis = values.basis ?? env.STALE_BASIS ?? "label";
  const label = (values.label ?? env.AUTO_CLOSE_LABEL ?? "auto-close").trim();
  const exemptLabels = values["exempt-label"]?.length
    ? values["exempt-label"]
    : (env.EXEMPT_LABELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const comment = values.comment ?? env.CLOSE_COMMENT ?? "";
  const dryRun = values["dry-run"] ?? env.DRY_RUN === "true";

  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error("--repo owner/name (または GITHUB_REPOSITORY) を指定してください");
  }
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--days は 0 以上の数値で指定してください: ${values.days ?? env.STALE_DAYS}`);
  }
  if (!["label", "updated", "created"].includes(basis)) {
    throw new Error(`--basis は label / updated / created のいずれかを指定してください: ${basis}`);
  }
  if (basis === "label" && !label) {
    throw new Error("--label (または AUTO_CLOSE_LABEL) を指定してください");
  }
  if (!token && !dryRun) {
    throw new Error("GITHUB_TOKEN (または --token) が必要です。確認だけなら --dry-run を付けてください");
  }

  return { repo, token, days, basis, label, exemptLabels, comment, dryRun };
}

function makeClient(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "close-stale-issues",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  return async function request(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}\n${text}`);
    }
    return res.status === 204 ? null : res.json();
  };
}

async function listAll(request, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await request("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    items.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return items;
}

async function listOpenIssues(request, repo) {
  const issues = await listAll(request, `/repos/${repo}/issues?state=open&sort=updated&direction=asc`);
  // issues エンドポイントは PR も返すので除外する
  return issues.filter((i) => !i.pull_request);
}

function labelNames(issue) {
  return issue.labels.map((l) => (typeof l === "string" ? l : l.name));
}

// auto-close → 既定日数、auto-close:7d / auto-close:7 → 7 日。該当しなければ null
function parseLabelDays(name, base, defaultDays) {
  if (name === base) return defaultDays;
  const m = name.match(/^(.+?):(\d+)d?$/);
  return m && m[1] === base ? Number(m[2]) : null;
}

// ラベルが最後に付与された日時を events から取得する
async function labeledAt(request, repo, number, labelName) {
  const events = await listAll(request, `/repos/${repo}/issues/${number}/events`);
  let latest = null;
  for (const ev of events) {
    if (ev.event !== "labeled" || ev.label?.name !== labelName) continue;
    const at = new Date(ev.created_at);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

// 追跡対象の Issue ごとに { issue, days, label, since, due } を返す
async function findTracked(request, cfg, issues) {
  const candidates = issues.filter(
    (issue) => !labelNames(issue).some((l) => cfg.exemptLabels.includes(l)),
  );

  if (cfg.basis !== "label") {
    const field = cfg.basis === "updated" ? "updated_at" : "created_at";
    return candidates.map((issue) => {
      const since = new Date(issue[field]);
      return { issue, days: cfg.days, label: "", since, due: new Date(since.getTime() + cfg.days * DAY_MS) };
    });
  }

  const results = [];
  for (const issue of candidates) {
    // 複数の auto-close ラベルがある場合は最も短い日数を採用する
    let picked = null;
    for (const name of labelNames(issue)) {
      const days = parseLabelDays(name, cfg.label, cfg.days);
      if (days !== null && (!picked || days < picked.days)) picked = { label: name, days };
    }
    if (!picked) continue;

    const since = await labeledAt(request, cfg.repo, issue.number, picked.label);
    if (!since) {
      console.warn(`#${issue.number}: ラベル ${picked.label} の付与日時が取得できないためスキップします`);
      continue;
    }
    results.push({ ...picked, issue, since, due: new Date(since.getTime() + picked.days * DAY_MS) });
  }
  return results;
}

function fillTemplate(text, entry) {
  return text
    .replaceAll("{days}", String(entry.days))
    .replaceAll("{label}", entry.label)
    .replaceAll("{number}", String(entry.issue.number));
}

function day(date) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cfg = loadConfig();
  const request = makeClient(cfg.token);
  const now = new Date();

  console.log(
    `repo=${cfg.repo} basis=${cfg.basis} days=${cfg.days}` +
      (cfg.basis === "label" ? ` label=${cfg.label}` : "") +
      (cfg.exemptLabels.length ? ` exempt=${cfg.exemptLabels.join(",")}` : "") +
      (cfg.dryRun ? " [DRY RUN]" : ""),
  );

  const issues = await listOpenIssues(request, cfg.repo);
  const tracked = await findTracked(request, cfg, issues);
  const due = tracked.filter((e) => e.due <= now);

  console.log(`open issues: ${issues.length}, tracked: ${tracked.length}, due: ${due.length}`);

  if (cfg.basis === "label") {
    for (const e of tracked.filter((e) => e.due > now)) {
      console.log(`  #${e.issue.number} ${e.label} since ${day(e.since)} -> closes on ${day(e.due)}`);
    }
  }

  let closed = 0;
  for (const e of due) {
    const tag = cfg.basis === "label" ? `${e.label} since` : cfg.basis;
    console.log(`#${e.issue.number} (${tag} ${day(e.since)}, ${e.days}d) ${e.issue.title}`);
    if (cfg.dryRun) continue;

    try {
      if (cfg.comment) {
        await request("POST", `/repos/${cfg.repo}/issues/${e.issue.number}/comments`, {
          body: fillTemplate(cfg.comment, e),
        });
      }
      await request("PATCH", `/repos/${cfg.repo}/issues/${e.issue.number}`, {
        state: "closed",
        state_reason: "not_planned",
      });
      closed++;
    } catch (err) {
      console.error(`  failed to close #${e.issue.number}: ${err.message}`);
      process.exitCode = 1;
    }
    await sleep(MUTATION_INTERVAL_MS);
  }

  console.log(cfg.dryRun ? `dry run: ${due.length} issue(s) would be closed` : `closed ${closed}/${due.length} issue(s)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
