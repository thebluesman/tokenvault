// The Settings overlay and the one-time connect question — UX git-sync §5.
//
// A **full-panel overlay behind the header gear**, not a fourth tab (configuring a repo is
// something you do once and then don't), not a section of the Tokens tab (it has nothing to do
// with a token), and not a modal (it has several fields and a connection test, and modals in this
// panel are for one decision).
//
// The one rule here that is a security property rather than a preference — ADR-0006 §1, UX §14:
//
//   > The PAT never enters the DOM. §5.2's field renders `••••` plus four characters from stored
//   > *metadata*, not from the token. No `value` attribute, no reveal toggle, no autofill-able
//   > input, and the field is inert until `[ Replace ]` swaps it for an empty one.
//
// The typed replacement lives in one local `const` inside the save handler, goes straight to the
// sandbox, and is never read back. `patLastFour` is derived at save time in `state.ts` so that
// rendering this screen never requires the PAT to be read out of storage at all.

import type { Appearance } from "../messages";
import type { RepoSettings } from "../git/types";
import { getAppearance, setAppearance } from "./appearance";
import { DEFAULT_TOKENS_DIR, parseRepo } from "../git/state";
import { normalizeTokensDir } from "../git/paths";
import { button, copy, el, toast } from "./dom";
import { openModal } from "./applyDialog";
import {
  checkPastedToken,
  disconnect,
  getGit,
  probeRepo,
  saveSettings,
  seedBase,
  testConnection,
  tokenExpiry,
} from "./git";
import {
  NEW_TOKEN_URL,
  expiryDetail,
  expiryHeadline,
  patChecklist,
  patChecklistText,
  statusLine as composeStatusLine,
  tokenVerdict,
  type TokenCheck,
  type TokenVerdict,
} from "../git/patSetup";
import { renderHowItWorks } from "./threePlace";
import { getModel } from "./state";

const settingsEl = document.getElementById("settings") as HTMLElement;

let open = false;
let onClose: () => void = () => undefined;

export function setSettingsCloseHandler(fn: () => void): void {
  onClose = fn;
}

export function closeSettings(): void {
  if (!open) return;
  open = false;
  settingsEl.classList.add("hidden");
  settingsEl.textContent = "";
  onClose();
}

export function openSettings(): void {
  open = true;
  helpOpen = false;
  renderSettings();
}

/**
 * Whether the gear carries its one state mark — `git-sync.md` §5.1, widened by
 * `onboarding-polish.md` §4.4.
 *
 * §5.1's rule was *amber `⚑` when the connection is broken*, argued from the point that a settings
 * icon decorated when everything is fine teaches the user to ignore it. That argument holds, so the
 * rule widens rather than loosening: **the `⚑` means the connection needs you**, of which *broken*
 * and *about to break* are two members. An expiring token is not "fine"; it is a scheduled outage,
 * and it is the only failure in the product that arrives with no user action at all. Still not a
 * count, and still never a green dot.
 */
export function connectionNeedsYou(): boolean {
  if (tokenExpiry().state !== "none") return true;
  const failure = getGit().failure;
  if (failure === null) return false;
  return (
    failure.kind === "unauthorized" ||
    failure.kind === "not-found" ||
    failure.kind === "forbidden-write"
  );
}

// ---------------------------------------------------------------------------

/** Local, unsaved edits to the fields. Reset each time the overlay opens. */
interface Draft {
  repo: string;
  branch: string;
  tokensDir: string;
  /** `null` = leave the stored token alone. A string = replace it with this. */
  token: string | null;
  replacing: boolean;
  branches: string[] | null;
  note: string | null;
  /** `onboarding-polish.md` §4.2 — open by default while the token field is empty. */
  howOpen: boolean;
  /** §4.3's in-place result. `null` until a token has been pasted and answered for. */
  verdict: TokenVerdict | null;
  /** The expiry the check found, carried into `RepoSettings.patExpiresAt` on save (§4.4). */
  checkedExpiry: string | null;
  /** A named failure from the paste-time check — a 401 or 404 keeps §11's own copy, verbatim. */
  checkFailure: string | null;
  checking: boolean;
}

let draft: Draft = blankDraft();

/** The `How Tokenvault works` page — a screen of this overlay, not a tab (§7.2). */
let helpOpen = false;

