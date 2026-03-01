#!/usr/bin/env bash
# =============================================================================
# Voice System — Setup & Test Script
#
# 1. Server Setup   — git pull, docker rebuild, health check
# 2. Azure TTS      — test prosody variants, measure latency + file size
# 3. Deepgram       — REST auth, TCP connectivity, transcription API
#
# Usage (on server):  bash /opt/voice-system/scripts/setup-test.sh
# Usage (sections):   bash setup-test.sh --only=tts
#                     bash setup-test.sh --only=deepgram
#                     bash setup-test.sh --only=setup
# =============================================================================
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_DIR/.env"
TMP_DIR="/tmp/voice-system-test"

# ── Parse args ────────────────────────────────────────────────────────────────
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="${arg#--only=}" ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
log_section() {
  echo ""
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  $1${NC}"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════${NC}"
}
log_ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
log_warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
log_err()  { echo -e "  ${RED}✗${NC}  $1"; }
log_info() { echo -e "  ${CYAN}→${NC}  $1"; }

ms_now() { date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))"; }

check_cmd() {
  for cmd in "$@"; do
    if ! command -v "$cmd" &>/dev/null; then
      log_err "Required command not found: $cmd"
      exit 1
    fi
  done
}

# Load .env line-by-line — safe against special characters in values (!, $, (, ), etc.)
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    log_err ".env not found at $ENV_FILE"
    exit 1
  fi
  local LINE KEY VALUE COUNT=0
  while IFS= read -r LINE || [[ -n "$LINE" ]]; do
    # Skip comments and blank lines
    [[ "$LINE" =~ ^[[:space:]]*'#' ]] && continue
    [[ "$LINE" =~ ^[[:space:]]*$ ]] && continue
    [[ "$LINE" != *=* ]] && continue
    KEY="${LINE%%=*}"
    VALUE="${LINE#*=}"
    # Strip surrounding single or double quotes
    VALUE="${VALUE#\"}" VALUE="${VALUE%\"}"
    VALUE="${VALUE#\'}" VALUE="${VALUE%\'}"
    # declare -x is the safest export — does not evaluate VALUE as bash
    declare -gx "${KEY}"="${VALUE}" 2>/dev/null && (( COUNT++ )) || true
  done < "$ENV_FILE"
  log_ok ".env loaded: $COUNT variables"
}

# ── Section 1: Server Setup ───────────────────────────────────────────────────
section_server_setup() {
  log_section "1 · Server Setup"

  cd "$REPO_DIR"

  # Check for uncommitted local changes
  DIRTY=$(git status --short src/ 2>/dev/null || true)
  if [[ -n "$DIRTY" ]]; then
    log_warn "Uncommitted local changes detected:"
    echo "$DIRTY" | sed 's/^/       /'
    echo ""
    read -rp "  Stash local changes and pull? [y/N] " CONFIRM
    if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
      git stash
      log_ok "Local changes stashed"
    else
      log_warn "Skipping git pull — local changes kept"
      SKIP_PULL=true
    fi
  fi

  # Git pull
  if [[ "${SKIP_PULL:-}" != "true" ]]; then
    log_info "Fetching origin/main..."
    git fetch origin main -q
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)

    if [[ "$LOCAL" == "$REMOTE" ]]; then
      log_ok "Already up to date ($(git rev-parse --short HEAD))"
    else
      log_info "Pulling $(git rev-parse --short HEAD)..$(git rev-parse --short origin/main)..."
      git pull origin main
      log_ok "Now at $(git rev-parse --short HEAD)"
    fi
  fi

  # Docker rebuild
  log_info "Building orchestrator Docker image..."
  BUILD_START=$(ms_now)
  docker compose up -d --build orchestrator 2>&1 | grep -E "^(#|=>|Step|Successfully|ERROR)" || true
  BUILD_END=$(ms_now)
  log_ok "Build finished in $(( BUILD_END - BUILD_START ))ms"

  # Wait for healthy
  log_info "Waiting for orchestrator to become healthy (max 60s)..."
  for i in $(seq 1 60); do
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' voice-system-orchestrator-1 2>/dev/null || echo "missing")
    if [[ "$STATUS" == "healthy" ]]; then
      log_ok "Orchestrator healthy after ${i}s"
      break
    fi
    if [[ $i -eq 60 ]]; then
      log_err "Orchestrator not healthy after 60s — current status: $STATUS"
      echo ""
      echo "--- Last 30 log lines ---"
      docker logs voice-system-orchestrator-1 --tail 30 2>&1 || true
      exit 1
    fi
    sleep 1
  done

  # HTTP health check
  log_info "Checking HTTP /health..."
  HEALTH_RESPONSE=$(curl -sf --max-time 5 "http://localhost:3000/health" 2>/dev/null || echo '{"status":"error"}')
  HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "parse_error")

  if [[ "$HEALTH_STATUS" == "healthy" ]]; then
    log_ok "HTTP /health → healthy"
  else
    log_err "HTTP /health → $HEALTH_STATUS"
    echo "  Response: $HEALTH_RESPONSE"
  fi

  # All containers status
  log_info "Container status:"
  docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null | sed 's/^/       /' || true
}

