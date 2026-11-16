# hey

type a plain-english request in your terminal, `hey` runs bash to do it.

    hey count pods across all envs

each command shows up as a step. whether it runs on its own or stops for approval is up to claude code (see permissions). when the model is unsure what you mean it asks a question first. it ends with an answer and, when the job can be repeated, one command that does the whole thing. design in docs/design.md

## setup

needs node 24, macos and a logged-in `claude` (the sdk uses the local claude login, no API key needed).

    npm install
    npm run build

add to ~/.zshrc

    source <path to>/hey-shell/shell/hey.zsh

then `hey <request>`, or `hey` for a prompt.

    hey --mode plan --model opus what is using port 3000

`--mode` and `--model` have to come before the request. see permissions for what they take.

hotkey: ctrl-x a opens the prompt from the zsh line editor. most terminals can map a key to send `\x18a`, point yours at that.
ctrl-x a is a zle binding, so it needs zle. in warp, type `hey`.

## using it

- a step is one command. click it (or up / down then enter) to open its output, click `copy command` or `copy output` to copy exactly that
- the answer has a `copy` link. the reuse command under it has `copy` and `tab`
- approval stops show the model's description and the exact command. the card's keys and buttons only count after 400ms with no input at all (any keypress or click restarts that), so typing ahead while it appears can't run or edit anything. `run` is dim until then
- a question stop shows the options as buttons. pick one, or choose `other` and type an answer
- the log scrolls with the wheel, pgup / pgdn or the scrollbar. a long output is just more rows, with a sticky header for the step it belongs to

## keys

- prompt: enter sends, empty enter quits. up / down for past requests (kept in ~/.hey_history). esc browses the log (quits if nothing ran). tab on an empty prompt hands the reuse command to the shell. ctrl-c clears the draft, then quits
- browse: up / down select, enter opens or closes, tab hands the selected step to the shell, esc goes back to the prompt
- running: up / down select, enter opens or closes, esc stops (ctrl-c stops, a second one quits)
- approval: enter runs, e edits, esc skips. in edit, enter runs the edited command and ctrl-j adds a line
- question: up / down choose, enter picks, esc skips
- prompt and browse: shift-tab cycles the permission mode (default, acceptEdits, plan, auto), ctrl-o opens the model menu. the `default` and `sonnet` chips in the status row open the same menus on click. up / down + enter or a click picks, esc closes
- ctrl-t turns mouse reporting off and on, pgup / pgdn scroll. everything except the copy links works from the keyboard

text selection: with mouse reporting on, the terminal passes drags to hey. press ctrl-t and plain drag selects again (`HEY_MOUSE=0` starts with it off). after hey exits, the answer and the commands that ran are normal scrollback.

tab to shell puts the command in the zsh buffer and history, and also copies it to the clipboard with pbcopy. the exit print says so, for terminals where the buffer insert does nothing. just paste.

## notifications

when hey stops for an approval, a question or the final answer and you are not looking, it rings the bell and posts a macos notification (`osascript`).

- not looking = the terminal reported focus-out (focus reporting). if no focus event has ever arrived in the session, it is a stop that waited 30s with no input
- once any focus event has arrived, only focus counts and the 30s fallback is off. it never notifies while the terminal is focused

## permissions

hey has no command rules of its own. its only tools are Bash and AskUserQuestion. whether a command runs, asks or is blocked comes from the permission mode, the rules and hooks in claude code's settings, and claude code's own checks.

hey loads managed policy (always) and your user settings (`~/.claude/settings.json`: permission rules, hooks, enabled plugins). project and local settings are not loaded, so a repo's own `.claude/` does not change what hey does in the current dir. configured MCP servers do not load, and no MCP tool is ever offered to the model (claude code's own claude in chrome server can still connect, its tools are hidden).

keep in mind - if your user settings allow `Bash` (or `Bash(*)`), every command runs with no card in `default` mode. the mode only decides what is left after your rules. deny rules and hooks still apply in every mode, including `bypassPermissions`.

mode, in order of precedence: the menu (shift-tab or the chip), `--mode`, `HEY_PERMISSION_MODE`, then `default`. it is never saved, so every launch starts from the flag, the env var or `default`.

    hey --mode bypassPermissions clean up /tmp/old-logs
    HEY_PERMISSION_MODE=plan hey what would you delete here

modes: `default`, `acceptEdits`, `plan`, `auto` (a model classifier approves or denies each call), `dontAsk`, `bypassPermissions`. a mode other than `default` shows as a badge in the status row, bypass in red. questions still reach you in every mode except `dontAsk`, where claude code denies them.

model: the menu (ctrl-o or the chip), `--model`, `HEY_MODEL`, the last one picked in the menu (kept in `~/.config/hey/model`), then `sonnet`. aliases are `sonnet`, `opus`, `haiku` and `fable`, a full model id works from the flag or env. a change applies from the next request.