function blankDraft(): Draft {
  const settings = getGit().settings;
  return {
    repo: settings === null ? "" : `${settings.owner}/${settings.repo}`,
    branch: settings?.branch ?? "main",
    tokensDir: settings?.tokensDir ?? DEFAULT_TOKENS_DIR,
    token: null,
    replacing: settings === null,
    branches: null,
    note: null,
    // Open while there is no stored token to collapse it, closed once there is one. Reopenable
    // forever either way — the disclosure is the *how*, and someone remaking a token wants it back.
    howOpen: !getGit().hasToken,
    verdict: null,
    checkedExpiry: null,
    checkFailure: null,
    checking: false,
  };
}

export function renderSettings(): void {
  if (!open) return;
  const git = getGit();
  if (settingsEl.textContent === "") {
    draft = blankDraft();
    // A fresh draft has no token in it, so nothing has been asked about yet. Reset alongside it, or
    // a check answered in a previous visit would let Save skip the wait for a newly pasted string.
    checkSequence += 1;
    checkedToken = null;
    inFlightToken = null;
    inFlightCheck = null;
  }

  settingsEl.textContent = "";
  settingsEl.classList.remove("hidden");
  // The in-place repaint targets belong to the tree being replaced. Dropped here so a stale node
  // detached from the document can never be painted into.
  checkResultEl = null;
  disclosureEl = null;
  statusEl = null;

  if (helpOpen) {
    renderHelpScreen();
    return;
  }

  const head = el("div", "panel-head");
  const back = button("←");
  back.title = "Back";
  back.addEventListener("click", closeSettings);
  head.appendChild(back);
  head.appendChild(el("div", "title", "Settings"));
  settingsEl.appendChild(head);

  const body = el("div", "panel-body");
  // "GitHub", not "Git provider" — §2's out-of-scope table. Don't design a picker for one provider.
  body.appendChild(el("h3", undefined, "GitHub"));

  // --- Repository -----------------------------------------------------------
  // First, because the token instructions name it (§4.1, §4.2).
  const repoInput = field(body, "Repository", draft.repo, "owner/repo");
  body.appendChild(el("div", "empty", "Paste a repo URL or type owner/repo."));
  repoInput.addEventListener("input", () => {
    draft.repo = repoInput.value;
    repoInput.classList.toggle("invalid", repoInput.value.trim().length > 0 && parseRepo(repoInput.value) === null);
    // §4.3's verdict names the repo it was about — *"This token can read and write owner/repoA"* —
    // so editing the field it names makes it a claim about somewhere else. It retires immediately
    // and re-asks itself if there is still a token to ask about.
    invalidateTokenCheck();
  });

  // --- Access token ---------------------------------------------------------
  // **Above the branch picker** (§4.1). The old order put a dropdown populated by
  // `GET …/branches` — a call needing a credential — above the field that supplies the credential,
  // so a first-timer's second interaction with this screen was a control that could not load.
  tokenSection(body);

  // --- Branch ---------------------------------------------------------------
  // A picker, not a free-text field: a typo'd branch name is a 404 the user then has to tell apart
  // from "the token can't see it", which §11 says are indistinguishable. The current value is
  // always present even if the list never loads.
  const branchWrap = el("div", "field");
  branchWrap.appendChild(el("label", undefined, "Branch"));
  const branchSelect = el("select") as HTMLSelectElement;
  const names = draft.branches ?? [];
  const options = names.indexOf(draft.branch) === -1 ? [draft.branch].concat(names) : names;
  for (const name of options) {
    const option = el("option", undefined, name) as HTMLOptionElement;
    option.value = name;
    branchSelect.appendChild(option);
  }
  branchSelect.value = draft.branch;
  branchSelect.addEventListener("change", () => {
    draft.branch = branchSelect.value;
  });
  branchWrap.appendChild(branchSelect);
  const loadBranches = button("Load branches");
  loadBranches.addEventListener("click", () => {
    void (async () => {
      // Reads. It never writes — Tokenvault is a sync client, not a git client (§9, UX §7.5).
      const list = await testConnection();
      if (list === null) {
        renderSettings();
        return;
      }
      draft.branches = list;
      renderSettings();
    })();
  });
  branchWrap.appendChild(loadBranches);
  body.appendChild(branchWrap);

  // --- Tokens folder --------------------------------------------------------
  const dirInput = field(body, "Tokens folder", draft.tokensDir, "tokens");
  dirInput.addEventListener("input", () => {
    draft.tokensDir = dirInput.value;
  });
  // "Tokenvault writes to my repo" is a scary sentence; this is the true and reassuring one, and it
  // is what `base_tree` actually guarantees (ADR-0006 §8).
  body.appendChild(
    el(
      "div",
      "empty",
      "Where Tokenvault reads and writes token JSON. Nothing outside this folder is ever touched."
    )
  );

  if (draft.note !== null) {
    const note = el("div", "entry");
    note.appendChild(el("div", undefined, draft.note));
    body.appendChild(note);
  }
  if (git.failure !== null) {
    const failure = el("div", "entry");
    failure.appendChild(el("div", "kind", git.failure.kind));
    failure.appendChild(el("div", undefined, failureText(git.failure.kind, git.failure.message, git.failure.rateLimitReset)));
    body.appendChild(failure);
  }

  appearanceSection(body);

  settingsEl.appendChild(body);

  // --- Status line and the footer ------------------------------------------
  const foot = el("div", "panel-foot");
  statusEl = el("span", "note grow", statusLine());
  foot.appendChild(statusEl);

  const save = button("Save", "primary");
  save.addEventListener("click", () => void onSave());
  foot.appendChild(save);
  settingsEl.appendChild(foot);

  const foot2 = el("div", "panel-foot");
  const test = button("Test connection");
  test.disabled = git.settings === null || (!git.hasToken && draft.token === null);
  test.addEventListener("click", () => {
    void (async () => {
      const list = await testConnection();
      draft.note =
        list === null ? null : `Connected · ${git.settings?.branch ?? ""} · checked just now`;
      if (list !== null) draft.branches = list;
      renderSettings();
    })();
  });
  foot2.appendChild(test);

  if (git.settings !== null) {
    foot2.appendChild(link("Open on GitHub ↗", `https://github.com/${git.settings.owner}/${git.settings.repo}/tree/${git.settings.branch}`));
  }
  foot2.appendChild(el("span", "grow"));

  // Not destructive styling and not red: it clears settings and the sync state, and touches no
  // tokens, no Figma, and nothing in the repo. It prompts once because the last clause of the
  // prompt is a real consequence nobody would predict (§5.2, §10.3).
  const cut = button("Disconnect");
  cut.disabled = git.settings === null;
  cut.addEventListener("click", () => confirmDisconnect());
  foot2.appendChild(cut);
  settingsEl.appendChild(foot2);

  // §7.2 — a **footer** row, under `[ Disconnect ]`, rather than a body row, so it stays reachable
  // when the fields above are full. Settings is the one place in the panel a person goes when they
  // don't know something.
  const foot3 = el("div", "panel-foot");
  const how = button("How Tokenvault works");
  how.addEventListener("click", () => {
    helpOpen = true;
    renderSettings();
  });
  foot3.appendChild(how);
  settingsEl.appendChild(foot3);
}

