import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { beforeEach } from "node:test";

// Keep fixtures independent of the day the scheduled workflow runs.
const TEST_NOW = new Date("2026-08-28T12:00:00Z");
beforeEach((t) => {
  t.mock.timers.enable({ apis: ["Date"], now: TEST_NOW });
});

import {
  buildCalendar,
  buildFeed,
  deduplicateTasks,
  extractReward,
  normalizeGitHubIssue,
  shouldIncludeIssue,
  validateCalendar,
  validateFeed,
  validatePlatforms,
  validateTaskData,
} from "./sync-tasks.mjs";

const source = {
  id: "github-example-bounties",
  platform_id: "github-bounties",
  include_unpriced: false,
  minimum_reward: 20,
  default_categories: ["development"],
  trust_level: "curated",
  ai_policy: "unknown",
};

const issue = {
  id: 123,
  number: 42,
  state: "open",
  locked: false,
  title: "Build a TypeScript MCP integration",
  body: "Create and test a small API integration.\n\n/bounty $250",
  html_url: "https://github.com/example/project/issues/42",
  repository_url: "https://api.github.com/repos/example/project",
  labels: [{ name: "💎 Bounty" }, { name: "$250" }, { name: "AI agent friendly" }],
  assignees: [],
  comments: 4,
  created_at: "2026-08-20T10:00:00Z",
  updated_at: "2026-08-28T10:00:00Z",
};

test("reward extraction prefers the largest explicit amount", () => {
  assert.deepEqual(extractReward({ ...issue, labels: [{ name: "$1" }, { name: "$1k" }] }), {
    amount_min: 1000,
    amount_max: 1000,
    currency: "USD",
    unit: "fixed",
    display: "$1,000",
    confirmed: false,
  });
});

test("a public issue is normalized into the stable task model", () => {
  const task = normalizeGitHubIssue(source, issue);
  assert.equal(task.id, "github-example-project-42");
  assert.equal(task.reward.amount_min, 250);
  assert.equal(task.ai_policy, "allowed");
  assert.equal(task.competition.level, "low");
  assert.deepEqual(task.categories, ["development", "ai-automation"]);
  assert.ok(task.skills.includes("TypeScript"));
  assert.ok(task.skills.includes("MCP"));
  assert.equal(validateTaskData([task]), 1);
});

test("completed and contributor-locked bounty leads are excluded", () => {
  assert.equal(shouldIncludeIssue(source, { ...issue, labels: [...issue.labels, { name: "💰 Rewarded" }] }), false);
  assert.equal(
    shouldIncludeIssue(source, { ...issue, body: "This issue is limited only to the creator of this issue. /bounty $250" }),
    false,
  );
});

test("the default 45-day expiry includes the boundary and excludes older issues", (t) => {
  const expiresAt = Date.parse(issue.updated_at) + 45 * 86_400_000;
  for (const [offset, included] of [[-1, true], [0, true], [1, false]]) {
    t.mock.timers.setTime(expiresAt + offset);
    assert.equal(shouldIncludeIssue(source, issue), included);
    assert.equal(normalizeGitHubIssue(source, issue) !== null, included);
  }
});

test("invalid update dates are excluded", () => {
  assert.equal(shouldIncludeIssue(source, { ...issue, updated_at: "invalid" }), false);
});

test("deduplication keeps the latest canonical task", () => {
  const older = normalizeGitHubIssue(source, issue);
  const newer = { ...older, source_updated_at: "2026-08-28T11:00:00.000Z", title: "Updated task" };
  assert.deepEqual(deduplicateTasks([older, newer]), [newer]);
});

test("subscription documents are complete and include known deadlines", () => {
  const task = {
    ...normalizeGitHubIssue(source, issue),
    deadline: "2026-09-01T12:00:00.000Z",
  };
  const feed = buildFeed([task]);
  const calendar = buildCalendar([task]);
  assert.doesNotThrow(() => validateFeed(feed));
  assert.doesNotThrow(() => validateCalendar(calendar));
  assert.match(feed, /Build a TypeScript MCP integration/);
  assert.match(calendar, /BEGIN:VEVENT/);
});

test("the checked-in platform catalog remains valid", async () => {
  const platforms = JSON.parse(await readFile(new URL("../data/platforms.json", import.meta.url), "utf8"));
  assert.ok(validatePlatforms(platforms) >= 5);
});
