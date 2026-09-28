import type { FolderInfo } from "../bridge";
import type { Session } from "../sessions";
import { Core, type Agent, type AgentStep, type Agents, type Ballot, type Brief, type Entry, type FinalData, type ModelChoice, type PlanData, type Project, type Role, type Tally, type Transcript, type Usage } from "./core";
import { Graph, type Handoffs, type Task } from "./graph";
import { Providers, type ProviderConfig, type SampleFn, type TraceKind } from "./providers";

// What claude.ai gives a page it hosts, and what the tests look for.
declare global {
  interface Window {
    claude?: { use(name: string): unknown };
    __QUORUM_TEST__?: boolean;
    __quorum?: unknown;
  }
}

type Phase = "idle" | "running" | "paused" | "stopped" | "blocked" | "done";
type SeatStatus = "idle" | "thinking" | "writing" | "done" | "error" | "stopped";
type Section = "proposals" | "questions" | "council" | "vote" | "review" | "plan";

// An agent step as the page shows it running. What it finished with is in its handoff.
interface Seat {
  status: SeatStatus;
  text: string;
  error: { code: string, message?: string } | null;
  truncated: boolean;
  ctl: AbortController | null;
  agent: Agent | null;
  served: string;
  activity: string;
  skipped: boolean;
}

// What stops the chosen agents from running here. See checkAgents.
interface AgentsProblem {
  message: string;
  focus?: HTMLElement;
  openProviders?: boolean;
  project?: boolean;
}

// What Quorum's local server says about itself, from GET /api/local.
interface LocalInfo {
  claudeCode: { available: boolean, version: string | null };
  sessions: { file: string } | null;
  project: string | null;
  home: string;
}

// The claude.ai capability that saves a file for the viewer.
interface Downloads {
  save(o: { filename: string, data: string }): Promise<{ status?: string } | null | undefined>;
}

// A piece of context in the form.
interface ContextField {
  id: string;
  kind: string;
  title: string;
  text: string;
  el: HTMLDivElement;
  titleEl: HTMLInputElement;
  textEl: HTMLTextAreaElement;
  removeEl: HTMLButtonElement;
  sizeEl: HTMLElement;
  labelEl: HTMLLabelElement;
}

interface FormSnapshot {
  feature: string;
  context: { kind: string, title?: string, text?: string }[];
}

// A step of a round, for the conversation viewer.
interface ConvoStep {
  round: number;
  node: string;
}

// A transcript this page is writing, with the session it's saved to.
type LiveTranscript = Transcript & { sid?: string | null };

// One turn of a conversation in the viewer. See convoBlocks.
interface Block {
  id: string;
  sig: string;
  live?: boolean;
  html(): string;
  after?(el: Element): void;
}

// What the page keeps on an element it draws into, so it's drawn again only when what it shows changes.
interface Drawn {
  _html?: string;
  _key?: string;
  _session?: number;
  _id?: string;
  _sig?: string;
  _flash?: ReturnType<typeof setTimeout>;
}

// A thrown error as the page reads it: a provider's { code, message, text }, or anything else.
type Thrown = { code?: unknown, message?: unknown, text?: unknown } | null | undefined;