/** §7.2's permanent page — one scrolling screen, reached from the Settings footer. */
function renderHelpScreen(): void {
  const head = el("div", "panel-head");
  const back = button("←");
  back.title = "Back to settings";
  back.addEventListener("click", () => {
    helpOpen = false;
    renderSettings();
  });
  head.appendChild(back);
  head.appendChild(el("div", "title", "How Tokenvault works"));
  settingsEl.appendChild(head);

  const body = el("div", "panel-body");
  body.appendChild(renderHowItWorks());
  settingsEl.appendChild(body);
}

// ---------------------------------------------------------------------------
// The token field — UX `onboarding-polish.md` §4.2, §4.3
// ---------------------------------------------------------------------------

/** Debounce behind the paste-time check, so typing a token doesn't spend a request per keystroke. */
let checkTimer = 0;

/** Bumped per check, so a slow answer about an older string never overwrites a newer one. */
let checkSequence = 0;

/**
 * The trimmed token string the last **completed** check answered for — verdict or named failure.
 *
 * Three things read it, and all three are the same question: *has this exact string already been
 * asked about?* Blur skips a redundant request, Save knows whether an expiry is still unlearned,
 * and editing the repo drops it because the answer was about the other repo.
 */
let checkedToken: string | null = null;

/** The string a check is in flight for, and the promise Save can join rather than start a second. */
let inFlightToken: string | null = null;
let inFlightCheck: Promise<void> | null = null;

