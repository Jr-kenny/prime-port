const LABEL = /^(job description|description|deliverables?|acceptance criteria|criteria|deadline|opening offer|offered wage)\s*:\s*(.*)$/i;

function parseDeadline(value, nowSeconds) {
  if (/^\d{10}$/.test(value)) return Number(value) > nowSeconds ? Number(value) : null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis / 1000 > nowSeconds ? Math.floor(millis / 1000) : null;
}

export function parseMarketplaceBrief(task, nowSeconds = Math.floor(Date.now() / 1000)) {
  const fields = {};
  let current = null;
  for (const raw of String(task.description ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(LABEL);
    if (match) {
      current = match[1].toLowerCase();
      fields[current] = match[2].trim();
    } else if (current && line) {
      fields[current] = `${fields[current]} ${line}`.trim();
    }
  }

  const title = String(task.title ?? "").trim();
  const description = fields["job description"] ?? fields.description ?? "";
  const deliverables = fields.deliverables ?? fields.deliverable ?? "";
  const acceptanceCriteria = fields["acceptance criteria"] ?? fields.criteria ?? "";
  const deadlineText = fields.deadline ?? "";
  const deadline = parseDeadline(deadlineText, nowSeconds);
  const openingOffer = fields["opening offer"] ?? fields["offered wage"] ?? null;
  const missing = [];

  if (title.length < 8 || /^(post|publish|help me post|set up)\b/i.test(title)) missing.push("a specific job title");
  if (description.length < 30) missing.push("job description (at least 30 characters)");
  if (deliverables.length < 10) missing.push("deliverables");
  if (acceptanceCriteria.length < 10) missing.push("acceptance criteria");
  if (!deadline) missing.push("a future deadline");
  if (openingOffer && !/^\d+(?:\.\d{1,6})?$/.test(openingOffer)) missing.push("a valid optional opening offer");

  return {
    complete: missing.length === 0,
    missing,
    brief: { title, description, deliverables, acceptanceCriteria, deadline, openingOffer },
  };
}

export const REQUIRED_BRIEF_TEMPLATE = [
  "Job description: <what the freelancer must do>",
  "Deliverables: <the files, output, or evidence expected>",
  "Acceptance criteria: <how completed work will be judged>",
  "Deadline: <future ISO date or Unix timestamp>",
  "Opening offer: <optional USDT amount; omit for open to offers>",
].join("\n");
