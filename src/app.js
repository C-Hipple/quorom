(function (Core, Graph) {
  "use strict";

  const LETTERS = Core.LETTERS, BUILDERS = Core.BUILDERS, COUNCIL = Core.COUNCIL, CHAIR = Core.CHAIR;
  const TIERS = Core.TIERS, ROLES = Core.ROLES, LENGTHS = Core.LENGTHS, PROVIDERS = Core.PROVIDERS;
  // Inside claude.ai the page gets the Claude runtime but can't reach other services; on its own it's the reverse.
  const INSIDE = !!(window.claude && typeof window.claude.use === "function");
  // Served by Quorum's local server (serve.js), the page can also choose a project folder and run Claude Code in it.
  const ON_WEB = !INSIDE && /^https?:$/.test(location.protocol);
  const COUNCIL_IDS = COUNCIL.map(c => c.id);
  const REVIEWERS = Core.REVIEWERS, REVIEWER_IDS = Core.REVIEWER_IDS;
  // The seats in the chamber's seating chart, and every step an agent works on. The Chair's seat also shows its
  // revision after the final review, the "final" step.
  // A councilor's questions and a builder's answers show on their seats too.
  const ASK_IDS = Core.ASK_IDS, AMEND_IDS = Core.AMEND_IDS, askId = Core.askId, amendId = Core.amendId;
  const SEAT_IDS = LETTERS.concat(COUNCIL_IDS, ["chair"]);
  const ALL_IDS = SEAT_IDS.concat(ASK_IDS, AMEND_IDS, REVIEWER_IDS, ["final"]);
  const CAST = {};
  ALL_IDS.forEach(id => { CAST[id] = Core.stepOf(id).cast; });
  const isBuilder = id => LETTERS.indexOf(id) >= 0;
  const isCouncil = id => COUNCIL_IDS.indexOf(id) >= 0;
  const isReviewer = id => REVIEWER_IDS.indexOf(id) >= 0;
  const isAsk = id => ASK_IDS.indexOf(id) >= 0;
  const isAmend = id => AMEND_IDS.indexOf(id) >= 0;

  // A step's name where the page says it couldn't finish.
  function stepName(id) {
    const st = Core.stepOf(id);
    if (isAsk(id)) return st.cast.name + "'s questions on Proposal " + st.letter;
    if (isAmend(id)) return st.cast.name + "'s answers to the council";
    return st.cast.name;
  }

  const EXAMPLES = [
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

  const CONTEXT_KINDS = {
    requirements: { title: "Product requirements", placeholder: "Paste the requirements, user stories or acceptance criteria." },
    today: { title: "How it works today", placeholder: "Describe the parts of the system this touches: the stack, services, data model and how the current flow works." },
    constraints: { title: "Constraints", placeholder: "Deadlines, team size, performance or compliance needs, and anything that can't change." },
    code: { title: "Relevant code", placeholder: "Paste the files or snippets the feature will touch.", code: true },
    other: { title: "", placeholder: "Anything else the council should know." },
  };
  const CONTEXT_LIMIT = Core.CONTEXT_LIMIT;

  // kind: fatal = Claude can't be used in this view; stop = needs a change first; retry = the viewer may retry.
  // {provider} and {hint} are filled in from the seat that failed.
  const ERRORS = {
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
    not_found: { kind: "retry", msg: "{provider} answered \u201Cnot found\u201D. Check the address under Providers, which usually ends in /v1, and the model name, then retry.", short: "{provider} answered \u201Cnot found\u201D." },
    unreachable: { kind: "retry", msg: "Couldn't reach {provider}. {hint}", short: "Couldn't reach {provider}." },
    bad_request: { kind: "retry", msg: "{provider} rejected the request{detail}. Check the model and provider settings, then retry.", short: "{provider} rejected the request." },
    project_missing: { kind: "retry", msg: "Claude Code couldn't open the project folder. Check that it's still there, then retry.", short: "Claude Code couldn't open the project folder." },
    claude_code_missing: { kind: "retry", msg: "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path, then retry.", short: "Quorum's server couldn't find Claude Code." },
  };
  const errInfo = code => ERRORS[code] || ERRORS.upstream_error;
  // Where a provider needs other advice than the general message.
  const PROVIDER_ERRORS = {
    "claude-code": {
      auth_failed: { msg: "Claude Code isn't signed in. Run claude in a terminal and sign in, then retry.", short: "Claude Code isn't signed in." },
    },
  };

  function pageOrigin() {
    return /^https?:$/.test(location.protocol) ? location.origin : "";
  }

  function unreachableHint(provider) {
    const origin = pageOrigin();
    if (provider === "hermes") {
      return "Check that hermes gateway is running" + (origin ? " and that API_SERVER_CORS_ORIGINS includes " + origin : ", and open Quorum from a local web server so Hermes can allow it") + ", then retry.";
    }
    if (provider === "custom") return "Check the address, and that the service accepts requests from this page, then retry.";
    if (provider === "claude-code") return "Check that Quorum's server, which npm start runs, is still running, then retry.";
    return "Check your internet connection, then retry.";
  }

  // An error's message, with the provider of the seat that failed filled in.
  function errText(code, seat, field) {
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

  const STAGE_WORDS = { waiting: "Waiting", active: "In progress", done: "Done", paused: "Paused", stopped: "Stopped", tied: "Tied" };

  /* ---------- Elements ---------- */

  const $ = id => document.getElementById(id);
  const els = {
    feature: $("feature"), featureNote: $("featureNote"), convene: $("convene"), resume: $("resume"),
    exampleNote: $("exampleNote"), undoExample: $("undoExample"), contextCount: $("contextCount"), contextNote: $("contextNote"),
    motionContext: $("motionContext"), motionContextSummary: $("motionContextSummary"), motionContextBody: $("motionContextBody"),
    settingsHint: $("settingsHint"), tierNote: $("tierNote"), agentsNote: $("agentsNote"), roster: $("roster"),
    providers: $("providers"), providersStatus: $("providersStatus"), providersIntro: $("providersIntro"), helpHermes: $("help-hermes"),
    status: $("status"), clock: $("clock"), railStop: $("railStop"),
    secProposals: $("sec-proposals"), secCouncil: $("sec-council"), secVote: $("sec-vote"), secPlan: $("sec-plan"),
    motionQuote: $("motionQuote"), propCount: $("propCount"), propPane: $("propPane"), propByline: $("propByline"),
    propDoc: $("propDoc"), propNote: $("propNote"), propTier: $("propTier"), councilTier: $("councilTier"), planTier: $("planTier"),
    councilCount: $("councilCount"), councilPane: $("councilPane"), councilByline: $("councilByline"),
    councilDoc: $("councilDoc"), ballot: $("ballot"), councilNote: $("councilNote"),
    division: $("division"), verdict: $("verdict"),
    plan: $("plan"), planByline: $("planByline"), planDoc: $("planDoc"), planNote: $("planNote"),
    planActions: $("planActions"), copyPlan: $("copyPlan"), dlPlan: $("dlPlan"), dlRecord: $("dlRecord"),
    notice: $("notice"), noticeText: $("noticeText"), noticeRetry: $("noticeRetry"), noticeDismiss: $("noticeDismiss"),
    project: $("project"), projectPath: $("projectPath"), projectBrowse: $("projectBrowse"), projectStatus: $("projectStatus"),
    projectBrowser: $("projectBrowser"), projectWhere: $("projectWhere"), projectDirs: $("projectDirs"), motionProject: $("motionProject"),
    statusClaudeCode: $("status-claude-code"),
    sessions: $("sessions"), sessionsStatus: $("sessionsStatus"), sessionsIntro: $("sessionsIntro"), sessionList: $("sessionList"),
    saveState: $("saveState"), motionRound: $("motionRound"), motionRoundIntro: $("motionRoundIntro"), motionRoundQuote: $("motionRoundQuote"),
    revise: $("revise"), reviseInput: $("reviseInput"), reviseNote: $("reviseNote"), reviseBtn: $("reviseBtn"),
    secRounds: $("sec-rounds"), roundsList: $("roundsList"),
    reviewOn: $("reviewOn"), rowReview: $("row-review"), stageReview: $("stageReview"), questionsOn: $("questionsOn"), stageQuestions: $("stageQuestions"),
    secQuestions: $("sec-questions"), questionsCount: $("questionsCount"), questionsPane: $("questionsPane"), questionsDoc: $("questionsDoc"),
    propDraft: $("propDraft"), propDraftDoc: $("propDraftDoc"),
    secReview: $("sec-review"), reviewCount: $("reviewCount"), reviewPane: $("reviewPane"), reviewByline: $("reviewByline"),
    reviewTier: $("reviewTier"), reviewDoc: $("reviewDoc"), reviewNote: $("reviewNote"), planDraft: $("planDraft"), planDraftDoc: $("planDraftDoc"),
  };
  const providerSelects = {}, tierSelects = {}, modelFields = {};
  ROLES.forEach(r => {
    providerSelects[r.id] = $("provider-" + r.id);
    tierSelects[r.id] = $("tier-" + r.id);
    modelFields[r.id] = $("model-" + r.id);
  });
  const credFields = {
    keys: { openrouter: $("key-openrouter"), hermes: $("key-hermes"), custom: $("key-custom") },
    urls: { hermes: $("url-hermes"), custom: $("url-custom") },
    remember: { openrouter: $("remember-openrouter"), hermes: $("remember-hermes"), custom: $("remember-custom") },
  };
  const providerSets = { openrouter: $("set-openrouter"), hermes: $("set-hermes"), custom: $("set-custom") };
  const EXTERNAL = ["openrouter", "hermes", "custom"];
  const lengthInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="length"]'));
  const exampleBtns = Array.prototype.slice.call(document.querySelectorAll(".example"));
  const addBtns = Array.prototype.slice.call(document.querySelectorAll(".add-btn"));
  const stageBtns = Array.prototype.slice.call(document.querySelectorAll(".stage-btn"));
  const seatEls = {};
  SEAT_IDS.forEach(id => { seatEls[id] = document.querySelector('[data-seat="' + id + '"]'); });
  const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (_) { /* storage unavailable */ } },
    remove(k) { try { window.localStorage.removeItem(k); } catch (_) { /* storage unavailable */ } },
  };

  /* ---------- State ---------- */

  const S = {
    phase: "idle", // idle | running | paused | stopped | blocked | done
    token: 0,
    session: 0,
    handoffs: {}, // node id to frozen handoff, for each step of this round that has finished
    round: 1, // the round of the session: each round after the first revises the last plan with the requester's input
    past: [], // the handoffs of each earlier round, oldest first
    sessionId: null, // the id of the saved session, when Quorum's local server saves sessions
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
  let sampleFn = null;
  let sampleState = "pending"; // pending | ready | none | blocked
  let downloadsNS = null;
  let clockTimer = 0;

  function freshSeat() {
    return { status: "idle", text: "", error: null, truncated: false, ctl: null, agent: null, served: "", activity: "", skipped: false };
  }
  function resetSeats() {
    ALL_IDS.forEach(id => { S.seats[id] = freshSeat(); });
  }
  resetSeats();

  if (window.__QUORUM_TEST__) window.__quorum = { S, saved: () => saved.queue };

  /* ---------- Capabilities ---------- */

  function useCapability(name) {
    const c = window.claude;
    if (!c || typeof c.use !== "function") return Promise.resolve(null);
    try {
      return Promise.resolve(c.use(name)).then(v => v || null, () => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  const sampleReady = useCapability("sample").then(fn => {
    sampleFn = typeof fn === "function" ? fn : null;
    if (sampleState === "pending") sampleState = sampleFn ? "ready" : "none";
    schedule();
    return sampleFn;
  });

  // What Quorum's local server says: { claudeCode: { available, version }, project, home }, or null without one.
  let local = null;
  let localState = ON_WEB ? "pending" : "none"; // pending | ready | none
  function localUrl(route) {
    return location.origin + "/api/" + route;
  }
  const localReady = ON_WEB && typeof fetch === "function" ?
    fetch(localUrl("local")).then(r => (r.ok ? r.json() : null)).then(o => (o && o.claudeCode ? o : null), () => null) :
    Promise.resolve(null);

  useCapability("downloads").then(ns => {
    downloadsNS = ns && typeof ns.save === "function" ? ns : null;
    schedule();
  });

  /* ---------- Derived values ---------- */

  function currentAgents() {
    const a = {};
    ROLES.forEach(r => {
      const provider = providerSelects[r.id].value;
      a[r.id] = { provider, model: provider === "claude" ? tierSelects[r.id].value : modelFields[r.id].value.trim() };
    });
    return a;
  }

  // The roles a session uses: the review role only with a final review.
  function activeRoles(review) {
    return ROLES.filter(r => !r.optional || review);
  }

  // Whether the session has a final review, and the council's questions: as chosen before it convenes, and as it
  // was convened after.
  function reviewing() {
    return S.phase === "idle" ? els.reviewOn.checked : !!brief().review;
  }
  function questioning() {
    return S.phase === "idle" ? els.questionsOn.checked : !!brief().questions;
  }

  function usesClaude(agents, review) {
    return activeRoles(review).some(r => agents[r.id].provider === "claude");
  }

  const ROLE_WORDS = { builders: "the builders", council: "the council", chair: "the Chair", review: "the final review" };

  // What stops these agents from running here, if anything: { message, focus, openProviders, project }, where project
  // says the message belongs with the project folder. project is the folder the session works in, resuming says the
  // session has already started, with or without one, and review says whether it has a final review.
  function checkAgents(agents, project, resuming, review) {
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
      if (a.provider === "claude-code") {
        if (!local) return { message: "Claude Code runs through Quorum's local server. Start it with npm start and open Quorum at the address it prints, or choose another provider for " + who + ".", focus: providerSelects[role] };
        if (!local.claudeCode.available) return { message: "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path, or choose another provider for " + who + ".", focus: providerSelects[role], openProviders: true };
        if (!project) {
          return resuming ?
            { message: "This session started without a project folder, so Claude Code can't join it. Choose another provider for " + who + ", or convene again.", focus: providerSelects[role] } :
            { message: "Choose the project folder for Claude Code to work in.", focus: els.projectPath, project: true };
        }
        continue;
      }
      if (!a.model) return { message: "Enter a model for " + who + ".", focus: modelFields[role] };
      if (a.provider === "openrouter" && !creds.keys.openrouter) return { message: "Add your OpenRouter API key under Providers.", focus: credFields.keys.openrouter, openProviders: true };
      if (a.provider === "hermes" && !creds.keys.hermes) return { message: "Add the Hermes Agent API key under Providers.", focus: credFields.keys.hermes, openProviders: true };
      if (a.provider === "custom" && !creds.urls.custom) return { message: "Add the address of your endpoint under Providers.", focus: credFields.urls.custom, openProviders: true };
    }
    return null;
  }

  function showAgentsNote(text) {
    els.agentsNote.textContent = text;
    els.agentsNote.hidden = !text;
  }

  function showAgentsProblem(problem) {
    if (problem.project) {
      proj.note = problem.message;
      render();
    } else {
      showAgentsNote(problem.message);
    }
    if (problem.openProviders) els.providers.open = true;
    if (problem.focus) problem.focus.focus();
  }
  function currentLength() {
    const c = lengthInputs.filter(i => i.checked)[0];
    return c && LENGTHS[c.value] ? c.value : "standard";
  }
  // The seat holding the current version of proposal L: its builder's adjustment, once that starts to arrive.
  function proposalSeatId(L) {
    const a = S.seats[amendId(L)];
    return !a.skipped && (a.text || a.status === "done") ? amendId(L) : L;
  }
  function proposalsMap() {
    const o = {};
    LETTERS.forEach(L => { o[L] = S.seats[proposalSeatId(L)].text; });
    return o;
  }
  function currentTitles() {
    return Core.titlesOf(proposalsMap());
  }
  // Finished results are read from the handoffs; seats only track each agent's progress and streamed words.
  const NO_BRIEF = { feature: "", context: [], length: "standard" };
  function handedOff(id) {
    return S.handoffs[id] ? S.handoffs[id].data : null;
  }
  function brief() {
    return handedOff("brief") || NO_BRIEF;
  }
  // The plan the session ends with: the Chair's revision after a final review, or else its plan.
  function planHandoff() {
    return brief().review ? handedOff("final") : handedOff("chair");
  }
  function tally() {
    return handedOff("tally");
  }
  function decided() {
    return handedOff("chair") ? handedOff("chair").decided : null;
  }
  function ballotOf(id) {
    return handedOff(id) ? handedOff(id).ballot : null;
  }
  function winnerLetter() {
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
    startClock();
    render();
    scrollToSection(els.secProposals);
    await startSaving();
    if (tok !== S.token) return;
    run(tok).catch(onRunCrash);
  }

  // Runs the session graph on from the handoffs already made, so a retry or resume redoes only what's missing.
  async function run(tok) {
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
    saveState();
    schedule();
  }

  function work(task, tok) {
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

  function sectionOf(id) {
    return isBuilder(id) ? "proposals" : isAsk(id) || isAmend(id) ? "questions" : isCouncil(id) ? "council" : isReviewer(id) ? "review" : "plan";
  }

  // An agent step: the seat's agent writes from the task's inputs alone, and the seat shows it writing.
  async function askAgent(task, step, tok) {
    const id = task.node, seat = S.seats[id];
    const ctl = new AbortController();
    seat.status = "thinking";
    seat.text = "";
    seat.error = null;
    seat.truncated = false;
    seat.ctl = ctl;
    const agent = S.agents[Core.roleOf(id)];
    const project = task.inputs.brief.data.project || null;
    seat.agent = agent;
    seat.served = "";
    seat.activity = "";
    S.revealed[sectionOf(id)] = true;
    schedule();
    const live = () => tok === S.token && seat.ctl === ctl;
    try {
      // Claude Code works inside the project folder. Hermes Agent has tools of its own and may be able to read the
      // project. The others only see the prompt.
      const kind = PROVIDERS[agent.provider];
      const prompt = step.prompt(task, { explore: !!kind.agentic, inProject: !!(kind.local && project) });
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
      });
      if (!live()) throw { code: "cancelled", message: "Stopped." };
      seat.text = String((res && res.text) || seat.text);
      seat.truncated = !!(res && res.truncated);
      seat.served = (res && res.served) || agent.model;
      return Object.assign(step.result(task, seat.text), {
        truncated: seat.truncated,
        agent: { provider: agent.provider, model: agent.model },
        served: seat.served,
      });
    } catch (e) {
      if (live()) failSeat(seat, e);
      throw e;
    } finally {
      if (seat.ctl === ctl) seat.ctl = null;
      schedule();
    }
  }

  function failSeat(seat, e) {
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
  function settle(failed) {
    const RANK = { fatal: 3, stop: 2, retry: 1 };
    let worst = null;
    failed.forEach(id => {
      const code = (S.seats[id].error && S.seats[id].error.code) || "upstream_error";
      if (!worst || RANK[errInfo(code).kind] > RANK[errInfo(worst).kind]) worst = code;
    });
    const info = errInfo(worst);
    const names = Core.namesList(failed.map(stepName));
    const example = S.seats[failed.filter(id => ((S.seats[id].error && S.seats[id].error.code) || "upstream_error") === worst)[0]];
    S.phase = info.kind === "fatal" ? "blocked" : "paused";
    S.notice = { text: (info.kind === "fatal" ? "" : names + " couldn't finish. ") + errText(worst, example), retry: info.kind === "retry" };
    S.canRetry = info.kind === "retry";
    pauseClock();
    saveState();
    schedule();
  }

  function abortAll() {
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
    saveState();
    const hadFocus = document.activeElement === els.resume || document.activeElement === els.noticeRetry;
    render();
    if (hadFocus) els.convene.focus();
    run(tok).catch(onRunCrash);
  }

  function onRunCrash(err) {
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
    saveState();
    schedule();
  }

  // When the viewer's plan lacks a chosen tier, the platform answers with a cheaper one. Say so.
  function substituted(seat) {
    return !!(seat.agent && seat.agent.provider === "claude" && TIERS[seat.served] && seat.served !== seat.agent.model);
  }

  function tierNoteText() {
    const subs = [];
    ROLES.forEach(r => {
      const seat = r.seats.map(id => S.seats[id]).filter(substituted)[0];
      if (seat) subs.push({ who: ROLE_WORDS[r.id], asked: seat.agent.model, got: seat.served });
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

  function settingsHint(agents) {
    const list = activeRoles(els.reviewOn.checked).map(r => agents[r.id]);
    const hints = [];
    const claude = list.filter(a => a.provider === "claude").map(a => a.model);
    if (claude.indexOf("complex") >= 0) hints.push("Frontier is Claude's most capable model and thinks longest, so its seats can take a few minutes.");
    else if (claude.length && claude.every(t => t === "quick")) hints.push("Fast is Claude's quickest, cheapest model.");
    if (list.some(a => a.provider === "claude-code")) hints.push("Claude Code explores the project before it writes, so its seats can take a few minutes.");
    if (list.some(a => a.provider === "openrouter")) hints.push("OpenRouter bills your account for each request.");
    if (list.some(a => a.provider === "hermes")) hints.push("Hermes Agent may use its tools first, so its seats can take longer.");
    if (els.questionsOn.checked) hints.push("The council's questions add up to twelve requests: each councilor's questions on each proposal, and each builder's answers.");
    if (els.reviewOn.checked) hints.push("The final review adds three requests: two reviews and the Chair's revision.");
    const blind = ["openrouter", "custom"].filter(p => list.some(a => a.provider === p));
    if (local && proj.info && blind.length) {
      hints.push(Core.listAnd(blind.map(p => (p === "custom" ? "your endpoint" : PROVIDERS[p].label))).replace(/^y/, "Y") +
        " can't read the project folder, so " + (blind.length > 1 ? "their" : "its") + " seats work from the pasted context.");
    }
    return hints.join(" ") || "Each role can run on a different provider and model.";
  }

  /* ---------- Providers and agent pickers ---------- */

  // Keys live in memory, and in this browser's storage only when "Remember" is ticked.
  const creds = { keys: { openrouter: "", hermes: "", custom: "" }, urls: { hermes: "", custom: "" }, remember: { openrouter: false, hermes: false, custom: false } };
  const lastModel = {};
  ROLES.forEach(r => { lastModel[r.id] = {}; });
  const modelLists = { openrouter: Core.OPENROUTER_PRESETS.slice(), hermes: [], custom: [] };

  function credsSnapshot() {
    return {
      keys: Object.assign({}, creds.keys),
      urls: { hermes: creds.urls.hermes || PROVIDERS.hermes.defaultUrl, custom: creds.urls.custom },
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

  function fillDatalist(id, list) {
    const dl = $(id);
    while (dl.firstChild) dl.removeChild(dl.firstChild);
    list.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      if (m.name) opt.label = m.name;
      dl.appendChild(opt);
    });
  }

  function modelPlaceholder(provider) {
    return provider === "openrouter" ? "nousresearch/hermes-4-70b" : provider === "hermes" ? "hermes-agent" :
      provider === "claude-code" ? "Claude Code's default model" : "Model name";
  }

  // Show the tier picker for Claude and a model field for everything else.
  function syncAgentRow(role) {
    const provider = providerSelects[role].value;
    const claude = provider === "claude";
    tierSelects[role].hidden = !claude;
    modelFields[role].hidden = claude;
    modelFields[role].placeholder = modelPlaceholder(provider);
    if (claude) modelFields[role].removeAttribute("list");
    else modelFields[role].setAttribute("list", "models-" + provider);
  }

  function applyAgents(agents) {
    ROLES.forEach(r => {
      const a = agents[r.id];
      providerSelects[r.id].value = a.provider;
      if (a.provider === "claude") tierSelects[r.id].value = a.model;
      else modelFields[r.id].value = a.model;
      lastModel[r.id][a.provider] = a.model;
      syncAgentRow(r.id);
    });
  }

  function onProviderChange(role) {
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
      Array.prototype.forEach.call(providerSelects[r.id].options, opt => {
        let usable = Core.usableHere(opt.value, INSIDE);
        let why = INSIDE ? " (outside Claude only)" : " (inside claude.ai only)";
        if (usable && PROVIDERS[opt.value].local && localState !== "pending" && !providerReady(opt.value)) {
          usable = false;
          why = local ? " (not installed)" : " (needs npm start)";
        }
        opt.disabled = !usable;
        const base = PROVIDERS[opt.value].label;
        opt.textContent = usable ? base : base + why;
      });
    });
    EXTERNAL.forEach(p => { providerSets[p].disabled = INSIDE; });
    $("set-claude-code").disabled = INSIDE;
  }

  function writeHermesHelp() {
    const el = els.helpHermes;
    while (el.firstChild) el.removeChild(el.firstChild);
    const origin = pageOrigin();
    const add = (text, code) => {
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
      "Quorum is open inside Claude, so every agent runs on Claude. Pages published on Claude can't reach other services. To use OpenRouter, Hermes Agent or another endpoint, open Quorum on its own, from the downloaded file or your GitHub Pages site. To use Claude Code, run Quorum on your computer with npm start." :
      "Keys stay in this browser and are sent only to the service they belong to. Leave Remember off on a shared computer.";
  }

  function providerReady(p) {
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
    renderClaudeCodeStatus();
  }

  function renderClaudeCodeStatus() {
    let text = "", ok = false;
    if (INSIDE) text = "Claude Code works when Quorum runs on your computer.";
    else if (localState === "pending") text = "Looking for Quorum's local server\u2026";
    else if (!local) text = "Claude Code works when Quorum runs on your computer: run npm start in Quorum's folder, then open the address it prints.";
    else if (local.claudeCode.available) { text = "Claude Code " + local.claudeCode.version + " is installed."; ok = true; }
    else text = "Quorum's server couldn't find Claude Code. Install it, or restart the server with QUORUM_CLAUDE_BIN set to its path.";
    setText(els.statusClaudeCode, text);
    els.statusClaudeCode.classList.toggle("is-ok", ok);
  }

  async function checkConnection(p) {
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
    } catch (e) {
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
  function activityOf(data) {
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
  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => (n < 10 ? "0" : "") + n;
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

  let frame = 0;
  function schedule() {
    if (frame) return;
    const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : fn => setTimeout(fn, 16);
    frame = raf(() => { frame = 0; render(); }) || 1;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }
  function setHTML(el, html) {
    if (el._html === html) return false;
    el.innerHTML = html;
    el._html = html;
    return true;
  }
  function toggle(el, on) {
    if (el.hidden === !!on) el.hidden = !on;
  }
  function setLetter(el, letter) {
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
    const tierNote = tierNoteText();
    toggle(els.tierNote, !!tierNote);
    setText(els.tierNote, tierNote);
    renderProvidersStatus();
    renderProject();
    renderSessions();
  }

  function seatAvailable(id) {
    return isBuilder(id) ? S.revealed.proposals : isCouncil(id) ? S.revealed.council : S.revealed.plan;
  }

  // The state a seat in the seating chart shows. The Chair's seat shows its revision after the final review once that
  // has started.
  // A builder's seat shows its answers to the council once it's answering, and a councilor's seat shows its questions
  // until it starts its review.
  function seatShown(id) {
    if (id === "chair") return S.seats.final.status !== "idle" ? S.seats.final : S.seats.chair;
    if (isBuilder(id)) {
      const a = S.seats[amendId(id)];
      return a.status !== "idle" && !a.skipped ? a : S.seats[id];
    }
    if (isCouncil(id) && S.seats[id].status === "idle") {
      const asks = LETTERS.map(L => S.seats[askId(id, L)].status);
      const status = ["error", "writing", "thinking", "stopped"].filter(x => asks.indexOf(x) >= 0)[0] || "idle";
      return { status };
    }
    return S.seats[id];
  }

  function seatPhrase(id) {
    const s = seatShown(id);
    switch (s.status) {
      case "thinking": return "thinking";
      case "writing": return "writing";
      case "done": return isCouncil(id) ? "ranked " + ballotOf(id).ranking[0] + " first" : isBuilder(id) ? "proposal ready" : "plan written";
      case "error": return "couldn't finish";
      case "stopped": return "stopped";
      default: return "waiting";
    }
  }

  const prevSeat = {};
  const popping = {};
  function renderSeats() {
    const w = winnerLetter();
    SEAT_IDS.forEach(id => {
      const g = seatEls[id], s = seatShown(id), st = s.status;
      let letter = "", glyph = "";
      if (isBuilder(id)) {
        letter = id;
        glyph = id;
      } else if (isCouncil(id)) {
        if (ballotOf(id)) { letter = ballotOf(id).ranking[0]; glyph = letter; }
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
      const glyphEl = g.querySelector(".seat-glyph");
      if (glyphEl.textContent !== glyph) glyphEl.textContent = glyph;
      const avail = seatAvailable(id);
      g.setAttribute("tabindex", avail ? "0" : "-1");
      g.setAttribute("aria-disabled", avail ? "false" : "true");
      g.setAttribute("aria-label", CAST[id].name + (isBuilder(id) ? ", proposal " + id : "") + ", " + seatPhrase(id));
    });
  }

  function stageState(ids) {
    const st = ids.map(id => S.seats[id].status);
    if (st.every(s => s === "done")) return "done";
    if (st.some(s => s === "thinking" || s === "writing")) return "active";
    if (st.some(s => s === "error")) return "paused";
    if (st.some(s => s === "stopped")) return "stopped";
    return S.phase === "running" ? "active" : "waiting";
  }

  function statusLine() {
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
            return S.agents.builders.provider === "claude-code" ? "The builders are exploring the project and drafting their proposals." : "The builders are drafting their proposals.";
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
    const states = {
      proposals: S.revealed.proposals ? stageState(LETTERS) : "waiting",
      questions: S.revealed.questions ? stageState(ASK_IDS.concat(AMEND_IDS)) : "waiting",
      council: S.revealed.council ? stageState(COUNCIL_IDS) : "waiting",
      vote: tally() ? (tally().decidedBy === "chair" && !decided() ? "tied" : "done") : "waiting",
      review: S.revealed.review ? stageState(REVIEWER_IDS) : "waiting",
      plan: S.revealed.plan ? stageState(reviewing() ? ["chair", "final"] : ["chair"]) : "waiting",
    };
    // The stages a session has, numbered in order in the rail and in each section's heading.
    const review = reviewing(), questions = questioning();
    toggle(els.stageReview, review);
    toggle(els.stageQuestions, questions);
    const order = ["proposals", questions && "questions", "council", "vote", review && "review", "plan"].filter(Boolean);
    stageBtns.forEach(btn => {
      const n = String(order.indexOf(btn.getAttribute("data-stage")) + 1);
      setText(btn.querySelector(".stage-n"), n);
      setText($(btn.getAttribute("data-target")).querySelector(".sec-num"), n);
    });
    stageBtns.forEach(btn => {
      const key = btn.getAttribute("data-stage");
      const st = states[key];
      if (btn.getAttribute("data-state") !== st) btn.setAttribute("data-state", st);
      setText(btn.querySelector(".stage-state"), STAGE_WORDS[st]);
      btn.setAttribute("aria-disabled", S.revealed[key] ? "false" : "true");
      btn.tabIndex = S.revealed[key] ? 0 : -1;
    });
    toggle(els.railStop, S.phase === "running");
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
    const input = roundInput(S.handoffs);
    toggle(els.motionRound, !!input);
    setText(els.motionRoundIntro, input ? "Round " + S.round + " revises the round " + (S.round - 1) + " plan with your input:" : "");
    setText(els.motionRoundQuote, input);
    const pr = brief().project;
    toggle(els.motionProject, !!pr);
    setHTML(els.motionProject, pr ? "In the project <code>" + Core.esc(pr.path) + "</code>" : "");
    if (els.motionContextBody._session !== S.session) {
      els.motionContextBody._session = S.session;
      const blocks = Core.contextBlocks(brief().context);
      toggle(els.motionContext, blocks.length > 0);
      els.motionContext.open = false;
      setText(els.motionContextSummary, blocks.length ?
        "With " + (blocks.length === 1 ? "one piece" : blocks.length + " pieces") + " of context: " + Core.listAnd(blocks.map(b => b.title)) : "");
      setHTML(els.motionContextBody, blocks.map(b => "<h3>" + Core.esc(b.title) + "</h3><pre>" + Core.esc(b.text) + "</pre>").join(""));
    }
  }

  function statusTitle(id) {
    switch (S.seats[id].status) {
      case "thinking": return "Thinking…";
      case "writing": return "Writing…";
      case "error": return "Couldn't finish";
      case "stopped": return "Stopped";
      case "done": return "Untitled";
      default: return "Waiting";
    }
  }

  function waitCopy(agent) {
    if (!agent || agent.provider !== "claude") {
      return agent && agent.provider === "hermes" ? "Hermes Agent may use its tools first, so writing can take a few minutes to start." :
        agent && agent.provider === "claude-code" ? "Claude Code explores the project first, so writing can take a few minutes to start." :
          "Writing usually starts within a minute.";
    }
    return agent.model === "quick" ? "Writing usually starts within a few seconds." :
      agent.model === "complex" ? "Frontier models think first, so writing can take a couple of minutes to start." :
        "Writing usually starts within a minute.";
  }

  // The agent a seat ran on, or will run on: what answered if known, else what was asked for.
  function agentFor(id) {
    const s = S.seats[id];
    const asked = s.agent || S.agents[Core.roleOf(id)];
    if (!s.served) return asked;
    return { provider: asked.provider, model: s.served };
  }

  function agentText(id) {
    return Core.agentLabel(agentFor(id), { customUrl: creds.urls.custom });
  }

  // The small chip beside each byline naming the agent that answered.
  function renderTier(el, id) {
    const s = S.seats[id];
    const sub = substituted(s);
    const label = agentText(id);
    const html = label ? '<span class="visually-hidden">Agent: </span>' + Core.esc(label) +
      (sub ? '<span class="visually-hidden">, because ' + TIERS[s.agent.model].label + " isn't available on your plan</span>" : "") : "";
    setHTML(el, html);
    toggle(el, !!html);
    el.classList.toggle("is-sub", sub);
    const full = agentFor(id);
    if (sub) el.title = TIERS[s.agent.model].label + " isn't available on your plan";
    else if (full.provider !== "claude") el.title = PROVIDERS[full.provider].label + (full.model ? ": " + full.model : "");
    else el.removeAttribute("title");
  }

  function placeholderFor(id) {
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

  function waitingText(id) {
    if (isBuilder(id)) return "Waiting to begin.";
    if (isAsk(id)) return "Waiting for Proposal " + Core.stepOf(id).letter + ".";
    if (isAmend(id)) return "The builder answers once the council has asked its questions.";
    if (isCouncil(id)) return "The council meets once all three proposals are " + (brief().questions ? "settled." : "in.");
    if (isReviewer(id)) return "The reviewers start once the Chair has written the plan.";
    return id === "final" ? "The Chair revises the plan once the reviewers are done." : "The Chair writes once the votes are counted.";
  }

  function noteFor(id) {
    const s = S.seats[id];
    if (s.status === "error") return { text: errText(s.error && s.error.code, s, "short"), error: true };
    if (s.status === "stopped") {
      return { text: s.text ? "Stopped part-way. Resuming asks for this again from the start." : "Resuming asks for this again.", error: false };
    }
    if (s.status === "done" && s.truncated) return { text: "This hit the length limit and stops mid-thought.", error: false };
    return null;
  }

  function renderNote(el, note) {
    toggle(el, !!note);
    if (!note) return;
    setText(el, note.text);
    el.classList.toggle("is-error", !!note.error);
  }

  function renderDoc(el, id, text, status, placeholder) {
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

  function appendCaret(root) {
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

  function proposalMeta(id) {
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

  function selectTab(group, key) {
    if (S.sel[group] === key) return;
    S.sel[group] = key;
    render();
  }

  function renderTab(tab, on, status) {
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
      const status = am.status === "done" ? "done" : ["error", "writing", "thinking", "stopped"].filter(x => states.indexOf(x) >= 0)[0] || "idle";
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
    const placeholder = p => '<p class="placeholder">' + (p.pulse ? '<span class="pulse" aria-hidden="true"></span>' : "") + "<span>" + Core.esc(p.text) + "</span></p>";
    const blocks = COUNCIL.map(c => {
      const id = askId(c.id, L), seat = S.seats[id], d = handedOff(id);
      const body = d ? (d.questions.length ? "<ol>" + d.questions.map(q => "<li>" + Core.inline(q) + "</li>").join("") + "</ol>" : '<p class="qa-none">No questions.</p>') :
        seat.text ? Core.renderMarkdown(seat.text.replace(/^[ \t]{0,3}#{1,6}[ \t]+questions[ \t]*$/im, "")) : placeholder(placeholderFor(id));
      const note = noteFor(id);
      return '<div class="qa-block"><p class="qa-who">' + Core.esc(c.name) + " asks</p><div class=\"doc\">" + body + "</div>" +
        (note && note.error ? '<p class="pane-note is-error">' + Core.esc(note.text) + "</p>" : "") + "</div>";
    });
    const am = S.seats[amendId(L)], answers = am.text && !am.skipped ? Core.sectionText(am.text, "Answers to the council") : "";
    const answer = am.skipped ? '<p class="qa-none">No one asked anything, so the proposal stands as submitted.</p>' :
      answers ? Core.renderMarkdown(answers) :
        am.status === "writing" ? placeholder({ pulse: true, text: CAST[L].name + " is adjusting the proposal." }) :
          placeholder(placeholderFor(amendId(L)));
    const amNote = noteFor(amendId(L));
    blocks.push('<div class="qa-block is-answer"><p class="qa-who">' + Core.esc(builder.replace(/^the/, "The")) + " answers</p><div class=\"doc\">" + answer + "</div>" +
      (amNote && amNote.error ? '<p class="pane-note is-error">' + Core.esc(amNote.text) + "</p>" : "") + "</div>");
    setHTML(els.questionsDoc, blocks.join(""));
  }

  function suffix(n) {
    return n === 1 ? "st" : n === 2 ? "nd" : "rd";
  }

  function rankBox(k) {
    return '<span class="rank r' + k + '"><span class="visually-hidden">ranked </span>' + k +
      '<span class="visually-hidden">' + suffix(k) + "</span></span>";
  }

  function ballotHTML(id, titles) {
    const b = ballotOf(id);
    const rank = {};
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
      const first = ballotOf(c.id) ? ballotOf(c.id).ranking[0] : "";
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
      const fills = Array.prototype.slice.call(els.division.querySelectorAll(".bar-fill"));
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

  function scrollToSection(el) {
    try {
      el.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
    } catch (_) {
      if (el.scrollIntoView) el.scrollIntoView();
    }
  }

  function focusQuietly(el) {
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
  }

  function jumpToSeat(id) {
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

  function showFieldNote(text) {
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

  let draftTimer = 0;
  function saveDraft() { store.set("quorum:draft", els.feature.value); }
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }

  async function copyText(text) {
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

  function flash(btn, text) {
    const label = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", label);
    btn.textContent = text;
    clearTimeout(btn._flash);
    btn._flash = setTimeout(() => { btn.textContent = label; }, 2400);
  }

  // The agent that wrote each step of a round, from its handoffs.
  function tiersOf(handoffs) {
    const tiers = {};
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
        (brief().project ? " Project: " + brief().project.path + "." : "") + (S.round > 1 ? " Round " + S.round + "." : ""),
      tiers: tiersOf(S.handoffs),
    }));
    for (let i = S.past.length - 1; i >= 0; i--) {
      const md = Core.recordMarkdown(Object.assign(Core.sessionOf(S.past[i]), { tiers: tiersOf(S.past[i]) }));
      out += "\n---\n\n# Round " + (i + 1) + "\n\n" + Core.shiftHeadings(md, 1);
    }
    return out;
  }

  // Outside Claude there's no save capability; a plain download link does the job.
  function downloadDirectly(filename, data) {
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

  async function saveFile(kind, btn) {
    const plan = planHandoff();
    if (!plan) return;
    const planText = plan.text;
    const base = Core.slug(Core.titleOf(planText) || brief().feature.slice(0, 60));
    const filename = (kind === "plan" ? "plan-" : "council-record-") + base + ".md";
    const data = kind === "plan" ? planText.trim() + "\n" : recordNow();
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
    } catch (e) {
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

  function wireTabs(list, group, keys, prefix) {
    list.addEventListener("click", e => {
      const tab = e.target.closest('[role="tab"]');
      if (tab) selectTab(group, tab.getAttribute("data-key"));
    });
    list.addEventListener("keydown", e => {
      const tab = e.target.closest('[role="tab"]');
      if (!tab) return;
      const i = keys.indexOf(tab.getAttribute("data-key"));
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
  let ctxItems = []; // { id, kind, title, text, el, titleEl, textEl, removeEl, sizeEl, labelEl }
  let ctxSeq = 0;

  function fmtNum(n) {
    return Number(n).toLocaleString("en-US");
  }

  function sizeContext(el) {
    el.style.height = "auto";
    el.style.height = Math.min(360, Math.max(104, el.scrollHeight + 2)) + "px";
  }

  function syncContextLabels(item) {
    const name = item.title.trim() || "this context";
    item.labelEl.textContent = item.title.trim() || "Context";
    item.removeEl.setAttribute("aria-label", "Remove " + name);
  }

  function addContext(kind, title, text, focus) {
    const k = CONTEXT_KINDS[kind] ? kind : "other";
    const id = "c" + (++ctxSeq);
    const item = { id, kind: k, title: title != null ? String(title) : CONTEXT_KINDS[k].title, text: text != null ? String(text) : "" };
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
    item.titleEl = el.querySelector(".ctx-title");
    item.textEl = el.querySelector(".ctx-text");
    item.removeEl = el.querySelector(".ctx-remove");
    item.sizeEl = el.querySelector(".ctx-size");
    item.labelEl = el.querySelector('label[for="ctx-text-' + id + '"]');
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

  function removeContext(item) {
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

  function contextTotal() {
    return ctxItems.reduce((n, it) => n + it.text.length, 0);
  }

  function contextForSession() {
    return ctxItems
      .filter(it => it.text.trim())
      .map(it => ({ title: it.title.trim() || CONTEXT_KINDS[it.kind].title || "", text: it.text }));
  }

  function showContextNote(text) {
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

  let contextTimer = 0;
  function saveContext() {
    store.set("quorum:context", JSON.stringify(ctxItems.map(it => ({ kind: it.kind, title: it.title, text: it.text }))));
  }
  function saveContextSoon() {
    clearTimeout(contextTimer);
    contextTimer = setTimeout(saveContext, 400);
  }

  // Examples replace the draft; keep the draft so it can be put back.
  let exampleUndo = null;
  function snapshotForm() {
    return { feature: els.feature.value, context: ctxItems.map(it => ({ kind: it.kind, title: it.title, text: it.text })) };
  }
  function formHasContent() {
    return !!els.feature.value.trim() || ctxItems.some(it => it.text.trim() || (it.title.trim() && it.title !== CONTEXT_KINDS[it.kind].title));
  }
  function setForm(snap) {
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
  const proj = { value: "", info: null, error: "", note: "", pending: null, seq: 0, listing: null, browsing: false };
  let projectTimer = 0;

  async function getFolder(path) {
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

  function checkProject(text) {
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
    }, e => {
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

  function chooseProject(path) {
    els.projectPath.value = path;
    proj.note = "";
    store.set("quorum:project", path);
    return checkProject(path);
  }

  function projectStatusHTML() {
    const i = proj.info;
    if (proj.note) return { html: Core.esc(proj.note), error: true };
    if (!proj.value) return { html: "Choose the folder of the project this feature is for. Seats on Claude Code work inside it, reading and searching the code without changing it." };
    if (proj.pending) return { html: "Looking for the folder\u2026" };
    if (proj.error) return { html: Core.esc(proj.error), error: true };
    if (!i) return { html: "" };
    const on = i.git ? (i.git.branch ? " on " + Core.esc(i.git.branch) : i.git.detached ? " at " + Core.esc(i.git.detached) : "") : "";
    const where = !i.git ? ". It isn't in a Git repository." : i.git.root === i.path ? ", a Git repository" + on + "." : ", in a Git repository" + on + ".";
    return { html: "Found <strong>" + Core.esc(i.name) + "</strong>" + where + (i.claudeMd ? " It has a CLAUDE.md, which Claude Code reads." : "") };
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
    const item = (path, label, up) => '<li><button type="button" class="project-dir' + (up ? " is-up" : "") + '" data-path="' + Core.esc(path) + '"' + off + ">" + label + "</button></li>";
    const items = [];
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
  const saved = { list: [], listed: false, listError: "", queue: Promise.resolve(), pending: 0, error: "", confirm: "" };

  function canSave() {
    return !!(local && local.sessions);
  }

  async function api(method, route, body) {
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

  function save(request) {
    const id = S.sessionId;
    if (!id) return;
    saved.pending += 1;
    schedule();
    saved.queue = saved.queue
      .then(() => request(id))
      .catch(e => { if (id === S.sessionId) saved.error = e.message; })
      .then(() => { saved.pending -= 1; schedule(); });
  }

  function saveHandoff(round, h) {
    save(id => api("PUT", "sessions/" + id + "/rounds/" + round + "/" + h.from, { kind: h.kind, data: h.data }));
  }

  function sessionTitle() {
    const plan = planHandoff() || handedOff("chair");
    const title = plan ? Core.titleOf(plan.text) : "";
    return title || brief().feature.trim().split("\n")[0].slice(0, 120) || "Untitled session";
  }

  function saveState() {
    const body = { status: S.phase === "idle" ? "stopped" : S.phase, round: S.round, agents: S.agents, title: sessionTitle(), elapsed: Math.round(elapsed()) };
    save(id => api("PATCH", "sessions/" + id, body));
    if (S.phase !== "running") save(() => refreshSessions());
  }

  function setSessionHash(id) {
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
    } catch (e) {
      saved.error = e.message;
    }
    schedule();
  }

  async function refreshSessions() {
    if (!canSave()) return;
    try {
      saved.list = (await api("GET", "sessions")).sessions;
      saved.listError = "";
    } catch (e) {
      saved.listError = e.message;
    }
    saved.listed = true;
    schedule();
  }

  function kindOfContext(title) {
    const k = Object.keys(CONTEXT_KINDS).filter(x => CONTEXT_KINDS[x].title && CONTEXT_KINDS[x].title === title)[0];
    return k || "other";
  }

  // Opens a saved session where it got to. Steps that were running when it stopped are shown as stopped, so Resume
  // asks for them again; a finished session is ready for questions and input on its plan.
  async function openSession(id) {
    if (S.phase === "running" || S.connecting) return;
    let o;
    try {
      o = await api("GET", "sessions/" + encodeURIComponent(id));
    } catch (e) {
      saved.listError = "That session couldn't be opened. " + e.message;
      els.sessions.open = true;
      render();
      return;
    }
    const rounds = {};
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
    S.sessionId = o.session.id;
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
    S.sel = { proposals: "A", council: "advocate", review: "scaling" };
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
    els.sessions.open = false;
    render();
    scrollToSection(finished ? els.secPlan : els.secProposals);
  }

  async function deleteSession(id) {
    try {
      await api("DELETE", "sessions/" + encodeURIComponent(id));
    } catch (e) {
      saved.listError = "That session couldn't be deleted. " + e.message;
    }
    if (id === S.sessionId) {
      S.sessionId = null;
      setSessionHash(null);
    }
    await refreshSessions();
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderSessions() {
    toggle(els.sessions, canSave());
    if (!canSave()) return;
    const list = saved.list, running = S.phase === "running";
    const open = list.filter(x => x.status !== "done").length;
    setText(els.sessionsStatus, !saved.listed ? "" : !list.length ? "None yet" :
      list.length + (list.length === 1 ? " session" : " sessions") + (open ? ", " + open + " unfinished" : ""));
    setText(els.sessionsIntro, saved.listError ||
      "Each session is saved in " + local.sessions.file + " as it runs, so you can come back to it after closing this page or stopping the server.");
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

  function showReviseNote(text) {
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
      if (problem.openProviders) els.providers.open = true;
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

  function roundInput(h) {
    return h && h.revision && h.revision.data ? h.revision.data.input : "";
  }

  function renderRounds() {
    toggle(els.secRounds, S.past.length > 0 && S.phase !== "idle");
    if (!S.past.length) return;
    const key = S.session + ":" + S.past.length;
    if (els.roundsList._key === key) return;
    els.roundsList._key = key;
    const all = S.past.concat([S.handoffs]);
    const html = [];
    for (let i = S.past.length - 1; i >= 0; i--) {
      const s = Core.sessionOf(S.past[i]), t = s.tally, won = t ? t.winner || s.decided : null;
      const titles = Core.titlesOf(s.proposals);
      html.push('<details class="round"><summary>Round ' + (i + 1) + ": " + Core.esc(Core.titleOf(s.plan) || "The plan") +
        (won ? '<span class="round-meta">Built on Proposal ' + won + (titles[won] ? ", \u201C" + Core.esc(titles[won]) + "\u201D" : "") + "</span>" : "") +
        '</summary><div class="round-body"><article class="doc">' + Core.renderMarkdown(s.plan || "") + "</article>" +
        '<p class="round-label">Your input on this plan</p><blockquote class="motion-quote">' + Core.esc(roundInput(all[i + 1])) + "</blockquote></div></details>");
    }
    els.roundsList.innerHTML = html.join("");
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
  function useExample(btn) {
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
  addBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      if (S.phase === "running") return;
      dropUndo();
      addContext(btn.getAttribute("data-kind"), null, "", true);
      saveContext();
    });
  });
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
    $("check-" + p).addEventListener("click", () => checkConnection(p));
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
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute("data-open")) {
      saved.confirm = "";
      openSession(btn.getAttribute("data-open"));
    } else if (btn.hasAttribute("data-delete")) {
      const id = btn.getAttribute("data-delete");
      if (saved.confirm === id) {
        saved.confirm = "";
        deleteSession(id);
      } else {
        saved.confirm = id;
        render();
        const again = els.sessionList.querySelector('[data-delete="' + id + '"]');
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
      getFolder(local.project || "").then(l => {
        if (!proj.listing) proj.listing = l;
        schedule();
      }, e => {
        proj.error = e.message;
        schedule();
      });
    }
    render();
  });
  // Choosing a folder in the browser makes it the project, and shows what's inside it.
  els.projectDirs.addEventListener("click", e => {
    const btn = e.target.closest("button[data-path]");
    if (!btn || btn.disabled) return;
    chooseProject(btn.getAttribute("data-path")).then(() => {
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
      const key = btn.getAttribute("data-stage");
      if (!S.revealed[key]) return;
      const sec = $(btn.getAttribute("data-target"));
      scrollToSection(sec);
      focusQuietly(sec.querySelector(".sec-title"));
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
  window.addEventListener("resize", () => {
    autosize();
    ctxItems.forEach(it => sizeContext(it.textEl));
  });

  /* ---------- Start ---------- */

  const draft = store.get("quorum:draft");
  if (draft) els.feature.value = draft;
  let savedContext = [];
  try { savedContext = JSON.parse(store.get("quorum:context") || "[]"); } catch (_) { savedContext = []; }
  if (Array.isArray(savedContext)) {
    savedContext.forEach(c => { if (c && typeof c === "object") addContext(c.kind, c.title, c.text); });
  }
  loadCreds();
  setProviderOptions();
  writeProvidersIntro();
  writeHermesHelp();
  fillDatalist("models-openrouter", modelLists.openrouter);
  let savedAgents = null;
  try { savedAgents = JSON.parse(store.get("quorum:agents") || "null"); } catch (_) { savedAgents = null; }
  if (!savedAgents && INSIDE) {
    // Earlier versions saved only Claude tiers per role.
    let tiers = null;
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
      const seen = {};
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
        const agents = {};
        ROLES.forEach(r => { agents[r.id] = { provider: "claude-code", model: "" }; });
        applyAgents(agents);
        if (providersOpenedForSetup) els.providers.open = false;
      }
    }
    render();
    if (!canSave()) return;
    // A session named in the address opens again; otherwise unfinished sessions are offered.
    const m = /^#session=([\w-]+)$/.exec(location.hash);
    refreshSessions().then(() => {
      if (m) openSession(m[1]);
      else if (S.phase === "idle" && saved.list.some(x => x.status !== "done")) els.sessions.open = true;
      render();
    });
  });
  els.reviewOn.checked = store.get("quorum:review") === "on";
  els.questionsOn.checked = store.get("quorum:questions") !== "off";
  const savedLength = store.get("quorum:length");
  if (savedLength && LENGTHS[savedLength]) lengthInputs.forEach(i => { i.checked = i.value === savedLength; });
  autosize();
  render();
})(Core, Graph);
