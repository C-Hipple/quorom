(function (Core, Graph) {
  "use strict";

  const LETTERS = Core.LETTERS, BUILDERS = Core.BUILDERS, COUNCIL = Core.COUNCIL, CHAIR = Core.CHAIR;
  const TIERS = Core.TIERS, ROLES = Core.ROLES, LENGTHS = Core.LENGTHS, PROVIDERS = Core.PROVIDERS;
  // Inside claude.ai the page gets the Claude runtime but can't reach other services; on its own it's the reverse.
  const INSIDE = !!(window.claude && typeof window.claude.use === "function");
  const COUNCIL_IDS = COUNCIL.map(c => c.id);
  const ALL_IDS = LETTERS.concat(COUNCIL_IDS, ["chair"]);
  const CAST = {};
  BUILDERS.forEach(b => { CAST[b.id] = b; });
  COUNCIL.forEach(c => { CAST[c.id] = c; });
  CAST.chair = CHAIR;
  const isBuilder = id => LETTERS.indexOf(id) >= 0;
  const isCouncil = id => COUNCIL_IDS.indexOf(id) >= 0;

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
  };
  const errInfo = code => ERRORS[code] || ERRORS.upstream_error;

  function pageOrigin() {
    return /^https?:$/.test(location.protocol) ? location.origin : "";
  }

  function unreachableHint(provider) {
    const origin = pageOrigin();
    if (provider === "hermes") {
      return "Check that hermes gateway is running" + (origin ? " and that API_SERVER_CORS_ORIGINS includes " + origin : ", and open Quorum from a local web server so Hermes can allow it") + ", then retry.";
    }
    if (provider === "custom") return "Check the address, and that the service accepts requests from this page, then retry.";
    return "Check your internet connection, then retry.";
  }

  // An error's message, with the provider of the seat that failed filled in.
  function errText(code, seat, field) {
    const info = errInfo(code);
    const agent = seat && seat.agent;
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
  ALL_IDS.forEach(id => { seatEls[id] = document.querySelector('[data-seat="' + id + '"]'); });
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
    handoffs: {}, // node id to frozen handoff, for each step of the session that has finished
    agents: Core.normalizeAgents(null, INSIDE),
    seats: {},
    revealed: { proposals: false, council: false, vote: false, plan: false },
    sel: { proposals: "A", council: "advocate" },
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
    return { status: "idle", text: "", error: null, truncated: false, ctl: null, agent: null, served: "", activity: "" };
  }
  function resetSeats() {
    ALL_IDS.forEach(id => { S.seats[id] = freshSeat(); });
  }
  resetSeats();

  if (window.__QUORUM_TEST__) window.__quorum = { S };

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

  function usesClaude(agents) {
    return ROLES.some(r => agents[r.id].provider === "claude");
  }

  const ROLE_WORDS = { builders: "the builders", council: "the council", chair: "the Chair" };

  // What stops these agents from running here, if anything: { message, focus, openProviders }.
  function checkAgents(agents) {
    for (let i = 0; i < ROLES.length; i++) {
      const role = ROLES[i].id, a = agents[role], who = ROLE_WORDS[role];
      if (a.provider === "claude") {
        if (!INSIDE) return { message: "Claude only works when Quorum is open inside claude.ai. Choose another provider for " + who + ".", focus: providerSelects[role] };
        if (sampleState === "blocked") return { message: errInfo(S.blockedCode).msg, focus: providerSelects[role] };
        if (sampleState === "none") return { message: "Claude can't be reached from this view. Open Quorum from claude.ai to convene the council.", focus: providerSelects[role] };
        continue;
      }
      if (INSIDE) {
        return { message: PROVIDERS[a.provider].label + " only works when Quorum is open outside Claude, because pages published on Claude can't reach other services. Choose Claude for " + who + ", or open the downloaded file.", focus: providerSelects[role] };
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
    showAgentsNote(problem.message);
    if (problem.openProviders) els.providers.open = true;
    if (problem.focus) problem.focus.focus();
  }
  function currentLength() {
    const c = lengthInputs.filter(i => i.checked)[0];
    return c && LENGTHS[c.value] ? c.value : "standard";
  }
  function proposalsMap() {
    const o = {};
    LETTERS.forEach(L => { o[L] = S.seats[L].text; });
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
    if (usesClaude(agents) && !sampleFn && sampleState === "pending") {
      S.connecting = true;
      render();
      await sampleReady;
      S.connecting = false;
    }
    const problem = checkAgents(agents);
    if (problem) {
      render();
      showAgentsProblem(problem);
      return;
    }
    showAgentsNote("");

    abortAll();
    S.token += 1;
    S.session += 1;
    const tok = S.token;
    resetSeats();
    S.phase = "running";
    S.handoffs = { brief: Graph.handoff("brief", "brief", { feature, context: contextForSession(), length: currentLength() }) };
    dropUndo();
    S.agents = agents;
    S.notice = null;
    S.canRetry = false;
    S.revealed = { proposals: true, council: false, vote: false, plan: false };
    S.sel = { proposals: "A", council: "advocate" };
    S.clock = { startedAt: 0, accumulated: 0 };
    S.convenedAt = Date.now();
    startClock();
    render();
    scrollToSection(els.secProposals);
    run(tok).catch(onRunCrash);
  }

  // Runs the session graph on from the handoffs already made, so a retry or resume redoes only what's missing.
  async function run(tok) {
    const res = await Graph.run(Core.SESSION, {
      done: S.handoffs,
      work: task => work(task, tok),
      live: () => tok === S.token,
      onHandoff: h => {
        if (tok !== S.token) return;
        S.handoffs[h.from] = h;
        if (S.seats[h.from]) S.seats[h.from].status = "done";
        if (h.kind === "tally") S.revealed.vote = true;
        schedule();
      },
    });
    if (tok !== S.token) return;
    const failed = Core.SESSION.order.filter(id => id in res.failed);
    const broken = failed.filter(id => !S.seats[id])[0];
    if (broken) throw res.failed[broken];
    if (failed.length) return settle(failed);
    S.phase = "done";
    pauseClock();
    schedule();
  }

  function work(task, tok) {
    const step = Core.STEPS[task.kind];
    if (!step) throw new Error("No worker handles " + task.kind + " steps.");
    return step.compute ? step.compute(task) : askAgent(task, step, tok);
  }

  function sectionOf(id) {
    return isBuilder(id) ? "proposals" : isCouncil(id) ? "council" : "plan";
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
    seat.agent = agent;
    seat.served = "";
    seat.activity = "";
    S.revealed[sectionOf(id)] = true;
    schedule();
    const live = () => tok === S.token && seat.ctl === ctl;
    try {
      // Hermes Agent has tools and may be able to read the project; the others only see the prompt.
      const prompt = step.prompt(task, { explore: !!PROVIDERS[agent.provider].agentic });
      if (agent.provider === "claude" && Core.utf8Len(prompt) > 64000) throw { code: "prompt_too_large", message: "Prompt over the size limit." };
      const res = await Providers.run(agent, prompt, {
        sample: sampleFn,
        config: credsSnapshot(),
        signal: ctl.signal,
        onText: text => {
          if (!live()) return;
          seat.status = "writing";
          seat.text = text;
          S.heard = true;
          schedule();
        },
        onActivity: (event, data) => {
          if (!live() || !/tool/i.test(event)) return;
          seat.activity = toolName(data);
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
    const names = Core.namesList(failed.map(id => CAST[id].name));
    const example = S.seats[failed.filter(id => ((S.seats[id].error && S.seats[id].error.code) || "upstream_error") === worst)[0]];
    S.phase = info.kind === "fatal" ? "blocked" : "paused";
    S.notice = { text: (info.kind === "fatal" ? "" : names + " couldn't finish. ") + errText(worst, example), retry: info.kind === "retry" };
    S.canRetry = info.kind === "retry";
    pauseClock();
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
    const hadFocus = document.activeElement === els.convene || document.activeElement === els.railStop;
    render();
    if (hadFocus && !els.resume.hidden) els.resume.focus();
  }

  function resume() {
    if (!(S.phase === "stopped" || (S.phase === "paused" && S.canRetry))) return;
    // Settings changed while paused (a key added, another model picked) apply to the seats that run again.
    const agents = currentAgents();
    const problem = checkAgents(agents);
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
    const list = ROLES.map(r => agents[r.id]);
    const hints = [];
    const claude = list.filter(a => a.provider === "claude").map(a => a.model);
    if (claude.indexOf("complex") >= 0) hints.push("Frontier is Claude's most capable model and thinks longest, so its seats can take a few minutes.");
    else if (claude.length && claude.every(t => t === "quick")) hints.push("Fast is Claude's quickest, cheapest model.");
    if (list.some(a => a.provider === "openrouter")) hints.push("OpenRouter bills your account for each request.");
    if (list.some(a => a.provider === "hermes")) hints.push("Hermes Agent may use its tools first, so its seats can take longer.");
    return hints.join(" ") || "Each role can run on a different provider and model.";
  }

  /* ---------- Providers and agent pickers ---------- */

  // Keys live in memory, and in this browser's storage only when "Remember" is ticked.
  const creds = { keys: { openrouter: "", hermes: "", custom: "" }, urls: { hermes: "", custom: "" }, remember: { openrouter: false, hermes: false, custom: false } };
  const lastModel = { builders: {}, council: {}, chair: {} };
  const modelLists = { openrouter: Core.OPENROUTER_PRESETS.slice(), hermes: [], custom: [] };

  function credsSnapshot() {
    return {
      keys: Object.assign({}, creds.keys),
      urls: { hermes: creds.urls.hermes || PROVIDERS.hermes.defaultUrl, custom: creds.urls.custom },
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
    return provider === "openrouter" ? "nousresearch/hermes-4-70b" : provider === "hermes" ? "hermes-agent" : "Model name";
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
        const usable = Core.usableHere(opt.value, INSIDE);
        opt.disabled = !usable;
        const base = PROVIDERS[opt.value].label;
        opt.textContent = usable ? base : base + (INSIDE ? " (outside Claude only)" : " (inside claude.ai only)");
      });
    });
    EXTERNAL.forEach(p => { providerSets[p].disabled = INSIDE; });
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
      "Quorum is open inside Claude, so every agent runs on Claude. Pages published on Claude can't reach other services. To use OpenRouter, Hermes Agent or another endpoint, open Quorum on its own, from the downloaded file or your GitHub Pages site." :
      "Keys stay in this browser and are sent only to the service they belong to. Leave Remember off on a shared computer.";
  }

  function providerReady(p) {
    if (p === "openrouter") return !!creds.keys.openrouter;
    if (p === "hermes") return !!creds.keys.hermes;
    return !!creds.urls.custom;
  }

  function renderProvidersStatus() {
    let text;
    if (INSIDE) {
      text = "Every agent runs on Claude here";
    } else {
      const used = EXTERNAL.filter(p => ROLES.some(r => providerSelects[r.id].value === p));
      text = used.length ? Core.listAnd(used.map(p => PROVIDERS[p].label + (providerReady(p) ? " is set up" : " needs setting up"))) : "";
      if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
    }
    setText(els.providersStatus, text);
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

  function toolName(data) {
    try {
      const o = JSON.parse(data);
      const name = o && (o.tool || o.name || o.tool_name || (o.function && o.function.name));
      return typeof name === "string" ? name.slice(0, 40) : "tools";
    } catch (_) {
      return "tools";
    }
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
    renderCouncil();
    renderVote();
    renderPlan();
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
  }

  function seatAvailable(id) {
    return isBuilder(id) ? S.revealed.proposals : isCouncil(id) ? S.revealed.council : S.revealed.plan;
  }

  function seatPhrase(id) {
    const s = S.seats[id];
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
    ALL_IDS.forEach(id => {
      const g = seatEls[id], s = S.seats[id], st = s.status;
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
        return "Paused. " + (f.length ? Core.namesList(f.map(id => CAST[id].name)) + " couldn't finish." : "");
      }
      case "done":
        return "The council has adjourned. Proposal " + w + " carried, and the plan is ready.";
      default: {
        const nb = LETTERS.filter(L => S.seats[L].status === "done").length;
        if (nb < 3) {
          if (!S.heard && nb === 0 && S.agents.builders.provider === "claude" && LETTERS.every(L => S.seats[L].status === "thinking")) {
            return "Waiting for Claude. If you're asked to allow this page to use Claude, allow it to begin.";
          }
          return nb === 0 ? "The builders are drafting their proposals." : "The builders are drafting. " + nb + " of 3 proposals are in.";
        }
        const nc = COUNCIL_IDS.filter(id => S.seats[id].status === "done").length;
        if (nc < 3) return nc === 0 ? "The council is reviewing the proposals." : "The council is reviewing. " + nc + " of 3 ballots are cast.";
        if (!w) return "The vote is tied. The Chair is casting the deciding vote and writing the plan.";
        return "Proposal " + w + " carried the vote. The Chair is writing the plan.";
      }
    }
  }

  function renderRail() {
    setText(els.status, statusLine());
    const states = {
      proposals: S.revealed.proposals ? stageState(LETTERS) : "waiting",
      council: S.revealed.council ? stageState(COUNCIL_IDS) : "waiting",
      vote: tally() ? (tally().decidedBy === "chair" && !decided() ? "tied" : "done") : "waiting",
      plan: S.revealed.plan ? stageState(["chair"]) : "waiting",
    };
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
  }

  function renderSections() {
    toggle(els.roster, !S.revealed.proposals);
    toggle(els.secProposals, S.revealed.proposals);
    toggle(els.secCouncil, S.revealed.council);
    toggle(els.secVote, S.revealed.vote);
    toggle(els.secPlan, S.revealed.plan);
    setText(els.motionQuote, brief().feature);
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
    else if (full.provider !== "claude") el.title = PROVIDERS[full.provider].label + ": " + full.model;
    else el.removeAttribute("title");
  }

  function placeholderFor(id) {
    const s = S.seats[id], name = CAST[id].name;
    if (s.status === "thinking") {
      if (s.activity) return { pulse: true, text: name + " is working with " + (s.activity === "tools" ? "its tools." : s.activity + ".") };
      const claudeFirst = !S.heard && s.agent && s.agent.provider === "claude";
      return { pulse: true, text: claudeFirst ? "Waiting for Claude. If you're asked to allow this page to use Claude, allow it to begin." : name + " is thinking. " + waitCopy(s.agent) };
    }
    if (s.status === "writing") return { pulse: true, text: name + " is writing." };
    if (s.status === "error") {
      return { pulse: false, text: isBuilder(id) ? "This proposal couldn't be finished." : isCouncil(id) ? "This review couldn't be finished." : "The plan couldn't be finished." };
    }
    if (s.status === "stopped") return { pulse: false, text: "Stopped before any words were written." };
    if (s.status === "done") return { pulse: false, text: "" };
    return {
      pulse: false,
      text: isBuilder(id) ? "Waiting to begin." : isCouncil(id) ? "The council meets once all three proposals are in." : "The Chair writes once the votes are counted.",
    };
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
    const s = S.seats[id];
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
    const id = S.sel.proposals, s = S.seats[id];
    els.propPane.setAttribute("aria-labelledby", "tab-" + id);
    setLetter(els.propPane, id);
    setText(els.propByline, "Proposal " + id + ", by " + Core.midName(CAST[id].name));
    renderTier(els.propTier, id);
    renderDoc(els.propDoc, id, s.text, s.status, placeholderFor(id));
    renderNote(els.propNote, noteFor(id));
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

  function renderPlan() {
    if (!S.revealed.plan) return;
    const s = S.seats.chair, w = winnerLetter(), titles = currentTitles();
    setLetter(els.plan, w || "");
    const from = w ? "Proposal " + w + (titles[w] ? ", \u201C" + titles[w] + "\u201D" : "") : "";
    const by = !w ? "The vote is tied, so the Chair casts the deciding vote in the plan." :
      s.status === "done" ? "Written by the Chair from " + from + "." : "The Chair writes from " + from + ".";
    setText(els.planByline, by);
    renderTier(els.planTier, "chair");
    renderDoc(els.planDoc, "chair", s.text, s.status, placeholderFor("chair"));
    renderNote(els.planNote, noteFor("chair"));
    toggle(els.planActions, s.status === "done");
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

  function recordNow() {
    const tiers = {};
    ALL_IDS.forEach(id => { tiers[id] = agentText(id); });
    return Core.recordMarkdown(Object.assign(Core.sessionOf(S.handoffs), {
      setupLine: "Agents: " + Core.agentsSentence(S.agents, { customUrl: creds.urls.custom }) + " Length: " + LENGTHS[brief().length].label + ".",
      tiers,
    }));
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
    const plan = handedOff("chair");
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

  function wireTabs(list, group, keys) {
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
      $("tab-" + keys[j]).focus();
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
  lengthInputs.forEach(inp => {
    inp.addEventListener("change", () => {
      store.set("quorum:length", currentLength());
      render();
    });
  });
  wireTabs($("propTabs"), "proposals", LETTERS);
  wireTabs($("councilTabs"), "council", COUNCIL_IDS);
  ALL_IDS.forEach(id => {
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
    const plan = handedOff("chair");
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
  // On its own, open the providers panel until something is set up, and fetch OpenRouter's model list for the pickers.
  if (!INSIDE) {
    if (!EXTERNAL.some(providerReady)) els.providers.open = true;
    Providers.listModels("openrouter", credsSnapshot()).then(list => {
      if (!list.length) return;
      const seen = {};
      const merged = Core.OPENROUTER_PRESETS.concat(list).filter(m => (seen[m.id] ? false : (seen[m.id] = true)));
      modelLists.openrouter = merged;
      fillDatalist("models-openrouter", merged);
    }, () => { /* keep the presets */ });
  }
  const savedLength = store.get("quorum:length");
  if (savedLength && LENGTHS[savedLength]) lengthInputs.forEach(i => { i.checked = i.value === savedLength; });
  autosize();
  render();
})(Core, Graph);
