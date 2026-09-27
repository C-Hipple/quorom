// What each seat answers in the scripted session that scripts/screenshots.ts records. It works the "CSV export for
// reports" example on the page. The builders and the council are written so that A and B tie on points and B wins on
// first-place votes, which shows the tie-break, and the Skeptic ranks the winner last, which shows the Dissent section.

const fence = "```";

const A = `# Stream Small, Queue Large
> Stream the CSV straight from the existing report query when it's small, and hand anything big to a Celery job that emails a link.

## The approach
Every report already runs through \`ReportService\`, so the export reuses it rather than adding a second query path. When someone clicks **Export CSV**, the API first runs a cheap \`COUNT(*)\` of the same filtered query. Under 50,000 rows, Django streams the file back with \`StreamingHttpResponse\`, writing rows as the database cursor yields them, so memory stays flat and the download starts at once. Above that, or if the count itself is slow, the request enqueues a Celery task and the page says the file will arrive by email.

The 50,000-row threshold is an assumption: it's roughly what streams in under 30 seconds on a typical report, and it should be tuned from real timings.

## What changes
- **ReportService**: a \`rows(filters)\` generator next to the existing query, using a server-side cursor.
- **API**: \`POST /reports/<id>/export\` returns either the stream or \`202 Accepted\`.
- **Celery**: one \`export_report_csv\` task that writes to S3 and calls the Notifications module.
- **Reports page**: the button, plus a short "We'll email you a link" message.
- **S3**: an \`exports/\` prefix with a 7-day expiry rule.

## How we'd build it
1. Row generator and CSV writer in \`ReportService\`, with tests (2 days).
2. Streaming endpoint and the button (2 days).
3. Celery task, S3 upload and email (3 days).
4. Threshold tuning against the largest production reports (1 day).

## Testing and rollout
Unit-test the CSV writer for quoting, Unicode and formulas that spreadsheets would execute. Load-test a 500,000-row export on staging. Ship behind a flag to internal users first, then everyone.

## Risks and trade-offs
Two paths mean two behaviors: a user may get a download one day and an email the next for the same report as its data grows. The count query adds a little latency. There's no progress indicator, and no way to cancel a large export once it's queued.

## Why the council should choose this
It meets every requirement with parts the team already runs, and it can ship in about two weeks. Nothing here is hard to undo.`;

const B = `# Every Export Is a Job
> Treat every export as a background job with live progress, so nothing ever times out and a slow export becomes an email without the user doing anything.

## The approach
Instead of guessing up front which exports are big, every click on **Export CSV** creates an export job and starts it on Celery right away. The Reports page shows a small progress toast that polls the job. If the file is ready within 30 seconds, which will be most of the time, the browser downloads it and the user never notices it was a job. If it isn't, the toast says "We'll email you when it's ready", and the job hands off to the Notifications module when it finishes.

This removes the fork in behavior: one path, one set of failure modes, and the 30-second rule falls out of how the page waits rather than being a threshold we tune. It also lays the foundation for PDF and Excel exports, which are the obvious next requests.

## What changes
- **Data model**: an \`ExportJob\` table with the user, report, filters, status, row count, S3 key and timings.
- **ReportService**: a row iterator over the filtered query, using a server-side cursor.
- **Celery**: an \`export_report\` task that streams rows to a multipart upload in S3 and updates progress every 10,000 rows.
- **API**: \`POST /exports\` to start, \`GET /exports/<id>\` for status and a signed download URL.
- **Reports page**: the button and the progress toast, and a "Recent exports" list in the user menu to fetch a file again.
- **Notifications module**: a new "export ready" email template.

## How we'd build it
1. \`ExportJob\` model and migration (1 day).
2. Row iterator and CSV writer, with tests (2 days).
3. Celery task with S3 multipart upload and progress (3 days).
4. API endpoints and the progress toast (3 days).
5. Email handoff and the Recent exports list (2 days).

## Testing and rollout
Test the writer for quoting and spreadsheet formula injection. Run a 500,000-row export on staging and watch memory and Celery queue time. Release to internal users behind a flag.

## Risks and trade-offs
Small exports take a round trip through Celery, so a queue backlog makes even a 20-row export wait; that needs its own queue. It's about three weeks of work instead of two.

## Why the council should choose this
One path serves every report size, users see progress instead of a spinner, and the job model pays for itself with the next export format.`;

