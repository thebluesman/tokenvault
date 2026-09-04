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
import { button, el, toast } from "./dom";
import { openModal } from "./applyDialog";
import {
  disconnect,
  getGit,
  probeRepo,
  saveSettings,
  seedBase,
  testConnection,
} from "./git";
import { getModel } from "./state";

const settingsEl = document.getElementById("settings") as HTMLElement;

const TOKEN_DOCS =
  "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens";

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
  renderSettings();
}

/** Whether the gear should carry its one state mark — an amber `⚑` for a broken connection (§5.1). */
export function connectionBroken(): boolean {
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
}

let draft: Draft = blankDraft();

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
  };
}

export function renderSettings(): void {
  if (!open) return;
  const git = getGit();
  if (settingsEl.textContent === "") draft = blankDraft();

  settingsEl.textContent = "";
  settingsEl.classList.remove("hidden");

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
  const repoInput = field(body, "Repository", draft.repo, "owner/repo");
  body.appendChild(el("div", "empty", "Paste a repo URL or type owner/repo."));
  repoInput.addEventListener("input", () => {
    draft.repo = repoInput.value;
    repoInput.classList.toggle("invalid", repoInput.value.trim().length > 0 && parseRepo(repoInput.value) === null);
  });

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

  // --- Access token ---------------------------------------------------------
  const tokenWrap = el("div", "field");
  tokenWrap.appendChild(el("label", undefined, "Access token"));
  const pat = el("div", "pat-field");

  if (draft.replacing) {
    const input = el("input") as HTMLInputElement;
    input.type = "password";
    input.placeholder = "github_pat_…";
    input.style.flex = "1";
    input.addEventListener("input", () => {
      draft.token = input.value;
    });
    pat.appendChild(input);
    if (git.settings !== null) {
      const cancel = button("Keep current");
      cancel.addEventListener("click", () => {
        draft.token = null;
        draft.replacing = false;
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
      renderSettings();
    });
    pat.appendChild(replace);
  }
  tokenWrap.appendChild(pat);
  body.appendChild(tokenWrap);

  const scope = el("div", "empty");
  scope.appendChild(
    document.createTextNode("A fine-grained token for this repo only, with Contents: read and write. ")
  );
  scope.appendChild(link("How ↗", TOKEN_DOCS));
  body.appendChild(scope);

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
  foot.appendChild(el("span", "note grow", statusLine()));

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

function statusLine(): string {
  const git = getGit();
  if (git.settings === null) return "● Not connected";
  if (git.sync === null) return "● Not connected for this file";
  if (git.failure !== null) return "⚑ Connection problem";
  return `● Connected · ${git.settings.branch}`;
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

async function onSave(): Promise<void> {
  const parsed = parseRepo(draft.repo);
  if (parsed === null) {
    draft.note = "That doesn't look like a repository. Paste a GitHub URL, or type owner/repo.";
    renderSettings();
    return;
  }

  const settings: RepoSettings = {
    owner: parsed.owner,
    repo: parsed.repo,
    branch: draft.branch.trim().length === 0 ? "main" : draft.branch.trim(),
    tokensDir: normalizeTokensDir(draft.tokensDir),
    patLastFour: getGit().settings?.patLastFour,
  };

  // `draft.token` is `null` for "leave the stored one alone" and a string for "replace it". The
  // distinction matters: editing a repo URL must not silently drop a credential the field can
  // never show back to the user.
  const token = draft.token === null ? undefined : draft.token;
  saveSettings(settings, token);
  draft.replacing = false;
  draft.token = null;
  draft.note = null;
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