# ── Section 2: Azure TTS Voice Tuning ────────────────────────────────────────
get_azure_token() {
  curl -sf --max-time 10 -X POST \
    "https://${AZURE_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken" \
    -H "Ocp-Apim-Subscription-Key: ${AZURE_SPEECH_KEY}" \
    -H "Content-Length: 0"
}

# $1=voice $2=label $3=rate $4=pitch $5=text $6=token
test_tts_preset() {
  local VOICE="$1" LABEL="$2" RATE="$3" PITCH="$4" TEXT="$5" TOKEN="$6"
  local OUTFILE="$TMP_DIR/${LABEL}.mp3"
  local XML_LANG="${VOICE:0:5}"  # e.g. bs-BA

  # Build SSML
  local SSML="<speak version='1.0' xml:lang='${XML_LANG}'><voice name='${VOICE}'>"
  if [[ "$RATE" == "0%" && "$PITCH" == "0%" ]]; then
    SSML+="${TEXT}"
  else
    SSML+="<prosody rate='${RATE}' pitch='${PITCH}'>${TEXT}</prosody>"
  fi
  SSML+="</voice></speak>"

  local START HTTP_CODE SIZE LATENCY
  START=$(ms_now)
  HTTP_CODE=$(curl -s -o "$OUTFILE" -w "%{http_code}" --max-time 15 \
    -X POST "https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/ssml+xml" \
    -H "X-Microsoft-OutputFormat: audio-16khz-32kbitrate-mono-mp3" \
    -H "X-Microsoft-UserAgent: VoiceSystemTest/1.0" \
    -d "$SSML" 2>/dev/null)
  LATENCY=$(( $(ms_now) - START ))
  SIZE=$(wc -c < "$OUTFILE" 2>/dev/null || echo 0)

  if [[ "$HTTP_CODE" == "200" && "$SIZE" -gt 500 ]]; then
    local DURATION_S
    DURATION_S=$(python3 -c "print(round($SIZE / (32000/8), 1))" 2>/dev/null || echo "?")
    printf "  ${GREEN}✓${NC}  %-28s  %4dms  %6d bytes (~%ss)  rate:%-5s pitch:%s\n" \
      "$LABEL" "$LATENCY" "$SIZE" "$DURATION_S" "$RATE" "$PITCH"
  else
    printf "  ${RED}✗${NC}  %-28s  HTTP %s  size:%d bytes\n" "$LABEL" "$HTTP_CODE" "$SIZE"
    [[ -f "$OUTFILE" ]] && rm -f "$OUTFILE"
  fi
}

