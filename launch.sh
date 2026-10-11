#!/usr/bin/env bash
# opencut_os (OpenChatCut) dev server — detached daemon (survives terminal / agent shell exit).
# Usage: ./launch.sh start|stop|restart|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
PIDFILE="$RUN_DIR/dev.pid"
LOGFILE="$RUN_DIR/dev.log"

load_env() {
  local env_file="$ROOT/.env.local"
  [[ -f "$env_file" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done <"$env_file"
}

load_env

PORT="${OPENCUT_PORT:-5200}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

  start    Start dev server as a detached background process
  stop     Stop the server started from this checkout
  restart  stop, then start
  status   Show whether the server is running

  Log:  $LOGFILE
  URL:  http://localhost:$PORT/
EOF
}

ensure_node() {
  if [[ -x /opt/homebrew/opt/node@24/bin/node ]]; then
    export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node not found (install Node 24.x; see .nvmrc)" >&2
    exit 1
  fi
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" != "24" ]]; then
    echo "warning: Node $(node -v) — project expects 24.x (.nvmrc)" >&2
  fi
}

pid_from_file() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' <"$PIDFILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  echo "$pid"
}

belongs_to_checkout() {
  local pid="$1"
  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$args" == *"$ROOT"* ]]
}

pids_on_port() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

listener_pid() {
  local pid
  for pid in $(pids_on_port); do
    if belongs_to_checkout "$pid"; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

http_ready() {
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null \
    || curl -sf -o /dev/null --max-time 2 "http://localhost:$PORT/" 2>/dev/null
}

kill_tree() {
  local pid="$1"
  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill -TERM "$pid" 2>/dev/null || true
}

stop_port_listeners() {
  local pid
  for pid in $(pids_on_port); do
    if belongs_to_checkout "$pid"; then
      kill_tree "$pid"
    fi
  done
}

# Double-fork + setsid so the daemon is outside this shell's process group
# (Cursor/agent shells otherwise kill background children when the tool returns).
daemonize_npm_dev() {
  ensure_node
  mkdir -p "$RUN_DIR"
  : >"$LOGFILE"

  PATH="$PATH" ROOT="$ROOT" LOGFILE="$LOGFILE" PIDFILE="$PIDFILE" \
  /usr/bin/python3 - <<'PY'
import os, sys, time

root = os.environ["ROOT"]
logfile = os.environ["LOGFILE"]
pidfile = os.environ["PIDFILE"]
path = os.environ["PATH"]

# First fork
if os.fork() > 0:
    sys.exit(0)
os.setsid()
# Second fork — cannot regain a controlling terminal
if os.fork() > 0:
    sys.exit(0)

os.chdir(root)
os.environ["PATH"] = path
os.environ["OPENCHATCUT_LAUNCH"] = "1"
for proxy_key in (
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY",
):
    os.environ.pop(proxy_key, None)

# Redirect stdio to the log before exec
log_fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)
os.close(log_fd)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.close(devnull)

# Write the soon-to-be npm pid after fork+exec — we exec npm, so write our pid first.
with open(pidfile, "w", encoding="utf-8") as f:
    f.write(str(os.getpid()))

# Bind IPv4 explicitly — Vite "localhost" often listens only on [::1],
# which makes Chrome's http://localhost / 127.0.0.1 show ERR_CONNECTION_REFUSED.
os.execvp("npm", ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", os.environ.get("OPENCUT_PORT", "5200")])
PY
}

cmd_stop() {
  local pid
  if pid="$(listener_pid)"; then
    echo "Stopping listener pid $pid …"
    kill_tree "$pid"
  fi
  if pid="$(pid_from_file)" && kill -0 "$pid" 2>/dev/null; then
    if belongs_to_checkout "$pid" || [[ "$(ps -p "$pid" -o args= 2>/dev/null || true)" == *"npm"* ]]; then
      echo "Stopping pid $pid …"
      kill_tree "$pid"
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  # Also kill any leftover process tree that still holds the port for this checkout.
  stop_port_listeners
  # Give listeners a moment to die.
  for _ in 1 2 3 4 5 6; do
    [[ -z "$(listener_pid)" ]] && break
    sleep 0.5
  done
  if pid="$(listener_pid)"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  if [[ -n "$(pids_on_port)" ]]; then
    echo "warning: port $PORT still in use by another process" >&2
    return 1
  fi
  echo "Stopped."
}

cmd_status() {
  local pid
  if pid="$(listener_pid)"; then
    echo "$pid" >"$PIDFILE"
    echo "running (pid $pid) — http://localhost:$PORT/"
    return 0
  fi
  if pid="$(pid_from_file)" && kill -0 "$pid" 2>/dev/null; then
    echo "starting (pid $pid, port not listening yet) — see $LOGFILE"
    return 0
  fi
  rm -f "$PIDFILE"
  echo "not running"
  return 1
}

cmd_start() {
  mkdir -p "$RUN_DIR"
  ensure_node

  if pid="$(listener_pid)"; then
    echo "$pid" >"$PIDFILE"
    echo "Already running (pid $pid) — http://localhost:$PORT/"
    exit 0
  fi
  rm -f "$PIDFILE"
  stop_port_listeners 2>/dev/null || true

  echo "Starting OpenChatCut dev server …"
  echo "Log: $LOGFILE"
  export OPENCUT_PORT="$PORT"
  export OPENCUT_PUBLIC_BASE_URL="${OPENCUT_PUBLIC_BASE_URL:-http://127.0.0.1:$PORT}"
  daemonize_npm_dev
  # Parent of the python double-fork returns immediately; wait for readiness.
  sleep 0.3

  local i listener
  for i in $(seq 1 120); do
    if listener="$(listener_pid)"; then
      echo "$listener" >"$PIDFILE"
      if http_ready; then
        echo "Ready — http://localhost:$PORT/ (pid $listener)"
        exit 0
      fi
    fi
    if pid="$(pid_from_file)" && ! kill -0 "$pid" 2>/dev/null && [[ -z "$(listener_pid)" ]]; then
      echo "error: process exited early; see $LOGFILE" >&2
      tail -n 40 "$LOGFILE" >&2 || true
      rm -f "$PIDFILE"
      exit 1
    fi
    sleep 1
  done
  if listener="$(listener_pid)"; then
    echo "$listener" >"$PIDFILE"
    echo "Started (pid $listener); HTTP not confirmed — check $LOGFILE"
    echo "http://localhost:$PORT/"
    exit 0
  fi
  echo "error: timed out waiting for port $PORT; see $LOGFILE" >&2
  tail -n 40 "$LOGFILE" >&2 || true
  exit 1
}

cmd_restart() {
  cmd_stop || true
  sleep 1
  cmd_start
}

main() {
  case "${1:-}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    -h|--help|help) usage ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