/**
 * How long Save waits on an unanswered token check before saving anyway — `error-states.md` §1.
 *
 * A credential the user has already pasted must not be held hostage to a network that isn't
 * answering. The wait exists so the common case (paste, hit Save immediately) keeps its expiry
 * date; past it the save goes through and a notice says what wasn't recorded.
 */
const SAVE_CHECK_TIMEOUT_MS = 4000;

/**
 * The two regions of this screen that repaint **without** a full re-render, and why they must.
 *
 * The token field is a `<input type="password">` whose value is never read back out of the DOM
 * (ADR-0006 §1), so rebuilding it mid-typing would silently discard what the user had pasted —
 * `draft.token` would still hold it while the field showed nothing, which reads as the panel
 * eating a credential. The paste-time check therefore repaints its own result strip and the
 * footer's status line in place, the same way `changes.ts` repaints `drift-bulk` without
 * rebuilding forty rows beneath it.
 */
let checkResultEl: HTMLElement | null = null;
let disclosureEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;

function paintTokenCheck(): void {
  if (checkResultEl === null) return;
  checkResultEl.textContent = "";
  tokenResult(checkResultEl);
  if (statusEl !== null) statusEl.textContent = statusLine();
}

function paintDisclosure(): void {
  if (disclosureEl === null) return;
  disclosureEl.textContent = "";
  fillDisclosure(disclosureEl);
}

function tokenSection(body: HTMLElement): void {
  const git = getGit();
  const tokenWrap = el("div", "field");
  tokenWrap.appendChild(el("label", undefined, "Access token"));
  const pat = el("div", "pat-field");

  if (draft.replacing) {
    const input = el("input") as HTMLInputElement;
    input.type = "password";
    input.placeholder = "Paste a fine-grained token";
    input.style.flex = "1";
    input.addEventListener("input", () => {
      draft.token = input.value;
      // The check runs on paste and on blur (§4.3) — no button press. Debounced rather than fired
      // per keystroke, because a token pasted character by character is still one token.
      window.clearTimeout(checkTimer);
      checkTimer = window.setTimeout(() => void runTokenCheck(), 500);
    });
    input.addEventListener("blur", () => {
      // Blurring is not new information. If the debounced check has already answered for this exact
      // string — or is mid-flight with it — tabbing out of the field must not spend a second GitHub
      // request on the same question, which paste-then-tab did every time.
      const value = input.value.trim();
      if (value.length > 0 && (value === checkedToken || value === inFlightToken)) return;
      window.clearTimeout(checkTimer);
      void runTokenCheck();
    });
    pat.appendChild(input);
    if (git.settings !== null) {
      const cancel = button("Keep current");
      cancel.addEventListener("click", () => {
        draft.token = null;
        draft.replacing = false;
        draft.verdict = null;
        draft.checkFailure = null;
        renderSettings();
      });
      pat.appendChild(cancel);
    }
  } else {
    // Inert. Not an `<input>` with a masked value — a mask rendered from stored metadata, so there
    // is nothing in the DOM for a reveal toggle, an autofill, or a copy button to reach.
    const mask = el("div", "pat-mask", git.hasToken ? `••••••••••••  ${git.settings?.patLastFour ?? "····"}` : "not set");
    pat.appendChild(mask);
    const replace = button("Replace");
    replace.addEventListener("click", () => {
      draft.replacing = true;
      draft.token = "";
      draft.howOpen = true;
      renderSettings();
    });
    pat.appendChild(replace);
  }
  tokenWrap.appendChild(pat);
  body.appendChild(tokenWrap);

  // The eleven words that survive the disclosure being shut — `git-sync.md` §5.2's summary line,
  // kept because the disclosure below is the *how*, not a replacement for the *what*.
  body.appendChild(
    el("div", "empty", "A fine-grained token for this repo only, with Contents: read and write.")
  );

  disclosureEl = el("div", "disclosure");
  fillDisclosure(disclosureEl);
  body.appendChild(disclosureEl);

  checkResultEl = el("div");
  tokenResult(checkResultEl);
  body.appendChild(checkResultEl);

  expiryNotice(body);
}

