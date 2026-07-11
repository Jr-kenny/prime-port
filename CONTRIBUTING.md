# Contributing

Short version: we ship quality or we don't ship. The hackathon deadline is not an excuse for sloppy work, it's the reason we can't afford any.

## The bar

Every PR gets reviewed before merge, and these are the things that get PRs bounced:

**No AI slop.** Using AI tools to help you code is fine, we all do. Pasting whatever a model spat out without reading it, understanding it, or testing it is not. If you can't explain every line of your PR when asked, it's not ready. Tell-tale slop gets closed on sight: dead code paths nobody calls, three abstractions for one use case, comments narrating the obvious ("// loop over the items"), hallucinated APIs that don't exist, and error handling that catches everything and does nothing.

**It has to actually run.** Before you open a PR, you ran it. Not "it should work", you watched it work. Say what you did to test it in the PR description, exact commands, real output. "Tested locally" with no detail reads the same as "didn't test".

**Small and focused.** One PR does one thing. If your diff mixes a feature, a refactor, and a formatting pass, split it. Big unreviewable PRs stall, and stalled PRs are how lanes die.

**Match what's there.** Follow the existing structure, naming, and style of the code around your change. Don't introduce a new pattern, framework, or dependency without raising it in the lane issue first. Every dependency is something the whole team inherits.

**No secrets, ever.** Keys, tokens, and wallet material never touch the repo. `.env` is gitignored for a reason. If you commit a secret even once, it's burned, rotate it.

**Handle the sad path.** This system moves real money through escrow and talks to a live protocol with a state machine that punishes wrong ordering. "Happy path works" is half a PR. What happens when the CLI call fails, the message doesn't arrive, the tx reverts? At minimum: fail loudly, never swallow errors silently.

## Process

1. Claim work in the lane issue before you build, so nobody double-builds.
2. Branch from `main`: `lane/short-description`.
3. Agree cross-lane interfaces in the issue BEFORE building against them. The Day 1 spec (port credential + hire commitment object) is frozen; changing it needs everyone's eyes.
4. Open the PR with: what it does, why, and how you tested it.
5. Kenny reviews and merges. Review comments are about the code, not about you. Push back if you disagree, with reasons.

## If you're stuck

Say so early, in the issue or the group. Half-working code pushed to a branch with a clear "stuck here" note is a contribution. Silence for three days is not. Nobody thinks less of you for asking; we think less of unexplained dead air.
