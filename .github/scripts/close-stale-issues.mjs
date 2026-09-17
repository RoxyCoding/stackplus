#!/usr/bin/env node
// 指定した期間を過ぎた GitHub Issue を自動的に close するスクリプト
//
// 使い方:
//   GITHUB_TOKEN=... node close-stale-issues.mjs --repo owner/name --days 30
//   node close-stale-issues.mjs --repo owner/name --days 30 --dry-run   (token 不要: 対象の一覧表示のみ)
//
// オプションは CLI 引数と環境変数のどちらでも指定できます (CLI 引数が優先)。
//   --repo, -r          対象リポジトリ owner/name        (env: GITHUB_REPOSITORY)
//   --token, -t         GitHub トークン (issues: write)   (env: GITHUB_TOKEN)
//   --days, -d          この日数を過ぎた Issue を close    (env: STALE_DAYS, default: 30)
//   --basis             判定基準 updated | created        (env: STALE_BASIS, default: updated)
//   --exempt-label      このラベルが付いた Issue は除外 (複数指定可) (env: EXEMPT_LABELS, カンマ区切り)
//   --comment           close 前に投稿するコメント (空なら投稿しない) (env: CLOSE_COMMENT)
//   --dry-run           close せず対象を表示するだけ      (env: DRY_RUN=true)
//   --help, -h          ヘルプ表示

import { parseArgs } from "node:util";

const API = "https://api.github.com";
const PER_PAGE = 100;
const MUTATION_INTERVAL_MS = 1000; // secondary rate limit 回避のため書き込み間に待機

function usage() {
  console.log(`Usage: node close-stale-issues.mjs --repo owner/name [--days N] [--basis updated|created]
       [--exempt-label L ...] [--comment TEXT] [--dry-run]

Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, STALE_DAYS, STALE_BASIS, EXEMPT_LABELS, CLOSE_COMMENT, DRY_RUN`);
}

function loadConfig() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", short: "r" },
      token: { type: "string", short: "t" },
      days: { type: "string", short: "d" },
      basis: { type: "string" },
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
  const basis = values.basis ?? env.STALE_BASIS ?? "updated";
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
  if (basis !== "updated" && basis !== "created") {
    throw new Error(`--basis は updated または created を指定してください: ${basis}`);
  }
  if (!token && !dryRun) {
    throw new Error("GITHUB_TOKEN (または --token) が必要です。確認だけなら --dry-run を付けてください");
  }

  return { repo, token, days, basis, exemptLabels, comment, dryRun };
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

async function listOpenIssues(request, repo) {
  const issues = [];
  for (let page = 1; ; page++) {
    const batch = await request(
      "GET",
      `/repos/${repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}&sort=updated&direction=asc`,
    );
    // issues エンドポイントは PR も返すので除外する
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < PER_PAGE) break;
  }
  return issues;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cfg = loadConfig();
  const request = makeClient(cfg.token);

  const cutoff = new Date(Date.now() - cfg.days * 24 * 60 * 60 * 1000);
  const field = cfg.basis === "updated" ? "updated_at" : "created_at";

  console.log(
    `repo=${cfg.repo} days=${cfg.days} basis=${cfg.basis} cutoff=${cutoff.toISOString()}` +
      (cfg.exemptLabels.length ? ` exempt=${cfg.exemptLabels.join(",")}` : "") +
      (cfg.dryRun ? " [DRY RUN]" : ""),
  );

  const issues = await listOpenIssues(request, cfg.repo);
  const targets = issues.filter((issue) => {
    if (new Date(issue[field]) >= cutoff) return false;
    const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
    return !labels.some((l) => cfg.exemptLabels.includes(l));
  });

  console.log(`open issues: ${issues.length}, stale: ${targets.length}`);

  let closed = 0;
  for (const issue of targets) {
    const stamp = issue[field].slice(0, 10);
    console.log(`#${issue.number} (${cfg.basis} ${stamp}) ${issue.title}`);
    if (cfg.dryRun) continue;

    try {
      if (cfg.comment) {
        await request("POST", `/repos/${cfg.repo}/issues/${issue.number}/comments`, { body: cfg.comment });
      }
      await request("PATCH", `/repos/${cfg.repo}/issues/${issue.number}`, {
        state: "closed",
        state_reason: "not_planned",
      });
      closed++;
    } catch (err) {
      console.error(`  failed to close #${issue.number}: ${err.message}`);
      process.exitCode = 1;
    }
    await sleep(MUTATION_INTERVAL_MS);
  }

  console.log(cfg.dryRun ? `dry run: ${targets.length} issue(s) would be closed` : `closed ${closed}/${targets.length} issue(s)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