/** §4.2's inline, in-panel checklist. Was `[ How ↗ ]` — a link to a doc, from a plugin, about a website. */
function fillDisclosure(wrap: HTMLElement): void {
  const repoLabel = repoName();

  const toggle = el("button", "disclosure-head", `${draft.howOpen ? "▾" : "▸"} How to make one`);
  toggle.addEventListener("click", () => {
    draft.howOpen = !draft.howOpen;
    // Repainted in place rather than re-rendered: opening the checklist while a token sits in the
    // field above must not take that token off the screen.
    paintDisclosure();
  });
  wrap.appendChild(toggle);
  if (!draft.howOpen) return;

  const inner = el("div", "disclosure-body");
  inner.appendChild(
    el("p", "empty", "You do this on github.com — Tokenvault can't create a token for you.")
  );

  patChecklist(repoLabel).forEach((step, index) => {
    const row = el("div", "step");
    row.appendChild(el("span", "step-n", String(index + 1)));
    row.appendChild(el("span", "grow", step));
    inner.appendChild(row);
  });

  const actions = el("div", "toolbar");
  // The new-token form, not a doc: the user doesn't need reading, they need to be on the right page
  // with the right three answers in hand.
  actions.appendChild(link("Open GitHub ↗", NEW_TOKEN_URL));
  // The panel is about to be behind a browser window, and a checklist you cannot see is not one.
  const copyThree = button("Copy these 3");
  copyThree.addEventListener("click", () => copy(patChecklistText(repoLabel), "the 3 steps"));
  actions.appendChild(copyThree);
  inner.appendChild(actions);

  wrap.appendChild(inner);
}

/** The three lines §4.3 asks for, in place, under the field. */
function tokenResult(body: HTMLElement): void {
  if (draft.checking) {
    body.appendChild(el("div", "empty", "Checking this token…"));
    return;
  }
  if (draft.checkFailure !== null) {
    const box = el("div", "entry");
    box.appendChild(el("div", undefined, draft.checkFailure));
    body.appendChild(box);
    return;
  }
  if (draft.verdict === null) return;

  const verdict = draft.verdict;
  const box = el("div", verdict.tone === "ok" ? "entry info" : "entry");
  box.appendChild(el("div", undefined, `${verdict.tone === "ok" ? "●" : "⚑"} ${verdict.headline}`));
  for (const line of verdict.detail) box.appendChild(el("div", "empty", line));
  if (verdict.offerGitHub) {
    const actions = el("div", "toolbar");
    actions.appendChild(link("Open GitHub ↗", NEW_TOKEN_URL));
    box.appendChild(actions);
  }
  body.appendChild(box);
}

/** §4.4 — the stored token's expiry, said before it becomes a 401 nobody can explain. */
function expiryNotice(body: HTMLElement): void {
  const expiry = tokenExpiry();
  const headline = expiryHeadline(expiry);
  if (headline === null) return;
  const box = el("div", "entry");
  box.appendChild(el("div", undefined, `⚑ ${headline}`));
  box.appendChild(el("div", "empty", expiryDetail(expiry)));
  body.appendChild(box);
}

function repoName(): string {
  const parsed = parseRepo(draft.repo);
  if (parsed !== null) return `${parsed.owner}/${parsed.repo}`;
  const settings = getGit().settings;
  return settings === null ? "your repo" : `${settings.owner}/${settings.repo}`;
}

/**
 * Runs §4.3's check against whatever is currently in the field.
 *
 * Silent when there is nothing to check — an empty field or an unparseable repo is not a failure,
 * it is a form half filled in, and saying so would be noise at exactly the wrong moment.
 */
async function runTokenCheck(): Promise<void> {
  const candidate = draft.token;
  const parsed = parseRepo(draft.repo);
  if (candidate === null || candidate.trim().length === 0 || parsed === null) {
    checkedToken = null;
    if (draft.verdict !== null || draft.checkFailure !== null) {
      draft.verdict = null;
      draft.checkFailure = null;
      paintTokenCheck();
    }
    return;
  }

  const value = candidate.trim();
  checkSequence += 1;
  const sequence = checkSequence;
  draft.checking = true;
  draft.checkFailure = null;
  inFlightToken = value;
  paintTokenCheck();

  const run = (async () => {
    const result = await checkPastedToken(parsed.owner, parsed.repo, value);
    if (sequence !== checkSequence) return;
    inFlightToken = null;
    inFlightCheck = null;
    checkedToken = value;

    draft.checking = false;
    if (result.ok) {
      applyCheck(result.check, `${parsed.owner}/${parsed.repo}`);
    } else {
      // A 401 stays *"GitHub rejected the token"* and a 404 stays *"Can't find owner/repo"* — §11's
      // copy, unchanged. Only the read-only case moves; this is a scheduling change, not a rewrite.
      draft.verdict = null;
      draft.checkedExpiry = null;
      draft.checkFailure = failureText(
        result.failure.kind,
        result.failure.message,
        result.failure.rateLimitReset
      );
    }
    paintTokenCheck();
  })();
  inFlightCheck = run;
  await run;
}

