# hey

type a plain-english request in your terminal, `hey` runs bash to do it.

    hey count pods across all envs

each command shows up as a step. read-only commands run on their own, anything else stops for approval. when the model is unsure what you mean it asks a question first. it ends with an answer and, when the job can be repeated, one command that does the whole thing. design in docs/design.md

## setup

needs node 24, macos and a logged-in `claude` (the sdk uses the local claude login, no API key needed).

    npm install
    npm run build

add to ~/.zshrc

    source <path to>/hey-shell/shell/hey.zsh

then `hey <request>`, or `hey` for a prompt.

hotkey: ctrl-x a opens the prompt from the zsh line editor. most terminals can map a key to send `\x18a`, point yours at that.
ctrl-x a is a zle binding, so it needs zle. in a terminal with its own input editor (warp, iirc) just type `hey`. i did not check whether warp can bind a key to send text.

## using it

- a step is one command. click it (or up / down then enter) to open its output, click `copy command` or `copy output` to copy exactly that
- the answer has a `copy` link. the reuse command under it has `copy` and `tab`
- approval stops show the model's description and the exact command. `run` ignores clicks and enter for the first 400ms so a stray tap can't run it
- a question stop shows the options as buttons. pick one, or choose `other` and type an answer
- the log scrolls with the wheel, pgup / pgdn or the scrollbar. a long output is just more rows, with a sticky header for the step it belongs to

## keys

- prompt: enter sends, empty enter quits. up / down for past requests (kept in ~/.hey_history). esc browses the log (quits if nothing ran). tab on an empty prompt hands the reuse command to the shell. ctrl-c clears the draft, then quits
- browse: up / down select, enter opens or closes, tab hands the selected step to the shell, esc goes back to the prompt
- running: up / down select, enter opens or closes, esc stops (ctrl-c stops, a second one quits)
- approval: enter runs, e edits, esc skips. in edit, enter runs the edited command and ctrl-j adds a line
- question: up / down choose, enter picks, esc skips
- ctrl-t turns mouse reporting off and on, pgup / pgdn scroll. everything except the copy links works from the keyboard

text selection: with mouse reporting on, the terminal passes drags to hey. press ctrl-t and plain drag selects again (`HEY_MOUSE=0` starts with it off). after hey exits, the answer and the commands that ran are normal scrollback.

tab to shell puts the command in the zsh buffer and history, and also copies it to the clipboard with pbcopy. the exit print says so, for terminals where the buffer insert does nothing. just paste.

## notifications

when hey stops for an approval, a question or the final answer and you are not looking, it rings the bell and posts a macos notification (`osascript`).

- not looking = the terminal reported focus-out (focus reporting). if the terminal never reports focus, it is a stop that waited 5s with no input
- once the terminal has reported focus-in it never notifies while focused. before it reports anything (a terminal that supports focus reporting but has not changed focus yet counts), the 5s fallback applies

read-only commands that skip approval are the `allowedTools` list in src/agent.ts.