(function (Core, Graph) {
  "use strict";

  const LETTERS = Core.LETTERS, BUILDERS = Core.BUILDERS, COUNCIL = Core.COUNCIL, CHAIR = Core.CHAIR;
  const TIERS = Core.TIERS, ROLES = Core.ROLES, LENGTHS = Core.LENGTHS, PROVIDERS = Core.PROVIDERS;
  // Inside claude.ai the page gets the Claude runtime but can't reach other services; on its own it's the reverse.
  const INSIDE = !!(window.claude && typeof window.claude.use === "function");
  // Served by Quorum's local server (serve.ts), the page can also choose a project folder and run Claude Code in it.
  const ON_WEB = !INSIDE && /^https?:$/.test(location.protocol);
  const COUNCIL_IDS = COUNCIL.map(c => c.id);
  const REVIEWERS = Core.REVIEWERS, REVIEWER_IDS = Core.REVIEWER_IDS;
  // The seats in the chamber's seating chart, and every step an agent works on. The Chair's seat also shows its
  // revision after the final review, the "final" step.
  // A councilor's questions and a builder's answers show on their seats too.
  const ASK_IDS = Core.ASK_IDS, AMEND_IDS = Core.AMEND_IDS, askId = Core.askId, amendId = Core.amendId;
  const SEAT_IDS = LETTERS.concat(COUNCIL_IDS, ["chair"]);
  const ALL_IDS = SEAT_IDS.concat(ASK_IDS, AMEND_IDS, REVIEWER_IDS, ["final"]);
  const CAST: Record<string, { name: string }> = {};
  ALL_IDS.forEach(id => { CAST[id] = Core.stepOf(id).cast; });
  const isBuilder = (id: string) => LETTERS.indexOf(id) >= 0;
  const isCouncil = (id: string) => COUNCIL_IDS.indexOf(id) >= 0;
  const isReviewer = (id: string) => REVIEWER_IDS.indexOf(id) >= 0;
  const isAsk = (id: string) => ASK_IDS.indexOf(id) >= 0;
  const isAmend = (id: string) => AMEND_IDS.indexOf(id) >= 0;

  // A step's name where the page says it couldn't finish.
  function stepName(id: string): string {
    const st = Core.stepOf(id);
    if (isAsk(id)) return st.cast.name + "'s questions on Proposal " + st.letter;
    if (isAmend(id)) return st.cast.name + "'s answers to the council";
    return st.cast.name;
  }

  const EXAMPLES: FormSnapshot[] = [
    {
      feature: "Add optional two-factor authentication to sign-in, using an authenticator app, with backup codes for account recovery.",
      context: [
        { kind: "requirements", title: "Product requirements", text: "- Users can turn two-factor authentication on or off in Account settings.\n- Setup shows a QR code for authenticator apps (TOTP) and asks for a code to confirm.\n- Show 10 single-use backup codes once, at setup.\n- Admins of team workspaces can require two-factor authentication for all members.\n- Existing users who haven't set it up must not be locked out." },
        { kind: "today", title: "How it works today", text: "Web app with a React front end, a Node.js (Express) API and PostgreSQL.\nSign-in: email and password, checked in POST /api/session, which sets an httpOnly session cookie.\nThe users table has id, email, password_hash, created_at and workspace_id.\nSessions live in Redis with a 14-day expiry." },
      ],
    },
    {
      feature: "Let users export any report on the Reports page as a CSV file.",
      context: [
        { kind: "requirements", title: "Product requirements", text: "- An \"Export CSV\" button on every report.\n- Exports respect the filters and date range currently applied.\n- Reports can have up to 500,000 rows, and exports must not time out.\n- If an export takes longer than 30 seconds, email the user a download link instead." },
        { kind: "today", title: "How it works today", text: "Reports are built from SQL queries in ReportService (Python, Django).\nBackground jobs run on Celery with a Redis broker.\nFiles are stored in S3, and the Notifications module already sends email." },
      ],
    },
    {
      feature: "Notify people in real time when a teammate comments on a task they follow.",
      context: [
        { kind: "requirements", title: "Product requirements", text: "- Followers of a task get an in-app notification within a few seconds of a new comment.\n- A bell icon shows the unread count.\n- Users can mute a task.\n- People who are offline get a daily email digest instead." },
        { kind: "constraints", title: "Constraints", text: "- Two backend engineers for about three weeks.\n- No new paid services this quarter.\n- The mobile apps must keep working with the current API version." },
      ],
    },
  ];

  const CONTEXT_KINDS: Record<string, { title: string, placeholder: string, code?: boolean }> = {
    requirements: { title: "Product requirements", placeholder: "Paste the requirements, user stories or acceptance criteria." },
    today: { title: "How it works today", placeholder: "Describe the parts of the system this touches: the stack, services, data model and how the current flow works." },
    constraints: { title: "Constraints", placeholder: "Deadlines, team size, performance or compliance needs, and anything that can't change." },
    code: { title: "Relevant code", placeholder: "Paste the files or snippets the feature will touch.", code: true },
    other: { title: "", placeholder: "Anything else the council should know." },
  };
  const CONTEXT_LIMIT = Core.CONTEXT_LIMIT;

  // kind: fatal = Claude can't be used in this view; stop = needs a change first; retry = the viewer may retry.
  // {provider} and {hint} are filled in from the seat that failed.
  const ERRORS: Record<string, { kind: "fatal" | "stop" | "retry", msg: string, short: string }> = {
    not_granted: { kind: "fatal", msg: "Claude access was declined for this page. Reload the page to be asked again.", short: "Claude access was declined for this page." },
    sampling_disabled: { kind: "fatal", msg: "Claude isn't available for this account, so the council can't meet.", short: "Claude isn't available for this account." },
    not_declared: { kind: "fatal", msg: "This page can no longer reach Claude. Reload it to try again.", short: "This page can't reach Claude." },
    capability_disabled: { kind: "fatal", msg: "Claude can't be reached from this view. Open the app from claude.ai to convene the council.", short: "Claude can't be reached from this view." },
    capability_removed: { kind: "fatal", msg: "Claude can't be reached from this view. Open the app from claude.ai to convene the council.", short: "Claude can't be reached from this view." },
    invalid_request: { kind: "stop", msg: "This page sent Claude a request it couldn't use. Reload the page and try again.", short: "Claude couldn't use the request." },
    transform_error: { kind: "stop", msg: "This page sent Claude a request it couldn't use. Reload the page and try again.", short: "Claude couldn't use the request." },
    queue_overflow: { kind: "stop", msg: "Too many requests were waiting for Claude. Reload the page and try again.", short: "Too many requests were waiting." },
    session_expired: { kind: "retry", msg: "Your Claude session has expired. Sign in again, then retry.", short: "The Claude session expired." },
    claude_unavailable: { kind: "retry", msg: "Claude only works when Quorum is open inside claude.ai. Choose another provider under Agents, then retry.", short: "Claude isn't available outside claude.ai." },
    refused: { kind: "stop", msg: "{provider} declined to work on this request as written. Reword it, then convene again.", short: "{provider} declined this request." },
    prompt_too_large: { kind: "stop", msg: "There was too much text for {provider}. Shorten the feature or the context, then convene again.", short: "There was too much text for {provider}." },
    rate_limited: { kind: "retry", msg: "{provider} has had too many requests, or a usage limit was reached. Wait a few minutes, then retry.", short: "{provider} had too many requests." },
    empty_completion: { kind: "retry", msg: "{provider} returned an empty answer. Retry, or try the Brief length.", short: "{provider} returned an empty answer." },
    bad_ballot: { kind: "retry", msg: "The ballot at the end of the review couldn't be read. Retry to ask for the review again.", short: "The ballot at the end of this review couldn't be read." },
    upstream_error: { kind: "retry", msg: "The connection to {provider} dropped. Retry to continue where the council left off.", short: "The connection to {provider} dropped before this was finished." },
    missing_key: { kind: "retry", msg: "{provider} needs an API key. Add it under Providers, then retry.", short: "{provider} needs an API key." },
    auth_failed: { kind: "retry", msg: "{provider} rejected the API key. Check it under Providers, then retry.", short: "{provider} rejected the API key." },
    no_credits: { kind: "retry", msg: "{provider} says the account is out of credits. Add credits, then retry.", short: "The {provider} account is out of credits." },
    bad_model: { kind: "retry", msg: "{provider} didn't accept the model name. Check it under Agents, then retry.", short: "{provider} didn't accept the model name." },
    no_tools: { kind: "retry", msg: "The model can't use tools on {provider}, and every seat there works as an agent. Choose a model that supports tool calling under Agents, then retry.", short: "The model can't use tools on {provider}." },
    not_found: { kind: "retry", msg: "{provider} answered \u201Cnot found\u201D. Check the address under Providers, which usually ends in /v1, and the model name, then retry.", short: "{provider} answered \u201Cnot found\u201D." },
    unreachable: { kind: "retry", msg: "Couldn't reach {provider}. {hint}", short: "Couldn't reach {provider}." },
    bad_request: { kind: "retry", msg: "{provider} rejected the request{detail}. Check the model and provider settings, then retry.", short: "{provider} rejected the request." },
    project_missing: { kind: "retry", msg: "Claude Code couldn't open the project folder. Check that it's still there, then retry.", short: "Claude Code couldn't open the project folder." },
    claude_code_missing: { kind: "retry", msg: "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path, then retry.", short: "Quorum's server couldn't find Claude Code." },
  };
  const errInfo = (code: string) => ERRORS[code] || ERRORS.upstream_error;
  // Where a provider needs other advice than the general message.
  const PROVIDER_ERRORS: Record<string, Record<string, { msg: string, short: string }>> = {
    "claude-code": {
      auth_failed: { msg: "Claude Code isn't signed in. Run claude in a terminal and sign in, then retry.", short: "Claude Code isn't signed in." },
    },
  };

  function pageOrigin() {
    return /^https?:$/.test(location.protocol) ? location.origin : "";
  }

  function unreachableHint(provider: string | null | undefined): string {
    const origin = pageOrigin();
    if (provider === "hermes") {
      return "Check that hermes gateway is running" + (origin ? " and that API_SERVER_CORS_ORIGINS includes " + origin : ", and open Quorum from a local web server so Hermes can allow it") + ", then retry.";
    }
    if (provider === "custom") return "Check the address, and that Quorum's server, which bun start runs, is still running and can reach it, then retry.";
    if (provider === "claude-code") return "Check that Quorum's server, which bun start runs, is still running, then retry.";
    if (provider === "openrouter") return "Check your internet connection, and that Quorum's server, which bun start runs, is still running, then retry.";
    return "Check your internet connection, then retry.";
  }

  // An error's message, with the provider of the seat that failed filled in.
  function errText(code: string, seat: { agent?: Agent | null, error?: { message?: string } | null } | null | undefined, field?: "msg" | "short"): string {
    const agent = seat && seat.agent;
    const info = (agent && PROVIDER_ERRORS[agent.provider] && PROVIDER_ERRORS[agent.provider][code]) || errInfo(code);
    const provider = agent ? PROVIDERS[agent.provider].label : "Claude";
    const detail = seat && seat.error && seat.error.message ? ": " + String(seat.error.message).slice(0, 160).replace(/[.\s]+$/, "") : "";
    return info[field || "msg"]
      .replace(/\{provider\}/g, agent && agent.provider === "custom" ? "the endpoint" : provider)
      .replace("{hint}", unreachableHint(agent && agent.provider))
      .replace("{detail}", detail)
      .replace(/^the endpoint/, "The endpoint");
  }

  const STAGE_WORDS: Record<string, string> = { waiting: "Waiting", active: "In progress", done: "Done", paused: "Paused", stopped: "Stopped", tied: "Tied" };

  /* ---------- Elements ---------- */

  // Every element the page looks up by id is in the page, which is parsed before the script runs.
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const els = {
    feature: $<HTMLTextAreaElement>("feature"), featureNote: $("featureNote"), convene: $<HTMLButtonElement>("convene"), resume: $<HTMLButtonElement>("resume"),
    exampleNote: $("exampleNote"), undoExample: $<HTMLButtonElement>("undoExample"), contextCount: $("contextCount"), contextNote: $("contextNote"),
    context: $("context"), addFiles: $<HTMLButtonElement>("addFiles"), fileInput: $<HTMLInputElement>("fileInput"),
    motionContext: $<HTMLDetailsElement>("motionContext"), motionContextSummary: $("motionContextSummary"), motionContextBody: $("motionContextBody"),
    settingsHint: $("settingsHint"), tierNote: $("tierNote"), agentsNote: $("agentsNote"), roster: $("roster"),
    providers: $<HTMLDetailsElement>("providers"), providersStatus: $("providersStatus"), providersIntro: $("providersIntro"), helpHermes: $("help-hermes"),
    status: $("status"), clock: $("clock"), railStop: $<HTMLButtonElement>("railStop"),
    secProposals: $("sec-proposals"), secCouncil: $("sec-council"), secVote: $("sec-vote"), secPlan: $("sec-plan"),
    motionQuote: $("motionQuote"), sessionName: $("sessionName"), propCount: $("propCount"), propPane: $("propPane"), propByline: $("propByline"),
    propDoc: $("propDoc"), propNote: $("propNote"), propTier: $("propTier"), councilTier: $("councilTier"), planTier: $("planTier"),
    councilCount: $("councilCount"), councilPane: $("councilPane"), councilByline: $("councilByline"),
    councilDoc: $("councilDoc"), ballot: $("ballot"), councilNote: $("councilNote"),
    division: $("division"), verdict: $("verdict"),
    plan: $("plan"), planByline: $("planByline"), planDoc: $("planDoc"), planNote: $("planNote"),
    planActions: $("planActions"), copyPlan: $<HTMLButtonElement>("copyPlan"), dlPlan: $<HTMLButtonElement>("dlPlan"), dlRecord: $<HTMLButtonElement>("dlRecord"),
    notice: $("notice"), noticeText: $("noticeText"), noticeRetry: $<HTMLButtonElement>("noticeRetry"), noticeDismiss: $<HTMLButtonElement>("noticeDismiss"),
    project: $("project"), projectPath: $<HTMLInputElement>("projectPath"), projectBrowse: $<HTMLButtonElement>("projectBrowse"), projectStatus: $("projectStatus"),
    projectBrowser: $("projectBrowser"), projectWhere: $("projectWhere"), projectDirs: $("projectDirs"), motionProject: $("motionProject"),
    statusClaudeCode: $("status-claude-code"),
    openSettings: $<HTMLButtonElement>("openSettings"), openHistory: $<HTMLButtonElement>("openHistory"), settingsBadge: $("settingsBadge"), historyBadge: $("historyBadge"),
    settingsDrawer: $("settingsDrawer"), settingsTitle: $("settingsTitle"), settingsNote: $("settingsNote"), historyDrawer: $("historyDrawer"), historyTitle: $("historyTitle"),
    agentsSummary: $("agentsSummary"), changeAgents: $<HTMLButtonElement>("changeAgents"), railUsage: $("railUsage"), railUsageList: $("railUsageList"),
    sessionsStatus: $("sessionsStatus"), sessionsIntro: $("sessionsIntro"), sessionList: $("sessionList"),
    saveState: $("saveState"), motionRound: $("motionRound"), motionRoundIntro: $("motionRoundIntro"), motionRoundQuote: $("motionRoundQuote"),
    revise: $("revise"), reviseInput: $<HTMLTextAreaElement>("reviseInput"), reviseNote: $("reviseNote"), reviseBtn: $<HTMLButtonElement>("reviseBtn"),
    secRounds: $("sec-rounds"), roundsList: $("roundsList"),
    reviewOn: $<HTMLInputElement>("reviewOn"), rowReview: $("row-review"), stageReview: $("stageReview"), questionsOn: $<HTMLInputElement>("questionsOn"), stageQuestions: $("stageQuestions"),
    secQuestions: $("sec-questions"), questionsCount: $("questionsCount"), questionsPane: $("questionsPane"), questionsDoc: $("questionsDoc"),
    propDraft: $<HTMLDetailsElement>("propDraft"), propDraftDoc: $("propDraftDoc"),
    secReview: $("sec-review"), reviewCount: $("reviewCount"), reviewPane: $("reviewPane"), reviewByline: $("reviewByline"),
    reviewTier: $("reviewTier"), reviewDoc: $("reviewDoc"), reviewNote: $("reviewNote"), planDraft: $<HTMLDetailsElement>("planDraft"), planDraftDoc: $("planDraftDoc"),
    propConvo: $<HTMLButtonElement>("propConvo"), councilConvo: $<HTMLButtonElement>("councilConvo"), reviewConvo: $<HTMLButtonElement>("reviewConvo"), planConvo: $<HTMLButtonElement>("planConvo"), railConvo: $<HTMLButtonElement>("railConvo"),
    convo: $("convo"), convoScrim: $("convoScrim"), convoPanel: $("convoPanel"), convoTitle: $("convoTitle"), convoClose: $<HTMLButtonElement>("convoClose"),
    convoStep: $<HTMLSelectElement>("convoStep"), convoPrev: $<HTMLButtonElement>("convoPrev"), convoNext: $<HTMLButtonElement>("convoNext"), convoMeta: $("convoMeta"), convoBody: $("convoBody"),
    convoCopy: $<HTMLButtonElement>("convoCopy"), convoSaveAll: $<HTMLButtonElement>("convoSaveAll"),
  };
  const providerSelects: Record<string, HTMLSelectElement> = {}, tierSelects: Record<string, HTMLSelectElement> = {};
  const modelFields: Record<string, HTMLInputElement> = {};
  ROLES.forEach(r => {
    providerSelects[r.id] = $<HTMLSelectElement>("provider-" + r.id);
    tierSelects[r.id] = $<HTMLSelectElement>("tier-" + r.id);
    modelFields[r.id] = $<HTMLInputElement>("model-" + r.id);
  });
  const credFields: Record<"keys" | "urls" | "remember", Record<string, HTMLInputElement>> = {
    keys: { openrouter: $<HTMLInputElement>("key-openrouter"), hermes: $<HTMLInputElement>("key-hermes"), custom: $<HTMLInputElement>("key-custom") },
    urls: { hermes: $<HTMLInputElement>("url-hermes"), custom: $<HTMLInputElement>("url-custom") },
    remember: { openrouter: $<HTMLInputElement>("remember-openrouter"), hermes: $<HTMLInputElement>("remember-hermes"), custom: $<HTMLInputElement>("remember-custom") },
  };
  const providerSets: Record<string, HTMLFieldSetElement> = { openrouter: $<HTMLFieldSetElement>("set-openrouter"), hermes: $<HTMLFieldSetElement>("set-hermes"), custom: $<HTMLFieldSetElement>("set-custom") };
  const EXTERNAL = ["openrouter", "hermes", "custom"];
  const lengthInputs: HTMLInputElement[] = Array.prototype.slice.call(document.querySelectorAll('input[name="length"]'));
  const exampleBtns: HTMLElement[] = Array.prototype.slice.call(document.querySelectorAll(".example"));
  const addBtns: HTMLButtonElement[] = Array.prototype.slice.call(document.querySelectorAll(".add-btn"));
  const stageBtns: HTMLButtonElement[] = Array.prototype.slice.call(document.querySelectorAll(".stage-btn"));
  const seatEls: Record<string, SVGGElement> = {};
  SEAT_IDS.forEach(id => { seatEls[id] = document.querySelector('[data-seat="' + id + '"]') as SVGGElement; });
  const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  const store = {
    get(k: string) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
    set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch (_) { /* storage unavailable */ } },
    remove(k: string) { try { window.localStorage.removeItem(k); } catch (_) { /* storage unavailable */ } },
  };

  /* ---------- State ---------- */

  const S: {
    phase: Phase,
    token: number,
    session: number,
    handoffs: Handoffs,
    round: number,
    past: Handoffs[],
    sessionId: string | null,
    name: string,
    agents: Agents,
    seats: Record<string, Seat>,
    revealed: Record<Section, boolean>,
    sel: { proposals: string, questions: string, council: string, review: string },
    clock: { startedAt: number, accumulated: number },
    notice: { text: string, retry: boolean } | null,
    canRetry: boolean,
    blockedCode: string,
    heard: boolean,
    connecting: boolean,
    convenedAt: number,
    stoppedAt: number,
  } = {
    phase: "idle",
    token: 0,
    session: 0,
    handoffs: {}, // node id to frozen handoff, for each step of this round that has finished
    round: 1, // the round of the session: each round after the first revises the last plan with the requester's input
    past: [], // the handoffs of each earlier round, oldest first
    sessionId: null, // the id of the saved session, when Quorum's local server saves sessions
    name: "", // what the Chair's agent named the session, once it has
    agents: Core.normalizeAgents(null, INSIDE),
    seats: {},
    revealed: { proposals: false, questions: false, council: false, vote: false, review: false, plan: false },
    sel: { proposals: "A", questions: "A", council: "advocate", review: "scaling" },
    clock: { startedAt: 0, accumulated: 0 },
    notice: null,
    canRetry: false,
    blockedCode: "",
    heard: false,
    connecting: false,
    convenedAt: 0,
    stoppedAt: 0,
  };
  let sampleFn: SampleFn | null = null;
  let sampleState: "pending" | "ready" | "none" | "blocked" = "pending";
  let downloadsNS: Downloads | null = null;
  let nameCtl: AbortController | null = null;
  // What naming the session used, which isn't a step with a conversation of its own.
  let nameUsage: { agent: Agent, served: string, usage: Usage | null, status: string } | null = null;
  let clockTimer: ReturnType<typeof setInterval> | 0 = 0;

  function freshSeat(): Seat {
    return { status: "idle", text: "", error: null, truncated: false, ctl: null, agent: null, served: "", activity: "", skipped: false };
  }
  function resetSeats() {
    ALL_IDS.forEach(id => { S.seats[id] = freshSeat(); });
  }
  resetSeats();

  if (window.__QUORUM_TEST__) window.__quorum = { S, saved: () => saved.queue, convos: () => convos };

  /* ---------- Capabilities ---------- */

  function useCapability(name: string): Promise<unknown> {
    const c = window.claude;
    if (!c || typeof c.use !== "function") return Promise.resolve(null);
    try {
      return Promise.resolve(c.use(name)).then(v => v || null, () => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  const sampleReady = useCapability("sample").then(fn => {
    sampleFn = typeof fn === "function" ? fn as SampleFn : null;
    if (sampleState === "pending") sampleState = sampleFn ? "ready" : "none";
    schedule();
    return sampleFn;
  });

  // What Quorum's local server says: { claudeCode: { available, version }, project, home }, or null without one.
  let local: LocalInfo | null = null;
  let localState: "pending" | "ready" | "none" = ON_WEB ? "pending" : "none";
  function localUrl(route: string): string {
    return location.origin + "/api/" + route;
  }
  const localReady: Promise<LocalInfo | null> = ON_WEB && typeof fetch === "function" ?
    fetch(localUrl("local")).then(r => (r.ok ? r.json() : null)).then(o => (o && o.claudeCode ? o : null), () => null) :
    Promise.resolve(null);

  useCapability("downloads").then(ns => {
    downloadsNS = ns && typeof (ns as Downloads).save === "function" ? ns as Downloads : null;
    schedule();
  });

  /* ---------- Derived values ---------- */

  function currentAgents(): Agents {
    const a: Agents = {};
    ROLES.forEach(r => {
      const provider = providerSelects[r.id].value;
      a[r.id] = { provider, model: provider === "claude" ? tierSelects[r.id].value : modelFields[r.id].value.trim() };
    });
    return a;
  }

  // The roles a session uses: the review role only with a final review.
  function activeRoles(review: boolean): Role[] {
    return ROLES.filter(r => !r.optional || review);
  }

  // Whether the session has a final review, and the council's questions: as chosen before it convenes, and as it
  // was convened after.
  function reviewing(): boolean {
    return S.phase === "idle" ? els.reviewOn.checked : !!brief().review;
  }
  function questioning(): boolean {
    return S.phase === "idle" ? els.questionsOn.checked : !!brief().questions;
  }

  function usesClaude(agents: Agents, review: boolean): boolean {
    return activeRoles(review).some(r => agents[r.id].provider === "claude");
  }

  const ROLE_WORDS: Record<string, string> = { builders: "the builders", council: "the council", chair: "the Chair", review: "the final review" };

  // What stops these agents from running here, if anything: { message, focus, openProviders, project }, where project
  // says the message belongs with the project folder. project is the folder the session works in, resuming says the
  // session has already started, with or without one, and review says whether it has a final review.
  function checkAgents(agents: Agents, project: Project | null | undefined, resuming: boolean, review: boolean): AgentsProblem | null {
    const roles = activeRoles(review);
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i].id, a = agents[role], who = ROLE_WORDS[role];
      if (a.provider === "claude") {
        if (!INSIDE) return { message: "Claude only works when Quorum is open inside claude.ai. Choose another provider for " + who + ".", focus: providerSelects[role] };
        if (sampleState === "blocked") return { message: errInfo(S.blockedCode).msg, focus: providerSelects[role] };
        if (sampleState === "none") return { message: "Claude can't be reached from this view. Open Quorum from claude.ai to convene the council.", focus: providerSelects[role] };
        continue;
      }
      if (INSIDE) {
        return { message: PROVIDERS[a.provider].label + " only works when Quorum is open outside Claude, because pages published on Claude can't reach other services. Choose Claude for " + who + ", or open the downloaded file.", focus: providerSelects[role] };
      }
      // Claude Code, OpenRouter and other endpoints run as agents on Quorum's local server, inside the project folder.
      if (PROVIDERS[a.provider].local) {
        const label = a.provider === "custom" ? "Your endpoint" : PROVIDERS[a.provider].label;
        if (!local) return { message: label + " runs through Quorum's local server. Start it with bun start and open Quorum at the address it prints, or choose another provider for " + who + ".", focus: providerSelects[role] };
        if (a.provider === "claude-code" && !local.claudeCode.available) return { message: "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path, or choose another provider for " + who + ".", focus: providerSelects[role], openProviders: true };
        if (!project) {
          return resuming ?
            { message: "This session started without a project folder, so " + Core.midName(label).replace(/^Your/, "your") + " can't join it. Choose another provider for " + who + ", or convene again.", focus: providerSelects[role] } :
            { message: "Choose the project folder for the agents to work in.", focus: els.projectPath, project: true };
        }
        if (a.provider === "claude-code") continue;
      }
      if (!a.model) return { message: "Enter a model for " + who + ".", focus: modelFields[role] };
      if (a.provider === "openrouter" && !creds.keys.openrouter) return { message: "Add your OpenRouter API key under Providers.", focus: credFields.keys.openrouter, openProviders: true };
      if (a.provider === "hermes" && !creds.keys.hermes) return { message: "Add the Hermes Agent API key under Providers.", focus: credFields.keys.hermes, openProviders: true };
      if (a.provider === "custom" && !creds.urls.custom) return { message: "Add the address of your endpoint under Providers.", focus: credFields.urls.custom, openProviders: true };
    }
    return null;
  }

  // A problem with the agents shows beside Convene, and in Settings, where it's put right.
  function showAgentsNote(text: string) {
    [els.agentsNote, els.settingsNote].forEach(el => {
      el.textContent = text;
      el.hidden = !text;
    });
  }

  function showAgentsProblem(problem: AgentsProblem) {
    if (problem.project) {
      proj.note = problem.message;
      render();
    } else {
      showAgentsNote(problem.message);
    }
    revealProblem(problem);
  }

  // Takes the viewer to what needs changing: in Settings, the drawer opens on it.
  function revealProblem(problem: AgentsProblem) {
    if (problem.openProviders) els.providers.open = true;
    if (problem.focus && els.settingsDrawer.contains(problem.focus)) showDrawer("settings", document.activeElement as HTMLElement | null);
    if (problem.focus) problem.focus.focus();
  }
  function currentLength(): string {
    const c = lengthInputs.filter(i => i.checked)[0];
    return c && LENGTHS[c.value] ? c.value : "standard";
  }
  // The seat holding the current version of proposal L: its builder's adjustment, once that starts to arrive.
  function proposalSeatId(L: string): string {
    const a = S.seats[amendId(L)];
    return !a.skipped && (a.text || a.status === "done") ? amendId(L) : L;
  }
  function proposalsMap(): Record<string, string> {
    const o: Record<string, string> = {};
    LETTERS.forEach(L => { o[L] = S.seats[proposalSeatId(L)].text; });
    return o;
  }
  function currentTitles() {
    return Core.titlesOf(proposalsMap());
  }
  // Finished results are read from the handoffs; seats only track each agent's progress and streamed words.
  const NO_BRIEF: Brief = { feature: "", context: [], length: "standard" };
  function handedOff(id: string) {
    return S.handoffs[id] ? S.handoffs[id].data : null;
  }
  function brief(): Brief {
    return handedOff("brief") || NO_BRIEF;
  }
  // The plan the session ends with: the Chair's revision after a final review, or else its plan.
  function planHandoff(): PlanData | FinalData | null {
    return brief().review ? handedOff("final") : handedOff("chair");
  }
  function tally(): Tally | null {
    return handedOff("tally");
  }
  function decided(): string | null {
    return handedOff("chair") ? handedOff("chair").decided : null;
  }
  function ballotOf(id: string): Ballot | null {
    return handedOff(id) ? handedOff(id).ballot : null;
  }
  function winnerLetter(): string | null {
    const t = tally();
    return t ? (t.winner || decided() || null) : null;
  }
  function failedIds() {
    return ALL_IDS.filter(id => S.seats[id].status === "error");
  }

  /* ---------- The session ---------- */

  async function convene() {
    if (S.phase === "running" || S.connecting) return;
    const feature = els.feature.value.trim();
    if (!feature) {
      showFieldNote("Describe the feature first. A sentence or two is enough.");
      els.feature.focus();
      return;
    }
    showFieldNote("");
    const total = contextTotal();
    if (total > CONTEXT_LIMIT) {
      showContextNote("The context is " + fmtNum(total) + " characters, more than the " + fmtNum(CONTEXT_LIMIT) +
        " the council can read at once. Trim it or remove a piece, then convene.");
      const longest = ctxItems.slice().sort((x, y) => y.text.length - x.text.length)[0];
      if (longest) longest.textEl.focus();
      return;
    }
    showContextNote("");
    const agents = currentAgents();
    const review = els.reviewOn.checked;
    if ((usesClaude(agents, review) && !sampleFn && sampleState === "pending") || localState === "pending") {
      S.connecting = true;
      render();
      await Promise.all([usesClaude(agents, review) ? sampleReady : null, localReady]);
      S.connecting = false;
    }
    // A path typed a moment ago may not have been looked up yet.
    const typed = local ? els.projectPath.value.trim() : "";
    if (local && (proj.value !== typed || proj.pending)) {
      S.connecting = true;
      render();
      await (proj.value !== typed ? checkProject(typed) : proj.pending);
      S.connecting = false;
    }
    if (typed && !proj.info) {
      render();
      showAgentsProblem({ message: proj.error || "There's no folder at " + typed + ".", focus: els.projectPath, project: true });
      return;
    }
    const project = proj.info ? { path: proj.info.path, name: proj.info.name } : null;
    const problem = checkAgents(agents, project, false, review);
    if (problem) {
      render();
      showAgentsProblem(problem);
      return;
    }
    showAgentsNote("");
    proj.note = "";

    abortAll();
    S.token += 1;
    S.session += 1;
    const tok = S.token;
    resetSeats();
    resetConvos(false);
    S.phase = "running";
    S.handoffs = {
      brief: Graph.handoff("brief", "brief", { feature, context: contextForSession(), length: currentLength(), project, questions: els.questionsOn.checked, review }),
      revision: Graph.handoff("revision", "revision", null),
    };
    S.round = 1;
    S.past = [];
    dropUndo();
    S.agents = agents;
    S.notice = null;
    S.canRetry = false;
    S.revealed = { proposals: true, questions: false, council: false, vote: false, review: false, plan: false };
    S.sel = { proposals: "A", questions: "A", council: "advocate", review: "scaling" };
    S.clock = { startedAt: 0, accumulated: 0 };
    S.convenedAt = Date.now();
    S.name = "";
    nameUsage = null;
    saveSession();
    startClock();
    render();
    scrollToSection(els.secProposals);
    await startSaving();
    if (tok !== S.token) return;
    nameSession();
    run(tok).catch(onRunCrash);
  }

  // The Chair's agent names the session while the builders work. Naming isn't a step of the session: if no name comes
  // back, the session carries on, titled after its plan or its feature.
  async function nameSession() {
    const session = S.session, b = brief(), agent = S.agents.chair;
    const ctl = new AbortController();
    if (nameCtl) nameCtl.abort();
    nameCtl = ctl;
    const counted = { agent: { provider: agent.provider, model: agent.model }, served: "", usage: null as Usage | null, status: "running" };
    try {
      const res = await Providers.run(agent, Core.namePrompt(b), {
        sample: sampleFn,
        config: credsSnapshot(),
        cwd: b.project ? b.project.path : "",
        signal: ctl.signal,
        onTrace: (kind, d) => {
          if (session !== S.session) return;
          if (kind === "start" && typeof d.model === "string") counted.served = d.model;
          if (kind === "usage") counted.usage = d;
          nameUsage = counted;
          schedule();
        },
      });
      const name = Core.sessionName(res.text);
      if (!name || session !== S.session || ctl.signal.aborted) return;
      S.name = name;
      saveSession();
      save(id => api("PATCH", "sessions/" + id, { title: name }));
      save(() => refreshSessions());
      schedule();
    } catch (_) {
      /* the session keeps its other title */
    } finally {
      if (nameCtl === ctl) nameCtl = null;
      counted.status = "done";
      if (nameUsage === counted) schedule();
    }
  }

  // Runs the session graph on from the handoffs already made, so a retry or resume redoes only what's missing.
  async function run(tok: number) {
    const graph = Core.graphFor(brief());
    const res = await Graph.run(graph, {
      done: S.handoffs,
      work: task => work(task, tok),
      live: () => tok === S.token,
      onHandoff: h => {
        if (tok !== S.token) return;
        S.handoffs[h.from] = h;
        saveHandoff(S.round, h);
        if (S.seats[h.from]) S.seats[h.from].status = "done";
        if (h.kind === "tally") S.revealed.vote = true;
        saveSession();
        schedule();
      },
    });
    if (tok !== S.token) return;
    const failed = graph.order.filter(id => id in res.failed);
    const broken = failed.filter(id => !S.seats[id])[0];
    if (broken) throw res.failed[broken];
    if (failed.length) return settle(failed);
    S.phase = "done";
    pauseClock();
    saveSession();
    saveState();
    schedule();
  }

  function work(task: Task, tok: number) {
    const step = Core.STEPS[task.kind];
    if (!step) throw new Error("No worker handles " + task.kind + " steps.");
    if (step.compute) return step.compute(task);
    // A step with nothing to do, such as answering no questions, hands on its input without asking an agent.
    const skipped = step.skip ? step.skip(task) : null;
    if (skipped) {
      const seat = S.seats[task.node];
      Object.assign(seat, { text: skipped.text, skipped: true, agent: skipped.agent, served: skipped.served });
      return skipped;
    }
    return askAgent(task, step, tok);
  }

  function sectionOf(id: string): Section {
    return isBuilder(id) ? "proposals" : isAsk(id) || isAmend(id) ? "questions" : isCouncil(id) ? "council" : isReviewer(id) ? "review" : "plan";
  }

  // An agent step: the seat's agent writes from the task's inputs alone, and the seat shows it writing.
  async function askAgent(task: Task, step: AgentStep, tok: number) {
    const id = task.node, seat = S.seats[id];
    const ctl = new AbortController();
    seat.status = "thinking";
    seat.text = "";
    seat.error = null;
    seat.truncated = false;
    seat.ctl = ctl;
    const agent = S.agents[Core.roleOf(id) as string];
    const project: Project | null = task.inputs.brief.data.project || null;
    seat.agent = agent;
    seat.served = "";
    seat.activity = "";
    S.revealed[sectionOf(id)] = true;
    schedule();
    const live = () => tok === S.token && seat.ctl === ctl;
    let t: LiveTranscript | null = null;
    try {
      // Claude Code works inside the project folder. Hermes Agent has tools of its own and may be able to read the
      // project. The others only see the prompt.
      const kind = PROVIDERS[agent.provider];
      const prompt = step.prompt(task, { explore: !!kind.agentic, inProject: !!(kind.local && project) });
      t = startTranscript(id, agent, prompt, kind.local && project ? project.path : "");
      if (agent.provider === "claude" && Core.utf8Len(prompt) > 64000) throw { code: "prompt_too_large", message: "Prompt over the size limit." };
      const res = await Providers.run(agent, prompt, {
        sample: sampleFn,
        config: credsSnapshot(),
        cwd: project ? project.path : "",
        signal: ctl.signal,
        onText: text => {
          if (!live()) return;
          seat.status = "writing";
          seat.text = text;
          S.heard = true;
          schedule();
        },
        // An agent using its tools has stopped writing for now; what it wrote so far was a preamble.
        onActivity: (event, data) => {
          if (!live() || !/tool/i.test(event)) return;
          seat.status = "thinking";
          seat.text = "";
          seat.activity = activityOf(data);
          schedule();
        },
        onTrace: (kind, data) => { if (live()) traceInto(t as LiveTranscript, kind, data); },
      });
      if (!live()) throw { code: "cancelled", message: "Stopped." };
      seat.text = String((res && res.text) || seat.text);
      seat.truncated = !!(res && res.truncated);
      seat.served = (res && res.served) || agent.model;
      answered(t, seat.text, seat.served, seat.truncated);
      const data = Object.assign(step.result(task, seat.text), {
        truncated: seat.truncated,
        agent: { provider: agent.provider, model: agent.model },
        served: seat.served,
      });
      closeTranscript(t, null);
      return data;
    } catch (e: any) {
      if (live()) failSeat(seat, e);
      if (t) closeTranscript(t, live() ? e : { code: "cancelled", message: "Stopped.", text: e && e.text });
      throw e;
    } finally {
      if (seat.ctl === ctl) seat.ctl = null;
      schedule();
    }
  }

  function failSeat(seat: Seat, e: Thrown) {
    const code = e && typeof e.code === "string" ? e.code : "upstream_error";
    if (code === "cancelled") {
      seat.status = "stopped";
    } else {
      seat.status = "error";
      seat.error = { code: ERRORS[code] ? code : "upstream_error", message: e && typeof e.message === "string" ? e.message : "" };
      if (code === "refused") seat.text = "";
      else if (e && typeof e.text === "string") seat.text = e.text;
      if (errInfo(code).kind === "fatal" && ERRORS[code]) {
        sampleState = "blocked";
        S.blockedCode = code;
      }
    }
    if (!(e && typeof e.code === "string")) console.error(e);
  }

  // When seats couldn't finish: pause, and say why.
  function settle(failed: string[]) {
    const RANK = { fatal: 3, stop: 2, retry: 1 };
    let worst = null as string | null;
    failed.forEach(id => {
      const code = (S.seats[id].error && (S.seats[id].error as { code: string }).code) || "upstream_error";
      if (!worst || RANK[errInfo(code).kind] > RANK[errInfo(worst).kind]) worst = code;
    });
    const info = errInfo(worst as string);
    const names = Core.namesList(failed.map(stepName));
    const example = S.seats[failed.filter(id => ((S.seats[id].error && (S.seats[id].error as { code: string }).code) || "upstream_error") === worst)[0]];
    S.phase = info.kind === "fatal" ? "blocked" : "paused";
    S.notice = { text: (info.kind === "fatal" ? "" : names + " couldn't finish. ") + errText(worst as string, example), retry: info.kind === "retry" };
    S.canRetry = info.kind === "retry";
    pauseClock();
    saveSession();
    saveState();
    schedule();
  }

  function abortAll() {
    if (nameCtl) {
      nameCtl.abort();
      nameCtl = null;
    }
    ALL_IDS.forEach(id => {
      const seat = S.seats[id];
      if (seat && seat.ctl) {
        try { seat.ctl.abort(); } catch (_) { /* already settled */ }
        seat.ctl = null;
      }
    });
  }

  function stop() {
    if (S.phase !== "running") return;
    S.token += 1;
    abortAll();
    ALL_IDS.forEach(id => {
      const seat = S.seats[id];
      if (seat.status === "thinking" || seat.status === "writing") seat.status = "stopped";
    });
    S.phase = "stopped";
    S.notice = null;
    S.stoppedAt = Date.now();
    pauseClock();
    saveSession();
    saveState();
    const hadFocus = document.activeElement === els.convene || document.activeElement === els.railStop;
    render();
    if (hadFocus && !els.resume.hidden) els.resume.focus();
  }

  function resume() {
    if (!(S.phase === "stopped" || (S.phase === "paused" && S.canRetry))) return;
    // Settings changed while paused (a key added, another model picked) apply to the seats that run again.
    const agents = currentAgents();
    const problem = checkAgents(agents, brief().project, true, !!brief().review);
    if (problem) {
      showAgentsProblem(problem);
      return;
    }
    showAgentsNote("");
    S.agents = agents;
    S.token += 1;
    const tok = S.token;
    ALL_IDS.forEach(id => {
      const seat = S.seats[id];
      if (seat.status === "error" || seat.status === "stopped") {
        seat.status = "idle";
        seat.error = null;
        seat.text = "";
        seat.truncated = false;
      }
    });
    S.notice = null;
    S.canRetry = false;
    S.phase = "running";
    S.convenedAt = Date.now();
    startClock();
    saveSession();
    saveState();
    const hadFocus = document.activeElement === els.resume || document.activeElement === els.noticeRetry;
    render();
    if (hadFocus) els.convene.focus();
    // A session stopped before it was named is named now.
    if (!S.name) nameSession();
    run(tok).catch(onRunCrash);
  }

  function onRunCrash(err: unknown) {
    console.error(err);
    S.token += 1;
    abortAll();
    ALL_IDS.forEach(id => {
      const seat = S.seats[id];
      if (seat.status === "thinking" || seat.status === "writing") {
        seat.status = "error";
        seat.error = { code: "upstream_error" };
      }
    });
    S.phase = "paused";
    S.notice = { text: "Something went wrong on this page. Retry to continue where the council left off.", retry: true };
    S.canRetry = true;
    pauseClock();
    saveSession();
    saveState();
    schedule();
  }

  /* ---------- Keeping the session ---------- */

  // The last session is kept in this browser, so a reload brings it back and an unfinished one can be resumed. Only
  // the brief and what each agent wrote are kept. The handoffs are rebuilt from those by the same steps that made
  // them, so an answer that comes back is checked the way a fresh one is, and a step whose answer no longer reads
  // simply runs again.
  const SESSION_KEY = "quorum:session";

  function saveSession() {
    const b = handedOff("brief");
    if (!b) return;
    const seats: Record<string, { text: string, truncated: boolean, agent: Agent | null, served: string }> = {};
    ALL_IDS.forEach(id => {
      const d = handedOff(id);
      if (d) seats[id] = { text: d.text, truncated: d.truncated, agent: d.agent, served: d.served };
    });
    store.set(SESSION_KEY, JSON.stringify({ v: 1, brief: b, revision: handedOff("revision"), name: S.name, agents: S.agents, elapsed: elapsed(), seats }));
  }

  function agentFrom(a: any): Agent | null {
    return a && typeof a === "object" && PROVIDERS[a.provider] && typeof a.model === "string" ? { provider: a.provider, model: a.model } : null;
  }

  function restoreSession(): boolean {
    let saved = null;
    try { saved = JSON.parse(store.get(SESSION_KEY) || "null"); } catch (_) { saved = null; }
    const b = saved && saved.v === 1 && saved.brief;
    if (!b || typeof b.feature !== "string" || !b.feature.trim()) return false;
    const seats = saved.seats && typeof saved.seats === "object" ? saved.seats : {};
    const project = b.project && typeof b.project.path === "string" ? { path: b.project.path, name: String(b.project.name || "") } : null;
    const rev = saved.revision && typeof saved.revision === "object" && Number.isInteger(saved.revision.round) ? saved.revision : null;
    const handoffs: Handoffs = {
      brief: Graph.handoff("brief", "brief", {
        feature: b.feature,
        context: (Array.isArray(b.context) ? b.context : [])
          .filter((c: any) => c && typeof c.text === "string")
          .map((c: any) => ({ title: typeof c.title === "string" ? c.title : "", text: c.text })),
        length: LENGTHS[b.length] ? b.length : "standard",
        project, questions: !!b.questions, review: !!b.review,
      }),
      revision: Graph.handoff("revision", "revision", rev),
    };
    // A step comes back only if everything it needs came back too.
    const graph = Core.graphFor(handoffs.brief.data);
    graph.order.forEach(id => {
      const node = graph.nodes[id], step = Core.STEPS[node.kind], s = seats[id];
      if (handoffs[id] || !step || !node.needs.every(d => handoffs[d])) return;
      const inputs: Handoffs = {};
      node.needs.forEach(d => { inputs[d] = handoffs[d]; });
      const task: Task = { node: id, kind: node.kind, inputs };
      try {
        if (step.compute) {
          handoffs[id] = Graph.handoff(id, node.kind, step.compute(task));
        } else if (s && typeof s.text === "string" && s.text.trim()) {
          handoffs[id] = Graph.handoff(id, node.kind, Object.assign(step.result(task, s.text), {
            truncated: !!s.truncated,
            agent: agentFrom(s.agent),
            served: typeof s.served === "string" ? s.served : "",
          }));
        }
      } catch (_) { /* this step runs again on resume */ }
    });
    S.handoffs = handoffs;
    S.session += 1;
    S.round = rev ? rev.round : 1;
    S.past = [];
    S.agents = Core.normalizeAgents(saved.agents, INSIDE);
    S.name = typeof saved.name === "string" ? Core.sessionName(saved.name) : "";
    resetSeats();
    resetConvos(false);
    ALL_IDS.forEach(id => {
      const h = handoffs[id], d = h ? h.data : null;
      if (d) Object.assign(S.seats[id], { status: "done", text: d.text, truncated: d.truncated, agent: d.agent, served: d.served, skipped: h.kind === "amend" && !d.amended });
    });
    // Seats that hadn't finished when the page closed read as stopped, so Resume asks them again.
    const ready = Graph.ready(graph, handoffs);
    ready.forEach(id => { if (S.seats[id]) S.seats[id].status = "stopped"; });
    S.phase = graph.order.every(id => handoffs[id]) ? "done" : "stopped";
    S.revealed = {
      proposals: true,
      questions: ASK_IDS.some(id => handoffs[id] || ready.indexOf(id) >= 0),
      council: graph.nodes.advocate.needs.every(n => handoffs[n]),
      vote: !!handoffs.tally,
      review: !!(handoffs.brief.data.review && handoffs.chair),
      plan: !!handoffs.tally,
    };
    const ms = Number(saved.elapsed);
    S.clock = { startedAt: 0, accumulated: Number.isFinite(ms) && ms > 0 ? ms : 0 };
    return true;
  }

  // When the viewer's plan lacks a chosen tier, the platform answers with a cheaper one. Say so.
  function substituted(seat: Seat): boolean {
    return !!(seat.agent && seat.agent.provider === "claude" && TIERS[seat.served] && seat.served !== seat.agent.model);
  }

  function tierNoteText(): string {
    const subs: { who: string, asked: string, got: string }[] = [];
    ROLES.forEach(r => {
      const seat = r.seats.map(id => S.seats[id]).filter(substituted)[0];
      if (seat) subs.push({ who: ROLE_WORDS[r.id], asked: (seat.agent as Agent).model, got: seat.served });
    });
    if (!subs.length) return "";
    const same = subs.every(x => x.asked === subs[0].asked && x.got === subs[0].got);
    if (same) {
      return TIERS[subs[0].asked].label + " isn't available on your plan, so " + Core.listAnd(subs.map(x => x.who)) +
        " answered on " + TIERS[subs[0].got].label + ".";
    }
    return "Your plan doesn't include every model you chose: " +
      Core.listAnd(subs.map(x => x.who + " answered on " + TIERS[x.got].label + " instead of " + TIERS[x.asked].label)) + ".";
  }

  function settingsHint(agents: Agents): string {
    const list = activeRoles(els.reviewOn.checked).map(r => agents[r.id]);
    const hints: string[] = [];
    const claude = list.filter(a => a.provider === "claude").map(a => a.model);
    if (claude.indexOf("complex") >= 0) hints.push("Frontier is Claude's most capable model and thinks longest, so its seats can take a few minutes.");
    else if (claude.length && claude.every(t => t === "quick")) hints.push("Fast is Claude's quickest, cheapest model.");
    const explorers = ["claude-code", "openrouter", "custom"].filter(p => list.some(a => a.provider === p));
    if (explorers.length) {
      hints.push("Agents on " + Core.listAnd(explorers.map(p => (p === "custom" ? "your endpoint" : PROVIDERS[p].label))) +
        " explore the project before they write, so their seats can take a few minutes.");
    }
    if (list.some(a => a.provider === "openrouter")) hints.push("OpenRouter bills your account for each request, and an agent makes several as it explores.");
    if (list.some(a => a.provider === "hermes")) hints.push("Hermes Agent may use its tools first, so its seats can take longer.");
    if (els.questionsOn.checked) hints.push("The council's questions add up to twelve requests: each councilor's questions on each proposal, and each builder's answers.");
    if (els.reviewOn.checked) hints.push("The final review adds three requests: two reviews and the Chair's revision.");
    return hints.join(" ") || "Each role can run on a different provider and model.";
  }

  /* ---------- Providers and agent pickers ---------- */

  // Keys live in memory, and in this browser's storage only when "Remember" is ticked.
  const creds: { keys: Record<string, string>, urls: Record<string, string>, remember: Record<string, boolean> } =
    { keys: { openrouter: "", hermes: "", custom: "" }, urls: { hermes: "", custom: "" }, remember: { openrouter: false, hermes: false, custom: false } };
  const lastModel: Record<string, Record<string, string>> = {};
  ROLES.forEach(r => { lastModel[r.id] = {}; });
  const modelLists: Record<string, ModelChoice[]> = { openrouter: Core.OPENROUTER_PRESETS.slice(), hermes: [], custom: [] };

  function credsSnapshot(): ProviderConfig {
    return {
      keys: Object.assign({}, creds.keys),
      urls: { hermes: creds.urls.hermes || PROVIDERS.hermes.defaultUrl as string, custom: creds.urls.custom },
      local: local ? location.origin : "",
    };
  }

  function saveCreds() {
    store.set("quorum:providers", JSON.stringify({ urls: creds.urls, remember: creds.remember }));
    EXTERNAL.forEach(p => {
      if (creds.remember[p] && creds.keys[p]) store.set("quorum:key:" + p, creds.keys[p]);
      else store.remove("quorum:key:" + p);
    });
  }

  function loadCreds() {
    let saved = null;
    try { saved = JSON.parse(store.get("quorum:providers") || "null"); } catch (_) { saved = null; }
    if (saved && typeof saved === "object") {
      ["hermes", "custom"].forEach(p => { if (saved.urls && typeof saved.urls[p] === "string") creds.urls[p] = saved.urls[p]; });
      EXTERNAL.forEach(p => { creds.remember[p] = !!(saved.remember && saved.remember[p]); });
    }
    EXTERNAL.forEach(p => { if (creds.remember[p]) creds.keys[p] = store.get("quorum:key:" + p) || ""; });
    EXTERNAL.forEach(p => {
      credFields.keys[p].value = creds.keys[p];
      credFields.remember[p].checked = creds.remember[p];
    });
    credFields.urls.hermes.value = creds.urls.hermes;
    credFields.urls.custom.value = creds.urls.custom;
  }

  function saveAgents() {
    store.set("quorum:agents", JSON.stringify(currentAgents()));
  }

  function fillDatalist(id: string, list: ModelChoice[]) {
    const dl = $(id);
    while (dl.firstChild) dl.removeChild(dl.firstChild);
    list.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      if (m.name) opt.label = m.name;
      dl.appendChild(opt);
    });
  }

  function modelPlaceholder(provider: string): string {
    return provider === "openrouter" ? "nousresearch/hermes-4-70b" : provider === "hermes" ? "hermes-agent" :
      provider === "claude-code" ? "Claude Code's default model" : "Model name";
  }

  // Show the tier picker for Claude and a model field for everything else.
  function syncAgentRow(role: string) {
    const provider = providerSelects[role].value;
    const claude = provider === "claude";
    tierSelects[role].hidden = !claude;
    modelFields[role].hidden = claude;
    modelFields[role].placeholder = modelPlaceholder(provider);
    if (claude) modelFields[role].removeAttribute("list");
    else modelFields[role].setAttribute("list", "models-" + provider);
  }

  function applyAgents(agents: Agents) {
    ROLES.forEach(r => {
      const a = agents[r.id];
      providerSelects[r.id].value = a.provider;
      if (a.provider === "claude") tierSelects[r.id].value = a.model;
      else modelFields[r.id].value = a.model;
      lastModel[r.id][a.provider] = a.model;
      syncAgentRow(r.id);
    });
  }

  function onProviderChange(role: string) {
    const provider = providerSelects[role].value;
    const remembered = lastModel[role][provider];
    const model = remembered != null ? remembered : Core.defaultModel(provider, role);
    if (provider === "claude") tierSelects[role].value = Core.TIERS[model] ? model : Core.defaultModel("claude", role);
    else modelFields[role].value = model;
    syncAgentRow(role);
    showAgentsNote("");
    saveAgents();
    render();
  }

  function setProviderOptions() {
    ROLES.forEach(r => {
      Array.prototype.forEach.call(providerSelects[r.id].options, (opt: HTMLOptionElement) => {
        let usable = Core.usableHere(opt.value, INSIDE);
        let why = INSIDE ? " (outside Claude only)" : " (inside claude.ai only)";
        // Agents on the local server need it running, and Claude Code needs to be installed too.
        if (usable && PROVIDERS[opt.value].local && localState !== "pending") {
          if (!local) {
            usable = false;
            why = " (needs bun start)";
          } else if (opt.value === "claude-code" && !local.claudeCode.available) {
            usable = false;
            why = " (not installed)";
          }
        }
        opt.disabled = !usable;
        const base = PROVIDERS[opt.value].label;
        opt.textContent = usable ? base : base + why;
      });
    });
    EXTERNAL.forEach(p => { providerSets[p].disabled = INSIDE; });
    $<HTMLFieldSetElement>("set-claude-code").disabled = INSIDE;
  }

  function writeHermesHelp() {
    const el = els.helpHermes;
    while (el.firstChild) el.removeChild(el.firstChild);
    const origin = pageOrigin();
    const add = (text: string, code?: boolean) => {
      const node = code ? document.createElement("code") : document.createTextNode(text);
      if (code) node.textContent = text;
      el.appendChild(node);
    };
    add("Hermes Agent runs on your computer. In ");
    add("~/.hermes/.env", true);
    add(", set ");
    add("API_SERVER_ENABLED=true", true);
    add(", an ");
    add("API_SERVER_KEY", true);
    add(" and ");
    if (origin) {
      add("API_SERVER_CORS_ORIGINS=" + origin, true);
      add(", then run ");
    } else {
      add("API_SERVER_CORS_ORIGINS", true);
      add(" set to this page's address. Browsers don't send an address from a file, so serve Quorum locally first, for example with ");
      add("python3 -m http.server 8000", true);
      add(" in its folder, and open it at ");
      add("http://localhost:8000", true);
      add(". Then run ");
    }
    add("hermes gateway", true);
    add(". Hermes answers with the model it's configured to use, and if it can read your project's files, the agents may check their proposals against the code.");
  }

  function writeProvidersIntro() {
    els.providersIntro.textContent = INSIDE ?
      "Quorum is open inside Claude, so every agent runs on Claude. Pages published on Claude can't reach other services. To use Claude Code, OpenRouter or another endpoint, run Quorum on your computer with bun start. To use Hermes Agent, open Quorum on its own." :
      "Keys stay in this browser and are sent only to the service they belong to, through Quorum's server on this computer for OpenRouter and other endpoints. Leave Remember off on a shared computer.";
  }

  function providerReady(p: string): boolean {
    if (p === "claude-code") return !!(local && local.claudeCode.available);
    if (p === "openrouter") return !!creds.keys.openrouter;
    if (p === "hermes") return !!creds.keys.hermes;
    return !!creds.urls.custom;
  }

  function renderProvidersStatus() {
    let text;
    if (INSIDE) {
      text = "Every agent runs on Claude here";
    } else {
      const used = ["claude-code"].concat(EXTERNAL).filter(p => activeRoles(reviewing()).some(r => providerSelects[r.id].value === p));
      text = used.length ? Core.listAnd(used.map(p => PROVIDERS[p].label + (providerReady(p) ? " is set up" : " needs setting up"))) : "";
      if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
    }
    setText(els.providersStatus, text);
    // Settings says when a provider the agents use still needs setting up.
    const needs = !INSIDE && ["claude-code"].concat(EXTERNAL).some(p => activeRoles(reviewing()).some(r => providerSelects[r.id].value === p) && !providerReady(p));
    toggle(els.settingsBadge, needs);
    renderClaudeCodeStatus();
  }

  function renderClaudeCodeStatus() {
    let text = "", ok = false;
    if (INSIDE) text = "Claude Code works when Quorum runs on your computer.";
    else if (localState === "pending") text = "Looking for Quorum's local server\u2026";
    else if (!local) text = "Claude Code works when Quorum runs on your computer: run bun start in Quorum's folder, then open the address it prints.";
    else if (local.claudeCode.available) { text = "Claude Code " + local.claudeCode.version + " is installed."; ok = true; }
    else text = "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path.";
    setText(els.statusClaudeCode, text);
    els.statusClaudeCode.classList.toggle("is-ok", ok);
  }

  async function checkConnection(p: string) {
    const status = $("status-" + p);
    status.className = "provider-status";
    status.textContent = "Checking…";
    try {
      const list = await Providers.listModels(p, credsSnapshot());
      modelLists[p] = list;
      fillDatalist("models-" + p, list);
      status.classList.add("is-ok");
      const names = list.slice(0, 3).map(m => m.id);
      status.textContent = "Connected." + (names.length ? " It offers " + Core.listAnd(names.map(n => "\u201C" + n + "\u201D")) + (list.length > 3 ? " and more." : ".") : "");
    } catch (e: any) {
      status.classList.add("is-error");
      const code = e && e.code;
      const label = p === "hermes" ? "Hermes Agent" : "the endpoint";
      status.textContent = code === "auth_failed" ? "Connected, but " + label + " rejected the API key." :
        code === "unreachable" ? "Couldn't reach " + label + ". " + unreachableHint(p) :
          code === "not_found" ? "Reached the server, but it answered \u201Cnot found\u201D. Check that the address ends in /v1." :
            "That didn't work" + (e && e.message ? ": " + String(e.message).slice(0, 160) : ".");
    }
  }

  // What an agent is doing with a tool, as a phrase: "reading src/app.js", or "working with read_file".
  function activityOf(data: string): string {
    let o = null;
    try { o = JSON.parse(data); } catch (_) { o = null; }
    const name = o && (o.tool || o.name || o.tool_name || (o.function && o.function.name));
    const tool = typeof name === "string" && name ? name.slice(0, 40) : "";
    const detail = o && typeof o.detail === "string" ? o.detail.slice(0, 120) : "";
    if (detail && tool === "Read") return "reading " + detail;
    if (detail && tool === "Grep") return "searching the code for \u201C" + detail + "\u201D";
    if (detail && tool === "Glob") return "looking for " + detail;
    return "working with " + (tool || "its tools");
  }

  /* ---------- Clock ---------- */

  function startClock() {
    S.clock.startedAt = Date.now();
    clearInterval(clockTimer);
    clockTimer = setInterval(renderClock, 1000);
  }
  function pauseClock() {
    if (S.clock.startedAt) {
      S.clock.accumulated += Date.now() - S.clock.startedAt;
      S.clock.startedAt = 0;
    }
    clearInterval(clockTimer);
    clockTimer = 0;
  }
  function elapsed() {
    return S.clock.accumulated + (S.clock.startedAt ? Date.now() - S.clock.startedAt : 0);
  }
  function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n: number) => (n < 10 ? "0" : "") + n;
    return h ? h + ":" + pad(m) + ":" + pad(sec) : m + ":" + pad(sec);
  }
  function renderClock() {
    const ms = elapsed();
    let t = "";
    if (S.phase === "running") t = "In session " + fmtDuration(ms);
    else if (S.phase === "done") t = "Adjourned after " + fmtDuration(ms);
    else if (S.phase === "stopped") t = "Stopped at " + fmtDuration(ms);
    else if (S.phase !== "idle" && ms > 0) t = "Paused at " + fmtDuration(ms);
    if (t && S.round > 1) t = "Round " + S.round + " \u00B7 " + t;
    setText(els.clock, t);
  }

  /* ---------- Rendering ---------- */

  let frame: unknown = 0;
  function schedule() {
    if (frame) return;
    const raf: (fn: () => void) => unknown = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : fn => setTimeout(fn, 16);
    frame = raf(() => { frame = 0; render(); }) || 1;
  }

  function setText(el: Element | null, text: string) {
    if ((el as Element).textContent !== text) (el as Element).textContent = text;
  }
  function setHTML(target: Element, html: string): boolean {
    const el = target as Element & Drawn;
    if (el._html === html) return false;
    el.innerHTML = html;
    el._html = html;
    return true;
  }
  function toggle(el: HTMLElement, on: boolean | string | null | undefined) {
    if (el.hidden === !!on) el.hidden = !on;
  }
  function setLetter(el: Element, letter: string | null | undefined) {
    if (letter) {
      if (el.getAttribute("data-letter") !== letter) el.setAttribute("data-letter", letter);
    } else if (el.hasAttribute("data-letter")) {
      el.removeAttribute("data-letter");
    }
  }

  function render() {
    renderControls();
    renderSeats();
    renderRail();
    renderSections();
    renderProposals();
    renderQuestions();
    renderCouncil();
    renderVote();
    renderReview();
    renderPlan();
    renderRevise();
    renderRounds();
    renderNotice();
    renderConvo();
  }

  function renderControls() {
    const running = S.phase === "running";
    const label = S.connecting ? "Connecting…" : running ? "Stop" : S.phase === "idle" ? "Convene the council" : "Convene again";
    setText(els.convene, label);
    els.convene.classList.toggle("is-stop", running);
    els.convene.disabled = S.connecting;
    const canResume = S.phase === "stopped" || (S.phase === "paused" && S.canRetry);
    toggle(els.resume, canResume);
    setText(els.resume, S.phase === "paused" ? "Retry" : "Resume");
    lengthInputs.forEach(i => { i.disabled = running; });
    els.reviewOn.disabled = running;
    els.questionsOn.disabled = running;
    // The review agent can be set while a session with a final review is under way, for Resume and new rounds.
    toggle(els.rowReview, els.reviewOn.checked || (S.phase !== "idle" && !!brief().review));
    ROLES.forEach(r => {
      providerSelects[r.id].disabled = running;
      tierSelects[r.id].disabled = running;
      modelFields[r.id].disabled = running;
    });
    exampleBtns.forEach(b => { b.setAttribute("aria-disabled", running ? "true" : "false"); });
    els.feature.readOnly = running;
    ctxItems.forEach(it => {
      it.titleEl.readOnly = running;
      it.textEl.readOnly = running;
      it.removeEl.disabled = running;
    });
    addBtns.forEach(b => { b.disabled = running; });
    setText(els.settingsHint, settingsHint(currentAgents()));
    setText(els.agentsSummary, agentsSummary());
    const tierNote = tierNoteText();
    toggle(els.tierNote, !!tierNote);
    setText(els.tierNote, tierNote);
    renderProvidersStatus();
    renderProject();
    renderSessions();
  }

  function seatAvailable(id: string): boolean {
    return isBuilder(id) ? S.revealed.proposals : isCouncil(id) ? S.revealed.council : S.revealed.plan;
  }

  // The state a seat in the seating chart shows. The Chair's seat shows its revision after the final review once that
  // has started.
  // A builder's seat shows its answers to the council once it's answering, and a councilor's seat shows its questions
  // until it starts its review.
  function seatShown(id: string): { status: SeatStatus } {
    if (id === "chair") return S.seats.final.status !== "idle" ? S.seats.final : S.seats.chair;
    if (isBuilder(id)) {
      const a = S.seats[amendId(id)];
      return a.status !== "idle" && !a.skipped ? a : S.seats[id];
    }
    if (isCouncil(id) && S.seats[id].status === "idle") {
      const asks = LETTERS.map(L => S.seats[askId(id, L)].status);
      const status = (["error", "writing", "thinking", "stopped"] as const).filter(x => asks.indexOf(x) >= 0)[0] || "idle";
      return { status };
    }
    return S.seats[id];
  }

  function seatPhrase(id: string): string {
    const s = seatShown(id);
    switch (s.status) {
      case "thinking": return "thinking";
      case "writing": return "writing";
      case "done": return isCouncil(id) ? "ranked " + (ballotOf(id) as Ballot).ranking[0] + " first" : isBuilder(id) ? "proposal ready" : "plan written";
      case "error": return "couldn't finish";
      case "stopped": return "stopped";
      default: return "waiting";
    }
  }

  const prevSeat: Record<string, SeatStatus> = {};
  const popping: Record<string, boolean> = {};
  function renderSeats() {
    const w = winnerLetter();
    SEAT_IDS.forEach(id => {
      const g = seatEls[id], s = seatShown(id), st = s.status;
      let letter = "", glyph = "";
      if (isBuilder(id)) {
        letter = id;
        glyph = id;
      } else if (isCouncil(id)) {
        const b = ballotOf(id);
        if (b) { letter = b.ranking[0]; glyph = letter; }
      } else if (w && (st === "writing" || st === "done")) {
        letter = w;
        if (st === "done") glyph = w;
      }
      if (st === "error") glyph = "!";
      if (prevSeat[id] !== undefined && prevSeat[id] !== "done" && st === "done" && !reduceMotion.matches) {
        popping[id] = true;
        setTimeout(() => { popping[id] = false; schedule(); }, 650);
      }
      prevSeat[id] = st;
      const working = st === "thinking" || st === "writing";
      const cls = "seat is-" + st + (working ? " is-working" : "") + (popping[id] ? " pop" : "");
      if (g.getAttribute("class") !== cls) g.setAttribute("class", cls);
      setLetter(g, letter);
      const glyphEl = g.querySelector(".seat-glyph") as Element;
      if (glyphEl.textContent !== glyph) glyphEl.textContent = glyph;
      const avail = seatAvailable(id);
      g.setAttribute("tabindex", avail ? "0" : "-1");
      g.setAttribute("aria-disabled", avail ? "false" : "true");
      g.setAttribute("aria-label", CAST[id].name + (isBuilder(id) ? ", proposal " + id : "") + ", " + seatPhrase(id));
    });
  }

  function stageState(ids: string[]): string {
    const st = ids.map(id => S.seats[id].status);
    if (st.every(s => s === "done")) return "done";
    if (st.some(s => s === "thinking" || s === "writing")) return "active";
    if (st.some(s => s === "error")) return "paused";
    if (st.some(s => s === "stopped")) return "stopped";
    return S.phase === "running" ? "active" : "waiting";
  }

  function statusLine(): string {
    const w = winnerLetter();
    switch (S.phase) {
      case "idle":
        return "The chamber is empty. Put a feature before the council to begin.";
      case "blocked":
        return "The council can't meet in this view.";
      case "stopped":
        return "Stopped. Resume to continue where the council left off.";
      case "paused": {
        const f = failedIds();
        return "Paused. " + (f.length ? Core.namesList(f.map(stepName)) + " couldn't finish." : "");
      }
      case "done":
        return "The council has adjourned. Proposal " + w + " carried, and the " + (S.round > 1 ? "revised " : "") + "plan is ready.";
      default: {
        const nb = LETTERS.filter(L => S.seats[L].status === "done").length;
        if (nb < 3 && S.round > 1) {
          return nb === 0 ? "The builders are revising their proposals with your input." : "The builders are revising. " + nb + " of 3 proposals are in.";
        }
        if (nb < 3) {
          if (!S.heard && nb === 0 && S.agents.builders.provider === "claude" && LETTERS.every(L => S.seats[L].status === "thinking")) {
            return "Waiting for Claude. If you're asked to allow this page to use Claude, allow it to begin.";
          }
          if (nb === 0) {
            return PROVIDERS[S.agents.builders.provider].local ? "The builders are exploring the project and drafting their proposals." : "The builders are drafting their proposals.";
          }
          return "The builders are drafting. " + nb + " of 3 proposals are in.";
        }
        const settled = AMEND_IDS.filter(id => S.seats[id].status === "done").length;
        if (brief().questions && settled < 3) {
          return "The council is questioning the proposals, and the builders are answering." + (settled ? " " + settled + " of 3 proposals are settled." : "");
        }
        const nc = COUNCIL_IDS.filter(id => S.seats[id].status === "done").length;
        if (nc < 3) return nc === 0 ? "The council is reviewing the " + (S.round > 1 ? "revised " : "") + "proposals." : "The council is reviewing. " + nc + " of 3 ballots are cast.";
        if (brief().review && S.seats.chair.status === "done") {
          const nr = REVIEWER_IDS.filter(id => S.seats[id].status === "done").length;
          if (nr < REVIEWER_IDS.length) return "The reviewers are checking the plan for scaling and security." + (nr ? " " + nr + " of 2 reviews are in." : "");
          return "The Chair is revising the plan after the final review.";
        }
        if (!w) return "The vote is tied. The Chair is casting the deciding vote and writing the plan.";
        return "Proposal " + w + " carried the vote. The Chair is writing the plan.";
      }
    }
  }

  function renderRail() {
    setText(els.status, statusLine());
    const states: Record<string, string> = {
      proposals: S.revealed.proposals ? stageState(LETTERS) : "waiting",
      questions: S.revealed.questions ? stageState(ASK_IDS.concat(AMEND_IDS)) : "waiting",
      council: S.revealed.council ? stageState(COUNCIL_IDS) : "waiting",
      vote: tally() ? ((tally() as Tally).decidedBy === "chair" && !decided() ? "tied" : "done") : "waiting",
      review: S.revealed.review ? stageState(REVIEWER_IDS) : "waiting",
      plan: S.revealed.plan ? stageState(reviewing() ? ["chair", "final"] : ["chair"]) : "waiting",
    };
    // The stages a session has, numbered in order in the rail and in each section's heading.
    const review = reviewing(), questions = questioning();
    toggle(els.stageReview, review);
    toggle(els.stageQuestions, questions);
    const order = ["proposals", questions && "questions", "council", "vote", review && "review", "plan"].filter(Boolean);
    stageBtns.forEach(btn => {
      const n = String(order.indexOf(btn.getAttribute("data-stage") as string) + 1);
      setText(btn.querySelector(".stage-n"), n);
      setText($(btn.getAttribute("data-target") as string).querySelector(".sec-num"), n);
    });
    stageBtns.forEach(btn => {
      const key = btn.getAttribute("data-stage") as Section;
      const st = states[key];
      if (btn.getAttribute("data-state") !== st) btn.setAttribute("data-state", st);
      setText(btn.querySelector(".stage-state"), STAGE_WORDS[st]);
      btn.setAttribute("aria-disabled", S.revealed[key] ? "false" : "true");
      btn.tabIndex = S.revealed[key] ? 0 : -1;
    });
    toggle(els.railStop, S.phase === "running");
    toggle(els.railConvo, S.phase !== "idle" && convoSteps().length > 0);
    renderUsage();
    renderClock();
    renderSaveState();
  }

  function renderSections() {
    toggle(els.roster, !S.revealed.proposals);
    toggle(els.secProposals, S.revealed.proposals);
    toggle(els.secCouncil, S.revealed.council);
    toggle(els.secVote, S.revealed.vote);
    toggle(els.secReview, S.revealed.review);
    toggle(els.secQuestions, S.revealed.questions);
    toggle(els.secPlan, S.revealed.plan);
    setText(els.motionQuote, brief().feature);
    const named = S.phase !== "idle" && !!S.name;
    toggle(els.sessionName, named);
    setText(els.sessionName, named ? S.name : "");
    const title = named ? S.name + " \u00B7 Quorum" : "Quorum";
    if (document.title !== title) document.title = title;
    const input = roundInput(S.handoffs);
    toggle(els.motionRound, !!input);
    setText(els.motionRoundIntro, input ? "Round " + S.round + " revises the round " + (S.round - 1) + " plan with your input:" : "");
    setText(els.motionRoundQuote, input);
    const pr = brief().project;
    toggle(els.motionProject, !!pr);
    setHTML(els.motionProject, pr ? "In the project <code>" + Core.esc(pr.path) + "</code>" : "");
    const contextBody = els.motionContextBody as HTMLElement & Drawn;
    if (contextBody._session !== S.session) {
      contextBody._session = S.session;
      const blocks = Core.contextBlocks(brief().context);
      toggle(els.motionContext, blocks.length > 0);
      els.motionContext.open = false;
      setText(els.motionContextSummary, blocks.length ?
        "With " + (blocks.length === 1 ? "one piece" : blocks.length + " pieces") + " of context: " + Core.listAnd(blocks.map(b => b.title)) : "");
      setHTML(els.motionContextBody, blocks.map(b => "<h3>" + Core.esc(b.title) + "</h3><pre>" + Core.esc(b.text) + "</pre>").join(""));
    }
  }

  function statusTitle(id: string): string {
    switch (S.seats[id].status) {
      case "thinking": return "Thinking…";
      case "writing": return "Writing…";
      case "error": return "Couldn't finish";
      case "stopped": return "Stopped";
      case "done": return "Untitled";
      default: return "Waiting";
    }
  }

  function waitCopy(agent: Agent | null): string {
    if (!agent || agent.provider !== "claude") {
      return agent && agent.provider === "hermes" ? "Hermes Agent may use its tools first, so writing can take a few minutes to start." :
        agent && PROVIDERS[agent.provider].local ? "It explores the project first, so writing can take a few minutes to start." :
          "Writing usually starts within a minute.";
    }
    return agent.model === "quick" ? "Writing usually starts within a few seconds." :
      agent.model === "complex" ? "Frontier models think first, so writing can take a couple of minutes to start." :
        "Writing usually starts within a minute.";
  }

  // The agent a seat ran on, or will run on: what answered if known, else what was asked for.
  function agentFor(id: string): Agent {
    const s = S.seats[id];
    const asked = s.agent || S.agents[Core.roleOf(id) as string];
    if (!s.served) return asked;
    return { provider: asked.provider, model: s.served };
  }

  function agentText(id: string): string {
    return Core.agentLabel(agentFor(id), { customUrl: creds.urls.custom });
  }

  // The small chip beside each byline naming the agent that answered.
  function renderTier(el: HTMLElement, id: string) {
    const s = S.seats[id];
    const sub = substituted(s);
    const label = agentText(id);
    const html = label ? '<span class="visually-hidden">Agent: </span>' + Core.esc(label) +
      (sub ? '<span class="visually-hidden">, because ' + TIERS[(s.agent as Agent).model].label + " isn't available on your plan</span>" : "") : "";
    setHTML(el, html);
    toggle(el, !!html);
    el.classList.toggle("is-sub", sub);
    const full = agentFor(id);
    if (sub) el.title = TIERS[(s.agent as Agent).model].label + " isn't available on your plan";
    else if (full.provider !== "claude") el.title = PROVIDERS[full.provider].label + (full.model ? ": " + full.model : "");
    else el.removeAttribute("title");
  }

  function placeholderFor(id: string): { pulse: boolean, text: string } {
    const s = S.seats[id], name = CAST[id].name;
    if (s.status === "thinking") {
      if (s.activity) return { pulse: true, text: name + " is " + s.activity + "." };
      const claudeFirst = !S.heard && s.agent && s.agent.provider === "claude";
      return { pulse: true, text: claudeFirst ? "Waiting for Claude. If you're asked to allow this page to use Claude, allow it to begin." : name + " is thinking. " + waitCopy(s.agent) };
    }
    if (s.status === "writing") return { pulse: true, text: name + " is writing." };
    if (s.status === "error") {
      return { pulse: false, text: isBuilder(id) || isAmend(id) ? "This proposal couldn't be finished." : isAsk(id) ? "These questions couldn't be finished." : isCouncil(id) || isReviewer(id) ? "This review couldn't be finished." : "The plan couldn't be finished." };
    }
    if (s.status === "stopped") return { pulse: false, text: "Stopped before any words were written." };
    if (s.status === "done") return { pulse: false, text: "" };
    return { pulse: false, text: waitingText(id) };
  }

  function waitingText(id: string): string {
    if (isBuilder(id)) return "Waiting to begin.";
    if (isAsk(id)) return "Waiting for Proposal " + Core.stepOf(id).letter + ".";
    if (isAmend(id)) return "The builder answers once the council has asked its questions.";
    if (isCouncil(id)) return "The council meets once all three proposals are " + (brief().questions ? "settled." : "in.");
    if (isReviewer(id)) return "The reviewers start once the Chair has written the plan.";
    return id === "final" ? "The Chair revises the plan once the reviewers are done." : "The Chair writes once the votes are counted.";
  }

  function noteFor(id: string): { text: string, error: boolean } | null {
    const s = S.seats[id];
    if (s.status === "error") return { text: errText(s.error ? s.error.code : "", s, "short"), error: true };
    if (s.status === "stopped") {
      return { text: s.text ? "Stopped part-way. Resuming asks for this again from the start." : "Resuming asks for this again.", error: false };
    }
    if (s.status === "done" && s.truncated) return { text: "This hit the length limit and stops mid-thought.", error: false };
    return null;
  }

  function renderNote(el: HTMLElement, note: { text: string, error?: boolean } | null) {
    toggle(el, !!note);
    if (!note) return;
    setText(el, note.text);
    el.classList.toggle("is-error", !!note.error);
  }

  function renderDoc(target: HTMLElement, id: string, text: string, status: SeatStatus, placeholder: { pulse: boolean, text: string }) {
    const el = target as HTMLElement & Drawn;
    const hasText = !!(text && text.trim());
    const key = S.session + "|" + id + "|" + status + "|" +
      (hasText ? text.length + ":" + text.slice(-32) : "p:" + placeholder.pulse + ":" + placeholder.text);
    if (el._key === key) return;
    el._key = key;
    if (hasText) {
      el.classList.remove("is-placeholder");
      el.innerHTML = Core.renderMarkdown(text);
      if (status === "writing") appendCaret(el);
    } else {
      el.classList.add("is-placeholder");
      el.innerHTML = placeholder.text ? '<p class="placeholder">' +
        (placeholder.pulse ? '<span class="pulse" aria-hidden="true"></span>' : "") +
        "<span>" + Core.esc(placeholder.text) + "</span></p>" : "";
    }
  }

  function appendCaret(root: Element) {
    let host = root;
    for (let guard = 0; guard < 12; guard++) {
      const last = host.lastElementChild;
      if (!last) break;
      const tag = last.tagName;
      if (tag === "UL" || tag === "OL" || tag === "BLOCKQUOTE") { host = last; continue; }
      if (tag === "LI") {
        host = last;
        const inner = last.lastElementChild;
        if (inner && (inner.tagName === "UL" || inner.tagName === "OL")) { host = inner; continue; }
        break;
      }
      if (/^(P|H[1-6])$/.test(tag)) host = last;
      break;
    }
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");
    host.appendChild(caret);
  }

  function proposalMeta(id: string): string {
    const s = S.seats[proposalSeatId(id)];
    if (s.status === "writing") return Core.wordCount(s.text) + " words so far";
    if (s.status === "error") return "Couldn't finish";
    if (s.status === "stopped") return s.text ? "Stopped part-way" : "";
    if (s.status !== "done") return "";
    const t = tally();
    if (!t) return Core.wordCount(s.text) + " words";
    const pts = t.rows[id].points, w = winnerLetter();
    const p = pts + (pts === 1 ? " point" : " points");
    if (w === id) return "Adopted with " + p;
    if (!w && t.tied.indexOf(id) >= 0) return "Tied at " + p;
    return p;
  }

  function selectTab(group: keyof typeof S.sel, key: string) {
    if (S.sel[group] === key) return;
    S.sel[group] = key;
    render();
  }

  function renderTab(tab: HTMLElement, on: boolean, status: string) {
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
    if (tab.getAttribute("data-status") !== status) tab.setAttribute("data-status", status);
  }

  function renderProposals() {
    if (!S.revealed.proposals) return;
    const titles = currentTitles();
    LETTERS.forEach(L => {
      const tab = $("tab-" + L);
      renderTab(tab, S.sel.proposals === L, S.seats[L].status);
      setText(tab.querySelector(".tab-title"), titles[L] || statusTitle(L));
      setText(tab.querySelector(".tab-meta"), proposalMeta(L));
    });
    const nb = LETTERS.filter(L => S.seats[L].status === "done").length;
    setText(els.propCount, nb === 3 ? "All three are in" : nb + " of 3 in");
    // A proposal the council questioned shows as its builder adjusted it, with the first version beneath.
    const id = S.sel.proposals, viewId = proposalSeatId(id), s = S.seats[viewId], am = S.seats[amendId(id)];
    els.propPane.setAttribute("aria-labelledby", "tab-" + id);
    setLetter(els.propPane, id);
    setText(els.propByline, "Proposal " + id + ", by " + Core.midName(CAST[id].name) + (viewId !== id ? ", adjusted after the council's questions" : ""));
    renderTier(els.propTier, viewId);
    renderConvoLink(els.propConvo, viewId);
    renderDoc(els.propDoc, viewId, s.text, s.status, placeholderFor(viewId));
    let note = noteFor(viewId);
    if (!note && viewId === id && !am.skipped) {
      if (am.status === "thinking") note = { text: "The council asked about this proposal, and " + Core.midName(CAST[id].name) + " is answering and adjusting it.", error: false };
      else if (am.status === "error" || am.status === "stopped") note = noteFor(amendId(id));
    }
    renderNote(els.propNote, note);
    toggle(els.propDraft, viewId !== id);
    if (viewId !== id) setHTML(els.propDraftDoc, Core.renderMarkdown(S.seats[id].text));
  }

  // Each proposal's questions from the councilors, and its builder's answers.
  function renderQuestions() {
    if (!S.revealed.questions) return;
    LETTERS.forEach(L => {
      const tab = $("qtab-" + L), am = S.seats[amendId(L)];
      const asks = COUNCIL_IDS.map(c => S.seats[askId(c, L)]);
      const asked = COUNCIL_IDS.map(c => handedOff(askId(c, L)));
      const all = asked.every(Boolean), n = asked.reduce((k, d) => k + (d ? d.questions.length : 0), 0);
      const states = asks.concat([am]).map(x => x.status);
      const status = am.status === "done" ? "done" : (["error", "writing", "thinking", "stopped"] as const).filter(x => states.indexOf(x) >= 0)[0] || "idle";
      renderTab(tab, S.sel.questions === L, status);
      setText(tab.querySelector(".tab-title"), all ? (n ? n + (n === 1 ? " question" : " questions") : "No questions") :
        asks.some(x => x.status !== "idle") ? "Asking\u2026" : "Waiting");
      setText(tab.querySelector(".tab-meta"), am.status === "done" ? (am.skipped ? "Stands as submitted" : "Adjusted") :
        am.status === "thinking" || am.status === "writing" ? "Answering\u2026" : am.status === "error" ? "Couldn't finish" : "");
    });
    const settled = AMEND_IDS.filter(id => S.seats[id].status === "done").length;
    setText(els.questionsCount, settled === 3 ? "All three are settled" : settled + " of 3 settled");
    const L = S.sel.questions, builder = Core.midName(CAST[L].name);
    els.questionsPane.setAttribute("aria-labelledby", "qtab-" + L);
    setLetter(els.questionsPane, L);
    const placeholder = (p: { pulse: boolean, text: string }) => '<p class="placeholder">' + (p.pulse ? '<span class="pulse" aria-hidden="true"></span>' : "") + "<span>" + Core.esc(p.text) + "</span></p>";
    const blocks = COUNCIL.map(c => {
      const id = askId(c.id, L), seat = S.seats[id], d = handedOff(id);
      const body = d ? (d.questions.length ? "<ol>" + d.questions.map((q: string) => "<li>" + Core.inline(q) + "</li>").join("") + "</ol>" : '<p class="qa-none">No questions.</p>') :
        seat.text ? Core.renderMarkdown(seat.text.replace(/^[ \t]{0,3}#{1,6}[ \t]+questions[ \t]*$/im, "")) : placeholder(placeholderFor(id));
      const note = noteFor(id);
      return '<div class="qa-block"><p class="qa-who">' + Core.esc(c.name) + " asks" + convoLinkHTML(id) + "</p><div class=\"doc\">" + body + "</div>" +
        (note && note.error ? '<p class="pane-note is-error">' + Core.esc(note.text) + "</p>" : "") + "</div>";
    });
    const am = S.seats[amendId(L)], answers = am.text && !am.skipped ? Core.sectionText(am.text, "Answers to the council") : "";
    const answer = am.skipped ? '<p class="qa-none">No one asked anything, so the proposal stands as submitted.</p>' :
      answers ? Core.renderMarkdown(answers) :
        am.status === "writing" ? placeholder({ pulse: true, text: CAST[L].name + " is adjusting the proposal." }) :
          placeholder(placeholderFor(amendId(L)));
    const amNote = noteFor(amendId(L));
    blocks.push('<div class="qa-block is-answer"><p class="qa-who">' + Core.esc(builder.replace(/^the/, "The")) + " answers" + (am.skipped ? "" : convoLinkHTML(amendId(L))) + "</p><div class=\"doc\">" + answer + "</div>" +
      (amNote && amNote.error ? '<p class="pane-note is-error">' + Core.esc(amNote.text) + "</p>" : "") + "</div>");
    setHTML(els.questionsDoc, blocks.join(""));
  }

  function suffix(n: number): string {
    return n === 1 ? "st" : n === 2 ? "nd" : "rd";
  }

  function rankBox(k: number): string {
    return '<span class="rank r' + k + '"><span class="visually-hidden">ranked </span>' + k +
      '<span class="visually-hidden">' + suffix(k) + "</span></span>";
  }

  function ballotHTML(id: string, titles: Record<string, string>): string {
    const b = ballotOf(id) as Ballot;
    const rank: Record<string, number> = {};
    b.ranking.forEach((L, k) => { rank[L] = k + 1; });
    const rows = LETTERS.map(L => {
      const sc = b.scores[L];
      const score = typeof sc === "number" ?
        sc + '<span aria-hidden="true">/10</span><span class="visually-hidden"> out of 10</span>' :
        '<span aria-hidden="true">–</span><span class="visually-hidden">no score</span>';
      return '<li class="ballot-row" data-letter="' + L + '"><span class="badge" aria-hidden="true">' + L + "</span>" +
        '<span class="bt"><span class="visually-hidden">Proposal ' + L + ", </span>" + Core.esc(titles[L] || "Proposal " + L) + "</span>" +
        '<span class="score">' + score + "</span>" + rankBox(rank[L]) + "</li>";
    }).join("");
    return '<div class="ballot"><p class="ballot-title">' + Core.esc(CAST[id].name) + "\u2019s ballot</p>" +
      '<ul class="ballot-rows">' + rows + "</ul></div>";
  }

  function renderCouncil() {
    if (!S.revealed.council) return;
    const titles = currentTitles();
    COUNCIL.forEach(c => {
      const tab = $("tab-" + c.id), s = S.seats[c.id];
      renderTab(tab, S.sel.council === c.id, s.status);
      const ballot = ballotOf(c.id), first = ballot ? ballot.ranking[0] : "";
      setLetter(tab, first);
      setText(tab.querySelector(".tab-title"), first ? "Ranks " + first + " first" : statusTitle(c.id));
      const meta = first ? (titles[first] ? "\u201C" + titles[first] + "\u201D" : "") :
        s.status === "writing" ? Core.wordCount(Core.reviewBody(s.text)) + " words so far" :
          s.status === "error" ? "Couldn't finish" : "";
      setText(tab.querySelector(".tab-meta"), meta);
    });
    const cast = COUNCIL_IDS.filter(id => S.seats[id].status === "done").length;
    setText(els.councilCount, cast === 3 ? "All ballots cast" : cast + " of 3 ballots cast");
    const id = S.sel.council, s = S.seats[id];
    els.councilPane.setAttribute("aria-labelledby", "tab-" + id);
    setText(els.councilByline, "Review by " + Core.midName(CAST[id].name));
    renderTier(els.councilTier, id);
    renderConvoLink(els.councilConvo, id);
    renderDoc(els.councilDoc, id, Core.reviewBody(s.text), s.status, placeholderFor(id));
    setHTML(els.ballot, ballotOf(id) ? ballotHTML(id, titles) : "");
    renderNote(els.councilNote, noteFor(id));
  }

  function renderVote() {
    const t = tally();
    if (!t) {
      setHTML(els.division, "");
      setText(els.verdict, "");
      return;
    }
    const titles = currentTitles(), w = winnerLetter();
    const pending = t.decidedBy === "chair" && !decided();
    const head = '<tr role="row"><th role="columnheader" scope="col">Proposal</th>' +
      COUNCIL.map(c => '<th role="columnheader" scope="col">' + c.short + "</th>").join("") +
      '<th role="columnheader" scope="col" class="pts">Points</th></tr>';
    const body = Core.orderRows(t, w).map(r => {
      const isW = r.letter === w;
      const tag = isW ? '<span class="tag">Adopted</span>' :
        pending && t.tied.indexOf(r.letter) >= 0 ? '<span class="tag is-tied">Tied</span>' : "";
      const cells = COUNCIL.map(c => '<td role="cell"><span class="cell-label" aria-hidden="true">' + c.short + "</span>" + rankBox(r.ranks[c.id]) + "</td>").join("");
      const pct = Math.round((100 * r.points) / t.maxPoints);
      return '<tr role="row" data-letter="' + r.letter + '"' + (isW ? ' class="is-winner"' : "") + ">" +
        '<th role="rowheader" scope="row"><span class="prop"><span class="badge" aria-hidden="true">' + r.letter + "</span>" +
        '<span class="pt"><span class="visually-hidden">Proposal ' + r.letter + ", </span>" + Core.esc(titles[r.letter] || "Proposal " + r.letter) + "</span>" +
        tag + "</span></th>" + cells +
        '<td role="cell" class="pts"><span class="pts-n">' + r.points + '</span><span class="bar" aria-hidden="true"><span class="bar-fill" data-pct="' + pct + '"></span></span></td></tr>';
    }).join("");
    const html = '<table class="division" role="table"><caption class="visually-hidden">How each councilor ranked the proposals, with the points each earned</caption>' +
      '<thead role="rowgroup">' + head + '</thead><tbody role="rowgroup">' + body + "</tbody></table>";
    if (setHTML(els.division, html)) {
      const fills: HTMLElement[] = Array.prototype.slice.call(els.division.querySelectorAll(".bar-fill"));
      const apply = () => fills.forEach(f => { f.style.width = f.getAttribute("data-pct") + "%"; });
      if (reduceMotion.matches || !window.requestAnimationFrame) apply();
      else window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
    }
    setText(els.verdict, Core.verdictText(t, titles, decided()));
  }

  function renderReview() {
    if (!S.revealed.review) return;
    REVIEWERS.forEach(r => {
      const tab = $("tab-" + r.id), s = S.seats[r.id], done = handedOff(r.id);
      renderTab(tab, S.sel.review === r.id, s.status);
      setText(tab.querySelector(".tab-title"), done ? Core.findingsText(done.findings) : statusTitle(r.id));
      setText(tab.querySelector(".tab-meta"), s.status === "writing" ? Core.wordCount(s.text) + " words so far" : s.status === "error" ? "Couldn't finish" : "");
    });
    const n = REVIEWER_IDS.filter(id => S.seats[id].status === "done").length;
    setText(els.reviewCount, n === REVIEWER_IDS.length ? "Both reviews are in" : n + " of 2 in");
    const id = S.sel.review, s = S.seats[id];
    els.reviewPane.setAttribute("aria-labelledby", "tab-" + id);
    setText(els.reviewByline, "Review by " + Core.midName(CAST[id].name));
    renderTier(els.reviewTier, id);
    renderConvoLink(els.reviewConvo, id);
    renderDoc(els.reviewDoc, id, s.text, s.status, placeholderFor(id));
    renderNote(els.reviewNote, noteFor(id));
  }

  // With a final review, the plan pane shows the Chair's plan until its revision starts to arrive, then the revision.
  function renderPlan() {
    if (!S.revealed.plan) return;
    const reviewed = !!brief().review, fin = S.seats.final;
    const showFinal = reviewed && (!!fin.text || fin.status === "done");
    const planId = showFinal ? "final" : "chair";
    const s = S.seats[planId], w = winnerLetter(), titles = currentTitles();
    setLetter(els.plan, w || "");
    const from = w ? "Proposal " + w + (titles[w] ? ", \u201C" + titles[w] + "\u201D" : "") : "";
    const by = (S.round > 1 ? "Round " + S.round + ". " : "") + (!w ? "The vote is tied, so the Chair casts the deciding vote in the plan." :
      fin.status === "done" && reviewed ? "Written by the Chair from " + from + ", and revised after the final review." :
        S.seats.chair.status === "done" ? "Written by the Chair from " + from + "." : "The Chair writes from " + from + ".");
    setText(els.planByline, by);
    renderTier(els.planTier, planId);
    renderConvoLink(els.planConvo, planId);
    renderDoc(els.planDoc, planId, s.text, s.status, placeholderFor(planId));
    let note = noteFor(planId);
    if (!note && reviewed && !showFinal && S.seats.chair.status === "done") {
      note = fin.status === "error" || fin.status === "stopped" ? noteFor("final") : {
        text: fin.status === "thinking" ? "The Chair is revising this plan after the final review." :
          "This is the plan before the final review. The Chair revises it once the reviewers are done.",
        error: false,
      };
    }
    renderNote(els.planNote, note);
    const draft = reviewed && handedOff("final") ? handedOff("chair") : null;
    toggle(els.planDraft, !!draft);
    if (draft) setHTML(els.planDraftDoc, Core.renderMarkdown(draft.text));
    toggle(els.planActions, !!planHandoff());
    const canSave = !!downloadsNS || !INSIDE;
    toggle(els.dlPlan, canSave);
    toggle(els.dlRecord, canSave);
  }

  function renderNotice() {
    const n = S.notice;
    toggle(els.notice, !!n);
    if (!n) return;
    setText(els.noticeText, n.text);
    toggle(els.noticeRetry, !!n.retry);
  }

  /* ---------- Actions ---------- */

  function scrollToSection(el: HTMLElement) {
    try {
      el.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
    } catch (_) {
      if (el.scrollIntoView) el.scrollIntoView();
    }
  }

  function focusQuietly(el: HTMLElement) {
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  }

  function jumpToSeat(id: string) {
    if (!seatAvailable(id)) return;
    if (isBuilder(id)) {
      selectTab("proposals", id);
      scrollToSection(els.secProposals);
      focusQuietly($("tab-" + id));
    } else if (isCouncil(id)) {
      selectTab("council", id);
      scrollToSection(els.secCouncil);
      focusQuietly($("tab-" + id));
    } else {
      scrollToSection(els.secPlan);
      focusQuietly($("h-plan"));
    }
  }

  function showFieldNote(text: string) {
    els.featureNote.textContent = text;
    els.featureNote.hidden = !text;
    if (text) els.feature.setAttribute("aria-invalid", "true");
    else els.feature.removeAttribute("aria-invalid");
  }

  function autosize() {
    const el = els.feature;
    el.style.height = "auto";
    el.style.height = Math.max(104, el.scrollHeight + 2) + "px";
  }

  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  function saveDraft() { store.set("quorum:draft", els.feature.value); }
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall back below */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.className = "visually-hidden";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function flash(target: HTMLElement, text: string) {
    const btn = target as HTMLElement & Drawn;
    const label = btn.getAttribute("data-label") || btn.textContent || "";
    btn.setAttribute("data-label", label);
    btn.textContent = text;
    clearTimeout(btn._flash);
    btn._flash = setTimeout(() => { btn.textContent = label; }, 2400);
  }

  // The agent that wrote each step of a round, from its handoffs.
  function tiersOf(handoffs: Handoffs): Record<string, string> {
    const tiers: Record<string, string> = {};
    ALL_IDS.forEach(id => {
      const d = handoffs[id] && handoffs[id].data;
      tiers[id] = d && d.agent ? Core.agentLabel({ provider: d.agent.provider, model: d.served || d.agent.model }, { customUrl: creds.urls.custom }) : "";
    });
    return tiers;
  }

  // The record of the latest round, followed by each earlier round, newest first.
  function recordNow() {
    let out = Core.recordMarkdown(Object.assign(Core.sessionOf(S.handoffs), {
      setupLine: "Agents: " + Core.agentsSentence(S.agents, { customUrl: creds.urls.custom }) + " Length: " + LENGTHS[brief().length].label + "." +
        (brief().review ? " Final review on " + Core.agentLabel(S.agents.review, { customUrl: creds.urls.custom }) + "." : "") +
        (brief().project ? " Project: " + (brief().project as Project).path + "." : "") + (S.round > 1 ? " Round " + S.round + "." : ""),
      tiers: tiersOf(S.handoffs),
    }));
    for (let i = S.past.length - 1; i >= 0; i--) {
      const md = Core.recordMarkdown(Object.assign(Core.sessionOf(S.past[i]), { tiers: tiersOf(S.past[i]) }));
      out += "\n---\n\n# Round " + (i + 1) + "\n\n" + Core.shiftHeadings(md, 1);
    }
    return out;
  }

  // Outside Claude there's no save capability; a plain download link does the job.
  function downloadDirectly(filename: string, data: string) {
    const url = URL.createObjectURL(new Blob([data], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function fileBase() {
    const plan = planHandoff();
    return Core.slug((plan && Core.titleOf(plan.text)) || brief().feature.slice(0, 60));
  }

  async function saveFile(kind: "plan" | "record", btn: HTMLElement) {
    const plan = planHandoff();
    if (!plan) return;
    const filename = (kind === "plan" ? "plan-" : "council-record-") + fileBase() + ".md";
    await saveText(filename, kind === "plan" ? plan.text.trim() + "\n" : recordNow(), btn);
  }

  async function saveText(filename: string, data: string, btn: HTMLElement) {
    if (!downloadsNS) {
      if (INSIDE) return;
      try {
        downloadDirectly(filename, data);
        flash(btn, "Downloaded");
      } catch (_) {
        flash(btn, "Couldn't download");
      }
      return;
    }
    try {
      const res = await downloadsNS.save({ filename, data });
      if (res && res.status === "saved") flash(btn, "Saved");
    } catch (e: any) {
      const code = e && e.code;
      if (code === "declined") return;
      if (code === "rate_limited") { flash(btn, "Finish the open save first"); return; }
      if (code === "too_large" || code === "bad_request" || code === "transform_error" || code === "rejected_extension") {
        flash(btn, "Couldn't save");
        return;
      }
      downloadsNS = null; // saving isn't available in this view
      render();
    }
  }

  function wireTabs(list: HTMLElement, group: keyof typeof S.sel, keys: string[], prefix?: string) {
    list.addEventListener("click", e => {
      const tab = (e.target as Element).closest('[role="tab"]');
      if (tab) selectTab(group, tab.getAttribute("data-key") as string);
    });
    list.addEventListener("keydown", e => {
      const tab = (e.target as Element).closest('[role="tab"]');
      if (!tab) return;
      const i = keys.indexOf(tab.getAttribute("data-key") as string);
      let j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % keys.length;
      else if (e.key === "ArrowLeft") j = (i + keys.length - 1) % keys.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = keys.length - 1;
      if (j < 0) return;
      e.preventDefault();
      selectTab(group, keys[j]);
      $((prefix || "tab-") + keys[j]).focus();
    });
  }

  /* ---------- Context blocks ---------- */

  const ctxList = $("contextList");
  let ctxItems: ContextField[] = [];
  let ctxSeq = 0;

  function fmtNum(n: number): string {
    return Number(n).toLocaleString("en-US");
  }

  function sizeContext(el: HTMLElement) {
    el.style.height = "auto";
    el.style.height = Math.min(360, Math.max(104, el.scrollHeight + 2)) + "px";
  }

  function syncContextLabels(item: ContextField) {
    const name = item.title.trim() || "this context";
    item.labelEl.textContent = item.title.trim() || "Context";
    item.removeEl.setAttribute("aria-label", "Remove " + name);
  }

  function addContext(kind: string, title?: string | null, text?: string | null, focus?: boolean): ContextField {
    const k = CONTEXT_KINDS[kind] ? kind : "other";
    const id = "c" + (++ctxSeq);
    // Its elements are added below, once they're made.
    const item = { id, kind: k, title: title != null ? String(title) : CONTEXT_KINDS[k].title, text: text != null ? String(text) : "" } as ContextField;
    const el = document.createElement("div");
    el.className = "ctx";
    el.innerHTML =
      '<div class="ctx-head">' +
        '<label class="visually-hidden" for="ctx-title-' + id + '">Name of this context</label>' +
        '<input class="ctx-title" id="ctx-title-' + id + '" type="text" maxlength="60" placeholder="Name this context" autocomplete="off">' +
        '<span class="ctx-size"></span>' +
        '<button type="button" class="ctx-remove">Remove</button>' +
      "</div>" +
      '<label class="visually-hidden" for="ctx-text-' + id + '"></label>' +
      '<textarea class="ctx-text' + (CONTEXT_KINDS[k].code ? " is-code" : "") + '" id="ctx-text-' + id + '" rows="4"></textarea>';
    item.el = el;
    item.titleEl = el.querySelector(".ctx-title") as HTMLInputElement;
    item.textEl = el.querySelector(".ctx-text") as HTMLTextAreaElement;
    item.removeEl = el.querySelector(".ctx-remove") as HTMLButtonElement;
    item.sizeEl = el.querySelector(".ctx-size") as HTMLElement;
    item.labelEl = el.querySelector('label[for="ctx-text-' + id + '"]') as HTMLLabelElement;
    item.titleEl.value = item.title;
    item.textEl.value = item.text;
    item.textEl.placeholder = CONTEXT_KINDS[k].placeholder;
    item.textEl.spellcheck = !CONTEXT_KINDS[k].code;
    item.titleEl.addEventListener("input", () => {
      item.title = item.titleEl.value;
      syncContextLabels(item);
      dropUndo();
      saveContextSoon();
    });
    item.textEl.addEventListener("input", () => {
      item.text = item.textEl.value;
      sizeContext(item.textEl);
      dropUndo();
      saveContextSoon();
      renderContextCounts();
    });
    item.textEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (S.phase !== "running") convene();
      }
    });
    item.removeEl.addEventListener("click", () => removeContext(item));
    ctxItems.push(item);
    ctxList.appendChild(el);
    syncContextLabels(item);
    sizeContext(item.textEl);
    renderContextCounts();
    if (focus) (item.title.trim() ? item.textEl : item.titleEl).focus();
    return item;
  }

  function removeContext(item: ContextField) {
    if (S.phase === "running") return;
    const i = ctxItems.indexOf(item);
    if (i < 0) return;
    ctxItems.splice(i, 1);
    item.el.remove();
    dropUndo();
    saveContext();
    renderContextCounts();
    const next = ctxItems[i] || ctxItems[i - 1];
    if (next) next.textEl.focus();
    else addBtns[0].focus();
  }

  function clearContext() {
    ctxItems.forEach(it => it.el.remove());
    ctxItems = [];
  }

  function contextTotal(): number {
    return ctxItems.reduce((n, it) => n + it.text.length, 0);
  }

  function contextForSession() {
    return ctxItems
      .filter(it => it.text.trim())
      .map(it => ({ title: it.title.trim() || CONTEXT_KINDS[it.kind].title || "", text: it.text }));
  }

  function showContextNote(text: string) {
    els.contextNote.textContent = text;
    els.contextNote.hidden = !text;
  }

  function renderContextCounts() {
    ctxItems.forEach(it => setText(it.sizeEl, it.text.length ? fmtNum(it.text.length) + " characters" : "Empty"));
    const total = contextTotal();
    const over = total > CONTEXT_LIMIT;
    setText(els.contextCount, ctxItems.length ? fmtNum(total) + " of " + fmtNum(CONTEXT_LIMIT) + " characters" : "");
    els.contextCount.classList.toggle("is-over", over);
    if (!over && !els.contextNote.hidden) showContextNote("");
  }

  // Text files come in as context named after the file, so the agents can refer to them by that name.
  const FILE_LIMIT = 200000;
  const PROSE_FILE = /\.(md|markdown|txt|rst|adoc)$/i;

  function readFile(file: File): Promise<string> {
    if (typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  async function addFiles(list: ArrayLike<File> | null | undefined) {
    const files: File[] = Array.prototype.slice.call(list || []);
    if (!files.length || S.phase === "running") return;
    dropUndo();
    const skipped: string[] = [];
    let first: ContextField | null = null;
    for (const file of files) {
      let text: string | null = null;
      if (file.size <= FILE_LIMIT) {
        try { text = await readFile(file); } catch (_) { text = null; }
      }
      // The council may have been convened while the file was read.
      if ((S.phase as Phase) === "running") break;
      if (text == null || text.indexOf("\u0000") >= 0) {
        skipped.push(file.name);
        continue;
      }
      const item = addContext(PROSE_FILE.test(file.name) ? "other" : "code", file.name.slice(0, 60), text.replace(/\r\n?/g, "\n"));
      if (!first) first = item;
    }
    saveContext();
    renderContextCounts();
    if (first) first.textEl.focus();
    const notes: string[] = [];
    if (skipped.length) notes.push("Skipped " + Core.listAnd(skipped) + ", because only text files up to 200 KB can be added.");
    const total = contextTotal();
    if (first && total > CONTEXT_LIMIT) {
      notes.push("The context is now " + fmtNum(total) + " characters, more than the " + fmtNum(CONTEXT_LIMIT) +
        " the council can read at once. Trim it to the parts that matter before you convene.");
    }
    showContextNote(notes.join(" "));
  }

  function carriesFiles(e: DragEvent): boolean {
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0);
  }

  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  function saveContext() {
    store.set("quorum:context", JSON.stringify(ctxItems.map(it => ({ kind: it.kind, title: it.title, text: it.text }))));
  }
  function saveContextSoon() {
    clearTimeout(contextTimer);
    contextTimer = setTimeout(saveContext, 400);
  }

  // Examples replace the draft; keep the draft so it can be put back.
  let exampleUndo: FormSnapshot | null = null;
  function snapshotForm(): FormSnapshot {
    return { feature: els.feature.value, context: ctxItems.map(it => ({ kind: it.kind, title: it.title, text: it.text })) };
  }
  function formHasContent() {
    return !!els.feature.value.trim() || ctxItems.some(it => it.text.trim() || (it.title.trim() && it.title !== CONTEXT_KINDS[it.kind].title));
  }
  function setForm(snap: FormSnapshot) {
    els.feature.value = snap.feature;
    clearContext();
    snap.context.forEach(c => addContext(c.kind, c.title, c.text));
    autosize();
    saveDraft();
    saveContext();
    renderContextCounts();
  }
  function dropUndo() {
    if (!exampleUndo) return;
    exampleUndo = null;
    els.exampleNote.hidden = true;
  }

  /* ---------- Project folder ---------- */

  // With Quorum's local server, the session can be about a folder on this computer. Seats on Claude Code work inside
  // it, and agents with tools of their own are told where it is. value is the path the lookup was for, info what the
  // server found there, and listing the folder the browser shows.
  const proj: {
    value: string,
    info: FolderInfo | null,
    error: string,
    note: string,
    pending: Promise<void> | null,
    seq: number,
    listing: FolderInfo | null,
    browsing: boolean,
  } = { value: "", info: null, error: "", note: "", pending: null, seq: 0, listing: null, browsing: false };
  let projectTimer: ReturnType<typeof setTimeout> | undefined;

  async function getFolder(path: string): Promise<FolderInfo> {
    let res, body = null;
    try {
      res = await fetch(localUrl("folder?path=" + encodeURIComponent(path)));
    } catch (_) {
      throw { message: "Couldn't reach Quorum's local server. Check that it's still running." };
    }
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok || !body) throw { message: (body && body.error && body.error.message) || "That folder couldn't be read." };
    return body;
  }

  function checkProject(text: string): Promise<void> {
    clearTimeout(projectTimer);
    const seq = ++proj.seq;
    proj.value = text;
    proj.info = null;
    proj.error = "";
    if (!text) {
      proj.pending = null;
      schedule();
      return Promise.resolve();
    }
    const done = getFolder(text).then(info => {
      if (seq !== proj.seq) return;
      proj.info = info;
      proj.listing = info;
    }, (e: { message: string }) => {
      if (seq === proj.seq) proj.error = e.message;
    }).then(() => {
      if (seq !== proj.seq) return;
      proj.pending = null;
      schedule();
    });
    proj.pending = done;
    schedule();
    return done;
  }

  function chooseProject(path: string): Promise<void> {
    els.projectPath.value = path;
    proj.note = "";
    store.set("quorum:project", path);
    return checkProject(path);
  }

  function projectStatusHTML(): { html: string, error?: boolean } {
    const i = proj.info;
    if (proj.note) return { html: Core.esc(proj.note), error: true };
    if (!proj.value) return { html: "Choose the folder of the project this feature is for. Seats on Claude Code work inside it, reading and searching the code without changing it." };
    if (proj.pending) return { html: "Looking for the folder\u2026" };
    if (proj.error) return { html: Core.esc(proj.error), error: true };
    if (!i) return { html: "" };
    const on = i.git ? (i.git.branch ? " on " + Core.esc(i.git.branch) : i.git.detached ? " at " + Core.esc(i.git.detached) : "") : "";
    const where = !i.git ? ". It isn't in a Git repository." : i.git.root === i.path ? ", a Git repository" + on + "." : ", in a Git repository" + on + ".";
    const guides = [i.claudeMd ? "a CLAUDE.md, which Claude Code reads" : "", i.agentsMd ? "an AGENTS.md, which agents on OpenRouter and other endpoints read" : ""].filter(Boolean);
    return { html: "Found <strong>" + Core.esc(i.name) + "</strong>" + where + (guides.length ? " It has " + guides.join(", and ") + "." : "") };
  }

  function renderProject() {
    toggle(els.project, !!local);
    if (!local) return;
    const running = S.phase === "running";
    els.projectPath.readOnly = running;
    els.projectBrowse.disabled = running;
    const st = projectStatusHTML();
    setHTML(els.projectStatus, st.html);
    els.projectStatus.classList.toggle("is-error", !!st.error);
    if (st.error) els.projectPath.setAttribute("aria-invalid", "true");
    else els.projectPath.removeAttribute("aria-invalid");
    toggle(els.projectBrowser, proj.browsing);
    els.projectBrowse.setAttribute("aria-expanded", proj.browsing ? "true" : "false");
    setText(els.projectBrowse, proj.browsing ? "Close" : "Browse");
    if (!proj.browsing) return;
    const l = proj.listing, off = running ? " disabled" : "";
    setText(els.projectWhere, l ? l.path : "Loading\u2026");
    const item = (path: string, label: string, up: boolean) => '<li><button type="button" class="project-dir' + (up ? " is-up" : "") + '" data-path="' + Core.esc(path) + '"' + off + ">" + label + "</button></li>";
    const items: string[] = [];
    if (l && l.parent) items.push(item(l.parent, '<span aria-hidden="true">\u2191 </span>Parent folder', true));
    if (l) l.dirs.forEach(d => items.push(item(d.path, Core.esc(d.name) + "/", false)));
    if (l && !l.dirs.length) items.push('<li class="project-empty">' + (l.unreadable ? "This folder can't be read." : "No folders inside.") + "</li>");
    if (l && l.more) items.push('<li class="project-empty">And ' + fmtNum(l.more) + " more. Type the path to reach them.</li>");
    setHTML(els.projectDirs, items.join(""));
  }

  /* ---------- Saved sessions ---------- */

  // With Quorum's local server, every session is saved as it runs: its settings, and the handoff each step makes in
  // each round. A saved session opened again, after the page or the server stopped, carries on from its handoffs.
  // Saves go one after another, so a session's status is written after the handoffs that led to it.
  const saved: {
    list: Session[],
    listed: boolean,
    listError: string,
    queue: Promise<unknown>,
    pending: number,
    error: string,
    confirm: string,
  } = { list: [], listed: false, listError: "", queue: Promise.resolve(), pending: 0, error: "", confirm: "" };

  function canSave() {
    return !!(local && local.sessions);
  }

  // What the local server answered, as JSON.
  async function api(method: string, route: string, body?: unknown): Promise<any> {
    let res, out = null;
    try {
      res = await fetch(localUrl(route), body === undefined ? { method } :
        { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (_) {
      throw new Error("Couldn't reach Quorum's local server.");
    }
    try { out = await res.json(); } catch (_) { out = null; }
    if (!res.ok) throw new Error((out && out.error && out.error.message) || "Quorum's server answered " + res.status + ".");
    return out;
  }

  // sid names the session to save to, when it isn't the open one.
  function save(request: (id: string) => Promise<unknown>, sid?: string | null) {
    const id = sid || S.sessionId;
    if (!id) return;
    saved.pending += 1;
    schedule();
    saved.queue = saved.queue
      .then(() => request(id))
      .catch((e: Error) => { if (id === S.sessionId) saved.error = e.message; })
      .then(() => { saved.pending -= 1; schedule(); });
  }

  function saveHandoff(round: number, h: Handoffs[string]) {
    save(id => api("PUT", "sessions/" + id + "/rounds/" + round + "/" + h.from, { kind: h.kind, data: h.data }));
  }

  function sessionTitle(): string {
    if (S.name) return S.name;
    const plan = planHandoff() || handedOff("chair");
    const title = plan ? Core.titleOf(plan.text) : "";
    return title || brief().feature.trim().split("\n")[0].slice(0, 120) || "Untitled session";
  }

  function saveState() {
    const body = { status: S.phase === "idle" ? "stopped" : S.phase, round: S.round, agents: S.agents, title: sessionTitle(), elapsed: Math.round(elapsed()) };
    save(id => api("PATCH", "sessions/" + id, body));
    if (S.phase !== "running") save(() => refreshSessions());
  }

  function setSessionHash(id: string | null) {
    try { history.replaceState(null, "", id ? "#session=" + id : location.pathname + location.search); } catch (_) { /* no history here */ }
  }

  // A new session starts saving before its first step runs, with the brief and the revision it was handed.
  async function startSaving() {
    S.sessionId = null;
    saved.error = "";
    if (!canSave()) return;
    setSessionHash(null);
    const b = brief();
    try {
      const o = await api("POST", "sessions", { title: sessionTitle(), project: b.project ? b.project.path : null, status: "running", agents: S.agents });
      S.sessionId = o.session.id;
      setSessionHash(S.sessionId);
      Core.HANDED_IN.forEach(k => saveHandoff(S.round, S.handoffs[k]));
      save(() => refreshSessions());
    } catch (e: any) {
      saved.error = e.message;
    }
    schedule();
  }

  async function refreshSessions() {
    if (!canSave()) return;
    try {
      saved.list = (await api("GET", "sessions")).sessions;
      saved.listError = "";
    } catch (e: any) {
      saved.listError = e.message;
    }
    saved.listed = true;
    schedule();
  }

  function kindOfContext(title: string | undefined): string {
    const k = Object.keys(CONTEXT_KINDS).filter(x => CONTEXT_KINDS[x].title && CONTEXT_KINDS[x].title === title)[0];
    return k || "other";
  }

  // Opens a saved session where it got to. Steps that were running when it stopped are shown as stopped, so Resume
  // asks for them again; a finished session is ready for questions and input on its plan.
  async function openSession(id: string) {
    if (S.phase === "running" || S.connecting) return;
    let o: { session: Session, handoffs: { round: number, node: string, kind: string, data: unknown }[] };
    try {
      o = await api("GET", "sessions/" + encodeURIComponent(id));
    } catch (e: any) {
      saved.listError = "That session couldn't be opened. " + e.message;
      showDrawer("history");
      return;
    }
    const rounds: Record<number, Handoffs> = {};
    o.handoffs.forEach(h => {
      rounds[h.round] = rounds[h.round] || {};
      rounds[h.round][h.node] = Graph.handoff(h.node, h.kind, h.data);
    });
    const last = o.session.round;
    const current = rounds[last] || {};
    if (!current.brief) {
      saved.listError = "That session was saved without its brief, so it can't be opened.";
      render();
      return;
    }
    if (!current.revision) current.revision = Graph.handoff("revision", "revision", null);
    abortAll();
    S.token += 1;
    S.session += 1;
    resetSeats();
    resetConvos(true);
    S.sessionId = o.session.id;
    S.name = o.session.title;
    saved.error = "";
    S.round = last;
    S.past = [];
    for (let r = 1; r < last; r++) S.past.push(rounds[r] || {});
    S.handoffs = current;
    S.agents = Core.normalizeAgents(o.session.agents, INSIDE);
    applyAgents(S.agents);
    const graph = Core.graphFor(S.handoffs.brief.data);
    const ready = Graph.ready(graph, S.handoffs);
    ALL_IDS.forEach(seatId => {
      const h = S.handoffs[seatId], seat = S.seats[seatId];
      if (h) {
        seat.status = "done";
        seat.skipped = h.kind === "amend" && !h.data.amended;
        seat.text = String(h.data.text || "");
        seat.truncated = !!h.data.truncated;
        seat.agent = h.data.agent || null;
        seat.served = h.data.served || "";
      } else if (ready.indexOf(seatId) >= 0) {
        seat.status = "stopped";
      }
    });
    const finished = graph.order.every(n => S.handoffs[n]);
    S.phase = finished ? "done" : "stopped";
    S.revealed = {
      proposals: true,
      questions: ASK_IDS.some(id => S.handoffs[id] || ready.indexOf(id) >= 0),
      council: Core.SESSION.nodes.advocate.needs.every(n => S.handoffs[n]) && graph.nodes.advocate.needs.every(n => S.handoffs[n]),
      vote: !!S.handoffs.tally,
      review: !!(S.handoffs.brief.data.review && S.handoffs.chair),
      plan: !!S.handoffs.tally,
    };
    S.sel = { proposals: "A", questions: "A", council: "advocate", review: "scaling" };
    S.clock = { startedAt: 0, accumulated: o.session.elapsed || 0 };
    clearInterval(clockTimer);
    S.notice = null;
    S.canRetry = false;
    S.heard = true;
    S.stoppedAt = 0;
    // The form shows what the session is about, so it can be convened again as it is or changed.
    const b = brief();
    setForm({ feature: b.feature, context: b.context.map(c => ({ kind: kindOfContext(c.title), title: c.title, text: c.text })) });
    els.projectPath.value = b.project ? b.project.path : "";
    checkProject(els.projectPath.value.trim());
    els.reviewOn.checked = !!b.review;
    els.questionsOn.checked = !!b.questions;
    setSessionHash(S.sessionId);
    closeDrawer(false);
    render();
    scrollToSection(finished ? els.secPlan : els.secProposals);
  }

  async function deleteSession(id: string) {
    try {
      await api("DELETE", "sessions/" + encodeURIComponent(id));
    } catch (e: any) {
      saved.listError = "That session couldn't be deleted. " + e.message;
    }
    if (id === S.sessionId) {
      S.sessionId = null;
      setSessionHash(null);
    }
    await refreshSessions();
  }

  function fmtWhen(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderSessions() {
    toggle(els.openHistory, canSave());
    if (!canSave()) return;
    const list = saved.list, running = S.phase === "running";
    const open = list.filter(x => x.status !== "done").length;
    // History counts the unfinished sessions there are to come back to, besides the one open now.
    const waiting = list.filter(x => x.status !== "done" && x.id !== S.sessionId).length;
    toggle(els.historyBadge, waiting > 0);
    setHTML(els.historyBadge, waiting ? waiting + '<span class="visually-hidden"> unfinished ' + (waiting === 1 ? "session" : "sessions") + "</span>" : "");
    setText(els.sessionsStatus, !saved.listed ? "" : !list.length ? "None yet" :
      list.length + (list.length === 1 ? " session" : " sessions") + (open ? ", " + open + " unfinished" : ""));
    setText(els.sessionsIntro, saved.listError ||
      "Each session is saved in " + (local as LocalInfo & { sessions: { file: string } }).sessions.file + " as it runs, so you can come back to it after closing this page or stopping the server.");
    els.sessionsIntro.classList.toggle("is-error", !!saved.listError);
    const off = running ? " disabled" : "";
    setHTML(els.sessionList, list.map(x => {
      const here = x.id === S.sessionId;
      const project = x.project ? x.project.split(/[\\/]/).filter(Boolean).pop() : "";
      const meta = [project, x.round > 1 ? "Round " + x.round : "", x.status === "done" ? "Plan ready" : "Unfinished", fmtWhen(x.updated_at), here ? "Open now" : ""].filter(Boolean).join(" \u00B7 ");
      const confirming = saved.confirm === x.id;
      return '<li class="session-item"' + (here ? ' aria-current="true"' : "") + ">" +
        '<button type="button" class="session-open" data-open="' + Core.esc(x.id) + '"' + off + ">" + Core.esc(x.title) + "</button>" +
        '<p class="session-meta">' + Core.esc(meta) + "</p>" +
        '<button type="button" class="link-btn session-delete' + (confirming ? " is-confirm" : "") + '" data-delete="' + Core.esc(x.id) + '"' + off +
        ' aria-label="' + Core.esc((confirming ? "Delete for good: " : "Delete ") + x.title) + '">' + (confirming ? "Delete for good" : "Delete") + "</button></li>";
    }).join(""));
  }

  function renderSaveState() {
    let text = "", error = false;
    if (canSave() && S.phase !== "idle") {
      if (saved.error) { text = (S.sessionId ? "Couldn't save: " : "Not saved: ") + saved.error; error = true; }
      else if (S.sessionId) text = saved.pending ? "Saving\u2026" : "Saved";
    }
    toggle(els.saveState, !!text);
    setText(els.saveState, text);
    els.saveState.classList.toggle("is-error", error);
  }

  /* ---------- Revisions ---------- */

  function showReviseNote(text: string) {
    els.reviseNote.textContent = text;
    els.reviseNote.hidden = !text;
  }

  // The requester's questions and input on the plan go back up the chain: the builders revise their proposals with
  // it, the council reviews them and votes again, and the Chair answers it in a revised plan. That's a new round of
  // the same graph, handed the brief and a revision that carries the input and what it revises.
  async function revise() {
    if (S.phase !== "done" || S.connecting) return;
    const input = els.reviseInput.value.trim();
    if (!input) {
      showReviseNote("Write your questions or input first.");
      els.reviseInput.focus();
      return;
    }
    const agents = currentAgents();
    const problem = checkAgents(agents, brief().project, true, !!brief().review);
    if (problem) {
      showReviseNote(problem.message);
      revealProblem(problem);
      return;
    }
    showReviseNote("");
    const revision = Core.nextRevision(Core.sessionOf(S.handoffs), input);
    abortAll();
    S.token += 1;
    S.session += 1;
    const tok = S.token;
    S.past.push(S.handoffs);
    S.round = revision.round;
    S.handoffs = { brief: S.handoffs.brief, revision: Graph.handoff("revision", "revision", revision) };
    resetSeats();
    S.agents = agents;
    S.phase = "running";
    S.notice = null;
    S.canRetry = false;
    S.revealed = { proposals: true, questions: false, council: false, vote: false, review: false, plan: false };
    S.sel = { proposals: "A", questions: "A", council: "advocate", review: "scaling" };
    S.convenedAt = Date.now();
    startClock();
    els.reviseInput.value = "";
    Core.HANDED_IN.forEach(k => saveHandoff(S.round, S.handoffs[k]));
    saveState();
    render();
    scrollToSection(els.secProposals);
    focusQuietly($("h-proposals"));
    run(tok).catch(onRunCrash);
  }

  function renderRevise() {
    toggle(els.revise, S.phase === "done");
    els.reviseBtn.disabled = S.connecting;
  }

  function roundInput(h: Handoffs | undefined): string {
    return h && h.revision && h.revision.data ? h.revision.data.input : "";
  }

  function renderRounds() {
    toggle(els.secRounds, S.past.length > 0 && S.phase !== "idle");
    if (!S.past.length) return;
    const key = S.session + ":" + S.past.length;
    const roundsList = els.roundsList as HTMLElement & Drawn;
    if (roundsList._key === key) return;
    roundsList._key = key;
    const all = S.past.concat([S.handoffs]);
    const html: string[] = [];
    for (let i = S.past.length - 1; i >= 0; i--) {
      const s = Core.sessionOf(S.past[i]), t = s.tally, won = t ? t.winner || s.decided : null;
      const titles = Core.titlesOf(s.proposals);
      html.push('<details class="round"><summary>Round ' + (i + 1) + ": " + Core.esc(Core.titleOf(s.plan) || "The plan") +
        (won ? '<span class="round-meta">Built on Proposal ' + won + (titles[won] ? ", \u201C" + Core.esc(titles[won]) + "\u201D" : "") + "</span>" : "") +
        '</summary><div class="round-body"><article class="doc">' + Core.renderMarkdown(s.plan || "") + "</article>" +
        '<p class="round-label">Your input on this plan</p><blockquote class="motion-quote">' + Core.esc(roundInput(all[i + 1])) + "</blockquote>" +
        '<p class="round-actions"><button type="button" class="btn btn-quiet btn-small" data-convo-round="' + (i + 1) + '">Every agent\u2019s conversation in round ' + (i + 1) + "</button></p></div></details>");
    }
    els.roundsList.innerHTML = html.join("");
  }

  /* ---------- Conversations ---------- */

  // Everything each agent was sent and did, kept so any agent's whole conversation on any step can be read: the
  // prompt, its reasoning where the provider shows it, what it wrote along the way, each tool it used and what came
  // back, and the answer the step took. A step that ran more than once, after a retry or a resume, keeps every
  // attempt. The transcript's shape is described in core.ts.
  // Transcripts made in this page are in mem. With Quorum's local server they're saved with the session as they
  // grow, and a reopened session's are fetched into loaded as they're viewed. A step with none, from a session kept
  // only in this browser or saved before conversations were kept, is rebuilt from its round's handoffs.
  const convos: {
    mem: Record<string, LiveTranscript[]>,
    loaded: Record<string, Transcript[] | "loading">,
    failed: Record<string, string>,
    all: boolean,
    fromServer: boolean,
    gen: number,
    dirty: Record<string, LiveTranscript>,
    timer: ReturnType<typeof setTimeout> | 0,
    view: ConvoStep | null,
    opener: HTMLElement | null,
  } = { mem: {}, loaded: {}, failed: {}, all: false, fromServer: false, gen: 0, dirty: {}, timer: 0, view: null, opener: null };
  const TRANSCRIPT_SAVE_MS = 4000;

  function convoKey(round: number, node: string): string {
    return round + ":" + node;
  }

  // fromServer: the session was opened from the database, which may hold conversations this page hasn't seen.
  function resetConvos(fromServer: boolean) {
    flushTranscripts();
    closeConvo();
    convos.gen += 1;
    convos.mem = {};
    convos.loaded = {};
    convos.failed = {};
    convos.all = false;
    convos.fromServer = !!fromServer;
  }

  function startTranscript(node: string, agent: Agent, prompt: string, cwd: string): LiveTranscript {
    const t: LiveTranscript = {
      v: 1, attempt: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), round: S.round, node,
      agent: { provider: agent.provider, model: agent.model }, served: "", cwd: cwd || "", tools: [],
      started: new Date().toISOString(), ended: "", status: "running", error: null, truncated: false, usage: null,
      entries: [{ type: "prompt", text: prompt }],
    };
    // The session it's saved with, which isn't part of what's saved.
    Object.defineProperty(t, "sid", { value: S.sessionId });
    const key = convoKey(t.round, node);
    (convos.mem[key] = convos.mem[key] || []).push(t);
    keepTranscript(t, false);
    return t;
  }

  // What the provider reports as the agent works, as turns of its conversation.
  function traceInto(t: LiveTranscript, kind: TraceKind, d: unknown) {
    const o: Record<string, any> = d && typeof d === "object" ? d : {};
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    if (kind === "start") {
      if (str(o.model)) t.served = o.model;
      if (Array.isArray(o.tools)) t.tools = o.tools.filter((x: unknown) => typeof x === "string");
    } else if (kind === "text" || kind === "thinking") {
      if (!str(o.text).trim()) return;
      t.entries.push({ type: kind, text: o.text });
    } else if (kind === "tool") {
      t.entries.push({ type: "tool", id: str(o.id), name: str(o.name), detail: str(o.detail), input: o.input === undefined ? null : o.input, result: null, error: false });
    } else if (kind === "tool_result") {
      const call = t.entries.filter(e => e.type === "tool" && e.id && e.id === o.id && e.result === null)[0];
      if (call) Object.assign(call, { result: str(o.content), error: !!o.error });
      else t.entries.push({ type: "tool", id: str(o.id), name: "", detail: "", input: null, result: str(o.content), error: !!o.error });
    } else if (kind === "event") {
      t.entries.push({ type: "event", name: str(o.name), data: str(o.data) });
    } else if (kind === "usage") {
      t.usage = o;
    } else {
      return;
    }
    keepTranscript(t, false);
  }

  // The answer as the step received it. An agent that wrote it as its last message already has it there.
  function answered(t: LiveTranscript, text: string, served: string, truncated: boolean) {
    t.served = served || t.served;
    t.truncated = !!truncated;
    addText(t, text, "final");
  }

  function addText(t: LiveTranscript, text: string, mark: "final" | "partial") {
    const s = String(text || "");
    if (!s.trim()) return;
    const last = t.entries[t.entries.length - 1];
    const same = last && last.type === "text" && last.text.trim() === s.trim();
    const entry = (same ? last : { type: "text", text: s }) as Extract<Entry, { type: "text" }>;
    entry[mark] = true;
    if (!same) t.entries.push(entry);
  }

  // e is null when the step finished, or else what stopped it.
  function closeTranscript(t: LiveTranscript, e: Thrown) {
    t.ended = new Date().toISOString();
    if (!e) {
      t.status = "done";
    } else {
      const code = typeof e.code === "string" ? e.code : "upstream_error";
      t.status = code === "cancelled" ? "stopped" : "error";
      if (t.status === "error") t.error = { code, message: typeof e.message === "string" ? e.message : "" };
      if (!t.entries.some(x => x.type === "text" && x.final) && typeof e.text === "string") addText(t, e.text, "partial");
    }
    keepTranscript(t, true);
  }

  // A transcript is saved with its session a few seconds after it changes, and at once when its step ends.
  function keepTranscript(t: LiveTranscript, now: boolean) {
    if (t.sid) {
      convos.dirty[t.sid + "|" + convoKey(t.round, t.node) + "|" + t.attempt] = t;
      if (now) flushTranscripts();
      else if (!convos.timer) convos.timer = setTimeout(flushTranscripts, TRANSCRIPT_SAVE_MS);
    }
    if (convos.view) schedule();
  }

  function flushTranscripts() {
    clearTimeout(convos.timer);
    convos.timer = 0;
    const dirty = convos.dirty;
    convos.dirty = {};
    Object.keys(dirty).forEach(k => {
      const t = dirty[k];
      save(() => api("PUT", "sessions/" + t.sid + "/rounds/" + t.round + "/" + t.node + "/transcripts/" + t.attempt, { data: t }), t.sid);
    });
  }

  function roundHandoffs(round: number): Handoffs {
    return round === S.round ? S.handoffs : S.past[round - 1] || {};
  }

  // Every agent step there's a conversation for, round by round, in the order the graph runs them.
  function convoSteps(): ConvoStep[] {
    const list: ConvoStep[] = [];
    for (let r = 1; r <= S.round; r++) {
      const hs = roundHandoffs(r);
      if (!hs.brief) continue;
      Core.graphFor(hs.brief.data).order.forEach(node => {
        if (!S.seats[node]) return;
        const h = hs[node], mem = convos.mem[convoKey(r, node)], seat = r === S.round ? S.seats[node] : null;
        if (h && h.kind === "amend" && !h.data.amended) return; // no one asked anything, so no agent was asked either
        if (h || (mem && mem.length) || (seat && seat.status !== "idle" && !seat.skipped)) list.push({ round: r, node });
      });
    }
    return list;
  }

  // What a step is and who took it, for the picker.
  function convoStepName(node: string): string {
    const st = Core.stepOf(node), who = CAST[node].name;
    if (isBuilder(node)) return "Proposal " + node + " · " + who;
    if (isAsk(node)) return "Questions on Proposal " + st.letter + " · " + who;
    if (isAmend(node)) return "Answers on Proposal " + st.letter + " · " + who;
    if (isCouncil(node)) return "Review · " + who;
    if (isReviewer(node)) return "Final review · " + who;
    return (node === "final" ? "Plan, revised after the final review" : "Plan") + " · " + who;
  }

  const CONVO_STATUS: Record<string, string> = { thinking: "working", writing: "writing", error: "couldn't finish", stopped: "stopped" };
  function convoOptionLabel(s: ConvoStep): string {
    const st = s.round === S.round ? CONVO_STATUS[S.seats[s.node].status] : "";
    return convoStepName(s.node) + (st ? " (" + st + ")" : "");
  }

  function convoAria(id: string): string {
    return "Full conversation: " + convoStepName(id).replace(" · ", ", ");
  }

  // The link beside a byline to its agent's whole conversation, once the agent has started.
  function renderConvoLink(el: HTMLElement, id: string) {
    const seat = S.seats[id];
    toggle(el, seat.status !== "idle" && !seat.skipped);
    if (el.getAttribute("data-node") !== id) {
      el.setAttribute("data-node", id);
      el.setAttribute("aria-label", convoAria(id));
    }
  }

  function convoLinkHTML(id: string): string {
    const seat = S.seats[id];
    if (seat.status === "idle" || seat.skipped) return "";
    return ' <button type="button" class="link-btn convo-link" data-convo="' + id + '" aria-label="' + Core.esc(convoAria(id)) + '">Full conversation</button>';
  }

  // The step to show when the viewer is opened from the rail: whatever is working now, or else the latest.
  function defaultConvoStep(): ConvoStep | null {
    const steps = convoSteps(), now = steps.filter(x => x.round === S.round);
    return now.filter(x => S.seats[x.node].status === "thinking" || S.seats[x.node].status === "writing")[0] ||
      now[now.length - 1] || steps[steps.length - 1] || null;
  }

  function openConvo(round: number, node: string, opener?: HTMLElement | null) {
    if (!S.seats[node]) return;
    closeDrawer(false);
    convos.view = { round, node };
    convos.opener = opener || null;
    toggle(els.convo, true);
    document.documentElement.classList.add("is-convo-open");
    render();
    focusQuietly(els.convoTitle);
  }

  function closeConvo() {
    if (!convos.view) return;
    convos.view = null;
    toggle(els.convo, false);
    document.documentElement.classList.remove("is-convo-open");
    let back = convos.opener;
    convos.opener = null;
    // A link inside the questions is drawn again as they change, so find it again.
    if (back && !back.isConnected && back.getAttribute("data-convo")) back = els.questionsDoc.querySelector<HTMLElement>('[data-convo="' + back.getAttribute("data-convo") + '"]');
    if (back && back.isConnected && !back.hidden) focusQuietly(back);
  }

  function stepConvo(by: number) {
    const v = convos.view;
    if (!v) return;
    const steps = convoSteps();
    let i = -1;
    steps.forEach((x, k) => { if (x.round === v.round && x.node === v.node) i = k; });
    const next = steps[i + by];
    if (!next) return;
    convos.view = { round: next.round, node: next.node };
    render();
    if (document.activeElement && (document.activeElement as HTMLButtonElement).disabled) els.convoStep.focus();
  }

  function transcriptRows(o: any): { round: number, node: string, data: Transcript }[] {
    return (o && Array.isArray(o.transcripts) ? o.transcripts : [])
      .filter((x: any) => x && x.data && typeof x.data === "object" && Array.isArray(x.data.entries));
  }

  function loadTranscripts(round: number, node: string) {
    const key = convoKey(round, node), gen = convos.gen;
    convos.loaded[key] = "loading";
    api("GET", "sessions/" + encodeURIComponent(S.sessionId as string) + "/rounds/" + round + "/" + node + "/transcripts").then(o => {
      if (gen !== convos.gen) return;
      convos.loaded[key] = transcriptRows(o).map(x => x.data);
      schedule();
    }, (e: Error) => {
      if (gen !== convos.gen) return;
      convos.loaded[key] = [];
      convos.failed[key] = e.message;
      schedule();
    });
  }

  // A step's attempts, oldest first: what was saved of it, and what this page has made since. With none, it's rebuilt.
  function attemptsFor(round: number, node: string): Transcript[] {
    const key = convoKey(round, node), mem = convos.mem[key] || [], loaded = convos.loaded[key];
    const ids = mem.map(t => t.attempt);
    const got = Array.isArray(loaded) ? loaded.filter(t => ids.indexOf(t.attempt) < 0) : [];
    const all = got.concat(mem).sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
    if (all.length || convos.loaded[key] === "loading") return all;
    const rebuilt = rebuildTranscript(round, node);
    return rebuilt ? [rebuilt] : [];
  }

  // A step with no transcript, rebuilt from its round's handoffs: the prompt its step makes from what it was handed,
  // and the answer it handed on. What the agent did in between wasn't kept.
  function rebuildTranscript(round: number, node: string): Transcript | null {
    const hs = roundHandoffs(round), h = hs[node];
    if (!h || !h.data || !h.data.agent || !hs.brief || !PROVIDERS[h.data.agent.provider]) return null;
    const gnode = Core.graphFor(hs.brief.data).nodes[node], step = Core.STEPS[h.kind];
    if (!gnode || !step || !step.prompt || !gnode.needs.every(d => hs[d])) return null;
    const inputs: Handoffs = {};
    gnode.needs.forEach(d => { inputs[d] = hs[d]; });
    const agent: Agent = h.data.agent, kind = PROVIDERS[agent.provider], project = hs.brief.data.project || null;
    let prompt: string;
    try {
      prompt = step.prompt({ node, kind: h.kind, inputs }, { explore: !!kind.agentic, inProject: !!(kind.local && project) });
    } catch (_) {
      return null;
    }
    return {
      v: 1, attempt: "rebuilt", round, node, agent: { provider: agent.provider, model: agent.model }, served: h.data.served || "",
      cwd: kind.local && project ? project.path : "", tools: [], started: "", ended: "", status: "done", error: null,
      truncated: !!h.data.truncated, usage: null, rebuilt: true,
      entries: [{ type: "prompt", text: prompt }, { type: "text", text: String(h.data.text || ""), final: true }],
    };
  }

  function transcriptAgent(t: Transcript): string {
    if (!t.agent || !PROVIDERS[t.agent.provider]) return "";
    return Core.agentLabel(t.served ? { provider: t.agent.provider, model: t.served } : t.agent, { customUrl: creds.urls.custom });
  }

  function convoMeta(v: ConvoStep, attempts: Transcript[]): string {
    const t = attempts[attempts.length - 1];
    const parts = S.round > 1 ? ["Round " + v.round] : [];
    if (t) {
      parts.push(transcriptAgent(t));
      if (t.cwd) parts.push("in " + t.cwd);
      const ms = t.started && t.ended ? Date.parse(t.ended) - Date.parse(t.started) : NaN;
      parts.push((Core.TRANSCRIPT_STATUS[t.status] || "") + (Number.isFinite(ms) ? " after " + fmtDuration(ms) : ""));
      parts.push(Core.usageText(t.usage));
      if (attempts.length > 1) parts.push(attempts.length + " attempts");
    }
    return parts.filter(Boolean).join(" · ");
  }

  function attemptHead(t: Transcript, i: number, n: number): string {
    const where = n > 1 ? "Attempt " + (i + 1) + " of " + n : "";
    let what = "";
    if (t.status === "error") {
      const agent = t.agent && PROVIDERS[t.agent.provider] ? t.agent : null;
      what = "Couldn't finish: " + errText(t.error ? t.error.code : "", { agent, error: t.error }, "short") +
        (t.error && t.error.message ? " (" + t.error.message + ")" : "");
    } else if (t.status === "stopped") {
      what = "Stopped before it finished.";
    }
    return [where, what].filter(Boolean).join(" · ");
  }

  function fold(cls: string, open: boolean, summary: string, size: string, body: string): string {
    return '<details class="turn ' + cls + '"' + (open ? " open" : "") + "><summary>" + summary +
      (size ? '<span class="turn-size"> · ' + Core.esc(size) + "</span>" : "") + "</summary>" + body + "</details>";
  }
  const preHTML = (text: string) => '<pre class="turn-pre">' + Core.esc(text) + "</pre>";
  const labelHTML = (text: string) => '<p class="turn-label">' + Core.esc(text) + "</p>";
  function lines(text: string): string {
    const n = text ? text.replace(/\n$/, "").split("\n").length : 0;
    return n ? fmtNum(n) + (n === 1 ? " line" : " lines") : "empty";
  }
  function noteBlock(id: string, text: string): Block {
    return { id, sig: text, html: () => '<p class="convo-note">' + Core.esc(text) + "</p>" };
  }

  // One turn of the conversation, as a block the viewer shows.
  function turnBlock(e: Entry, id: string, who: string): Block {
    const esc = Core.esc;
    if (e.type === "prompt") {
      return { id, sig: "p" + e.text.length, html: () => fold("is-prompt", true, '<span class="turn-who">Quorum</span> sent ' + esc(Core.midName(who)) + " this prompt", fmtNum(e.text.length) + " characters", preHTML(e.text)) };
    }
    if (e.type === "thinking") {
      return { id, sig: "k" + e.text.length, html: () => fold("is-thinking", false, '<span class="turn-who">' + esc(who) + "</span> thought", fmtNum(Core.wordCount(e.text)) + " words", preHTML(e.text)) };
    }
    if (e.type === "text") {
      const what = e.final ? "\u2019s answer" : e.partial ? " had written this when it stopped" : " wrote";
      return {
        id, sig: "x" + e.text.length + (e.final ? "f" : "") + (e.partial ? "p" : ""),
        html: () => '<div class="turn is-' + (e.final ? "answer" : "text") + '"><p class="turn-head"><span class="turn-who">' + esc(who) + "</span>" + what +
          '</p><div class="doc turn-doc">' + Core.renderMarkdown(e.text) + "</div></div>",
      };
    }
    if (e.type === "tool") {
      const state = e.result == null ? "no result yet" : e.error ? "failed" : lines(e.result);
      return {
        id, sig: "t" + (e.result == null ? "-" : e.result.length) + (e.error ? "e" : ""),
        html: () => fold("is-tool" + (e.error ? " is-error" : ""), false, '<span class="turn-tool">' + esc(e.name || "A tool") + "</span>" + (e.detail ? " " + esc(e.detail) : ""), state,
          (e.input != null ? labelHTML("Input") + preHTML(typeof e.input === "string" ? e.input : JSON.stringify(e.input, null, 2)) : "") +
          (e.result == null ? "" : labelHTML(e.error ? "It failed" : "What came back") + preHTML(e.result))),
      };
    }
    return { id, sig: "e" + String(e.data || "").length, html: () => fold("is-tool", false, '<span class="turn-tool">' + esc(e.name || "Event") + "</span>", "", preHTML(String(e.data || ""))) };
  }

  // The conversation as the blocks the viewer shows, in order. Each has an id saying which turn it is and a signature
  // saying what it holds, so a turn that hasn't changed isn't drawn again, and a fold the reader opened stays open.
  function convoBlocks(v: ConvoStep, attempts: Transcript[]): Block[] {
    const key = convoKey(v.round, v.node), who = CAST[v.node].name, blocks: Block[] = [];
    if (convos.failed[key]) blocks.push(noteBlock("failed", "The saved conversation couldn't be loaded, so it's rebuilt from the session. " + convos.failed[key]));
    if (!attempts.length) {
      const seat = v.round === S.round ? S.seats[v.node] : null;
      blocks.push(noteBlock("empty", convos.loaded[key] === "loading" ? "Loading the conversation…" :
        seat && seat.status === "idle" ? "This step hasn't started." : "No conversation was kept for this step."));
      return blocks;
    }
    attempts.forEach((t, i) => {
      const head = attemptHead(t, i, attempts.length);
      if (head) blocks.push({ id: "h" + i, sig: head, html: () => '<p class="convo-attempt' + (t.status === "error" ? " is-error" : "") + '">' + Core.esc(head) + "</p>" });
      if (t.rebuilt) blocks.push(noteBlock("r" + i, "Rebuilt from the saved session: the prompt as this step makes it from what it was handed, and the answer it handed on. What the agent did in between wasn't kept."));
      t.entries.forEach((e, j) => blocks.push(turnBlock(e, "t" + i + "." + j, who)));
    });
    // What the agent is doing right now, until it's part of the transcript.
    const last = attempts[attempts.length - 1], seat = S.seats[v.node];
    if (last.status === "running" && v.round === S.round && (seat.status === "thinking" || seat.status === "writing")) {
      const end = last.entries[last.entries.length - 1];
      const written = end && end.type === "text" && end.text.trim() === seat.text.trim();
      if (seat.status === "writing" && seat.text.trim() && !written) {
        blocks.push({
          id: "live", sig: "w" + seat.text.length, live: true,
          html: () => '<div class="turn is-text is-live"><p class="turn-head"><span class="turn-who">' + Core.esc(who) + '</span> is writing</p><div class="doc turn-doc">' + Core.renderMarkdown(seat.text) + "</div></div>",
          after: el => appendCaret(el.querySelector(".turn-doc") as Element),
        });
      } else {
        const p = placeholderFor(v.node);
        blocks.push({ id: "live", sig: "p" + p.text, live: true, html: () => '<p class="placeholder convo-wait"><span class="pulse" aria-hidden="true"></span><span>' + Core.esc(p.text) + "</span></p>" });
      }
    }
    return blocks;
  }

  function patchBlocks(target: HTMLElement, blocks: Block[], key: string) {
    const root = target as HTMLElement & Drawn;
    if (root._key !== key) {
      root._key = key;
      root.innerHTML = "";
      root.scrollTop = 0;
    }
    const pinned = root.scrollHeight - root.scrollTop - root.clientHeight < 60;
    blocks.forEach((b, i) => {
      const old = root.children[i] as (HTMLElement & Drawn) | undefined;
      if (old && old._id === b.id && old._sig === b.sig) return;
      const box = document.createElement("div");
      box.innerHTML = b.html();
      const el = box.firstElementChild as HTMLElement & Drawn;
      el._id = b.id;
      el._sig = b.sig;
      if (b.after) b.after(el);
      if (old && old._id === b.id && old.tagName === "DETAILS" && el.tagName === "DETAILS") (el as HTMLDetailsElement).open = (old as HTMLDetailsElement).open;
      if (old) root.replaceChild(el, old);
      else root.appendChild(el);
    });
    while (root.children.length > blocks.length) root.removeChild(root.lastElementChild as Element);
    // A reader at the bottom of a conversation that's still going stays at the bottom.
    if (pinned && blocks.length && blocks[blocks.length - 1].live) root.scrollTop = root.scrollHeight;
  }

  function renderConvo() {
    const v = convos.view;
    if (!v) return;
    const key = convoKey(v.round, v.node);
    let steps = convoSteps();
    if (!steps.some(x => convoKey(x.round, x.node) === key)) steps = steps.concat([v]);
    const labels = steps.map(convoOptionLabel);
    const sig = steps.map((x, i) => convoKey(x.round, x.node) + "=" + labels[i]).join("|");
    const picker = els.convoStep as HTMLSelectElement & Drawn;
    if (picker._sig !== sig) {
      picker._sig = sig;
      const grouped = steps.some(x => x.round !== steps[0].round);
      let html = "", round = 0;
      steps.forEach((x, i) => {
        if (grouped && x.round !== round) {
          html += (round ? "</optgroup>" : "") + '<optgroup label="Round ' + x.round + '">';
          round = x.round;
        }
        html += '<option value="' + convoKey(x.round, x.node) + '">' + Core.esc(labels[i]) + "</option>";
      });
      els.convoStep.innerHTML = html + (grouped ? "</optgroup>" : "");
    }
    if (els.convoStep.value !== key) els.convoStep.value = key;
    let i = -1;
    steps.forEach((x, k) => { if (convoKey(x.round, x.node) === key) i = k; });
    els.convoPrev.disabled = i <= 0;
    els.convoNext.disabled = i < 0 || i >= steps.length - 1;
    setLetter(els.convoPanel, isBuilder(v.node) ? v.node : Core.stepOf(v.node).letter || "");
    if (S.sessionId && convos.fromServer && convos.loaded[key] === undefined) loadTranscripts(v.round, v.node);
    const attempts = attemptsFor(v.round, v.node);
    setText(els.convoMeta, convoMeta(v, attempts));
    patchBlocks(els.convoBody, convoBlocks(v, attempts), S.session + "|" + key);
    els.convoCopy.disabled = !attempts.length;
    toggle(els.convoSaveAll, !!downloadsNS || !INSIDE);
  }

  function convoMarkdown(round: number, node: string): string {
    const attempts = attemptsFor(round, node);
    if (!attempts.length) return "";
    return Core.conversationMarkdown(attempts, {
      title: (S.round > 1 ? "Round " + round + ": " : "") + convoStepName(node),
      who: CAST[node].name,
      agent: transcriptAgent,
    });
  }

  // Every agent's conversation in the session, as one Markdown file. A reopened session's are fetched first.
  async function saveAllConvos(btn: HTMLElement) {
    if (S.sessionId && convos.fromServer && !convos.all) {
      const gen = convos.gen;
      let o;
      try {
        o = await api("GET", "sessions/" + encodeURIComponent(S.sessionId) + "/transcripts");
      } catch (_) {
        flash(btn, "Couldn't load them");
        return;
      }
      if (gen !== convos.gen) return;
      const by: Record<string, Transcript[]> = {};
      transcriptRows(o).forEach(x => { const k = convoKey(x.round, x.node); (by[k] = by[k] || []).push(x.data); });
      convoSteps().forEach(x => { const k = convoKey(x.round, x.node); if (!by[k]) by[k] = []; });
      Object.keys(by).forEach(k => { if (!Array.isArray(convos.loaded[k])) convos.loaded[k] = by[k]; });
      convos.all = true;
    }
    const b = brief();
    const head = "# Every agent\u2019s conversation\n\n" + String(b.feature).trim().split("\n").map(l => "> " + l).join("\n") + "\n\n" +
      "Each step of the session, in the order it ran: what Quorum sent the agent, what the agent did with its tools, and the answer the step took.\n\n";
    const body = convoSteps().map(x => convoMarkdown(x.round, x.node)).filter(Boolean).join("\n---\n\n");
    await saveText("council-conversations-" + fileBase() + ".md", head + body, btn);
  }

  // The viewer holds focus while it's open, and Escape closes it.
  function onConvoKey(e: KeyboardEvent) {
    holdFocus(e, els.convoPanel, els.convoTitle, closeConvo);
  }

  // A panel over the page holds focus while it's open, and Escape closes it.
  function holdFocus(e: KeyboardEvent, panel: HTMLElement, title: HTMLElement, close: () => void) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const all: HTMLElement[] = Array.prototype.slice.call(panel.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]"))
      .filter((el: HTMLButtonElement) => el.tabIndex >= 0 && !el.disabled && !el.closest("[hidden]"));
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === title)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ---------- Tokens used ---------- */

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n < 1e4 ? (n / 1e3).toFixed(1) : String(Math.round(n / 1e3))).replace(/\.0$/, "") + "k";
    return (n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\.?0+$/, "") + "M";
  }

  // What the agents have used, by provider and model, as the rail shows it: every attempt at every step this page ran,
  // in every round, and naming the session. A running step counts what its provider has reported so far.
  function usageByAgent() {
    // pending: a run that's still going hasn't said what it used yet.
    type Row = { label: string, input: number, output: number, cost: number, counted: boolean, costed: boolean, pending: boolean };
    const rows: Record<string, Row> = {};
    const runs: { agent: Agent, served: string, usage: Usage | null, status: string }[] = [];
    Object.keys(convos.mem).forEach(k => convos.mem[k].forEach(t => runs.push(t)));
    if (nameUsage) runs.push(nameUsage);
    runs.forEach(t => {
      if (!t.agent || !PROVIDERS[t.agent.provider]) return;
      const model = t.served || t.agent.model, key = t.agent.provider + "\u0000" + model;
      const r = rows[key] || (rows[key] = {
        label: Core.agentLabel({ provider: t.agent.provider, model }, { customUrl: creds.urls.custom }),
        input: 0, output: 0, cost: 0, counted: false, costed: false, pending: false,
      });
      const u = t.usage;
      if (!u) {
        if (t.status === "running") r.pending = true;
        return;
      }
      if (typeof u.inputTokens === "number" || typeof u.outputTokens === "number") {
        r.input += u.inputTokens || 0;
        r.output += u.outputTokens || 0;
        r.counted = true;
      }
      if (typeof u.costUsd === "number") {
        r.cost += u.costUsd;
        r.costed = true;
      }
    });
    return Object.keys(rows).map(k => rows[k]);
  }

  function renderUsage() {
    const rows = S.phase === "idle" ? [] : usageByAgent();
    toggle(els.railUsage, rows.length > 0);
    if (!rows.length) return;
    const money = (n: number) => "$" + n.toFixed(n < 1 ? 4 : 2);
    const line = (who: string, r: { input: number, output: number, cost: number, counted: boolean, costed: boolean, pending: boolean }, total?: boolean) =>
      '<li class="rail-usage-row' + (total ? " is-total" : "") + '"><span class="rail-usage-who">' + Core.esc(who) + '</span> <span class="rail-usage-n">' +
      (r.counted ? fmtTokens(r.input) + " in \u00B7 " + fmtTokens(r.output) + " out" : r.pending ? "Counting\u2026" : "Not reported") +
      (r.costed ? " \u00B7 " + money(r.cost) : "") + "</span></li>";
    const counted = rows.filter(r => r.counted);
    const sum = {
      input: counted.reduce((n, r) => n + r.input, 0), output: counted.reduce((n, r) => n + r.output, 0),
      cost: rows.reduce((n, r) => n + r.cost, 0), counted: counted.length > 0, costed: rows.some(r => r.costed), pending: rows.some(r => r.pending),
    };
    setHTML(els.railUsageList, rows.map(r => line(r.label, r)).join("") + (rows.length > 1 ? line("Total", sum, true) : ""));
  }

  /* ---------- Settings and History ---------- */

  // The agents and providers, and the saved sessions, open from the foot of the rail in drawers, one at a time.
  const DRAWERS = {
    settings: { el: els.settingsDrawer, title: els.settingsTitle, button: els.openSettings },
    history: { el: els.historyDrawer, title: els.historyTitle, button: els.openHistory },
  };
  type DrawerName = keyof typeof DRAWERS;
  let drawer: { name: DrawerName, opener: HTMLElement | null } | null = null;

  function showDrawer(name: DrawerName, opener?: HTMLElement | null) {
    if (drawer && drawer.name === name) return;
    closeDrawer(false);
    closeConvo();
    const d = DRAWERS[name];
    drawer = { name, opener: opener || d.button };
    toggle(d.el, true);
    d.button.setAttribute("aria-expanded", "true");
    document.documentElement.classList.add("is-drawer-open");
    if (name === "history" && canSave()) refreshSessions();
    render();
    focusQuietly(d.title);
  }

  // restore: give focus back to what opened the drawer.
  function closeDrawer(restore = true) {
    if (!drawer) return;
    const d = DRAWERS[drawer.name], back = drawer.opener;
    drawer = null;
    toggle(d.el, false);
    d.button.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("is-drawer-open");
    if (restore && back && back.isConnected && !back.hidden) focusQuietly(back);
  }

  function agentsSummary(): string {
    const agents = currentAgents(), opts = { customUrl: creds.urls.custom };
    return Core.agentsSentence(agents, opts) + (reviewing() ? " The final review on " + Core.agentLabel(agents.review, opts) + "." : "");
  }

  /* ---------- Events ---------- */

  els.convene.addEventListener("click", () => {
    if (S.phase === "running") {
      if (Date.now() - S.convenedAt > 400) stop();
      return;
    }
    if (Date.now() - S.stoppedAt < 400) return;
    convene();
  });
  els.resume.addEventListener("click", resume);
  els.railStop.addEventListener("click", stop);
  els.noticeRetry.addEventListener("click", resume);
  els.noticeDismiss.addEventListener("click", () => {
    S.notice = null;
    render();
  });
  els.feature.addEventListener("input", () => {
    autosize();
    dropUndo();
    saveDraftSoon();
    if (!els.featureNote.hidden && els.feature.value.trim()) showFieldNote("");
  });
  els.feature.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (S.phase !== "running") convene();
    }
  });
  function useExample(btn: HTMLElement) {
    const ex = EXAMPLES[Number(btn.getAttribute("data-example"))];
    if (!ex || S.phase === "running") return;
    const before = formHasContent() ? snapshotForm() : null;
    setForm(ex);
    showFieldNote("");
    showContextNote("");
    exampleUndo = before;
    els.exampleNote.hidden = !before;
    els.feature.focus();
  }
  els.undoExample.addEventListener("click", () => {
    if (!exampleUndo) return;
    const snap = exampleUndo;
    exampleUndo = null;
    els.exampleNote.hidden = true;
    setForm(snap);
    els.feature.focus();
  });
  addBtns.filter(btn => btn.hasAttribute("data-kind")).forEach(btn => {
    btn.addEventListener("click", () => {
      if (S.phase === "running") return;
      dropUndo();
      addContext(btn.getAttribute("data-kind") as string, null, "", true);
      saveContext();
    });
  });
  els.addFiles.addEventListener("click", () => {
    if (S.phase !== "running") els.fileInput.click();
  });
  els.fileInput.addEventListener("change", () => {
    const files: File[] = Array.prototype.slice.call(els.fileInput.files || []);
    els.fileInput.value = "";
    addFiles(files);
  });
  els.context.addEventListener("dragover", e => {
    if (!carriesFiles(e) || S.phase === "running") return;
    e.preventDefault();
    (e.dataTransfer as DataTransfer).dropEffect = "copy";
    els.context.classList.add("is-dropping");
  });
  els.context.addEventListener("dragleave", e => {
    if (!els.context.contains(e.relatedTarget as Node | null)) els.context.classList.remove("is-dropping");
  });
  els.context.addEventListener("drop", e => {
    els.context.classList.remove("is-dropping");
    if (!carriesFiles(e)) return;
    e.preventDefault();
    addFiles((e.dataTransfer as DataTransfer).files);
  });
  // A file dropped anywhere else would replace the page with the file, and the session with it.
  window.addEventListener("dragover", e => {
    if (!carriesFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    (e.dataTransfer as DataTransfer).dropEffect = "none";
  });
  window.addEventListener("drop", e => { if (carriesFiles(e)) e.preventDefault(); });
  exampleBtns.forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      useExample(btn);
    });
    btn.addEventListener("keydown", e => {
      if (e.key === " ") {
        e.preventDefault();
        useExample(btn);
      }
    });
  });
  ROLES.forEach(r => {
    providerSelects[r.id].addEventListener("change", () => onProviderChange(r.id));
    tierSelects[r.id].addEventListener("change", () => {
      lastModel[r.id].claude = tierSelects[r.id].value;
      saveAgents();
      render();
    });
    modelFields[r.id].addEventListener("input", () => {
      lastModel[r.id][providerSelects[r.id].value] = modelFields[r.id].value.trim();
      if (!els.agentsNote.hidden) showAgentsNote("");
      saveAgents();
      render();
    });
  });
  EXTERNAL.forEach(p => {
    credFields.keys[p].addEventListener("input", () => {
      creds.keys[p] = credFields.keys[p].value.trim();
      if (!els.agentsNote.hidden) showAgentsNote("");
      saveCreds();
      render();
    });
    credFields.remember[p].addEventListener("change", () => {
      creds.remember[p] = credFields.remember[p].checked;
      saveCreds();
    });
  });
  ["hermes", "custom"].forEach(p => {
    credFields.urls[p].addEventListener("input", () => {
      creds.urls[p] = credFields.urls[p].value.trim();
      if (!els.agentsNote.hidden) showAgentsNote("");
      saveCreds();
      render();
    });
    $<HTMLButtonElement>("check-" + p).addEventListener("click", () => checkConnection(p));
  });
  els.reviseBtn.addEventListener("click", revise);
  els.reviseInput.addEventListener("input", () => { if (!els.reviseNote.hidden) showReviseNote(""); });
  els.reviseInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      revise();
    }
  });
  // Delete asks once more before it deletes.
  els.sessionList.addEventListener("click", e => {
    const btn = (e.target as Element).closest("button");
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute("data-open")) {
      saved.confirm = "";
      openSession(btn.getAttribute("data-open") as string);
    } else if (btn.hasAttribute("data-delete")) {
      const id = btn.getAttribute("data-delete") as string;
      if (saved.confirm === id) {
        saved.confirm = "";
        deleteSession(id);
      } else {
        saved.confirm = id;
        render();
        const again = els.sessionList.querySelector<HTMLElement>('[data-delete="' + id + '"]');
        if (again) again.focus();
      }
    }
  });
  els.projectPath.addEventListener("input", () => {
    proj.note = "";
    store.set("quorum:project", els.projectPath.value);
    clearTimeout(projectTimer);
    const text = els.projectPath.value.trim();
    projectTimer = setTimeout(() => checkProject(text), 300);
    render();
  });
  els.projectPath.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      checkProject(els.projectPath.value.trim());
    }
  });
  els.projectBrowse.addEventListener("click", () => {
    proj.browsing = !proj.browsing;
    if (proj.browsing && !proj.listing) {
      getFolder((local as LocalInfo).project || "").then(l => {
        if (!proj.listing) proj.listing = l;
        schedule();
      }, (e: { message: string }) => {
        proj.error = e.message;
        schedule();
      });
    }
    render();
  });
  // Choosing a folder in the browser makes it the project, and shows what's inside it.
  els.projectDirs.addEventListener("click", e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-path]");
    if (!btn || btn.disabled) return;
    chooseProject(btn.getAttribute("data-path") as string).then(() => {
      render();
      const first = els.projectDirs.querySelector("button");
      if (first && proj.browsing) first.focus();
    });
  });
  lengthInputs.forEach(inp => {
    inp.addEventListener("change", () => {
      store.set("quorum:length", currentLength());
      render();
    });
  });
  wireTabs($("propTabs"), "proposals", LETTERS);
  wireTabs($("councilTabs"), "council", COUNCIL_IDS);
  wireTabs($("reviewTabs"), "review", REVIEWER_IDS);
  wireTabs($("questionTabs"), "questions", LETTERS, "qtab-");
  els.questionsOn.addEventListener("change", () => {
    store.set("quorum:questions", els.questionsOn.checked ? "on" : "off");
    render();
  });
  els.reviewOn.addEventListener("change", () => {
    store.set("quorum:review", els.reviewOn.checked ? "on" : "");
    if (!els.agentsNote.hidden) showAgentsNote("");
    render();
  });
  SEAT_IDS.forEach(id => {
    const g = seatEls[id];
    g.addEventListener("click", () => jumpToSeat(id));
    g.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jumpToSeat(id);
      }
    });
  });
  stageBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-stage") as Section;
      if (!S.revealed[key]) return;
      const sec = $(btn.getAttribute("data-target") as string);
      scrollToSection(sec);
      focusQuietly(sec.querySelector(".sec-title") as HTMLElement);
    });
  });
  els.copyPlan.addEventListener("click", async () => {
    const plan = planHandoff();
    if (!plan) return;
    const ok = await copyText(plan.text.trim() + "\n");
    flash(els.copyPlan, ok ? "Copied" : "Couldn't copy");
  });
  els.dlPlan.addEventListener("click", () => saveFile("plan", els.dlPlan));
  els.dlRecord.addEventListener("click", () => saveFile("record", els.dlRecord));
  [els.propConvo, els.councilConvo, els.reviewConvo, els.planConvo].forEach(btn => {
    btn.addEventListener("click", () => openConvo(S.round, btn.getAttribute("data-node") as string, btn));
  });
  els.questionsDoc.addEventListener("click", e => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-convo]");
    if (btn) openConvo(S.round, btn.getAttribute("data-convo") as string, btn);
  });
  els.roundsList.addEventListener("click", e => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-convo-round]");
    if (!btn) return;
    const first = convoSteps().filter(x => x.round === Number(btn.getAttribute("data-convo-round")))[0];
    if (first) openConvo(first.round, first.node, btn);
  });
  els.railConvo.addEventListener("click", () => {
    const at = defaultConvoStep();
    if (at) openConvo(at.round, at.node, els.railConvo);
  });
  els.convoClose.addEventListener("click", closeConvo);
  els.convoScrim.addEventListener("click", closeConvo);
  els.convo.addEventListener("keydown", onConvoKey);
  els.openSettings.addEventListener("click", () => (drawer && drawer.name === "settings" ? closeDrawer() : showDrawer("settings", els.openSettings)));
  els.openHistory.addEventListener("click", () => (drawer && drawer.name === "history" ? closeDrawer() : showDrawer("history", els.openHistory)));
  els.changeAgents.addEventListener("click", () => showDrawer("settings", els.changeAgents));
  (Object.keys(DRAWERS) as DrawerName[]).forEach(name => {
    const d = DRAWERS[name];
    d.el.addEventListener("keydown", e => holdFocus(e, d.el.querySelector(".drawer-panel") as HTMLElement, d.title, () => closeDrawer()));
    d.el.addEventListener("click", e => { if ((e.target as Element).closest("[data-close]")) closeDrawer(); });
    d.button.setAttribute("aria-expanded", "false");
  });
  els.convoStep.addEventListener("change", () => {
    const m = /^(\d+):(.+)$/.exec(els.convoStep.value);
    if (!m || !convos.view) return;
    convos.view = { round: Number(m[1]), node: m[2] };
    render();
  });
  els.convoPrev.addEventListener("click", () => stepConvo(-1));
  els.convoNext.addEventListener("click", () => stepConvo(1));
  els.convoCopy.addEventListener("click", async () => {
    const v = convos.view;
    const md = v ? convoMarkdown(v.round, v.node) : "";
    if (!md) return;
    flash(els.convoCopy, (await copyText(md)) ? "Copied" : "Couldn't copy");
  });
  els.convoSaveAll.addEventListener("click", () => saveAllConvos(els.convoSaveAll));
  window.addEventListener("resize", () => {
    autosize();
    ctxItems.forEach(it => sizeContext(it.textEl));
  });

  /* ---------- Start ---------- */

  const draft = store.get("quorum:draft");
  if (draft) els.feature.value = draft;
  let savedContext: any = [];
  try { savedContext = JSON.parse(store.get("quorum:context") || "[]"); } catch (_) { savedContext = []; }
  if (Array.isArray(savedContext)) {
    savedContext.forEach((c: any) => { if (c && typeof c === "object") addContext(c.kind, c.title, c.text); });
  }
  loadCreds();
  setProviderOptions();
  writeProvidersIntro();
  writeHermesHelp();
  fillDatalist("models-openrouter", modelLists.openrouter);
  let savedAgents: any = null;
  try { savedAgents = JSON.parse(store.get("quorum:agents") || "null"); } catch (_) { savedAgents = null; }
  if (!savedAgents && INSIDE) {
    // Earlier versions saved only Claude tiers per role.
    let tiers: any = null;
    try { tiers = JSON.parse(store.get("quorum:models") || "null"); } catch (_) { tiers = null; }
    if (tiers && typeof tiers === "object") {
      savedAgents = {};
      ROLES.forEach(r => { savedAgents[r.id] = { provider: "claude", model: tiers[r.id] }; });
    }
  }
  applyAgents(Core.normalizeAgents(savedAgents, INSIDE));
  fillDatalist("models-claude-code", Core.CLAUDE_CODE_MODELS);
  // On its own, open the providers panel until something is set up, and fetch OpenRouter's model list for the pickers.
  let providersOpenedForSetup = false;
  if (!INSIDE) {
    if (!EXTERNAL.some(providerReady)) els.providers.open = providersOpenedForSetup = true;
    Providers.listModels("openrouter", credsSnapshot()).then(list => {
      if (!list.length) return;
      const seen: Record<string, boolean> = {};
      const merged = Core.OPENROUTER_PRESETS.concat(list).filter(m => (seen[m.id] ? false : (seen[m.id] = true)));
      modelLists.openrouter = merged;
      fillDatalist("models-openrouter", merged);
    }, () => { /* keep the presets */ });
  }
  // With Quorum's local server, offer the project folder, and until other agents are chosen, put every seat on Claude Code.
  localReady.then(info => {
    local = info;
    localState = info ? "ready" : "none";
    setProviderOptions();
    if (info) {
      const start = info.project || store.get("quorum:project") || "";
      els.projectPath.value = start;
      if (start.trim()) checkProject(start.trim());
      if (!savedAgents && info.claudeCode.available) {
        const agents: Agents = {};
        ROLES.forEach(r => { agents[r.id] = { provider: "claude-code", model: "" }; });
        applyAgents(agents);
        if (providersOpenedForSetup) els.providers.open = false;
      }
    }
    render();
    if (!canSave()) return;
    // A session named in the address opens again. History counts any unfinished ones.
    const m = /^#session=([\w-]+)$/.exec(location.hash);
    refreshSessions().then(() => {
      if (m) openSession(m[1]);
      render();
    });
  });
  els.reviewOn.checked = store.get("quorum:review") === "on";
  els.questionsOn.checked = store.get("quorum:questions") !== "off";
  const savedLength = store.get("quorum:length");
  if (savedLength && LENGTHS[savedLength]) lengthInputs.forEach(i => { i.checked = i.value === savedLength; });
  restoreSession();
  autosize();
  render();
})(Core, Graph);