/**
 * Retires whatever the token field is currently claiming, and re-asks if it still can.
 *
 * Called when the repo changes under a finished check. The sequence bump is what drops an answer
 * already in flight: it was asked about the previous repo and its verdict would name that repo.
 */
function invalidateTokenCheck(): void {
  checkSequence += 1;
  inFlightToken = null;
  inFlightCheck = null;
  checkedToken = null;

  const showing = draft.verdict !== null || draft.checkFailure !== null || draft.checking;
  draft.verdict = null;
  draft.checkFailure = null;
  draft.checkedExpiry = null;
  draft.checking = false;
  if (showing) paintTokenCheck();

  if (draft.token !== null && draft.token.trim().length > 0) {
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => void runTokenCheck(), 500);
  }
}

/**
 * Save's guarantee that a pasted token's expiry is not lost to a race — §4.4.
 *
 * `onSave` reads `draft.checkedExpiry`, which only a completed check fills in. Pasting a token and
 * hitting Save inside the 500ms debounce therefore used to persist a real, expiring credential with
 * no expiry recorded at all, so the Repo tab could never warn before it lapsed. This waits for the
 * answer — joining a check already running rather than starting a second — and returns the notice
 * to show if it never came.
 */
async function ensureTokenChecked(): Promise<string | null> {
  const candidate = draft.token === null ? "" : draft.token.trim();
  if (candidate.length === 0) return null;
  if (checkedToken === candidate) return null;

  window.clearTimeout(checkTimer);
  const running =
    inFlightToken === candidate && inFlightCheck !== null ? inFlightCheck : runTokenCheck();

  let timer = 0;
  await Promise.race([
    running.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, SAVE_CHECK_TIMEOUT_MS);
    }),
  ]);
  window.clearTimeout(timer);

  // A check that *failed* still answered — a 401's own copy is already on screen and there is no
  // expiry to learn. Only a check that never landed leaves the user with a silent gap to explain.
  if (checkedToken === candidate) return null;
  return "Saved, but Tokenvault couldn't reach GitHub to read this token's expiry date — it won't be able to warn you before the token lapses. Open settings again when you're back online and hit Save to record it.";
}

function applyCheck(check: TokenCheck, repoLabel: string): void {
  draft.verdict = tokenVerdict(check, repoLabel);
  draft.checkedExpiry = check.expiresAt;
  draft.checkFailure = null;
}

/**
 * The Appearance section — UX `dark-mode.md` §2.3.
 *
 * **Settings, not a header control.** `git-sync.md` §4.1 fixes the test: tabs and header controls
 * are for things you do repeatedly, and this is something you set once. The gear already exists and
 * the overlay already exists, so this is one more field in it rather than a new surface.
 *
 * **The control never explains itself further.** Three words and one line of help; the case for the
 * override does not need arguing inside the panel.
 */
