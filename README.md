# Quorum

Decide how to implement a feature in an existing software project by putting it before a small AI council. Three builders each propose an implementation, three councilors review the proposals blind and cast ranked ballots, and a Chair counts the votes and writes the implementation plan.

Each role can run on a different provider and model: Claude inside claude.ai, and Claude Code, OpenRouter, Hermes Agent or any OpenAI-compatible endpoint when you run Quorum yourself. Run on your own computer, Quorum attaches to a project folder, and seats on Claude Code work inside it, exploring the code before they propose, review or plan.

## How a session works

You choose the project folder, when Quorum runs on your computer, and describe the feature. Then paste in whatever context the council should work from, as plain text: product requirements, how the system works today, constraints, relevant code or anything else. Each piece gets a name, and every agent sees all of it. The agents are told to use names that appear in the context, or that they found in the project's code, and to state assumptions rather than invent file names, endpoints or libraries. Context is limited to 24,000 characters so that every request, which carries the context along with the proposals and reviews, stays a manageable size.

1. **Proposals.** Three builders write in parallel, each with a different approach: the Pragmatist looks for the smallest change that fits the existing code, the Visionary for a better design than the obvious one, and the Architect for something that fits the system's structure and holds up as it grows.
2. **Council review.** The Advocate (users and requirements), the Skeptic (regressions, security, performance and hidden complexity) and the Strategist (effort, risk and sequencing) each review all three proposals without knowing who wrote them, each reading them in a different order. Every review ends with a ranked ballot and a score from 1 to 10 for each proposal.
3. **The vote.** A first-place ranking earns 3 points, second place 2 and third place 1. A tie goes to first-place votes, then to combined scores, then to the Chair.
4. **Implementation plan.** The Chair writes the plan from the winning proposal, covering requirements, design, changes by area, implementation steps, testing, rollout, risks and open questions. It folds in the best ideas from the other proposals and answers any councilor who ranked the winner last.
5. **Final review, if you ask for it.** Tick "Final review" under Agents before convening, and two more reviewers check the Chair's plan before it's final: the Scaling Reviewer for how it holds up as usage grows (load, data volume, queries and indexes, queues, contention, the limits of what it depends on, cost), and the Security Reviewer for security and privacy (access control across users and tenants, injection, secrets, new dependencies, sensitive data, abuse). Each grades its findings Critical, High, Medium or Low. The Chair then revises the plan to fix every Critical and High finding, and adds a Final review section saying what it did about each one. The revised plan is the one you copy and download, and the plan from before the review stays on the page beneath it.
6. **Your questions and input.** Under the finished plan, you can ask about anything in it or add what the council should know, and send it back. That starts a new round: each builder revises its own proposal with your input and the plan in front of it, the council reviews the revised proposals blind and votes again, and the Chair writes a revised plan that answers your questions and says what changed. You can go as many rounds as you like, and what you asked for in earlier rounds stays in front of every seat.

Each round makes seven requests, or ten with the final review, which runs again in every round. The finished plan can be copied or downloaded, along with a full record of every round: the request, the context, your input, every proposal and review, the vote and which model each seat ran on. Earlier rounds' plans stay on the page under Earlier rounds.

### Saved sessions

Served by `npm start`, Quorum saves every session in a SQLite database, `~/.quorum/quorum.db`, or the file `QUORUM_DB` names. A session is saved when the council convenes, and each step's result is saved the moment the step finishes, in every round. The page's address names the open session, so reloading it opens the session again, and the Saved sessions list at the top of the page opens any session, or deletes it.

If you close the page or stop the server in the middle of a session, open it again: the finished steps come back, the steps that were running show as stopped, and Resume runs only those. Saving sessions needs Node.js 22.13 or later, for its built-in SQLite; on older versions everything else works but sessions aren't saved. Opened as a file or inside claude.ai, Quorum doesn't save sessions, but revision rounds still work while the page is open.

## Agents and providers

