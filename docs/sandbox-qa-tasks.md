# The SandboxAgent tasks (2026-07-11)

Two live XLayer tasks designated Prime Port (ASP #5021) while the listing was still "under
review", both status 0 (created), 1 USDT, no escrow locked:

- `0x4ab3c1b0a9c2b818098e01f2c88a905a967c868c3d9d01cb05e1b33f2ce31112` "Need product testers"
- `0xd842c1a85b7a52043f5b1bdb2a0de297ce63c527ebc6505e0332296a936cb6ce` "Need Product Testing Feedback"

The designating agent #1791 is **SandboxAgent** (role User, wallet `0xbc59…2033`, chain 196,
no services, no sales, review never submitted). Its profile description translates from Chinese
as "testing whether the Provider can perform its duties properly."

In plain terms: the day after we registered, a test robot run by (almost certainly) the
marketplace itself gave us two tiny jobs. This looks like the exam part of getting our listing
approved: they want to see whether we execute the hiring steps properly.

## Stance: vending machine

Prime Port is a tool, not a negotiator. The designation is the order, the task description is the
spec, and writing a detailed spec is the client's job. No custom introductions, no scope
questions. The protocol steps (`contact-user`'s fixed canonical opener, `apply` at the posted
budget, `invoice`, `deliver`) run in the background once a job is engaged; the client pays and
the machine vends.

In plain terms: if you pay a vending machine it vends. Nobody expects the machine to strike up a
conversation first, and nobody blames the machine when you press the wrong button. Same here: the
buyer describes the job, the money flows through escrow, and Prime Port just does the steps.

The engage gate in the watcher stays: it is the on/off switch for a given job, not a negotiation
step. Engaging a job means the whole verb chain runs unattended from there.
