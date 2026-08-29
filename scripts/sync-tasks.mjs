import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_API_BASE = "https://api.github.com";
const SITE_TASKS_URL = "https://www.aigccreative.com/tasks/";

const OUTPUTS = Object.freeze({
  tasks: "data/tasks.json",
  platforms: "data/platforms.json",
  sources: "data/sources.json",
  schema: "data/schema.json",
  feed: "tasks/feed.xml",
  calendar: "tasks/deadlines.ics",
});

const VALID_CATEGORIES = new Set([
  "development",
  "ai-automation",
  "design",
  "video",
  "image",
  "audio",
  "writing",
  "translation",
  "data",
  "research",
  "testing",
  "ai-evaluation",
  "other",
]);
const VALID_AI_POLICIES = new Set(["allowed", "limited", "human-only", "unknown"]);
const VALID_TRUST_LEVELS = new Set(["official", "curated", "community", "unverified"]);
const EXCLUDED_LABELS = ["rewarded", "completed", "paid", "claimed", "in progress", "wontfix"];
const EXCLUDED_BODY_PATTERNS = [
  "refrain from submitting",
  "pending app review",
  "has been finalized for this bounty",
  "limited only to the creator of this issue",
  "only the issue author can attempt",
  "bounty has been claimed",
];

const CATEGORY_RULES = [
  ["ai-automation", /\b(ai|agent|llm|mcp|langchain|model|prompt)\b/i],
  ["design", /\b(design|figma|ui|ux|illustrat|visual)\b/i],
  ["video", /\b(video|ffmpeg|camera|lens|stabili[sz]|render)\b/i],
  ["image", /\b(image|photo|graphic|illustrat)\b/i],
  ["audio", /\b(audio|voice|speech|music|transcri)\b/i],
  ["writing", /\b(article|blog|content|documentation|docs|writing|guide)\b/i],
  ["translation", /\b(translation|translate|locali[sz]ation|i18n)\b/i],
  ["data", /\b(dataset|annotation|labeling|data collection|etl)\b/i],
  ["research", /\b(research|study|survey|analysis)\b/i],
  ["testing", /\b(test|qa|quality assurance|benchmark)\b/i],
];

const SKILL_RULES = [
  ["TypeScript", /\btypescript\b|\.tsx?\b/i],
  ["JavaScript", /\bjavascript\b|\.jsx?\b/i],
  ["Python", /\bpython\b|\.py\b/i],
  ["Rust", /\brust\b|\.rs\b/i],
  ["Go", /\bgolang\b|\bgo\b/i],
  ["React", /\breact\b/i],
  ["Svelte", /\bsvelte\b/i],
  ["AWS", /\baws\b|amazon web services/i],
  ["API integration", /\bapi\b|integration/i],
  ["SQL", /\bsql\b|postgres|supabase/i],
  ["WebAssembly", /\bwasm\b|webassembly/i],
  ["MCP", /\bmcp\b/i],
  ["LLM", /\bllm\b|language model/i],
  ["Technical writing", /\barticle|documentation|docs|guide|technical writing\b/i],
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizeLabel(value) {
  return normalizeText(value).toLocaleLowerCase();
}

function slugify(value) {
  return normalizeText(value)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripMarkdown(value) {
  const text = normalizeText(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s+|\d+[.)]\s+)/gm, " ")
    .replace(/[*_~`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 320) return text;
  return `${text.slice(0, 317).trimEnd()}…`;
}

function parseIsoDateTime(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time string`);
  }
  return new Date(value).toISOString();
}

function parseHttpsUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("HTTPS required");
    return parsed.href;
  } catch {
    throw new TypeError(`${label} must be a valid HTTPS URL`);
  }
}

function rewardCandidate(label) {
  const match = normalizeText(label).match(/^\s*(USD\s*)?([$€£¥])\s*([\d,.]+)\s*([kK])?\s*$/);
  if (!match) return null;
  const currency = match[2] === "$" ? "USD" : match[2] === "€" ? "EUR" : match[2] === "£" ? "GBP" : "CNY";
  const amount = Number(match[3].replaceAll(",", "")) * (match[4] ? 1_000 : 1);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency, symbol: match[2] };
}

