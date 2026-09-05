// The three-place explainer — UX `onboarding-polish.md` §7.
//
// Every empty state in the panel is excellent locally and none of them explains the system. A
// first-timer can read *"No tokens yet. Scan the file on the Import tab"* and still not know that
// the plugin holds a copy, that editing changes nothing in Figma, or that there is a third place
// at all.
//
// **Not a tour, not a modal, not a dismissible carousel** (§7.1). A tour is a thing people skip; a
// first-run modal is the single most-complained-about pattern in a plugin listing; and the local
// empty states are already good — the missing thing is the *system*, best explained standing
// inside the part of it you are in.
//
// So it is one component with an enum, rendered into three existing empty states, above their
// existing copy. It disappears by being **outgrown, not dismissed**: it lives inside an empty
// state, so it is gone the moment that screen has content, there is no dismissal flag anywhere,
// and it comes back — correctly — for someone who opens a fresh Figma file six months later.
//
// §7.3's copy register applies to every string in this file and to the Settings page below it:
// three internal words are banned outright — *overlay*, *baseline*, *DTCG* — as is *drift*, which
// `apply-and-drift.md` §3 already bans panel-wide. `test/onboarding.test.ts` asserts it.

import { el } from "./dom";

/** The three places, in the order the drawing puts them. */
export type Place = "figma" | "tokenvault" | "repo";

/** Which screen the strip is standing in — one enum, three placements (§11). */
export type Placement = "import" | "tokens" | "repo";

export interface PlacementCopy {
  place: Place;
  /** The one sentence under the drawing. Leads with what this screen owns. */
  lead: string;
  body: string;
}

/**
 * One sentence per screen, each naming the verb that screen owns.
 *
 * The user meets the model one third at a time, in the place that third is true. Three sentences
 * total is the whole explanation budget, and it buys the entire model.
 */
export const PLACEMENTS: Record<Placement, PlacementCopy> = {
  import: {
    place: "figma",
    lead: "Start here.",
    body:
      "Tokenvault reads your Figma Variables and Styles into a set of token files it keeps for you. Nothing in Figma changes.",
  },
  tokens: {
    place: "tokenvault",
    lead: "Your tokens live here, not in Figma.",
    body:
      "Edits stay in the plugin until you Apply them to the file or Push them to a repo.",
  },
  repo: {
    place: "repo",
    lead: "A repo makes your tokens outlive this file.",
    body: "Push sends the token JSON to GitHub; Pull brings back what someone else changed.",
  },
};

const LABELS: Record<Place, string> = {
  figma: "Figma file",
  tokenvault: "Tokenvault",
  repo: "GitHub repo",
};

/**
 * The drawing from `user-journeys.md` §2, because that drawing already works.
 *
 * Rendered as text nodes rather than an SVG: it is four words and four arrows, it has to survive
 * both themes with no colour of its own, and at 460 px an SVG would be the heavier of the two.
 */
function diagram(highlighted: Place | null): HTMLElement {
  const wrap = el("div", "three-place");

  const row = el("div", "tp-row");
  const places: Place[] = ["figma", "tokenvault", "repo"];
  places.forEach((place, index) => {
    if (index > 0) {
      row.appendChild(el("span", "tp-arrow", index === 1 ? "──scan──▶" : "──push──▶"));
    }
    row.appendChild(
      el("span", highlighted === place ? "tp-place on" : "tp-place", LABELS[place])
    );
  });
  wrap.appendChild(row);

  // The return legs, said in words rather than drawn, so the strip stays one line tall on a narrow
  // panel. Apply and Pull are the two verbs the forward arrows don't carry.
  wrap.appendChild(el("div", "tp-back", "◀──apply── back to Figma   ·   ◀──pull── back from GitHub"));
  return wrap;
}

/**
 * The strip, for one screen's empty state. Static: no interaction, nothing to dismiss.
 *
 * Placed **above** the existing empty-state copy, which is untouched and stays beneath it. The
 * strip explains the system; the sentence under it explains the screen; the button under that does
 * the thing.
 */
export function threePlaceStrip(placement: Placement): HTMLElement {
  const copy = PLACEMENTS[placement];
  const wrap = el("div", "three-place-strip");
  wrap.appendChild(diagram(copy.place));
  const line = el("p", "tp-line");
  line.appendChild(el("b", undefined, copy.lead));
  line.appendChild(document.createTextNode(` ${copy.body}`));
  wrap.appendChild(line);
  return wrap;
}

// ---------------------------------------------------------------------------
// The permanent page — §7.2
// ---------------------------------------------------------------------------

export interface HelpBlock {
  heading: string;
  lines: string[];
}

/**
 * `How Tokenvault works`, in the footer of the Settings overlay.
 *
 * It exists as much for the person returning after a month as for the first-timer, which is why it
 * is permanent rather than part of a first-run sequence. The block that matters most, and has never
 * been said in the panel, is the third one: the plugin's working copy and your token are on this
 * device only, and a repo is the only thing that makes either survive a new machine.
 */
export const HOW_IT_WORKS: HelpBlock[] = [
  {
    heading: "Your Figma file",
    lines: [
      "Holds the Variables and Styles you already design with.",
      "Scan reads them into Tokenvault. Apply writes Tokenvault's values back.",
      "Nothing here changes unless you press Apply.",
    ],
  },
  {
    heading: "Tokenvault",
    lines: [
      "Holds a working copy of your tokens, plus any edits you've made that haven't gone anywhere yet.",
      "This copy lives on this device only. So does your GitHub token.",
      "Uninstalling the plugin, or moving to another computer, leaves it behind.",
    ],
  },
  {
    heading: "Your GitHub repo",
    lines: [
      "Holds the token JSON as files you can review, branch and roll back.",
      "Push sends your tokens to it. Pull brings back what someone else changed.",
      "A repo is the only thing that makes your tokens survive a new machine.",
    ],
  },
];

/** The four verbs, in a four-row table — §7.2. */
export const VERBS: Array<[string, string]> = [
  ["Scan", "reads Figma"],
  ["Apply", "writes Figma"],
  ["Push", "writes the repo"],
  ["Pull", "writes neither"],
];

/**
 * The two fears a stranger installs this with, both answered, neither stated anywhere else.
 *
 * Both are true — ADR-0006 §8's `base_tree` carries every file outside the tokens folder through by
 * SHA, and ADR-0005 makes the confirmed apply dialog the only write path into the document.
 */
export const NEVER_DOES: string[] = [
  "Tokenvault never writes anything outside your tokens folder.",
  "Tokenvault never changes your Figma file without an explicit Apply.",
];

export function renderHowItWorks(): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(diagram(null));

  for (const block of HOW_IT_WORKS) {
    wrap.appendChild(el("h3", undefined, block.heading));
    for (const line of block.lines) wrap.appendChild(el("p", "empty", line));
  }

  wrap.appendChild(el("h3", undefined, "The four verbs"));
  for (const [verb, meaning] of VERBS) {
    const row = el("div", "row");
    row.appendChild(el("b", "name", verb));
    row.appendChild(el("span", "empty", meaning));
    wrap.appendChild(row);
  }

  wrap.appendChild(el("h3", undefined, "What Tokenvault never does"));
  for (const line of NEVER_DOES) wrap.appendChild(el("p", "empty", line));
  return wrap;
}