function appearanceSection(into: HTMLElement): void {
  into.appendChild(el("h3", undefined, "Appearance"));
  const wrap = el("div", "field");
  wrap.appendChild(el("label", undefined, "Theme"));

  const group = el("div", "chips");
  const options: Array<{ value: Appearance; label: string }> = [
    { value: "auto", label: "Auto" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  for (const option of options) {
    const chip = el("button", getAppearance() === option.value ? "chip on" : "chip", option.label);
    chip.addEventListener("click", () => {
      // Live, not on next open: the class is stamped before this handler returns and the cascade
      // repaints every open surface in place. A user who switches and sees one white rectangle
      // stay white reads it as a bug in the plugin, which it would be.
      setAppearance(option.value);
      renderSettings();
    });
    group.appendChild(chip);
  }
  wrap.appendChild(group);
  into.appendChild(wrap);
  into.appendChild(el("div", "empty", "Auto follows Figma's own theme."));
}

/**
 * §4.5 — the status line says what is missing, not that the button is off.
 *
 * The shape lives in `patSetup.ts` so it can be reasoned about without a DOM; this reads the two
 * view models and hands it the answer. `hasToken` counts a typed-but-unsaved one: the field is
 * filled in, and telling someone they need a token while they are looking at the one they just
 * pasted is worse than saying nothing.
 */
function statusLine(): string {
  const git = getGit();
  return composeStatusLine({
    settings: git.settings,
    hasToken: git.hasToken || (draft.token !== null && draft.token.trim().length > 0),
    connectedForFile: git.sync !== null,
    draftRepo: parseRepo(draft.repo) !== null,
    failure: git.failure !== null,
    checked: git.checkedAt !== null || draft.verdict !== null,
  });
}

function field(into: HTMLElement, label: string, value: string, placeholder: string): HTMLInputElement {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", undefined, label));
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  wrap.appendChild(input);
  into.appendChild(wrap);
  return input;
}

/** An external link. Figma's plugin iframe allows `window.open`; nothing else leaves the panel. */
function link(label: string, href: string): HTMLElement {
  const node = el("button", "chip", label);
  node.addEventListener("click", () => window.open(href, "_blank"));
  return node;
}

// ---------------------------------------------------------------------------

/** Re-entry guard: Save now awaits, and a second click mid-await would save twice. */
let saving = false;

async function onSave(): Promise<void> {
  if (saving) return;
  const parsed = parseRepo(draft.repo);
  if (parsed === null) {
    draft.note = "That doesn't look like a repository. Paste a GitHub URL, or type owner/repo.";
    renderSettings();
    return;
  }

  saving = true;
  let expiryNote: string | null;
  try {
    expiryNote = await ensureTokenChecked();
  } finally {
    saving = false;
  }

  const settings: RepoSettings = {
    owner: parsed.owner,
    repo: parsed.repo,
    branch: draft.branch.trim().length === 0 ? "main" : draft.branch.trim(),
    tokensDir: normalizeTokensDir(draft.tokensDir),
    patLastFour: getGit().settings?.patLastFour,
    // §4.4: the expiry the paste-time check learned, kept beside the token's last four. A save that
    // doesn't replace the token keeps whatever was already recorded — the date belongs to the
    // credential, not to this visit to the screen.
    patExpiresAt:
      draft.token === null ? getGit().settings?.patExpiresAt : (draft.checkedExpiry ?? undefined),
  };

  // `draft.token` is `null` for "leave the stored one alone" and a string for "replace it". The
  // distinction matters: editing a repo URL must not silently drop a credential the field can
  // never show back to the user.
  const token = draft.token === null ? undefined : draft.token;
  saveSettings(settings, token);
  draft.replacing = false;
  draft.token = null;
  checkedToken = null;
  draft.note = expiryNote;
  // The disclosure collapses once a valid token is stored (§4.2) — reopenable forever.
  if (token !== undefined && draft.verdict !== null && draft.verdict.tone === "ok") {
    draft.howOpen = false;
  }
  renderSettings();

  await maybeFirstConnect();
}

/**
 * First connect — asked once, and only when there is genuinely a question (§5.3, ADR-0006 §6).
 *
 * Skipped entirely when the repo has no tokens folder (the first push is the bootstrap) or when
 * this Figma file has never been scanned (there is nothing to adopt *from*). Asking "adopt or
 * publish?" when there is nothing to adopt is a dialog with one real answer.
 */
export async function maybeFirstConnect(): Promise<void> {
  const git = getGit();
  if (git.settings === null || git.sync !== null) return;

  const probe = await probeRepo();
  if (probe === null) {
    renderSettings();
    return;
  }

  if (probe.remoteFiles === 0 || !getModel().ready || probe.localFiles === 0) {
    await seedBase(probe.remoteFiles === 0 ? "figma" : "repo");
    renderSettings();
    return;
  }

  openConnectModal(probe.remoteFiles);
}

function openConnectModal(remoteFiles: number): void {
  const git = getGit();
  let side: "repo" | "figma" = "repo";

  openModal((close) => {
    const card = el("div", "modal-card");

    const head = el("div", "modal-head");
    const heading = el("div", "grow");
    heading.appendChild(el("div", "title", `Connect to ${git.settings?.repo ?? ""}`));
    // The counts sit in the header so the choice is made against a number rather than a feeling.
    heading.appendChild(
      el(
        "div",
        "sub",
        `${git.settings?.branch ?? "main"} · ${remoteFiles} token file${remoteFiles === 1 ? "" : "s"} already in ${git.settings?.tokensDir ?? "tokens"}/`
      )
    );
    head.appendChild(heading);
    const dismiss = el("button", "modal-close", "✕");
    dismiss.title = "Cancel";
    dismiss.addEventListener("click", close);
    head.appendChild(dismiss);
    card.appendChild(head);

    const body = el("div", "modal-body");
    body.appendChild(
      el("p", undefined, "Both sides already have tokens. Which one should Tokenvault start from?")
    );

    const choose = (
      value: "repo" | "figma",
      label: string,
      explanation: string[]
    ): void => {
      const wrap = el("label", "toolbar");
      wrap.style.alignItems = "flex-start";
      const radio = el("input") as HTMLInputElement;
      radio.type = "radio";
      radio.name = "connect-side";
      // The repo is preselected: it is the source of truth (ADR-0006 §2) and the non-destructive
      // direction — adopting produces pending changes that still need an apply, so nothing is
      // written anywhere until the user confirms again. A default that overwrites someone's repo
      // on first run is not a default.
      radio.checked = value === side;
      radio.addEventListener("change", () => {
        side = value;
      });
      wrap.appendChild(radio);
      const text = el("div", "grow");
      text.appendChild(el("div", undefined, label));
      for (const line of explanation) text.appendChild(el("div", "empty", line));
      wrap.appendChild(text);
      body.appendChild(wrap);
    };

    choose("repo", "The repo", [
      `Its ${remoteFiles} file${remoteFiles === 1 ? "" : "s"} become the baseline.`,
      "Anything Figma says differently shows up as pending changes you can review and apply.",
      "Nothing is written anywhere yet.",
    ]);
    choose("figma", "This Figma file", [
      "Your tokens become the baseline and overwrite the repo's on your next push.",
    ]);
    card.appendChild(body);

    const foot = el("div", "modal-foot");
    const actions = el("div", "actions");
    const cancel = button("Cancel");
    cancel.addEventListener("click", close);
    actions.appendChild(cancel);
    actions.appendChild(el("span", "grow"));
    const connect = button("Connect", "primary");
    connect.addEventListener("click", () => {
      close();
      void (async () => {
        await seedBase(side);
        toast(side === "repo" ? "Connected — the repo is the baseline." : "Connected — your tokens are the baseline.");
        renderSettings();
      })();
    });
    actions.appendChild(connect);
    foot.appendChild(actions);
    card.appendChild(foot);
    return card;
  });
}

function confirmDisconnect(): void {
  const git = getGit();
  const name = git.settings === null ? "this repo" : `${git.settings.owner}/${git.settings.repo}`;
  openModal((close) => {
    const card = el("div", "modal-card");
    const head = el("div", "modal-head");
    head.appendChild(el("div", "title", `Disconnect from ${name}?`));
    card.appendChild(head);

    const body = el("div", "modal-body");
    body.appendChild(
      el(
        "p",
        undefined,
        // The last clause is the one nobody would predict, and it is why this prompts at all.
        "Your tokens and local changes stay exactly as they are; drift goes back to comparing against your last scan."
      )
    );
    card.appendChild(body);

    const foot = el("div", "modal-foot");
    const actions = el("div", "actions");
    const cancel = button("Cancel");
    cancel.addEventListener("click", close);
    actions.appendChild(cancel);
    actions.appendChild(el("span", "grow"));
    const go = button("Disconnect");
    go.addEventListener("click", () => {
      close();
      disconnect();
      draft = blankDraft();
      toast("Disconnected.");
      renderSettings();
    });
    actions.appendChild(go);
    foot.appendChild(actions);
    card.appendChild(foot);
    return card;
  });
}

/**
 * §11's copy table, keyed by failure kind.
 *
 * Every string is written by us from a status code — never GitHub's response body, which can echo
 * a request header, and never a URL, which can carry a token (UX §14). `api.ts` has already written
 * most of them; this adds the panel-side sentence a kind needs on top of its own.
 */
export function failureText(kind: string, message: string, reset?: number): string {
  if (kind === "rate-limited" && reset !== undefined && reset > 0) {
    const at = new Date(reset * 1000);
    const hh = `${at.getHours()}`.padStart(2, "0");
    const mm = `${at.getMinutes()}`.padStart(2, "0");
    return `${message} Try again after ${hh}:${mm}.`;
  }
  return message;
}

