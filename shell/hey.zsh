# source this file from ~/.zshrc. run `hey <request>` or press ctrl-x a (map cmd+opt+a to it, see README)

_HEY_DIR="${${(%):-%x}:A:h:h}"

# runs the tui. if you pressed tab on the final command, it comes back in $REPLY
_hey_run() {
  local out=$(mktemp)
  HEY_OUT=$out node "$_HEY_DIR/dist/cli.js" "$@"
  REPLY=$(<$out)
  rm -f $out
}

hey() {
  _hey_run "$@"
  [[ -n $REPLY ]] || return 0
  print -s -- "$REPLY"
  print -z -- "$REPLY"
}

# run hey as a normal command (raw tty input is unreliable inside a widget). push-input keeps what you had typed
_hey_widget() {
  zle push-input
  BUFFER=hey
  zle accept-line
}
zle -N _hey_widget
bindkey '^Xa' _hey_widget