const C = `# A Dedicated Export Pipeline
> Build exporting as its own module with a clear contract, so every report, format and delivery channel plugs into one well-instrumented pipeline.

## The approach
Exports get a home of their own: an \`exports\` Django app that owns the job lifecycle, the file formats and delivery. \`ReportService\` exposes one new interface, \`iter_rows(report, filters)\`, and knows nothing about files. The pipeline reads rows in batches of 5,000 on a read replica, writes CSV through a pluggable \`Formatter\`, uploads to S3 in parts, and delivers through a \`Delivery\` interface with two implementations: direct download, and email through the Notifications module.

Jobs run on a dedicated Celery queue so exports can't starve other background work. Each job records row counts, bytes and timings, and emits metrics so we can see export latency per report.

## What changes
- **New \`exports\` app**: an \`ExportJob\` model, a state machine (queued, running, delivered, failed, expired), and the \`Formatter\` and \`Delivery\` interfaces.
- **ReportService**: \`iter_rows()\` against a read replica. This assumes a replica exists; the context doesn't say.
- **Celery**: an \`exports\` queue with its own workers and a concurrency limit per user.
- **S3**: lifecycle rules that expire files after 7 days, and signed URLs that expire after 24 hours.
- **API**: create, status and download endpoints, versioned under \`/api/v2/exports\`.
- **Observability**: metrics and alerts for failed and slow jobs.

## How we'd build it
1. \`exports\` app skeleton, model and state machine (3 days).
2. \`iter_rows()\` and the CSV formatter (3 days).
3. Pipeline task, S3 upload and the dedicated queue (4 days).
4. Delivery by download and by email (3 days).
5. API, the Reports page button and a status view (3 days).
6. Metrics, alerts and a runbook (2 days).

## Testing and rollout
Contract tests for \`iter_rows()\` against every report type. Soak tests at 500,000 rows. Shadow-run exports for a week before turning the button on.

## Risks and trade-offs
This is the most work, about four weeks, and it adds a new app, a queue and possibly a replica to operate. Much of the flexibility pays off only if more formats and channels actually come.

## Why the council should choose this
Exports will grow. This design keeps them from leaking into \`ReportService\`, isolates their load, and makes them observable from day one.`;

const ballot = (ranking: string[], scores: Record<string, number>) => fence + "json\n" + JSON.stringify({ ranking, scores }) + "\n" + fence;

const advocate = `## Verdict
B gives users the best experience of the three: one predictable way to export, visible progress, and an email that arrives without anyone having to guess which kind of export they started. A meets the requirements too, but its behavior changes as a report grows. C serves the team more than the users.

## A: Stream Small, Queue Large
Small exports download instantly, which is what most people want. But the same button sometimes downloads and sometimes emails, with no warning before the click, and there's no progress for the big ones. Users will read that as flaky.

## B: Every Export Is a Job
A progress toast and a download that simply starts meet the 30-second rule the way users experience it, not as a server threshold. The Recent exports list answers "where did my file go?" without a support ticket. It's the only proposal that shows people what's happening.

## C: A Dedicated Export Pipeline
Sound, but the parts users see arrive in the last week of a four-week plan, and the status view is barely described. Nothing here is better for users than B.

## Worth keeping
From A: use the row count to tell people up front when an export is big enough to come by email, instead of making them wait 30 seconds to find out.

${ballot(["B", "A", "C"], { A: 7, B: 9, C: 5 })}`;

const skeptic = `## Verdict
A is the most likely to ship without incident. It adds one Celery task and one endpoint, and it handles the risky part, a 500,000-row query, the same careful way in both of its paths. B and C put every export behind the job queue, and B doesn't say what happens when that queue backs up.

## A: Stream Small, Queue Large
Strength: server-side cursors and streaming keep memory flat, and it names formula injection as a test case. Weakness: \`StreamingHttpResponse\` holds a web worker and a database connection for the whole download, so several large-ish exports at once could exhaust the pool. Streaming needs a hard time limit, not just a row threshold.

## B: Every Export Is a Job
Strength: one code path is easier to reason about. Weakness: it routes even tiny exports through Celery, which today shares a Redis broker with everything else, so a backlog slows every export and nobody is alerted. The signed URL's lifetime, and who can use it, aren't specified, which matters for report data.

## C: A Dedicated Export Pipeline
Strength: the dedicated queue, per-user limits and metrics answer my concerns about B. Weakness: it assumes a read replica the context never mentions, and a v2 API for one feature is scope we don't need.

## Worth keeping
From C: a dedicated Celery queue with a per-user concurrency limit, whichever proposal wins.

${ballot(["A", "C", "B"], { A: 8, B: 5, C: 6 })}`;

const strategist = `## Verdict
B is the best investment. It costs about a week more than A, but it removes the threshold A would need to keep tuning, and it's the foundation that the obvious next requests, Excel and scheduled exports, need anyway. C buys the same foundation at twice the price, before we know we need all of it.

## A: Stream Small, Queue Large
Cheapest and fastest to first value, and every step is small. But two paths are a maintenance cost that compounds: each new format has to be built twice, and the threshold becomes a knob someone owns forever.

## B: Every Export Is a Job
It ships in steps that each deliver something: the job model and a download first, then progress, then email. Its cost is concentrated in the Celery and S3 work, which the team already runs. The Recent exports list can wait for a second release.

## C: A Dedicated Export Pipeline
Well structured, but four weeks of work with most of the value in the last week, and it may need a read replica nobody has budgeted for. Better as the direction B grows into than as the first release.

## Worth keeping
From C: record row counts and timings on every job from the start, so the 30-second behavior can be tuned from data.

${ballot(["B", "A", "C"], { A: 7, B: 8, C: 5 })}`;

