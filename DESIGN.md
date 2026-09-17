# Prompt Stash — design plan

## The brief, restated

One developer. Drafts prompts for building apps and for thinking through ideas.
Needs three things to be instant: **capture** a draft, **find** it again, **copy** it out.
Everything else is secondary. The app competes with a scratch `.md` file, and it only
wins if it is faster than one.

## Subject matter

The material here is *prose written to be executed* — instructions, drafts, half-formed
ideas. That is closer to a writing desk than to a dashboard. So the design is set like a
writing surface: the text carries the most contrast and the most space, and the chrome
gets out of the way. The organising metaphor is a **card index** — a column of slips on
the left, the slip itself open on the right — not a grid of cards.

## Tokens

### Colour — ink and paper, one violet

The accent is carried over from the app mark. It is the only saturated colour in the
interface and it earns its place twice: it marks *where you are*, and it marks
*`{{variables}}`* in the prompt body. Nothing else is violet.

| Token | Dark (default) | Light |
| --- | --- | --- |
| `--bg` | `#12151C` ink | `#FBFAF7` bone |
| `--surface` | `#181C25` | `#FFFFFF` |
| `--surface-2` | `#1F2430` | `#F3F1EC` |
| `--line` | `#262C39` | `#E4E1D9` |
| `--text` | `#E4E8F1` | `#1A1C22` |
| `--muted` | `#8F98AB` | `#6B7180` |
| `--accent` | `#7C6CFF` | `#5B4BE0` |
| `--good` | `#4FC08D` | `#2E9E6F` |

Deliberately *not*: cream + serif + terracotta; near-black + acid green; a violet
gradient wash. The violet is a point, not a field.

### Type

No downloaded fonts — the app is fully local, so nothing may be fetched at runtime and
nothing bulky gets bundled. The personality comes from the *setting*, not from an exotic
face.

- **Chrome and index**: `Segoe UI Variable Text, Segoe UI, system-ui` — tight, small, quiet.
- **Prompt body**: same family, 15px/1.62, measure capped near 78ch. Long prompts are
  read as prose; mono for all of it would be tiring.
- **Variables, code, counts**: `Cascadia Mono, Consolas, ui-monospace` — used only where
  monospacing is doing a job, never as a decorative "data" font.

Scale (minor third): 12 · 13 · 15 · 18 · 22 · 28.

### Layout

Two panes and a command palette. A third rail for tags would cost width the editor needs;
`Ctrl+K` does that job with no permanent chrome.

```
┌──────────────────────┬──────────────────────────────────────────────┐
│ ▪ Star River       ▾ │  Title, set large                            │
│ search               │                                              │
│ ────────────────────│  ┌ (margin rule)                              │
│▍Title of a prompt    │  │ Body text, measure capped, variables       │
│ 2 days ago · 340w    │  │ tinted violet in mono.                     │
│ ────────────────────│  │                                             │
│ │Another prompt      │  │                                             │
│ │just now · 1.2kw    │  │                                             │
│ ────────────────────│  │                                             │
│                      │                                              │
│ ────────────────────│ ─────────────────────────────────────────────│
│ 128 prompts          │  340 words · ~450 tokens        ● saved      │
└──────────────────────┴──────────────────────────────────────────────┘
  320px                  flex
```

Left aligned throughout. Centred text in a working tool slows scanning.

### Structural devices

State lives in the **spine** — a 2px gutter down the left edge of each index row — not in
badges scattered across the row. Filled violet: this is the row you are on. A small dot
at the top of the spine: pinned. That is the whole vocabulary.

Hairline rules separate index rows. No card boxes, no shadows, no per-row border-radius.
Radius is reserved for things that genuinely float above the surface: the palette, the
variable-fill sheet, the toast.

## Projects and tags are different things, so they look different

A prompt has **one project** and **any number of tags**. That difference is the whole
reason both exist, so the interface never lets them blur together:

- The project is a **scope**. It lives above the search box, because everything below it —
  search, the pinned filter, tag chips, and the prompt `Ctrl+N` creates — happens inside
  it. It gets a colour on creation, and that colour is the dot on every row.
- Tags are **labels**. They sit with the prompt, lower contrast, no colour, and they filter
  within whatever scope is active.

The project chip reads `No project` in a dashed outline when a prompt is unfiled — the same
visual grammar as the dashed `+ tag` button, because both are invitations rather than state.

Deleting a project is not deleting prompts, and the confirmation says so in those words.

## Sections

`Ctrl+Enter` writes `----------` across the prompt. The choice of a plain hyphen line over
a special marker is deliberate: the text has to stay useful when it is pasted into a model,
a terminal, or a Markdown file, none of which know anything about this app.

Behind the divider line the backdrop paints a quiet band, so it reads as a rule rather than
as stray punctuation — the same trick that tints `{{placeholders}}`, reusing the one overlay
rather than adding a second mechanism.

`Ctrl+A` then means "this section", which is what you want when a prompt holds three
variants of the same thing. Pressing it again widens to the whole prompt: a bounded
select-all that can never trap you.

## Principles

1. **The text is the interface.** Body copy gets the highest contrast and the most room.
   Everything else is set quieter and smaller than feels comfortable at first.
2. **State lives in the spine.** One gutter carries selection and pin state; rows stay
   clean enough to scan forty at a glance.
3. **Motion only answers an action.** Opening the palette, the variable sheet sliding in,
   a row leaving on delete. No entrance animations, no hover transitions on rows — at
   forty rows they read as noise and cost frames.
4. **One accent, two jobs.** Where you are, and what will be substituted. Project colours
   are the one exception, and they only ever appear as a 6px dot.
5. **Saving is never announced.** A dot in the status line goes from violet to nothing.
   No toasts for the thing that happens three times a minute.

## Copy

Plain verbs, sentence case. The button says what happens and the result uses the same
word: **Copy** → "Copied". **Delete** → the row leaves and the status line offers "Undo".

Empty states are invitations, not decoration:
- No prompts yet → "Press Ctrl+N to stash your first prompt."
- No search results → "Nothing matches *foo*. Ctrl+N stashes it as a new prompt."
- Trash empty → "Deleted prompts rest here for 30 days."

Errors state what happened and what to do, in the interface's voice, and never discard
user text to recover from anything.
