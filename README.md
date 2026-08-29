# AIGC Opportunity Tasks

Open, normalized snapshots of public bounty and creator-task opportunities for
[AIGC Opportunity Radar](https://www.aigccreative.com/tasks/).

## Principles

- Only collect public, auditable sources. Never use contributor login sessions.
- A listing is a lead, not a payout guarantee. Users must confirm the current rules.
- AI assistance is optional and recorded per task as `allowed`, `limited`,
  `human-only`, or `unknown`.
- Prefer a small curated source catalog over unreviewed global scraping.
- Keep stable IDs and canonical URLs so downstream clients can deduplicate safely.

## Published data

- `data/tasks.json` — normalized open task snapshot
- `data/platforms.json` — platform and policy catalog
- `data/sources.json` — enabled public collection sources
- `data/schema.json` — task JSON Schema
- `tasks/feed.xml` — RSS updates
- `tasks/deadlines.ics` — deadlines with known dates

The scheduled workflow checks public sources every 15 minutes. It commits only
when the normalized task snapshot changes.

## Local commands

```bash
node --test scripts/sync-tasks.test.mjs
node scripts/sync-tasks.mjs --check
node scripts/sync-tasks.mjs --sync
```

`GITHUB_TOKEN` is optional locally and supplied automatically by GitHub Actions.

## Scope

The first connector covers curated public GitHub bounty issues. Account-only
platforms remain in the platform catalog until an official public API, feed, or
partnership is available.

## License

[MIT](LICENSE)
