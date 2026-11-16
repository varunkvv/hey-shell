# shell agent - rough design

a terminal tool where you type a plain-english request and it runs bash to do it. "count the pods across all envs", "rename every file starting with st to ch".

it's a command runner, not a chat. each step is a command you can see, approve, edit and keep. the model's prose shrinks to a one-line answer at the end.

name: `hey`, e.g. `hey count pods across all envs`. repo is `hey-shell` (~/hey-shell), seeded from this doc.

## what?

- one request in, a few commands run, one answer out
- read-only commands run on their own. anything that changes state stops for approval
- you can always see what a command acts on before it runs
- the final command can be pulled into your shell, so you learn it instead of depending on the agent
- opens with a hotkey (ctrl-x a) from the zsh line editor, exits back to the same prompt

## out of scope

- general chat, file editing, web search
- sessions list, sidebars, model picker
- multi-agent anything
- local rules about which commands are risky. that's claude's call, not ours

## ui

alt-screen, so any step can be expanded in place. on exit the one-line answer (and the commands that ran) print to normal stdout, so the result still lands in scrollback like `fzf` / `less` selections do.

### running

```
~/repos
agent> count pods across all envs

  ✓ kubectl config get-contexts -o name                      4 contexts
  ✓ kubectl --context olaf get pods -A --no-headers | wc -l       312
  ✓ kubectl --context sweeney get pods -A --no-headers | wc -l    290
  ⠋ kubectl --context us01 get pods -A --no-headers | wc -l

  esc stop · o output
```

- one line per command: status, the command, a short result on the right
- status is a spinner, ✓, or the exit code in red
- output is collapsed. on failure show the last 2 lines. `o` expands the selected step in place
- at most one dim line of model narration between steps ("4 contexts, checking each"). no thinking, no tool names

### done

```
  1,284 pods   olaf 312 · sweeney 290 · us01 512 · d-use-1 170

agent> _                                   enter on empty exits · tab reuse
```

- one line answer. a short table at most
- prompt stays open for a follow-up in the same context ("now just the crashlooping ones")
- empty enter exits

### approval

```
  ? rename 12 files in ~/repos/reports (st_ -> ch_)

      for f in st_*; do mv "$f" "ch_${f#st_}"; done

    enter run · e edit · esc skip
```

- the headline is the model's own description of what the command does and where (the Bash tool's `description` field). the app doesn't parse commands, so this works the same for kubectl, aws, git, ssh or anything else
- the command shows underneath
- for bulk changes the model runs a read-only dry run first (per the system prompt), so the list of what will change is already on screen as the step above
- `e` opens the command for editing before it runs. often it's 90% right and you want to fix one flag
- esc skips that step and tells the model it was declined

### approvals

no local classifier. which commands run on their own vs. stop for approval is left to the SDK's own permission handling (claude code already handles compound commands, redirects etc). `canUseTool` only fires when claude code would have asked, and it's just where the approval card renders.

a hand-rolled verb list / regex would be a worse copy of that, and it's kubectl/aws-specific by nature.

### keys

the ui was redesigned after the mvp: a scrolling log with a pinned dock (prompt, approval or question) and a status row, mouse optional. the keys, by mode:

| mode | keys |
|---|---|
| prompt | type, enter sends (empty quits), up / down history, tab on empty puts the reuse command in zsh, esc browses (quits if nothing ran) |
| browse | up / down select, enter open or close, tab puts the selected step in zsh, esc back |
| running | up / down select, enter open or close, esc stop |
| approval | enter run (after 400ms), e edit, esc skip |
| question | up / down choose, enter pick, esc skip |
| everywhere | ctrl-t mouse on / off, pgup / pgdn scroll, ctrl-c |

the old `o` key is gone (it also typed an `o`). copying is by clicking the copy links. the reuse command is a fenced block the model ends its answer with (prompt.md), falling back to the last successful step. when hey stops and you are not looking, it rings the bell and posts a macos notification.

### footer

shows cwd. env (kube context, aws profile etc) isn't shown globally - the model loops over envs, so a global "current context" is often not where a command runs. each change step names its own target instead.

## how?

typescript + ink, on the claude agent sdk. not a wrapper around the `claude` cli, because the sdk gives:

- streamed tool events, so steps render as they happen
- `canUseTool` callback, which is where the approval card plugs in (returns `updatedInput` for `e`, deny + message for esc)
- control over the tool list (bash only) and the system prompt

rough layout:

```
src/
  cli.tsx          entry, arg parsing, `hey "request"` or interactive
  agent.ts         sdk session, system prompt, tool list, event stream
  ui/
    Prompt.tsx
    Steps.tsx
    Approval.tsx
    Footer.tsx
  shell/
    hey.zsh        `hey` function, zle widget on ctrl-x a, tab handoff into the buffer
prompt.md          system prompt
```

system prompt, roughly:

- you're in zsh on macos. use bash for everything
- for k8s, list contexts first and loop. never assume an env. pass `--context` per command, never `use-context`
- for bulk changes, list what will change before changing it
- when a command changes something, the `description` says what it acts on and where ("delete pod api-7f in us01", "rename 12 files in ~/repos/reports")
- answer with the result only. a number, a short table, or what changed

if `description` turns out unreliable, swap Bash for an in-process `run({ command, target, effect })` tool so the card always has a target slot. start with `description` since it's zero code.

hotkey: ctrl-x a, bound by a zle widget that launches `hey`. most terminals can map a key to send `0x18 0x61`. a terminal without zle (its own input editor) just runs `hey` by hand.

tab handoff: the tui writes the final command to a temp file on exit. the zsh widget reads it into `BUFFER` and calls `print -s`.

## mvp

1. prompt, run, steps list, one line answer. anything the sdk would ask about is declined
2. approval card with the model's description, `e` edit
3. footer with cwd, `o` expand, answer printed to stdout on exit
4. zsh widget + tab handoff

1 is a one-shot. 2-4 is a day.

## prior art

- the grove `shell-agent` branch (worktree `worktrees/session-manager-shell-agent`, `tools/shell-agent/`) has the no-code version: a zsh function that runs `claude --tools Bash,Read --allowedTools <read-only list> --append-system-prompt-file prompt.md`. worth keeping as the fallback and reusing its prompt
- warp ai, shell-gpt, aichat do nl -> command. none of them make the run itself the ui

## open questions

- model: sonnet for speed by default, opus on a flag? probably sonnet, the tasks are short
- keep a per-request log on disk (request, commands, results) so a run can be replayed or turned into a script later?
- distribute as an npm global, or a single bun-compiled binary so startup is fast enough for a hotkey? keep in mind the TS sdk spawns the claude code process under the hood (iirc), so measure cold start of a bare sdk hello-world first. a hotkey that takes 1s feels broken
- auth: the no-code version uses the `claude` login. not 100% sure the sdk picks that up vs. wanting an API key - check before step 1
- timeouts: `kubectl logs -f`, `watch`, `port-forward` never exit. default timeout per step, or leave it to the model + esc?
