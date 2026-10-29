#!/bin/sh
# Модель разбана под TLC: Appeal - без ошибок, мутанты обязаны нарушить свой инвариант.
# Несовпадение ожидания или сбой tlc - ненулевой выход.
set -u
cd "$(dirname "$0")" || exit 2
java -version >/dev/null 2>&1 || for j in /opt/homebrew/opt/openjdk@25/bin /opt/homebrew/opt/openjdk/bin; do [ -x "$j/java" ] && PATH="$j:$PATH" && break; done
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected: none | <Invariant>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers 2 -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" Appeal.tla >"$log" 2>&1
  code=$?
  if grep -q "Model checking completed. No error has been found." "$log"; then got=none
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$log" | head -1); fi
  if [ "$got" = "$expect" ] && { [ "$got" != none ] || [ "$code" -eq 0 ]; }; then
    echo "OK $cfg: ${got}"; ok=$((ok+1))
  else
    echo "FAIL $cfg: got '${got:-error}', expected '$expect'"; tail -20 "$log"; failed=$((failed+1))
  fi
}
check Appeal none
check Appeal-nowait NoHiddenBan
check Appeal-nosource AdminWins
check Appeal-repeat OneAppeal
echo "check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
