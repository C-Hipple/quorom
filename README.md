# Quorum

Decide how to implement a feature in an existing software project by putting it before a small AI council. Three builders each propose an implementation, three councilors review the proposals blind and cast ranked ballots, and a Chair counts the votes and writes the implementation plan.

Each role can run on a different provider and model: Claude inside claude.ai, and Claude Code, OpenRouter, Hermes Agent or any OpenAI-compatible endpoint when you run Quorum yourself. Run on your own computer, Quorum attaches to a project folder, and seats on Claude Code work inside it, exploring the code before they propose, review or plan.

![Quorum in session: the seating chart on the left shows who is working, and the builders' proposals stream in side by side](docs/screenshots/proposals.png)

## How a session works

You choose the project folder, when Quorum runs on your computer, and describe the feature. Then paste in whatever context the council should work from, as plain text: product requirements, how the system works today, constraints, relevant code or anything else. You can also drop text files onto the context, or add them with "From files…", and each comes in named after its file. Each piece gets a name, and every agent sees all of it. The agents are told to use names that appear in the context, or that they found in the project's code, and to state assumptions rather than invent file names, endpoints or libraries. Context is limited to 24,000 characters so that every request, which carries the context along with the proposals and reviews, stays a manageable size.

1. **Proposals.** Three builders write in parallel, each with a different approach: the Pragmatist looks for the smallest change that fits the existing code, the Visionary for a better design than the obvious one, and the Architect for something that fits the system's structure and holds up as it grows.
2. **Council review.** The Advocate (users and requirements), the Skeptic (regressions, security, performance and hidden complexity) and the Strategist (effort, risk and sequencing) each review all three proposals without knowing who wrote them, each reading them in a different order. Every review ends with a ranked ballot and a score from 1 to 10 for each proposal.
3. **The vote.** A first-place ranking earns 3 points, second place 2 and third place 1. A tie goes to first-place votes, then to combined scores, then to the Chair.
4. **Implementation plan.** The Chair writes the plan from the winning proposal, covering requirements, design, changes by area, implementation steps, testing, rollout, risks and open questions. It folds in the best ideas from the other proposals and answers any councilor who ranked the winner last.
5. **Final review, if you ask for it.** Tick "Final review" under Agents before convening, and two more reviewers check the Chair's plan before it's final: the Scaling Reviewer for how it holds up as usage grows (load, data volume, queries and indexes, queues, contention, the limits of what it depends on, cost), and the Security Reviewer for security and privacy (access control across users and tenants, injection, secrets, new dependencies, sensitive data, abuse). Each grades its findings Critical, High, Medium or Low. The Chair then revises the plan to fix every Critical and High finding, and adds a Final review section saying what it did about each one. The revised plan is the one you copy and download, and the plan from before the review stays on the page beneath it.
6. **Your questions and input.** Under the finished plan, you can ask about anything in it or add what the council should know, and send it back. That starts a new round: each builder revises its own proposal with your input and the plan in front of it, the council reviews the revised proposals blind and votes again, and the Chair writes a revised plan that answers your questions and says what changed. You can go as many rounds as you like, and what you asked for in earlier rounds stays in front of every seat.

Each round makes seven requests, or ten with the final review, which runs again in every round. The finished plan can be copied or downloaded, along with a full record of every round: the request, the context, your input, every proposal and review, the vote and which model each seat ran on. Earlier rounds' plans stay on the page under Earlier rounds.

### Every agent's conversation

Every agent's whole conversation on every step can be read, in every round. Each pane has a **Full conversation** link beside its byline, and so does each councilor's questions and each builder's answers. The link opens a panel showing that step from start to finish:

- the prompt Quorum sent, exactly as sent
- the agent's reasoning, where its provider shows it: Claude Code's thinking, the reasoning OpenRouter models send alongside their answer, and `<think>` blocks
- what the agent wrote along the way
- each tool it used, with the tool's input and what came back, such as every file a Claude Code seat read and every search it ran
- anything else its provider reported, such as Hermes Agent's tool progress
- its answer

The panel also shows which model answered, how long it took and, for Claude Code, the turns, tokens and cost. A step that ran more than once, after a retry or a resume, keeps every attempt, including the ones that couldn't finish and why. A step that's still running updates as the agent works.

A picker at the top of the panel, with Previous and Next, moves between every agent's step, grouped by round. **Every agent's conversation** in the rail opens it, as does a button under each of the Earlier rounds. **Copy as Markdown** copies one conversation. **Download every conversation** saves the whole session's in one Markdown file.

Served by `bun start`, each conversation is saved with its session as it runs, so a saved session opened again still has them. A step with no saved conversation is rebuilt from the session, for example in a session kept only in the browser or saved before conversations were kept: the prompt as the step makes it from what it was handed, and the answer it handed on. The panel says when a conversation is rebuilt, because what the agent did in between wasn't kept.

### Saved sessions

Served by `bun start`, Quorum saves every session in a SQLite database, `~/.quorum/quorum.db`, or the file `QUORUM_DB` names. A session is saved when the council convenes, and each step's result is saved the moment the step finishes, in every round. Each step's conversation with its agent is saved every few seconds while the step runs, and again when it ends. The page's address names the open session, so reloading it opens the session again, and the Saved sessions list at the top of the page opens any session, or deletes it.

If you close the page or stop the server in the middle of a session, open it again: the finished steps come back, the steps that were running show as stopped, and Resume runs only those. Opened as a file or inside claude.ai, Quorum doesn't save sessions, but revision rounds still work while the page is open.

## What a session looks like

These screenshots follow the "CSV export for reports" example on the page, with the default OpenRouter setup. They were recorded by `bun run screenshots`, which plays a scripted session through the real page, so the agents' words were written for the demo rather than by the models named on them, and the session timer is moved forward the way minutes would pass in a real session.

**Putting a feature before the council.** The feature, and the context the council works from.

![The feature request and two pieces of context filled in from the CSV export example](docs/screenshots/convene.png)

**Council review.** Each councilor reviews the proposals blind, through their own lens, and ends with a ranked ballot. The seating chart shows each councilor's first choice.

![The Skeptic's review, ranking Proposal A first, while the Chair waits to write the plan](docs/screenshots/council.png)

**The vote.** The ballots are counted. Here A and B tie on points, and B wins on first-place votes.

![The vote table: B and A tie at 7 points, and B is adopted on first-place votes](docs/screenshots/vote.png)

**The plan.** The Chair writes the implementation plan from the winner, folds in ideas from the other proposals, and answers the councilor who ranked the winner last.

![The Chair's implementation plan, built on Proposal B](docs/screenshots/plan.png)

The page follows your system's light or dark setting.

![The vote in dark mode](docs/screenshots/vote-dark.png)

## Agents and providers

Under Agents, each role (the builders, the council and the Chair, and the final review when it's on) gets a provider and a model. The Chair's revision after the final review runs on the Chair's agent. A common setup puts the builders on a cheaper model and the council and the Chair on a frontier one. A separate Length setting (Brief, Standard or Detailed) sets how long each document is. The page remembers your choices in your browser, and every byline shows which model wrote it.

Which providers you can use depends on where the page is open:

- **Inside claude.ai**, as a published artifact, every agent runs on Claude through the artifact runtime. You pick a tier per role (Fast, Balanced or Frontier), and requests run on the Claude account of whoever opens the page. Pages published on Claude can't reach other services, so the other providers are switched off there.
- **On your own computer or site**, agents run on OpenRouter, Hermes Agent or any other OpenAI-compatible endpoint, with your own keys. Requests go straight from your browser to the provider.
- **Served by `bun start`**, Quorum can also attach a project folder and run agents on Claude Code inside it.

### Running it yourself

```sh
bun start                        # or, to start with a project folder attached:
bun start ~/code/your-app
```

This builds the page and serves it at http://localhost:8765, along with the small local server that reads folders and runs Claude Code. It only answers the page itself, on this computer. You can also open `dist/quorum.html` directly as a file, which works for OpenRouter, but Hermes Agent and other local services need the page to have a web address they can allow, and Claude Code and the project folder need `bun start`.

Open **Providers** on the page to add keys. Keys stay in your browser and are sent only to the service they belong to. They're forgotten when you close the page unless you tick "Remember on this device".

### The project folder

Served by `bun start`, the page has a **Project folder** field above the feature. Type a path, or use Browse to walk through the folders on your computer. The page says whether the folder is a Git repository, on which branch, and whether it has a `CLAUDE.md`. It remembers the folder in your browser, and `bun start <folder>` sets it when the server starts.

The project is part of the session and its record. Seats on Claude Code run inside it, seats on Hermes Agent are told where it is, and seats on OpenRouter or another endpoint can't read it, so they work from the pasted context. The page says so under Agents when that happens.

### Claude Code

If the `claude` command is installed, `bun start` finds it on your `PATH` and offers Claude Code as a provider for every role. Until you choose other agents, every seat runs on it. Set `QUORUM_CLAUDE_BIN` to its path if it's installed somewhere else. The model field takes an alias such as `opus`, `sonnet` or `haiku`, or a full model name, and left empty it uses Claude Code's default model. Each seat runs as you, signed in as you are in Claude Code, and is billed to that account.

Every seat is a separate headless run of `claude -p` in the project folder, so it reads the project's `CLAUDE.md` and explores the code the way Claude Code always does. The builders are told to explore the code the feature touches before they propose, the councilors to check what the proposals claim against the code, and the Chair to check what the plan depends on. Each seat can only look:

- It has only the Read, Grep and Glob tools, so it can't edit files or run commands.
- Reading outside the project folder needs permission, and every permission request is denied.
- It loads your user settings but not the project's settings or hooks, and none of your MCP servers.
- Its session isn't saved, so it doesn't show up in `claude --resume`.

While a seat explores, the page shows what it's reading or searching for, and its conversation shows each file it read and each search it ran, with what came back. A tool's result is kept up to its first 200,000 characters. Stopping the session stops every Claude Code run in progress.

### OpenRouter

Create a key at https://openrouter.ai/keys and paste it under Providers. The defaults are Nous Research's Hermes 4 70B (`nousresearch/hermes-4-70b`) for the builders and Hermes 4 405B (`nousresearch/hermes-4-405b`) for the council and the Chair. The model fields suggest everything OpenRouter offers, so you can type any model ID, for example a frontier model for the council and the Chair. Requests are billed to your OpenRouter account.

### Hermes Agent

Hermes Agent's API server speaks the OpenAI chat completions format. To let Quorum use it, add this to `~/.hermes/.env`:

```sh
API_SERVER_ENABLED=true
API_SERVER_KEY=choose-a-secret
API_SERVER_CORS_ORIGINS=http://localhost:8765
```

Then run `hermes gateway`. Under Providers, the address defaults to `http://127.0.0.1:8642/v1`; paste the same `API_SERVER_KEY` and use Check connection. `API_SERVER_CORS_ORIGINS` must match the address the page is open at exactly, and the page shows its own address in the Hermes setup note.

Hermes answers with the model it's configured to use. It also has tools, so Hermes seats are told they may read the project's files to check their work against the code, and not to change anything or run anything that modifies the project. Seats on Hermes can take longer because the agent may use its tools before it writes.

### Other endpoints

Any server that speaks the OpenAI chat completions format works under "Other OpenAI-compatible endpoint", such as Ollama, LM Studio, vLLM or LiteLLM. Give its address (usually ending in `/v1`), a key if it needs one, and a model name per role. The server has to accept requests from the page's address.

### Adding a provider

Providers are described in `PROVIDERS` in `src/core.ts` and called from `run()` in `src/providers.ts`. An OpenAI-compatible service only needs a new entry that points `streamChat` at its address; anything else needs its own branch in `run()` that resolves `{ text, truncated, served }` or rejects with one of Quorum's error codes. A provider that runs on this computer, as Claude Code does, is marked `local`, and goes through a route in `bridge.ts`.

### Publishing to claude.ai

Build `dist/quorum.html` and ask Claude to publish that file as an artifact with the `sample` and `downloads` capabilities.

## Project layout

| Path | What it holds |
|---|---|
| `src/head.html` | Document head and all of the CSS |
| `src/body.html` | Page markup, including the seating chart SVG |
| `src/graph.ts` | Declares a graph of steps, checks it up front, and runs it as a queue of tasks that pass each other frozen handoffs |
| `src/core.ts` | Pure logic: the cast and their prompts, the session graph and what each step does, context handling, providers and models, the streaming parser, the Markdown renderer, ballot parsing, the vote count, the full-record export, and conversations as Markdown |
| `src/providers.ts` | Calls to each provider: Claude through the artifact runtime, Claude Code through the local server, and streamed chat completions for OpenRouter, Hermes Agent and other endpoints, each reporting what goes into the agent's conversation |
| `src/app.ts` | Running the session graph, the project folder, the agents and providers settings, keeping and showing each agent's conversation, rendering and event handling |
| `build.ts` | Bundles `src/app.ts` and what it imports, and assembles it with the HTML into `dist/quorum.html` |
| `serve.ts` | Serves `dist/` at http://localhost:8765 for `bun start`, and passes `/api/` requests from the page to the bridge |
| `bridge.ts` | The local server's routes: whether Claude Code is installed, folders for the project picker, running Claude Code in the project and streaming what it does, including its thinking and each tool's result, and saved sessions and their conversations |
| `sessions.ts` | The database of saved sessions: each session, the handoff each step made in each round, and each attempt's conversation with its agent |
| `dist/quorum.html` | The built single-file page |
| `test/` | Unit tests for `graph.ts`, `core.ts` and `bridge.ts`; in-page tests that stand in a simulated Claude and simulated OpenRouter, Hermes Agent and custom endpoints; and in-page tests against the real local server and database, with `test/fake-claude.ts` standing in for Claude Code. `test/setup.ts` builds the page before they run |
| `scripts/screenshots.ts` | Records the screenshots in `docs/screenshots/` by driving the built page in Chromium with a scripted OpenRouter |
| `scripts/scripted-session.ts` | What each seat answers in that scripted session |

### The session graph

A session is declared up front, as `SESSION` in `src/core.ts`, as a directed acyclic graph of ten steps, or thirteen with the final review. Every round of a session runs the same graph:

| Step | Needs | Hands on |
|---|---|---|
| `brief` | Nothing. It's made when the council convenes | The feature request, the context, the length and the project folder |
| `revision` | Nothing. It's made when the round starts | Nothing in the first round. In later rounds, your input on the last plan, your input from earlier rounds, and the last round's plan and proposals |
| `A`, `B`, `C` | `brief` and `revision` | A proposal and its title |
| `advocate`, `skeptic`, `strategist` | `brief`, `revision` and the three proposals | A review and its ballot |
| `tally` | The three reviews | The count |
| `chair` | Everything above | The plan, and the deciding vote if the council was deadlocked |
| `scaling`, `security` | `brief`, `revision` and `chair` | A review of the plan and its findings by severity. Only with the final review |
| `final` | `brief`, `revision`, `chair` and both reviews | The plan, revised to address the findings. Only with the final review |

A session with the final review runs `REVIEWED`, the same graph with the last three steps added. Whether a session has one is part of its brief, so it's fixed when the council convenes.

`src/graph.ts` checks the graph before anything runs, rejecting cycles and steps that need something that isn't there. It then works through the graph as a queue of tasks. A step starts as soon as everything it needs has been handed off, so the builders write side by side, and so do the councilors. Each task carries only the handoffs its step needs. What a worker returns is copied and frozen into a handoff for the steps after it, so no step can see or change another's work. `STEPS` in `src/core.ts` says how each kind of step turns its inputs into a prompt, and how it turns the agent's answer into what it hands on.

If a step fails, nothing that needs it starts. A retry runs the graph again from the handoffs already made, so only the unfinished steps are asked again. Saved sessions work the same way: the database holds each round's handoffs, and a reopened session runs the graph on from them.

The same holds across a reload. The page keeps the brief and what each agent wrote in the browser, and rebuilds the handoffs from them by running each step's `result` again, so a saved answer is checked the same way a fresh one is. A step whose answer no longer reads, and every step after it, simply runs again when the session is resumed.

## Build and test

Quorum is written in TypeScript and runs on [Bun](https://bun.sh) 1.3 or later, which runs the TypeScript directly, bundles the page and saves sessions with its built-in SQLite.

```sh
bun install
bun start           # builds, then serves the page at http://localhost:8765
bun run build       # writes dist/quorum.html only
bun test            # rebuilds, then runs the unit, bridge and in-page tests
bun run typecheck   # checks the types with tsc
```

To record the screenshots again after changing the page, install Playwright and Chromium, which aren't among the project's dependencies, then run the script:

```sh
bun add --no-save playwright && bunx playwright install chromium
bun run screenshots
```