section_tts_voice_tuning() {
  log_section "2 · Azure TTS Voice Tuning"

  mkdir -p "$TMP_DIR"

  # Validate required vars
  if [[ -z "${AZURE_SPEECH_KEY:-}" || -z "${AZURE_REGION:-}" ]]; then
    log_err "AZURE_SPEECH_KEY or AZURE_REGION not set in .env"
    return 1
  fi

  log_info "Requesting Azure token (region: ${AZURE_REGION})..."
  local TOKEN
  TOKEN=$(get_azure_token 2>/dev/null || true)
  if [[ -z "$TOKEN" ]]; then
    log_err "Failed to get Azure token — check AZURE_SPEECH_KEY and AZURE_REGION"
    return 1
  fi
  log_ok "Azure token obtained (${#TOKEN} chars)"

  local TEXT_BS="Dobar dan, zovem se Goran iz Step Tu Džob-a. Da li vas zanima posao u Njemačkoj?"
  local TEXT_SR="Dobar dan, Vesna ovde iz Step Tu Džob-a. Da li vas zanima rad u inostranstvu?"

  local VOICE_BS="${TTS_VOICE_BS:-bs-BA-GoranNeural}"
  local VOICE_SR="${TTS_VOICE_SR:-sr-RS-SophieNeural}"

  echo ""
  echo -e "  ${BOLD}── Goran ($VOICE_BS) ──────────────────────────────────────${NC}"
  echo -e "  ${CYAN}label                         latency    size      ~dur   prosody${NC}"
  test_tts_preset "$VOICE_BS" "BS_default"    "0%"    "0%"   "$TEXT_BS" "$TOKEN"
  test_tts_preset "$VOICE_BS" "BS_slower_10"  "-10%"  "0%"   "$TEXT_BS" "$TOKEN"
  test_tts_preset "$VOICE_BS" "BS_slower_20"  "-20%"  "0%"   "$TEXT_BS" "$TOKEN"
  test_tts_preset "$VOICE_BS" "BS_faster_10"  "+10%"  "0%"   "$TEXT_BS" "$TOKEN"
  test_tts_preset "$VOICE_BS" "BS_warm"       "-5%"   "-5%"  "$TEXT_BS" "$TOKEN"
  test_tts_preset "$VOICE_BS" "BS_energetic"  "+5%"   "+10%" "$TEXT_BS" "$TOKEN"

  # Token may expire after many calls — refresh
  TOKEN=$(get_azure_token 2>/dev/null || true)

  echo ""
  echo -e "  ${BOLD}── Vesna ($VOICE_SR) ──────────────────────────────────────${NC}"
  echo -e "  ${CYAN}label                         latency    size      ~dur   prosody${NC}"
  test_tts_preset "$VOICE_SR" "SR_default"    "0%"    "0%"   "$TEXT_SR" "$TOKEN"
  test_tts_preset "$VOICE_SR" "SR_slower_10"  "-10%"  "0%"   "$TEXT_SR" "$TOKEN"
  test_tts_preset "$VOICE_SR" "SR_slower_20"  "-20%"  "0%"   "$TEXT_SR" "$TOKEN"
  test_tts_preset "$VOICE_SR" "SR_faster_10"  "+10%"  "0%"   "$TEXT_SR" "$TOKEN"
  test_tts_preset "$VOICE_SR" "SR_warm"       "-5%"   "-5%"  "$TEXT_SR" "$TOKEN"
  test_tts_preset "$VOICE_SR" "SR_energetic"  "+5%"   "+10%" "$TEXT_SR" "$TOKEN"

  echo ""
  log_ok "Audio files saved: $TMP_DIR/*.mp3"
  log_info "Play with:  mpg123 $TMP_DIR/BS_default.mp3"
  log_info "List all:   ls -lh $TMP_DIR/"
}