export function extractReward(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => (isObject(label) ? label.name : label)) : [];
  const candidates = labels.map(rewardCandidate).filter(Boolean);
  const bodyText = `${normalizeText(issue.title)}\n${normalizeText(issue.body)}`;
  const bodyPattern = /(?:\/bounty|\bbounty\s*[:\-]?)\s*(?:USD\s*)?([$€£¥])\s*([\d,.]+)\s*([kK])?/gi;
  for (const match of bodyText.matchAll(bodyPattern)) {
    const candidate = rewardCandidate(`${match[1]}${match[2]}${match[3] || ""}`);
    if (candidate) candidates.push(candidate);
  }

  const best = candidates.sort((left, right) => right.amount - left.amount)[0];
  if (!best) {
    return {
      amount_min: null,
      amount_max: null,
      currency: null,
      unit: "unknown",
      display: "Amount not stated",
      confirmed: false,
    };
  }

  return {
    amount_min: best.amount,
    amount_max: best.amount,
    currency: best.currency,
    unit: "fixed",
    display: `${best.symbol}${best.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    confirmed: false,
  };
}

function inferCategories(source, issue) {
  const categories = new Set(source.default_categories || []);
  const haystack = `${issue.title || ""}\n${(issue.labels || [])
    .map((label) => (isObject(label) ? label.name : label))
    .join(" ")}`;
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(haystack)) categories.add(category);
  }
  if (categories.size === 0) categories.add("other");
  return [...categories].filter((category) => VALID_CATEGORIES.has(category)).slice(0, 5);
}

function inferSkills(issue) {
  const haystack = `${issue.title || ""}\n${issue.body || ""}\n${(issue.labels || [])
    .map((label) => (isObject(label) ? label.name : label))
    .join(" ")}`;
  return SKILL_RULES.filter(([, pattern]) => pattern.test(haystack)).map(([skill]) => skill).slice(0, 8);
}

function inferAiPolicy(source, issue) {
  const labels = (issue.labels || []).map((label) => normalizeLabel(isObject(label) ? label.name : label));
  if (labels.some((label) => label.includes("ai agent friendly") || label.includes("agent-friendly"))) {
    return { ai_policy: "allowed", ai_policy_basis: "explicit-task-label" };
  }
  return {
    ai_policy: VALID_AI_POLICIES.has(source.ai_policy) ? source.ai_policy : "unknown",
    ai_policy_basis: "check-task-rules",
  };
}

function competitionLevel(commentCount, assigneeCount) {
  if (assigneeCount > 0 || commentCount > 20) return "high";
  if (commentCount > 5) return "medium";
  return "low";
}

function repositoryName(issue) {
  const source = normalizeText(issue.repository_url || issue.html_url);
  try {
    const parsed = new URL(source);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const offset = parsed.hostname === "api.github.com" && segments[0] === "repos" ? 1 : 0;
    if (segments.length < offset + 2) throw new Error("Repository path is incomplete");
    return `${segments[offset]}/${segments[offset + 1]}`.replace(/\.git$/i, "");
  } catch {
    throw new Error(`Unable to determine repository for issue ${issue.html_url || issue.id}`);
  }
}

export function shouldIncludeIssue(source, issue) {
  if (!isObject(issue) || issue.state !== "open" || issue.pull_request || issue.locked) return false;
  const labels = (issue.labels || []).map((label) => normalizeLabel(isObject(label) ? label.name : label));
  if (labels.some((label) => EXCLUDED_LABELS.some((excluded) => label.includes(excluded)))) return false;
  const body = normalizeLabel(issue.body);
  if (EXCLUDED_BODY_PATTERNS.some((pattern) => body.includes(pattern))) return false;

  const reward = extractReward(issue);
  if (reward.amount_min === null && !source.include_unpriced) return false;
  if (reward.amount_min !== null && reward.amount_min < Number(source.minimum_reward || 0)) return false;
  const updatedAt = Date.parse(issue.updated_at);
  const staleAfterMs = Number(source.stale_after_days || 45) * 86_400_000;
  if (!Number.isFinite(updatedAt) || updatedAt + staleAfterMs < Date.now()) return false;
  return true;
}

export function normalizeGitHubIssue(source, issue) {
  if (!shouldIncludeIssue(source, issue)) return null;
  const repo = repositoryName(issue);
  const title = normalizeText(issue.title);
  const summary = stripMarkdown(issue.body) || title;
  const reward = extractReward(issue);
  const assigneeCount = Array.isArray(issue.assignees) ? issue.assignees.length : issue.assignee ? 1 : 0;
  const commentCount = Number.isInteger(issue.comments) ? issue.comments : 0;
  const aiPolicy = inferAiPolicy(source, issue);
  const categories = inferCategories(source, issue);
  const skills = inferSkills(issue);
  if (categories.includes("video")) skills.push("Video engineering");
  const sourceUpdatedAt = parseIsoDateTime(issue.updated_at, `${repo}#${issue.number}.updated_at`);
  const expiresAt = new Date(Date.parse(sourceUpdatedAt) + Number(source.stale_after_days || 45) * 86_400_000).toISOString();
  const warnings = ["confirm-reward-before-work"];
  if (reward.amount_min === null) warnings.push("reward-not-stated");
  if (commentCount > 20) warnings.push("high-visible-competition");

  return {
    id: `github-${slugify(repo)}-${Number(issue.number)}`,
    platform_id: source.platform_id,
    source_id: source.id,
    title,
    summary,
    categories,
    skills: [...new Set(skills)].slice(0, 8),
    regions: ["global"],
    languages: ["en"],
    reward,
    status: "open",
    published_at: parseIsoDateTime(issue.created_at, `${repo}#${issue.number}.created_at`),
    source_updated_at: sourceUpdatedAt,
    expires_at: expiresAt,
    deadline: null,
    application_url: parseHttpsUrl(issue.html_url, `${repo}#${issue.number}.html_url`),
    rules_url: parseHttpsUrl(issue.html_url, `${repo}#${issue.number}.html_url`),
    ...aiPolicy,
    trust: {
      level: VALID_TRUST_LEVELS.has(source.trust_level) ? source.trust_level : "unverified",
      signals: ["public-source", "curated-source", "open-github-issue"],
      warnings,
    },
    competition: {
      comment_count: commentCount,
      assignee_count: assigneeCount,
      level: competitionLevel(commentCount, assigneeCount),
    },
    source_repo: repo,
    source_number: Number(issue.number),
  };
}

