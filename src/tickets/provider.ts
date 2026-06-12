/**
 * Ticket-aware capture (TICKETS_DESIGN.md, phases T1–T2).
 *
 * Architecture principle: contract + adapters, not a mandatory service.
 * aidimag core only ever knows `TicketProvider.getTicket(id)`. All API
 * parsing, auth, and rate-limit handling lives behind that boundary:
 *
 *   JiraProvider    direct API, local creds
 *   GitHubProvider  direct API (issues), local creds
 *   HttpProvider    any URL implementing the contract (BYO middleware)
 *   (RemoteProvider via the sync server lands with T3)
 *
 * Hard rule: ticket FETCH is lazy and non-blocking — the post-commit hook
 * only extracts the ticket id (regex, offline); getTicket runs at review
 * time or on demand (`dim ticket show`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- contract

export interface Ticket {
  id: string;
  url: string;
  title: string;
  /** description, truncated (~2KB) */
  body: string;
  type: "bug" | "story" | "task" | "epic" | "other";
  status: "open" | "in_progress" | "done" | "other";
  labels: string[];
  parent?: { id: string; title: string };
}

export interface TicketProvider {
  readonly name: string;
  getTicket(id: string): Promise<Ticket | null>;
}

// ---------------------------------------------------------------- config

export interface BranchRules {
  pattern?: string;
  exempt?: string[];
  enforce?: "push" | "warn" | "off";
}

export interface TicketsConfig {
  provider?: "jira" | "github" | "http";
  /** ticket-id regex for branch/commit-message extraction */
  pattern?: string;
  /** Jira site / GitHub repo URL / HttpProvider endpoint */
  baseUrl?: string;
  branch?: BranchRules;
}

export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".aidimag", "config.json");
}

export function readTicketsConfig(repoRoot: string): TicketsConfig {
  try {
    const cfg = JSON.parse(readFileSync(configPath(repoRoot), "utf8"));
    return (cfg.tickets as TicketsConfig) ?? {};
  } catch {
    return {};
  }
}

export function writeTicketsConfig(repoRoot: string, tickets: TicketsConfig): void {
  const p = configPath(repoRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // fresh file
  }
  writeFileSync(p, JSON.stringify({ ...existing, tickets }, null, 2) + "\n");
}

// ---------------------------------------------------------------- credentials (never the repo)

function credentialsPath(): string {
  return path.join(homedir(), ".aidimag", "credentials.json");
}

/** Ticket credentials live alongside sync tokens, keyed `ticket:<baseUrl>`. */
export function getTicketCredential(baseUrl: string): string | null {
  if (process.env.AIDIMAG_TICKET_TOKEN) return process.env.AIDIMAG_TICKET_TOKEN;
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8"))[`ticket:${baseUrl}`] ?? null;
  } catch {
    return null;
  }
}

export function saveTicketCredential(baseUrl: string, credential: string): void {
  const p = credentialsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const creds = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  creds[`ticket:${baseUrl}`] = credential;
  writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------- ticket-id extraction (T1 — offline)

/** Extract the first ticket id from text (branch name, commit subject/body). */
export function extractTicketId(text: string, pattern: string = DEFAULT_TICKET_PATTERN): string | null {
  try {
    const m = text.match(new RegExp(pattern));
    return m ? m[0] : null;
  } catch {
    return null; // bad user regex — never break capture
  }
}

// ---------------------------------------------------------------- providers

const FETCH_TIMEOUT_MS = 5_000;
const BODY_LIMIT = 2_048;

async function fetchJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(t);
  }
}

function truncate(s: string): string {
  return s.length > BODY_LIMIT ? s.slice(0, BODY_LIMIT) + "…" : s;
}

/** Jira Cloud/Server: GET /rest/api/2/issue/<id>. Credential: "email:apiToken" (Basic) or a PAT (Bearer). */
class JiraProvider implements TicketProvider {
  readonly name = "jira";
  constructor(private baseUrl: string, private credential: string) {}

  async getTicket(id: string): Promise<Ticket | null> {
    const auth = this.credential.includes(":")
      ? `Basic ${Buffer.from(this.credential).toString("base64")}`
      : `Bearer ${this.credential}`;
    const raw = await fetchJson(`${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(id)}`, {
      Authorization: auth,
      Accept: "application/json",
    });
    if (!raw) return null;
    const f = (raw.fields ?? {}) as Record<string, unknown>;
    const issueType = String((f.issuetype as Record<string, unknown>)?.name ?? "").toLowerCase();
    const statusCat = String(
      ((f.status as Record<string, unknown>)?.statusCategory as Record<string, unknown>)?.key ?? ""
    );
    const parent = f.parent as Record<string, unknown> | undefined;
    return {
      id: String(raw.key ?? id),
      url: `${this.baseUrl}/browse/${raw.key ?? id}`,
      title: String(f.summary ?? ""),
      body: truncate(String(f.description ?? "")),
      type: issueType.includes("bug")
        ? "bug"
        : issueType.includes("story")
          ? "story"
          : issueType.includes("epic")
            ? "epic"
            : issueType.includes("task")
              ? "task"
              : "other",
      status: statusCat === "done" ? "done" : statusCat === "indeterminate" ? "in_progress" : statusCat === "new" ? "open" : "other",
      labels: Array.isArray(f.labels) ? (f.labels as string[]).map(String) : [],
      parent: parent
        ? { id: String(parent.key), title: String(((parent.fields ?? {}) as Record<string, unknown>).summary ?? "") }
        : undefined,
    };
  }
}

