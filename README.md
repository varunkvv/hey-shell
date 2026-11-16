# hey

type a plain-english request in your terminal, `hey` runs bash to do it.

    hey count pods across all envs

each command shows up as a step. read-only commands run on their own, anything else stops for approval (`enter` run, `e` edit, `esc` skip). it ends with a one-line answer. design in docs/design.md

## setup

needs node 24 and a logged-in `claude` (the sdk uses the local claude login, no API key needed).

    npm install
    npm run build

add to ~/.zshrc

    source <path to>/hey-shell/shell/hey.zsh

then `hey <request>`, or `hey` for a prompt. ctrl-x a opens the prompt from the zsh line editor.

hotkey: zsh can't bind cmd, so map cmd+opt+a in the terminal to send ctrl-x a.
iterm: settings > profiles > keys > add cmd+opt+a, action "send hex code", `0x18 0x61`

## keys

- enter sends, empty enter exits. up / down for past requests (kept in ~/.hey_history)
- esc stops a running request
- o expands the output of the selected step (up / down moves the selection while running)
- tab on the done screen puts the last successful command in the zsh buffer and exits (also added to history)
- on exit the answer and the commands that ran print to normal stdout

read-only commands that skip approval are the `allowedTools` list in src/agent.ts.
