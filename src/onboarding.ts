// Onboarding (Phase 13b — SPEC.md's "Show it off"): a short first-visit
// walkthrough explaining what this app is (Parth's Spotify listening, alive
// as a Naruto-DS village — every genre lives here as a character in its own
// district), how to look around, and where the rest of the app lives (the
// Hokage chat, the notice board, the Chronicle). Shown once automatically
// (nothing dismissed yet in localStorage — same try/catch convention as
// src/sound.ts/src/era.ts, so private mode or blocked storage just means it
// reappears next visit rather than erroring), and reopenable any time from
// the topbar's "?" button (src/main.ts wires #helpBtn to initOnboarding).
//
// A small centered modal with its own backdrop, not a reuse of the sidebar/
// top-artists-panel shapes — this is a one-time walkthrough, not persistent
// chrome. Unlike every other overlay in this app, it needs an actual focus
// trap (SPEC.md calls for one explicitly): it's the very first thing a new
// visitor's keyboard focus should be contained to, before they've had a
// chance to Tab out into the map underneath.

const STORAGE_KEY = "echoes:onboarding-dismissed";

interface Step {
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to Echoes",
    body: "This village is Parth's Spotify listening, alive as a Naruto-DS town — every genre lives here as its own character, in its own district.",
  },
  {
    title: "Look around",
    body: "Drag (or use the arrow keys) to look around, and tap any character or district — in the village or the sidebar — to open their profile: top artists, songs, and mood.",
  },
  {
    title: "More to find",
    body: "Ask the Hokage about the listening, check the notice board for the week's recap, and open the Chronicle to replay what the village agent changed overnight.",
  },
];

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // private mode / blocked storage — it just shows again next visit
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Best-effort only — reappears next visit if this didn't stick.
  }
}

let backdrop: HTMLDivElement;
let modal: HTMLDivElement;
let stepIndex = 0;
let dontShowAgain = false;
// Focus returns here on close, same "give focus back to whatever opened it"
// convention as main.ts's own sidebar onClose hook (which refocuses #game).
let lastFocused: HTMLElement | null = null;

function isOpen(): boolean {
  return !modal.hidden;
}

function focusableElements(): HTMLElement[] {
  return Array.from(
    modal.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]"),
  ).filter((el) => !el.hasAttribute("disabled"));
}

/** Keeps Tab/Shift+Tab cycling within the modal instead of escaping into the
 * map underneath — the one piece of chrome in this app that actually needs
 * this (every other overlay here relies on being the last thing in DOM
 * order plus a backdrop click/Escape to close, but a first-visit walkthrough
 * shouldn't let a Tab press wander off into a half-loaded village behind
 * it). */
function trapFocus(ev: KeyboardEvent): void {
  if (ev.key !== "Tab") return;
  const focusable = focusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

function close(): void {
  if (!isOpen()) return;
  if (dontShowAgain) writeDismissed();
  backdrop.hidden = true;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  lastFocused?.focus();
}

function render(): void {
  modal.innerHTML = "";
  const step = STEPS[stepIndex]!;
  const isLast = stepIndex === STEPS.length - 1;

  // Same header-row shape as src/top-artists.ts's .ta-panel-header (heading +
  // close button) rather than an absolutely-positioned close button, so it
  // can never overlap a long title.
  const header = document.createElement("div");
  header.className = "onboarding-header";
  const title = document.createElement("h2");
  title.className = "onboarding-title";
  title.id = "onboardingTitle";
  title.textContent = step.title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn onboarding-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", close);
  header.append(title, closeBtn);
  modal.appendChild(header);

  const body = document.createElement("p");
  body.className = "onboarding-body";
  body.textContent = step.body;
  modal.appendChild(body);

  const dots = document.createElement("div");
  dots.className = "onboarding-dots";
  dots.setAttribute("aria-hidden", "true");
  STEPS.forEach((_, i) => {
    const dot = document.createElement("span");
    dot.className = "onboarding-dot";
    if (i === stepIndex) dot.classList.add("is-active");
    dots.appendChild(dot);
  });
  modal.appendChild(dots);

  if (isLast) {
    const label = document.createElement("label");
    label.className = "onboarding-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = dontShowAgain;
    checkbox.addEventListener("change", () => (dontShowAgain = checkbox.checked));
    label.append(checkbox, document.createTextNode("Don't show this again"));
    modal.appendChild(label);
  }

  const actions = document.createElement("div");
  actions.className = "onboarding-actions";
  if (stepIndex > 0) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "onboarding-btn";
    back.textContent = "Back";
    back.addEventListener("click", () => {
      stepIndex -= 1;
      render();
    });
    actions.appendChild(back);
  }
  const next = document.createElement("button");
  next.type = "button";
  next.className = "onboarding-btn onboarding-btn--primary";
  next.textContent = isLast ? "Start exploring" : "Next";
  next.addEventListener("click", () => {
    if (isLast) {
      close();
      return;
    }
    stepIndex += 1;
    render();
  });
  actions.appendChild(next);
  modal.appendChild(actions);

  next.focus();
}

function open(): void {
  if (isOpen()) return;
  stepIndex = 0;
  dontShowAgain = false;
  lastFocused = document.activeElement as HTMLElement | null;
  backdrop.hidden = false;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  render();
}

/** Wires the "?" button (reopens any time) and the auto-open-on-first-visit
 * check. Call once at startup, same as src/main.ts's other init*() calls. */
export function initOnboarding(backdropEl: HTMLDivElement, modalEl: HTMLDivElement, helpBtn: HTMLButtonElement): void {
  backdrop = backdropEl;
  modal = modalEl;

  helpBtn.addEventListener("click", open);
  backdrop.addEventListener("click", close);
  modal.addEventListener("keydown", trapFocus);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isOpen()) close();
  });

  if (!readDismissed()) open();
}