# ── Section 3: Deepgram Check ─────────────────────────────────────────────────
section_deepgram_check() {
  log_section "3 · Deepgram Connection Check"

  if [[ -z "${DEEPGRAM_API_KEY:-}" ]]; then
    log_err "DEEPGRAM_API_KEY not set in .env"
    return 1
  fi

  # 1. REST API auth + latency
  log_info "Testing Deepgram REST API (GET /v1/projects)..."
  local START END LATENCY HTTP_CODE BODY
  START=$(ms_now)
  BODY=$(curl -s --max-time 10 -w "\n%{http_code}" \
    "https://api.deepgram.com/v1/projects" \
    -H "Authorization: Token ${DEEPGRAM_API_KEY}" 2>&1)
  END=$(ms_now)
  LATENCY=$(( END - START ))
  HTTP_CODE=$(echo "$BODY" | tail -1)

  if [[ "$HTTP_CODE" == "200" ]]; then
    PROJECT_COUNT=$(echo "$BODY" | head -1 \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('projects',[])))" 2>/dev/null || echo "?")
    log_ok "REST API: HTTP 200  latency: ${LATENCY}ms  projects: $PROJECT_COUNT"
  else
    log_err "REST API: HTTP $HTTP_CODE  latency: ${LATENCY}ms"
    echo "  Body: $(echo "$BODY" | head -1 | head -c 200)"
  fi

  # 2. TCP to api.deepgram.com:443
  log_info "TCP handshake to api.deepgram.com:443..."
  START=$(ms_now)
  if timeout 5 bash -c "echo > /dev/tcp/api.deepgram.com/443" 2>/dev/null; then
    END=$(ms_now)
    log_ok "TCP connect: $(( END - START ))ms"
  else
    log_err "Cannot reach api.deepgram.com:443 via TCP"
  fi

  # 3. Transcription REST API (short PCM)
  log_info "Testing transcription API (0.5s silence PCM)..."
  # 0.5s of silence: 16000 samples × 2 bytes = 32000 bytes
  local SILENT_PCM
  SILENT_PCM=$(python3 -c "import sys; sys.stdout.buffer.write(b'\x00' * 32000)" 2>/dev/null)
  START=$(ms_now)
  HTTP_CODE=$(echo "$SILENT_PCM" | curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    "https://api.deepgram.com/v1/listen?model=nova-3&language=bs&encoding=linear16&sample_rate=16000&channels=1" \
    -H "Authorization: Token ${DEEPGRAM_API_KEY}" \
    -H "Content-Type: audio/wav" \
    --data-binary @- 2>/dev/null)
  END=$(ms_now)
  LATENCY=$(( END - START ))

  if [[ "$HTTP_CODE" == "200" ]]; then
    log_ok "Transcription API: HTTP 200  latency: ${LATENCY}ms"
  elif [[ "$HTTP_CODE" == "400" ]]; then
    # 400 on silence is expected — API is reachable and auth works
    log_ok "Transcription API: reachable (HTTP 400 on silence — expected)  latency: ${LATENCY}ms"
  else
    log_warn "Transcription API: HTTP $HTTP_CODE  latency: ${LATENCY}ms"
  fi

  # 4. WebSocket endpoint reachability summary
  log_info "WebSocket endpoint (wss://api.deepgram.com/v1/listen)..."
  START=$(ms_now)
  if timeout 5 bash -c "echo > /dev/tcp/api.deepgram.com/443" 2>/dev/null; then
    END=$(ms_now)
    log_ok "WebSocket host reachable — TCP RTT: $(( END - START ))ms"
    log_info "Full WS test requires an active call — use test call to verify"
  else
    log_err "Cannot reach WebSocket host"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║   Voice System — Setup & Test                    ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo -e "  Host: $(hostname)  |  $(date '+%Y-%m-%d %H:%M:%S')"

  check_cmd curl docker git python3

  load_env

  case "${ONLY}" in
    setup)    section_server_setup ;;
    tts)      section_tts_voice_tuning ;;
    deepgram) section_deepgram_check ;;
    "")
      section_server_setup
      section_tts_voice_tuning
      section_deepgram_check
      ;;
    *)
      log_err "Unknown --only value: $ONLY. Use: setup | tts | deepgram"
      exit 1
      ;;
  esac

  log_section "Done"
  echo -e "  TTS audio files: ${CYAN}$TMP_DIR/*.mp3${NC}"
  echo -e "  Run with --only=tts to re-test voices only"
  echo ""
}

main "$@"