Under Agents, each role (the builders, the council and the Chair, and the final review when it's on) gets a provider and a model. The Chair's revision after the final review runs on the Chair's agent. A common setup puts the builders on a cheaper model and the council and the Chair on a frontier one. A separate Length setting (Brief, Standard or Detailed) sets how long each document is. The page remembers your choices in your browser, and every byline shows which model wrote it.

Which providers you can use depends on where the page is open:

- **Inside claude.ai**, as a published artifact, every agent runs on Claude through the artifact runtime. You pick a tier per role (Fast, Balanced or Frontier), and requests run on the Claude account of whoever opens the page. Pages published on Claude can't reach other services, so the other providers are switched off there.
- **On your own computer or site**, agents run on OpenRouter, Hermes Agent or any other OpenAI-compatible endpoint, with your own keys. Requests go straight from your browser to the provider.
- **Served by `npm start`**, Quorum can also attach a project folder and run agents on Claude Code inside it.

### Running it yourself

```sh
npm start                        # or, to start with a project folder attached:
npm start -- ~/code/your-app
```

This builds the page and serves it at http://localhost:8765, along with the small local server that reads folders and runs Claude Code. It only answers the page itself, on this computer. You can also open `dist/quorum.html` directly as a file, which works for OpenRouter, but Hermes Agent and other local services need the page to have a web address they can allow, and Claude Code and the project folder need `npm start`.

Open **Providers** on the page to add keys. Keys stay in your browser and are sent only to the service they belong to. They're forgotten when you close the page unless you tick "Remember on this device".

### The project folder

Served by `npm start`, the page has a **Project folder** field above the feature. Type a path, or use Browse to walk through the folders on your computer. The page says whether the folder is a Git repository, on which branch, and whether it has a `CLAUDE.md`. It remembers the folder in your browser, and `npm start -- <folder>` sets it when the server starts.

The project is part of the session and its record. Seats on Claude Code run inside it, seats on Hermes Agent are told where it is, and seats on OpenRouter or another endpoint can't read it, so they work from the pasted context. The page says so under Agents when that happens.

### Claude Code

If the `claude` command is installed, `npm start` finds it on your `PATH` and offers Claude Code as a provider for every role. Until you choose other agents, every seat runs on it. Set `QUORUM_CLAUDE_BIN` to its path if it's installed somewhere else. The model field takes an alias such as `opus`, `sonnet` or `haiku`, or a full model name, and left empty it uses Claude Code's default model. Each seat runs as you, signed in as you are in Claude Code, and is billed to that account.

Every seat is a separate headless run of `claude -p` in the project folder, so it reads the project's `CLAUDE.md` and explores the code the way Claude Code always does. The builders are told to explore the code the feature touches before they propose, the councilors to check what the proposals claim against the code, and the Chair to check what the plan depends on. Each seat can only look:

- It has only the Read, Grep and Glob tools, so it can't edit files or run commands.
- Reading outside the project folder needs permission, and every permission request is denied.
- It loads your user settings but not the project's settings or hooks, and none of your MCP servers.
- Its session isn't saved, so it doesn't show up in `claude --resume`.

While a seat explores, the page shows what it's reading or searching for. Stopping the session stops every Claude Code run in progress.

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

Providers are described in `PROVIDERS` in `src/core.js` and called from `run()` in `src/providers.js`. An OpenAI-compatible service only needs a new entry that points `streamChat` at its address; anything else needs its own branch in `run()` that resolves `{ text, truncated, served }` or rejects with one of Quorum's error codes. A provider that runs on this computer, as Claude Code does, is marked `local`, and goes through a route in `bridge.js`.

### Publishing to claude.ai

Build `dist/quorum.html` and ask Claude to publish that file as an artifact with the `sample` and `downloads` capabilities.

## Project layout

| Path | What it holds |
|---|---|
| `src/head.html` | Document head and all of the CSS |
| `src/body.html` | Page markup, including the seating chart SVG |
| `src/graph.js` | Declares a graph of steps, checks it up front, and runs it as a queue of tasks that pass each other frozen handoffs |
| `src/core.js` | Pure logic: the cast and their prompts, the session graph and what each step does, context handling, providers and models, the streaming parser, the Markdown renderer, ballot parsing, the vote count and the full-record export |
| `src/providers.js` | Calls to each provider: Claude through the artifact runtime, Claude Code through the local server, and streamed chat completions for OpenRouter, Hermes Agent and other endpoints |
| `src/app.js` | Running the session graph, the project folder, the agents and providers settings, rendering and event handling |
| `build.js` | Assembles `src/` into `dist/quorum.html` |
| `serve.js` | Serves `dist/` at http://localhost:8765 for `npm start`, and passes `/api/` requests from the page to the bridge |
| `bridge.js` | The local server's routes: whether Claude Code is installed, folders for the project picker, running Claude Code in the project and streaming what it does, and saved sessions |
| `sessions.js` | The database of saved sessions: each session, and the handoff each step made in each round |
| `dist/quorum.html` | The built single-file page |
| `test/` | Unit tests for `core.js` and `bridge.js`; in-page tests that stand in a simulated Claude and simulated OpenRouter, Hermes Agent and custom endpoints; and in-page tests against the real local server and database, with `test/fake-claude.js` standing in for Claude Code |

### The session graph

A session is declared up front, as `SESSION` in `src/core.js`, as a directed acyclic graph of ten steps, or thirteen with the final review. Every round of a session runs the same graph:

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

`src/graph.js` checks the graph before anything runs, rejecting cycles and steps that need something that isn't there. It then works through the graph as a queue of tasks. A step starts as soon as everything it needs has been handed off, so the builders write side by side, and so do the councilors. Each task carries only the handoffs its step needs. What a worker returns is copied and frozen into a handoff for the steps after it, so no step can see or change another's work. `STEPS` in `src/core.js` says how each kind of step turns its inputs into a prompt, and how it turns the agent's answer into what it hands on.

If a step fails, nothing that needs it starts. A retry runs the graph again from the handoffs already made, so only the unfinished steps are asked again. Saved sessions work the same way: the database holds each round's handoffs, and a reopened session runs the graph on from them.

## Build and test

Requires Node.js 18 or later, and 22.13 or later to save sessions.

```sh
npm install
npm start       # builds, then serves the page at http://localhost:8765
npm run build   # writes dist/quorum.html only
npm test        # rebuilds, then runs the unit, bridge and in-page tests
```