const chair = `# CSV Export as Background Jobs
Every report on the Reports page gets an **Export CSV** button. Each export runs as a job on its own Celery queue: most download within seconds, and anything slower than 30 seconds arrives by email.

## The decision
The council adopted Proposal B, "Every Export Is a Job", on first-place votes after it tied with Proposal A at 7 points. The Advocate and the Strategist ranked it first for its single, predictable path and because later export formats will build on it. The Skeptic preferred A and raised the one serious risk in B, a shared Celery queue; this plan answers it with Proposal C's dedicated queue and per-user limits. From A it keeps the up-front row count, so people know before they wait when a file will come by email.

## Requirements
- **A button on every report**: one shared component on the Reports page, wired to each report's current filters.
- **Respects filters and date range**: the job stores the exact filters at the moment of the click and runs the same \`ReportService\` query.
- **Up to 500,000 rows without timing out**: rows stream from a server-side cursor into a multipart upload to S3, and no web request waits on the export.
- **Email after 30 seconds**: the page waits up to 30 seconds for the job, then hands off to the Notifications module.

## Design
Clicking **Export CSV** creates an \`ExportJob\` with the user, the report, the filters and a row estimate from a \`COUNT(*)\` of the filtered query. If the estimate is over 200,000 rows, the page says straight away that the file will be emailed, as Proposal A suggested. Otherwise it shows a progress toast that polls the job every two seconds.

A Celery task on a new \`exports\` queue reads rows through \`ReportService\`, writes CSV in batches of 5,000 and uploads the parts to S3 under \`exports/\`, updating the job's progress as it goes. When it finishes, the page downloads the file if it is still waiting; if the 30 seconds have passed, the task sends an "export ready" email through the Notifications module instead.

## Changes by area
- **Data model**: an \`ExportJob\` table with status, filters, row estimate, rows written, S3 key and timings.
- **ReportService**: a row iterator for the filtered query, using a server-side cursor. No existing query changes.
- **Celery**: an \`export_report_csv\` task on a dedicated \`exports\` queue, with at most two running exports per user, from Proposal C.
- **S3**: an \`exports/\` prefix with a lifecycle rule that deletes files after 7 days.
- **API**: \`POST /exports\`, \`GET /exports/<id>\`, and \`GET /exports/<id>/file\`, which checks the user and redirects to an S3 link signed for five minutes.
- **Reports page**: the button and the progress toast.
- **Notifications module**: an "export ready" email template that links to \`/exports/<id>/file\`.

## Implementation steps
1. \`ExportJob\` model and migration (1 day).
2. Row iterator in \`ReportService\` and the CSV writer, with tests (2 days).
3. Celery task, dedicated queue and S3 multipart upload (3 days).
4. API endpoints and the signed download (1 day).
5. Export button and progress toast on the Reports page (2 days).
6. Email handoff through the Notifications module (1 day).
7. Metrics for queue time, rows and duration per job, and an alert on failures, from Proposal C (1 day).

## Testing
- Unit tests for the CSV writer, including cells that start with \`=\`, \`+\`, \`-\` or \`@\`, which are escaped so spreadsheets don't run them.
- Integration tests that an export matches the on-screen report for the same filters and date range.
- A 500,000-row export on staging, watching worker memory and total time.
- A backlog test: fill the \`exports\` queue and confirm other Celery work carries on.

## Rollout
Ship behind a feature flag, first to internal users, then to 10% of workspaces, then everyone. The \`exports\` queue gets its own workers before the flag turns on. Rolling back means turning the flag off; jobs already running finish, and their emails still send.

## Risks and mitigations
- **A backlog slows every export**: the dedicated queue and per-user limit isolate exports, and an alert fires when queue time passes 60 seconds.
- **Report data leaking through links**: downloads check the user's session and use links signed for five minutes, and files are deleted after 7 days.
- **Slow queries on the largest reports**: the row estimate sends very large exports straight to email, and the timings from step 7 show which reports need indexes.
- **Scope creep**: Proposal B's Recent exports list waits for a second release.

## Open questions
- Should the 7-day retention be configurable per workspace for compliance?
- Is there a read replica the export query could run against, as Proposal C assumed?
- Should admins be able to see and cancel running exports?

## Dissent
The Skeptic ranked this proposal last, arguing that routing every export through a shared Celery broker lets one backlog slow them all, with nobody alerted. The concern is fair. The plan answers it with a dedicated queue, per-user limits and an alert on queue time, taken from Proposal C, while keeping B's single, predictable path for users.`;

// Each seat's answer, by seat.
export const answers: Record<string, string> = { A, B, C, advocate, skeptic, strategist, chair };