export function deduplicateTasks(tasks) {
  const byUrl = new Map();
  for (const task of tasks) {
    const existing = byUrl.get(task.application_url);
    if (!existing || task.source_updated_at > existing.source_updated_at) {
      byUrl.set(task.application_url, task);
    }
  }
  return [...byUrl.values()].sort(
    (left, right) => right.source_updated_at.localeCompare(left.source_updated_at) || left.id.localeCompare(right.id),
  );
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must contain unique values`);
}

export function validateTaskData(tasks, { allowEmpty = false } = {}) {
  if (!Array.isArray(tasks)) throw new TypeError("Task data must be an array");
  if (!allowEmpty && tasks.length === 0) throw new Error("Task data must not be empty");
  const ids = [];
  const urls = [];

  tasks.forEach((task, index) => {
    const label = `tasks[${index}]`;
    if (!isObject(task)) throw new TypeError(`${label} must be an object`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id || "")) throw new Error(`${label}.id is invalid`);
    ids.push(task.id);
    urls.push(parseHttpsUrl(task.application_url, `${label}.application_url`));
    parseHttpsUrl(task.rules_url, `${label}.rules_url`);
    parseIsoDateTime(task.published_at, `${label}.published_at`);
    parseIsoDateTime(task.source_updated_at, `${label}.source_updated_at`);
    parseIsoDateTime(task.expires_at, `${label}.expires_at`);
    if (task.deadline !== null) parseIsoDateTime(task.deadline, `${label}.deadline`);
    if (!normalizeText(task.title) || !normalizeText(task.summary)) throw new Error(`${label} requires a title and summary`);
    if (!Array.isArray(task.categories) || task.categories.length === 0) throw new Error(`${label}.categories is required`);
    if (task.categories.some((category) => !VALID_CATEGORIES.has(category))) throw new Error(`${label} has an invalid category`);
    assertUnique(task.categories, `${label}.categories`);
    if (!VALID_AI_POLICIES.has(task.ai_policy)) throw new Error(`${label}.ai_policy is invalid`);
    if (!VALID_TRUST_LEVELS.has(task.trust?.level)) throw new Error(`${label}.trust.level is invalid`);
    if (!isObject(task.reward) || !normalizeText(task.reward.display)) throw new Error(`${label}.reward is invalid`);
    if (!isObject(task.competition) || !Number.isInteger(task.competition.comment_count)) {
      throw new Error(`${label}.competition is invalid`);
    }
  });

  assertUnique(ids, "Task IDs");
  assertUnique(urls, "Task URLs");
  return tasks.length;
}

export function validatePlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error("Platform catalog must not be empty");
  const ids = platforms.map((platform, index) => {
    if (!isObject(platform) || !normalizeText(platform.id) || !normalizeText(platform.name)) {
      throw new Error(`platforms[${index}] is invalid`);
    }
    parseHttpsUrl(platform.url, `platforms[${index}].url`);
    if (!VALID_AI_POLICIES.has(platform.ai_policy) && platform.ai_policy !== "per-task") {
      throw new Error(`platforms[${index}].ai_policy is invalid`);
    }
    return platform.id;
  });
  assertUnique(ids, "Platform IDs");
  return platforms.length;
}

export function validateSources(sources, platforms) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("Source catalog must not be empty");
  const platformIds = new Set(platforms.map((platform) => platform.id));
  const ids = sources.map((source, index) => {
    if (!isObject(source) || !normalizeText(source.id) || source.type !== "github_search") {
      throw new Error(`sources[${index}] is invalid`);
    }
    if (!platformIds.has(source.platform_id)) throw new Error(`sources[${index}] references an unknown platform`);
    parseHttpsUrl(source.url, `sources[${index}].url`);
    return source.id;
  });
  assertUnique(ids, "Source IDs");
  return sources.length;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildFeed(tasks) {
  const latest = tasks.reduce((value, task) => (task.source_updated_at > value ? task.source_updated_at : value), "");
  const items = tasks.slice(0, 50).map((task) => `    <item>
      <title>${escapeXml(task.title)}</title>
      <link>${escapeXml(task.application_url)}</link>
      <guid isPermaLink="true">${escapeXml(task.application_url)}</guid>
      <pubDate>${new Date(task.source_updated_at).toUTCString()}</pubDate>
      <category>${escapeXml(task.categories.join(", "))}</category>
      <description>${escapeXml(`${task.summary} Reward: ${task.reward.display}. AI policy: ${task.ai_policy}.`)}</description>
    </item>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>AIGC Opportunity Radar — Tasks</title>
    <link>${SITE_TASKS_URL}</link>
    <description>Curated public bounty and creator task opportunities.</description>
    <language>zh-CN</language>${latest ? `\n    <lastBuildDate>${new Date(latest).toUTCString()}</lastBuildDate>` : ""}
${items.join("\n")}
  </channel>
</rss>
`;
}

function escapeCalendar(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");
}

function calendarTimestamp(value) {
  return new Date(value).toISOString().replaceAll(/[-:]/g, "").replace(".000", "");
}

export function buildCalendar(tasks) {
  const events = tasks
    .filter((task) => task.deadline)
    .map((task) => `BEGIN:VEVENT
UID:${escapeCalendar(task.id)}@aigccreative.com
DTSTAMP:${calendarTimestamp(task.source_updated_at)}
DTSTART:${calendarTimestamp(task.deadline)}
SUMMARY:${escapeCalendar(task.title)}
DESCRIPTION:${escapeCalendar(`${task.summary}\nReward: ${task.reward.display}\nAI policy: ${task.ai_policy}`)}
URL:${escapeCalendar(task.application_url)}
END:VEVENT`);
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//AIGC Opportunity Radar//Tasks//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:AIGC 任务截止时间
${events.join("\n")}${events.length ? "\n" : ""}END:VCALENDAR
`;
}