/** GitHub Issues: baseUrl is the repo URL (https://github.com/owner/repo); ids are issue numbers ("123" or "#123"). */
class GitHubProvider implements TicketProvider {
  readonly name = "github";
  constructor(private baseUrl: string, private credential: string) {}

  async getTicket(id: string): Promise<Ticket | null> {
    const m = this.baseUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!m) throw new Error(`tickets.baseUrl must look like https://github.com/owner/repo (got ${this.baseUrl})`);
    const num = id.replace(/^#/, "");
    const raw = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}/issues/${num}`, {
      Authorization: `Bearer ${this.credential}`,
      Accept: "application/vnd.github+json",
    });
    if (!raw) return null;
    const labels = Array.isArray(raw.labels)
      ? (raw.labels as Array<Record<string, unknown>>).map((l) => String(l.name ?? l))
      : [];
    const lower = labels.map((l) => l.toLowerCase());
    return {
      id: `#${raw.number}`,
      url: String(raw.html_url ?? ""),
      title: String(raw.title ?? ""),
      body: truncate(String(raw.body ?? "")),
      type: lower.some((l) => l.includes("bug")) ? "bug" : lower.some((l) => l.includes("enhancement") || l.includes("feature")) ? "story" : "other",
      status: raw.state === "closed" ? "done" : "open",
      labels,
    };
  }
}

/** Bring-your-own middleware: GET <baseUrl>/ticket/<id> returning the normalized Ticket JSON. */
class HttpProvider implements TicketProvider {
  readonly name = "http";
  constructor(private baseUrl: string, private credential: string | null) {}

  async getTicket(id: string): Promise<Ticket | null> {
    const raw = await fetchJson(`${this.baseUrl.replace(/\/$/, "")}/ticket/${encodeURIComponent(id)}`, {
      ...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}),
      Accept: "application/json",
    });
    return raw ? (raw as unknown as Ticket) : null;
  }
}

/** Build the configured provider, or null when tickets aren't set up / no credential. */
export function ticketProviderFor(repoRoot: string): TicketProvider | null {
  const cfg = readTicketsConfig(repoRoot);
  if (!cfg.provider || !cfg.baseUrl) return null;
  const cred = getTicketCredential(cfg.baseUrl);
  switch (cfg.provider) {
    case "jira":
      return cred ? new JiraProvider(cfg.baseUrl.replace(/\/$/, ""), cred) : null;
    case "github":
      return cred ? new GitHubProvider(cfg.baseUrl, cred) : null;
    case "http":
      return new HttpProvider(cfg.baseUrl, cred); // credential optional for internal services
    default:
      return null;
  }
}

// ---------------------------------------------------------------- branch convention (T1.5)

export interface BranchCheckResult {
  branch: string;
  ok: boolean;
  exempt: boolean;
  enforce: "push" | "warn" | "off";
  pattern: string | null;
}

export function checkBranchName(repoRoot: string, branch: string): BranchCheckResult {
  const rules = readTicketsConfig(repoRoot).branch ?? {};
  const enforce = rules.enforce ?? "off";
  const pattern = rules.pattern ?? null;
  if (!pattern || enforce === "off") return { branch, ok: true, exempt: false, enforce, pattern };
  const exemptList = rules.exempt ?? ["main", "master", "develop", "release/.*", "HEAD"];
  const isExempt = exemptList.some((e) => {
    try {
      return new RegExp(`^(${e})$`).test(branch);
    } catch {
      return e === branch;
    }
  });
  if (isExempt) return { branch, ok: true, exempt: true, enforce, pattern };
  let ok = false;
  try {
    ok = new RegExp(pattern).test(branch);
  } catch {
    ok = true; // bad admin regex must not lock everyone out
  }
  return { branch, ok, exempt: false, enforce, pattern };
}

/** Build a conforming branch name: feature/XXX-2100-serialize-token-refresh */
export function buildBranchName(ticketId: string, title?: string, prefix = "feature"): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug ? `${prefix}/${ticketId}-${slug}` : `${prefix}/${ticketId}`;
}

