// What the stand-in agents in the tests answer as each of Quorum's seats.

// A valid answer for each Quorum seat, which says where it ran, or null if the prompt isn't a seat's.
export function seatAnswer(p: string, cwd: string): string | null {
  const seat = (/^You are (The \w+ Reviewer|The \w+|the Chair)/.exec(p) || [])[1];
  const where = "Ran in " + cwd + ".";
  if (/^You are the Chair[^\n]*finishing the plan after its final review/.test(p)) {
    return "# The Plan, Reviewed\nWhat we'll build.\n\n## The decision\nProposal A. " + where + "\n\n## Final review\n- **High**: fixed.";
  }
  if (/ Reviewer$/.test(seat || "")) {
    return "## Verdict\nNearly. " + where + "\n\n## Findings\n1. **High**: exports aren't rate limited. Add a limit.\n\n## What the plan gets right\nThe queue.";
  }
  if (["The Pragmatist", "The Visionary", "The Architect"].includes(seat)) {
    return "# " + seat.slice(4) + " Route\n> A pitch.\n\n## The approach\n" + where + "\n\n## What changes\n- src/app.js\n\n## How we'd build it\n1. Step\n\n## Testing and rollout\nTests.\n\n## Risks and trade-offs\nSome.\n\n## Why the council should choose this\nIt fits.";
  }
  if (["The Advocate", "The Skeptic", "The Strategist"].includes(seat)) {
    return "## Verdict\nA fits best. " + where + "\n\n## A: x\nGood.\n\n## B: y\nOk.\n\n## C: z\nOk.\n\n## Worth keeping\nTests.\n\n```json\n" +
      JSON.stringify({ ranking: ["A", "B", "C"], scores: { A: 8, B: 6, C: 4 } }) + "\n```";
  }
  if (seat === "the Chair") return "# The Plan\nWhat we'll build.\n\n## The decision\nProposal A. " + where + "\n\n## Implementation steps\n1. Build";
  return null;
}

// What the Chair's agent names a session, from the feature in the naming prompt, or null if the prompt isn't that.
export function nameAnswer(p: string): string | null {
  if (!/^Name a session of Quorum/.test(p)) return null;
  const feature = (/"""\n([\s\S]*?)\n"""/.exec(p) || [])[1] || "";
  return "Session on " + feature.split("\n")[0].replace(/\.$/, "");
}