export function validateFeed(feed) {
  const value = normalizeText(feed);
  if (!value.startsWith("<?xml") || !value.includes("<rss") || !value.includes("<channel>") || !value.endsWith("</rss>")) {
    throw new Error("Task feed is not a complete RSS document");
  }
}

export function validateCalendar(calendar) {
  const value = calendar.replace(/\r\n/g, "\n").trim();
  if (!value.startsWith("BEGIN:VCALENDAR") || !value.includes("\nVERSION:2.0\n") || !value.endsWith("END:VCALENDAR")) {
    throw new Error("Task calendar is not a complete iCalendar document");
  }
}

function publicSources(config) {
  return config
    .filter((source) => source.enabled)
    .sort((left, right) => left.priority - right.priority)
    .map(({ id, name, platform_id, type, url, trust_level, stale_after_days }) => ({
      id,
      name,
      platform_id,
      type,
      url,
      trust_level,
      update_interval_minutes: 15,
      stale_after_days,
    }));
}

async function fetchJson(url, attempts = 3) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "aigc-opportunity-task-sync",
          "x-github-api-version": "2022-11-28",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        const error = new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && error.retryable !== false) await delay(attempt * 1_000);
      else break;
    }
  }
  throw new Error(`Unable to fetch ${url}: ${lastError.message}`);
}

