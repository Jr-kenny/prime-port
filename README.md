# Prime Port

AI agents hire real humans for jobs agents can't do.

The agent pays through OKX's own AI Task Marketplace, gets a **port** (a live, private conversation endpoint it controls), and negotiates directly with the freelancers who claim the job. Everybody else gives agents a post button. We give them a seat at the table.

Full architecture, lifecycle, and confirmed protocol facts live in [docs/BRIEF.md](docs/BRIEF.md). Read it before writing code, especially the "confirmed facts" section so we don't re-verify things twice.

## OKX.AI Genesis Hackathon

Deadline: **July 17, 2026**. Team of 4.

## How we work

- `main` is protected in spirit: **nobody pushes to it directly, including me.** Everything lands by PR.
- Kenny is the maintainer and merges PRs. Review is quick, the point is a second pair of eyes and a clean history, not ceremony.
- Branch naming: `lane/short-description` (e.g. `backend/port-lifecycle`, `frontend/claim-flow`).
- Keep PRs small enough to review in minutes. A stalled 2000-line PR is worse than three merged small ones.
- The Day 1 spec (port access credential + hire commitment object) freezes before feature code. It's the load-bearing wall; changing it after Day 1 needs everyone's eyes on the PR.

## Team lanes

| Lane | Owner | Deliverable |
|---|---|---|
| **Backend / protocol** | Kenny | ASP registration + onchainos integration, port lifecycle (mint / grant / revoke / scrap), MCP tools (`publish`, `get_offers`, `negotiate`, `hire`, `approve`) |
| **Payout + contracts** | open, grab it | Forwarding contract on XLayer (register-at-hire, forward-by-anyone, fee split), release watcher |
| **Frontend** | PASdeco | Job pages, claim flow with embedded wallet onboarding, freelancer chat UI, evidence submission |
| **Distribution + demo** | open, grab it | X + Telegram posting pipeline, demo storyboard, submission page, pitch |

Lane rules:

- An open lane belongs to whoever claims it first (comment on the tracking issue or just say so in the group). Put your name in this table via PR when you claim.
- Don't be scared off by a lane looking above your level. Take it, push what you have, and flag where you're stuck early. Half-working code in a PR beats silence.
- If a lane stalls, Kenny (or anyone free) can pick up pieces of it. That's not stepping on toes, that's shipping. Coordinate in the group first so two people aren't building the same thing.
- Cross-lane interfaces get agreed in an issue before either side builds against them.

## Repo layout (will grow)

```
docs/        brief, specs, decisions
backend/     ASP integration, port manager, MCP server
contracts/   forwarding contract (XLayer)
web/         job pages + freelancer app
distribution/ social posting pipeline
```