async function collectSource(source) {
  const query = `${source.query} -label:\"💰 Rewarded\"`;
  const params = new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(Math.min(100, Math.max(1, source.max_items * 4))),
  });
  const payload = await fetchJson(`${GITHUB_API_BASE}/search/issues?${params}`);
  if (!Array.isArray(payload.items)) throw new TypeError(`${source.id} did not return GitHub issue items`);
  return payload.items.map((issue) => normalizeGitHubIssue(source, issue)).filter(Boolean).slice(0, source.max_items);
}

async function readJson(relativePath) {
  const content = await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8");
  return JSON.parse(content.replace(/^\uFEFF/, ""));
}

async function writeChanged(relativePath, content) {
  const target = path.join(REPOSITORY_ROOT, relativePath);
  let current = null;
  try {
    current = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current === content) return false;

  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

async function checkLocal() {
  const [tasks, platforms, sources, schema, feed, calendar] = await Promise.all([
    readJson(OUTPUTS.tasks),
    readJson(OUTPUTS.platforms),
    readJson(OUTPUTS.sources),
    readJson(OUTPUTS.schema),
    readFile(path.join(REPOSITORY_ROOT, OUTPUTS.feed), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, OUTPUTS.calendar), "utf8"),
  ]);
  if (!isObject(schema) || schema.type !== "array") throw new Error("Task schema is invalid");
  const taskCount = validateTaskData(tasks, { allowEmpty: process.env.ALLOW_EMPTY_TASKS === "1" });
  const platformCount = validatePlatforms(platforms);
  const sourceCount = validateSources(sources, platforms);
  validateFeed(feed);
  validateCalendar(calendar);
  return { taskCount, platformCount, sourceCount };
}

async function sync() {
  const [config, platforms] = await Promise.all([
    readJson("config/sources.json"),
    readJson(OUTPUTS.platforms),
  ]);
  validatePlatforms(platforms);
  const enabled = config.filter((source) => source.enabled).sort((left, right) => left.priority - right.priority);
  const batches = [];
  for (const source of enabled) batches.push(...(await collectSource(source)));
  const tasks = deduplicateTasks(batches);
  validateTaskData(tasks);
  const sources = publicSources(config);
  validateSources(sources, platforms);

  const outputs = [
    [OUTPUTS.tasks, `${JSON.stringify(tasks, null, 2)}\n`],
    [OUTPUTS.sources, `${JSON.stringify(sources, null, 2)}\n`],
    [OUTPUTS.feed, buildFeed(tasks)],
    [OUTPUTS.calendar, buildCalendar(tasks)],
  ];
  const changed = [];
  for (const [relativePath, content] of outputs) {
    if (await writeChanged(relativePath, content)) changed.push(relativePath);
  }
  return { taskCount: tasks.length, sourceCount: sources.length, changed };
}

async function main() {
  const mode = process.argv[2] || "--sync";
  if (!new Set(["--sync", "--check"]).has(mode)) {
    throw new Error("Usage: node scripts/sync-tasks.mjs [--sync|--check]");
  }
  if (mode === "--check") {
    const result = await checkLocal();
    console.log(`Validated ${result.taskCount} tasks, ${result.platformCount} platforms, and ${result.sourceCount} sources.`);
    return;
  }
  const result = await sync();
  if (result.changed.length === 0) {
    console.log(`Sources are unchanged; ${result.taskCount} tasks validated from ${result.sourceCount} sources.`);
  } else {
    console.log(`Validated ${result.taskCount} tasks and updated: ${result.changed.join(", ")}`);
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
