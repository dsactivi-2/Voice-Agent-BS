#!/usr/bin/env bash
# =============================================================================
# autofix.sh — Production health check and auto-repair for Voice AI system
# =============================================================================
# Usage:
#   autofix.sh check       Read-only diagnostics, no changes
#   autofix.sh fix         Diagnose + auto-repair where possible
#   autofix.sh voice-test  Voice/TTS checks only (Phase 3)
#
# Exit codes:
#   0 — all checks passed
#   1 — issues found and fixed (fix mode only)
#   2 — manual intervention required
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
readonly SCRIPT_VERSION="1.0.0"
readonly COMPOSE_PROJECT="voice-system"
readonly PROJECT_DIR="/opt/voice-system"
readonly ENV_FILE="${PROJECT_DIR}/.env"
readonly COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"
readonly LOG_BASE="${PROJECT_DIR}/logs/autofix"
readonly TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly REPORT_FILE="${LOG_BASE}/report-${TIMESTAMP}.json"
readonly LATEST_LINK="${LOG_BASE}/latest.json"
readonly CURL_TIMEOUT=5
readonly TTS_CURL_TIMEOUT=10
readonly PUBLIC_HOST="voice.activi.io"
readonly EXPECTED_IP="157.90.126.58"
readonly EMAIL_TO="ds@activi.io"
readonly EMAIL_FROM="autofix@voice.activi.io"
readonly EMAIL_SUBJECT_PREFIX="[Voice AutoFix]"

readonly -a SERVICES=(orchestrator management-api postgres redis prometheus grafana caddy)
readonly -a CONTAINER_NAMES=(
    "voice-system-orchestrator-1"
    "voice-system-management-api-1"
    "voice-system-postgres-1"
    "voice-system-redis-1"
    "voice-system-prometheus-1"
    "voice-system-grafana-1"
    "voice-system-caddy-1"
)

# ---------------------------------------------------------------------------
# Colors (disabled when stdout is not a terminal or running in cron)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    readonly C_GREEN="\033[0;32m"
    readonly C_YELLOW="\033[0;33m"
    readonly C_RED="\033[0;31m"
    readonly C_BOLD="\033[1m"
    readonly C_RESET="\033[0m"
else
    readonly C_GREEN=""
    readonly C_YELLOW=""
    readonly C_RED=""
    readonly C_BOLD=""
    readonly C_RESET=""
fi

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
MODE=""
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
FIX_APPLIED=0
JSON_CHECKS="[]"

# Environment variables loaded from .env
DEEPGRAM_API_KEY=""
AZURE_SPEECH_KEY=""
AZURE_REGION=""
OPENAI_API_KEY=""
POSTGRES_USER=""
POSTGRES_DB=""
TTS_VOICE_BS=""
TTS_VOICE_SR=""
RING_BUFFER_SIZE_KB=""
VAD_ENDPOINTING_MS=""
VAD_GRACE_MS=""
VAD_BARGE_IN_MIN_MS=""
VAD_SILENCE_TIMEOUT_MS=""
VONAGE_APPLICATION_ID=""
VONAGE_DEFAULT_LANGUAGE=""

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------
log_ok() {
    local msg="$1"
    printf "${C_GREEN}[OK]${C_RESET}   %s\n" "$msg"
}

log_warn() {
    local msg="$1"
    printf "${C_YELLOW}[WARN]${C_RESET} %s\n" "$msg"
}

log_fail() {
    local msg="$1"
    printf "${C_RED}[FAIL]${C_RESET} %s\n" "$msg"
}

log_info() {
    local msg="$1"
    printf "${C_BOLD}[INFO]${C_RESET} %s\n" "$msg"
}

log_header() {
    local msg="$1"
    printf "\n${C_BOLD}=== %s ===${C_RESET}\n\n" "$msg"
}

# Record a check result into the JSON report and increment counters.
# Usage: record_check "check_name" "status" "message" ["detail"]
record_check() {
    local name="$1"
    local status="$2"   # ok | warn | fail | fixed
    local message="$3"
    local detail="${4:-}"
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    case "$status" in
        ok)    ((PASS_COUNT++)) || true ;;
        warn)  ((WARN_COUNT++)) || true ;;
        fail)  ((FAIL_COUNT++)) || true ;;
        fixed) ((FIX_APPLIED++)) || true; ((PASS_COUNT++)) || true ;;
    esac

    # Escape strings for JSON
    local j_name j_status j_message j_detail
    j_name="$(printf '%s' "$name" | sed 's/"/\\"/g')"
    j_status="$(printf '%s' "$status" | sed 's/"/\\"/g')"
    j_message="$(printf '%s' "$message" | sed 's/"/\\"/g')"
    j_detail="$(printf '%s' "$detail" | sed 's/"/\\"/g')"

    local entry
    entry=$(cat <<JSONEOF
{"name":"${j_name}","status":"${j_status}","message":"${j_message}","detail":"${j_detail}","timestamp":"${ts}"}
JSONEOF
)
    # Append to JSON_CHECKS array using jq if available, otherwise string concat
    if command -v jq &>/dev/null; then
        JSON_CHECKS="$(printf '%s' "$JSON_CHECKS" | jq -c --argjson e "$entry" '. + [$e]')"
    else
        if [[ "$JSON_CHECKS" == "[]" ]]; then
            JSON_CHECKS="[${entry}]"
        else
            JSON_CHECKS="${JSON_CHECKS%]},${entry}]"
        fi
    fi
}

# Load environment variables from .env file.
load_env() {
    if [[ ! -f "$ENV_FILE" ]]; then
        log_fail ".env file not found at ${ENV_FILE}"
        record_check "env_file" "fail" ".env file not found at ${ENV_FILE}"
        return 2
    fi

    # Source each KEY=VALUE line, handling quoting properly
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip comments and blank lines
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        # Only process lines that look like KEY=VALUE
        if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            local key="${line%%=*}"
            local value="${line#*=}"
            # Strip surrounding quotes (single or double)
            value="${value#\"}"
            value="${value%\"}"
            value="${value#\'}"
            value="${value%\'}"

            case "$key" in
                DEEPGRAM_API_KEY)       DEEPGRAM_API_KEY="$value" ;;
                AZURE_SPEECH_KEY)       AZURE_SPEECH_KEY="$value" ;;
                AZURE_REGION)           AZURE_REGION="$value" ;;
                OPENAI_API_KEY)         OPENAI_API_KEY="$value" ;;
                POSTGRES_USER)          POSTGRES_USER="$value" ;;
                POSTGRES_DB)            POSTGRES_DB="$value" ;;
                TTS_VOICE_BS)           TTS_VOICE_BS="$value" ;;
                TTS_VOICE_SR)           TTS_VOICE_SR="$value" ;;
                RING_BUFFER_SIZE_KB)    RING_BUFFER_SIZE_KB="$value" ;;
                VAD_ENDPOINTING_MS)     VAD_ENDPOINTING_MS="$value" ;;
                VAD_GRACE_MS)           VAD_GRACE_MS="$value" ;;
                VAD_BARGE_IN_MIN_MS)    VAD_BARGE_IN_MIN_MS="$value" ;;
                VAD_SILENCE_TIMEOUT_MS) VAD_SILENCE_TIMEOUT_MS="$value" ;;
                VONAGE_APPLICATION_ID)  VONAGE_APPLICATION_ID="$value" ;;
                VONAGE_DEFAULT_LANGUAGE) VONAGE_DEFAULT_LANGUAGE="$value" ;;
            esac
        fi
    done < "$ENV_FILE"

    log_ok "Environment loaded from ${ENV_FILE}"
    record_check "env_file" "ok" "Environment loaded successfully"
    return 0
}

# ---------------------------------------------------------------------------
# Phase 1: Server Health
# ---------------------------------------------------------------------------

check_docker_containers() {
    log_info "Checking Docker containers..."
    local overall=0

    for i in "${!SERVICES[@]}"; do
        local service="${SERVICES[$i]}"
        local container="${CONTAINER_NAMES[$i]}"
        local state health

        state="$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")"

        if [[ "$state" == "not_found" ]]; then
            log_fail "Container ${container} not found"
            record_check "container_${service}" "fail" "Container not found" "$container"
            overall=2

            if [[ "$MODE" == "fix" ]]; then
                log_info "Attempting to start ${service}..."
                if docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d "$service" 2>/dev/null; then
                    sleep 5
                    state="$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")"
                    if [[ "$state" == "running" ]]; then
                        log_ok "Container ${container} started successfully"
                        record_check "container_${service}_fix" "fixed" "Container started via compose up"
                    fi
                fi
            fi
            continue
        fi

        if [[ "$state" != "running" ]]; then
            log_fail "Container ${container} state: ${state}"
            record_check "container_${service}" "fail" "Container not running" "state=${state}"
            overall=2

            if [[ "$MODE" == "fix" ]]; then
                log_info "Restarting ${service}..."
                if docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" restart "$service" 2>/dev/null; then
                    sleep 5
                    state="$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")"
                    if [[ "$state" == "running" ]]; then
                        log_ok "Container ${container} restarted successfully"
                        record_check "container_${service}_fix" "fixed" "Container restarted"
                    else
                        log_fail "Container ${container} still not running after restart"
                        record_check "container_${service}_fix" "fail" "Restart failed" "state=${state}"
                    fi
                fi
            fi
            continue
        fi

        # Check health status if healthcheck is defined
        health="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo "unknown")"

        if [[ "$health" == "healthy" || "$health" == "none" ]]; then
            log_ok "Container ${container}: running (health=${health})"
            record_check "container_${service}" "ok" "Running" "health=${health}"
        elif [[ "$health" == "starting" ]]; then
            log_warn "Container ${container}: running but health=starting"
            record_check "container_${service}" "warn" "Health check still starting" "health=${health}"
            if [[ $overall -lt 1 ]]; then overall=1; fi
        else
            log_fail "Container ${container}: running but health=${health}"
            record_check "container_${service}" "fail" "Unhealthy" "health=${health}"
            overall=2

            if [[ "$MODE" == "fix" ]]; then
                log_info "Restarting unhealthy ${service}..."
                if docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" restart "$service" 2>/dev/null; then
                    sleep 10
                    health="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo "unknown")"
                    if [[ "$health" == "healthy" || "$health" == "starting" ]]; then
                        log_ok "Container ${container} restarted, health=${health}"
                        record_check "container_${service}_fix" "fixed" "Restarted unhealthy container" "health=${health}"
                    else
                        log_fail "Container ${container} still unhealthy after restart"
                        record_check "container_${service}_fix" "fail" "Still unhealthy after restart" "health=${health}"
                    fi
                fi
            fi
        fi
    done

    return $overall
}

check_disk_space() {
    log_info "Checking disk space..."

    local usage_line usage_pct
    usage_line="$(df -h / | tail -1)"
    usage_pct="$(echo "$usage_line" | awk '{gsub(/%/,""); print $(NF-1)}')"

    if [[ -z "$usage_pct" || ! "$usage_pct" =~ ^[0-9]+$ ]]; then
        log_warn "Could not parse disk usage"
        record_check "disk_space" "warn" "Could not parse disk usage" "$usage_line"
        return 1
    fi

    local avail
    avail="$(df -h / | tail -1 | awk '{print $(NF-2)}')"

    if (( usage_pct >= 95 )); then
        log_fail "Disk usage critical: ${usage_pct}% used (available: ${avail})"
        record_check "disk_space" "fail" "Critical disk usage: ${usage_pct}%" "available=${avail}"

        if [[ "$MODE" == "fix" ]]; then
            log_info "Pruning unused Docker images..."
            local freed
            freed="$(docker image prune -af 2>/dev/null | tail -1 || echo "unknown")"
            log_info "Prune result: ${freed}"
            record_check "disk_space_fix" "fixed" "Pruned Docker images" "$freed"

            # Re-check
            usage_pct="$(df -h / | tail -1 | awk '{gsub(/%/,""); print $(NF-1)}')"
            if (( usage_pct >= 95 )); then
                log_fail "Disk still critical after prune: ${usage_pct}%"
                record_check "disk_space_after_fix" "fail" "Still critical after prune" "${usage_pct}%"
                return 2
            else
                log_ok "Disk usage after prune: ${usage_pct}%"
                record_check "disk_space_after_fix" "ok" "Improved after prune" "${usage_pct}%"
            fi
        fi
        return 2
    elif (( usage_pct >= 90 )); then
        log_warn "Disk usage high: ${usage_pct}% used (available: ${avail})"
        record_check "disk_space" "warn" "High disk usage: ${usage_pct}%" "available=${avail}"
        return 1
    else
        log_ok "Disk usage: ${usage_pct}% used (available: ${avail})"
        record_check "disk_space" "ok" "Disk usage normal: ${usage_pct}%" "available=${avail}"
        return 0
    fi
}

check_log_rotation() {
    log_info "Checking Docker log sizes..."
    local overall=0

    for i in "${!SERVICES[@]}"; do
        local service="${SERVICES[$i]}"
        local container="${CONTAINER_NAMES[$i]}"
        local log_path log_size_bytes log_size_human

        log_path="$(docker inspect --format='{{.LogPath}}' "$container" 2>/dev/null || echo "")"

        if [[ -z "$log_path" || ! -f "$log_path" ]]; then
            log_warn "Log path not found for ${container}"
            record_check "log_${service}" "warn" "Log path not found" "$log_path"
            if [[ $overall -lt 1 ]]; then overall=1; fi
            continue
        fi

        log_size_bytes="$(stat -c%s "$log_path" 2>/dev/null || stat -f%z "$log_path" 2>/dev/null || echo "0")"
        log_size_human="$(du -sh "$log_path" 2>/dev/null | awk '{print $1}' || echo "unknown")"

        # Warn at 100MB, fail at 500MB
        if (( log_size_bytes > 524288000 )); then
            log_fail "Log for ${container}: ${log_size_human} (>500MB)"
            record_check "log_${service}" "fail" "Log file too large: ${log_size_human}" "$log_path"
            overall=2
        elif (( log_size_bytes > 104857600 )); then
            log_warn "Log for ${container}: ${log_size_human} (>100MB)"
            record_check "log_${service}" "warn" "Log file large: ${log_size_human}" "$log_path"
            if [[ $overall -lt 1 ]]; then overall=1; fi
        else
            log_ok "Log for ${container}: ${log_size_human}"
            record_check "log_${service}" "ok" "Log size normal: ${log_size_human}" "$log_path"
        fi
    done

    return $overall
}

check_postgres() {
    log_info "Checking PostgreSQL..."
    local container="voice-system-postgres-1"
    local overall=0

    # Active connections
    local conn_count
    conn_count="$(docker exec "$container" psql -U "${POSTGRES_USER:-voice_app}" -d "${POSTGRES_DB:-voice_system}" -tAc "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null || echo "error")"

    if [[ "$conn_count" == "error" ]]; then
        log_fail "Could not query pg_stat_activity"
        record_check "postgres_connections" "fail" "Query failed"
        return 2
    fi

    conn_count="$(echo "$conn_count" | tr -d '[:space:]')"

    if (( conn_count > 80 )); then
        log_fail "PostgreSQL active connections: ${conn_count} (>80)"
        record_check "postgres_connections" "fail" "Too many connections: ${conn_count}"
        overall=2
    elif (( conn_count > 50 )); then
        log_warn "PostgreSQL active connections: ${conn_count} (>50)"
        record_check "postgres_connections" "warn" "High connection count: ${conn_count}"
        if [[ $overall -lt 1 ]]; then overall=1; fi
    else
        log_ok "PostgreSQL active connections: ${conn_count}"
        record_check "postgres_connections" "ok" "Connection count normal: ${conn_count}"
    fi

    # Blocked locks
    local lock_count
    lock_count="$(docker exec "$container" psql -U "${POSTGRES_USER:-voice_app}" -d "${POSTGRES_DB:-voice_system}" -tAc "SELECT count(*) FROM pg_locks WHERE NOT granted;" 2>/dev/null || echo "error")"

    if [[ "$lock_count" == "error" ]]; then
        log_fail "Could not query pg_locks"
        record_check "postgres_locks" "fail" "Query failed"
        return 2
    fi

    lock_count="$(echo "$lock_count" | tr -d '[:space:]')"

    if (( lock_count > 5 )); then
        log_fail "PostgreSQL blocked locks: ${lock_count} (>5)"
        record_check "postgres_locks" "fail" "Too many blocked locks: ${lock_count}"
        overall=2
    elif (( lock_count > 0 )); then
        log_warn "PostgreSQL blocked locks: ${lock_count}"
        record_check "postgres_locks" "warn" "Blocked locks present: ${lock_count}"
        if [[ $overall -lt 1 ]]; then overall=1; fi
    else
        log_ok "PostgreSQL blocked locks: ${lock_count}"
        record_check "postgres_locks" "ok" "No blocked locks"
    fi

    return $overall
}

check_redis() {
    log_info "Checking Redis..."
    local container="voice-system-redis-1"
    local overall=0

    local info
    info="$(docker exec "$container" redis-cli INFO memory 2>/dev/null || echo "error")"

    if [[ "$info" == "error" ]]; then
        log_fail "Could not query Redis INFO memory"
        record_check "redis_memory" "fail" "Query failed"
        return 2
    fi

    local used_memory used_memory_human maxmemory evicted_keys

    used_memory="$(echo "$info" | grep -E "^used_memory:" | cut -d: -f2 | tr -d '[:space:]')"
    used_memory_human="$(echo "$info" | grep -E "^used_memory_human:" | cut -d: -f2 | tr -d '[:space:]')"
    maxmemory="$(echo "$info" | grep -E "^maxmemory:" | cut -d: -f2 | tr -d '[:space:]')"

    # Get evicted_keys from stats section
    local stats_info
    stats_info="$(docker exec "$container" redis-cli INFO stats 2>/dev/null || echo "")"
    evicted_keys="$(echo "$stats_info" | grep -E "^evicted_keys:" | cut -d: -f2 | tr -d '[:space:]')"
    evicted_keys="${evicted_keys:-0}"

    if [[ -n "$maxmemory" && "$maxmemory" != "0" && -n "$used_memory" ]]; then
        local usage_pct=$(( (used_memory * 100) / maxmemory ))

        if (( usage_pct >= 90 )); then
            log_fail "Redis memory: ${used_memory_human} / ${maxmemory} bytes (${usage_pct}%)"
            record_check "redis_memory" "fail" "Critical memory usage: ${usage_pct}%" "used=${used_memory_human}"
            overall=2
        elif (( usage_pct >= 75 )); then
            log_warn "Redis memory: ${used_memory_human} (${usage_pct}% of max)"
            record_check "redis_memory" "warn" "High memory usage: ${usage_pct}%" "used=${used_memory_human}"
            if [[ $overall -lt 1 ]]; then overall=1; fi
        else
            log_ok "Redis memory: ${used_memory_human} (${usage_pct}% of max)"
            record_check "redis_memory" "ok" "Memory usage normal: ${usage_pct}%" "used=${used_memory_human}"
        fi
    else
        log_ok "Redis memory: ${used_memory_human} (no maxmemory limit or unlimited)"
        record_check "redis_memory" "ok" "Memory usage: ${used_memory_human}" "maxmemory=${maxmemory:-unset}"
    fi

    # Evicted keys
    if (( evicted_keys > 1000 )); then
        log_warn "Redis evicted keys: ${evicted_keys} (>1000)"
        record_check "redis_evictions" "warn" "High eviction count: ${evicted_keys}"
        if [[ $overall -lt 1 ]]; then overall=1; fi
    else
        log_ok "Redis evicted keys: ${evicted_keys}"
        record_check "redis_evictions" "ok" "Eviction count normal: ${evicted_keys}"
    fi

    return $overall
}

check_ssl() {
    log_info "Checking SSL/TLS certificate..."

    local end_date
    end_date="$(echo | openssl s_client -connect "${PUBLIC_HOST}:443" -servername "$PUBLIC_HOST" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null \
        | cut -d= -f2)"

    if [[ -z "$end_date" ]]; then
        log_fail "Could not retrieve SSL certificate from ${PUBLIC_HOST}"
        record_check "ssl_cert" "fail" "Could not retrieve certificate"
        return 2
    fi

    # Calculate days until expiry
    local end_epoch now_epoch days_left
    end_epoch="$(date -d "$end_date" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$end_date" +%s 2>/dev/null || echo "0")"
    now_epoch="$(date +%s)"

    if [[ "$end_epoch" == "0" ]]; then
        log_warn "Could not parse certificate expiry date: ${end_date}"
        record_check "ssl_cert" "warn" "Cannot parse expiry date" "$end_date"
        return 1
    fi

    days_left=$(( (end_epoch - now_epoch) / 86400 ))

    if (( days_left < 0 )); then
        log_fail "SSL certificate EXPIRED (${days_left} days ago) — expiry: ${end_date}"
        record_check "ssl_cert" "fail" "Certificate expired" "expired ${days_left} days ago, enddate=${end_date}"
        return 2
    elif (( days_left < 7 )); then
        log_fail "SSL certificate expires in ${days_left} days — expiry: ${end_date}"
        record_check "ssl_cert" "fail" "Certificate expiring soon" "${days_left} days left, enddate=${end_date}"
        return 2
    elif (( days_left < 14 )); then
        log_warn "SSL certificate expires in ${days_left} days — expiry: ${end_date}"
        record_check "ssl_cert" "warn" "Certificate expiring in ${days_left} days" "enddate=${end_date}"
        return 1
    else
        log_ok "SSL certificate valid for ${days_left} days — expiry: ${end_date}"
        record_check "ssl_cert" "ok" "Certificate valid: ${days_left} days remaining" "enddate=${end_date}"
        return 0
    fi
}

check_dns() {
    log_info "Checking DNS resolution..."

    local resolved_ip
    resolved_ip="$(dig +short "$PUBLIC_HOST" 2>/dev/null | tail -1)"

    if [[ -z "$resolved_ip" ]]; then
        log_fail "DNS: ${PUBLIC_HOST} did not resolve"
        record_check "dns" "fail" "DNS resolution failed for ${PUBLIC_HOST}"
        return 2
    fi

    if [[ "$resolved_ip" == "$EXPECTED_IP" ]]; then
        log_ok "DNS: ${PUBLIC_HOST} -> ${resolved_ip}"
        record_check "dns" "ok" "Resolves correctly to ${EXPECTED_IP}"
        return 0
    else
        log_fail "DNS: ${PUBLIC_HOST} -> ${resolved_ip} (expected ${EXPECTED_IP})"
        record_check "dns" "fail" "Wrong IP: ${resolved_ip}" "expected=${EXPECTED_IP}"
        return 2
    fi
}

# ---------------------------------------------------------------------------
# Phase 2: Call Pipeline
# ---------------------------------------------------------------------------

check_deepgram() {
    log_info "Checking Deepgram API..."

    if [[ -z "$DEEPGRAM_API_KEY" ]]; then
        log_fail "DEEPGRAM_API_KEY not set in .env"
        record_check "deepgram_api" "fail" "API key not configured"
        return 2
    fi

    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$CURL_TIMEOUT" \
        -H "Authorization: Token ${DEEPGRAM_API_KEY}" \
        "https://api.deepgram.com/v1/projects" 2>/dev/null || echo "000")"

    if [[ "$http_code" == "200" ]]; then
        log_ok "Deepgram API: HTTP ${http_code}"
        record_check "deepgram_api" "ok" "API reachable: HTTP ${http_code}"
        return 0
    elif [[ "$http_code" == "000" ]]; then
        log_fail "Deepgram API: connection failed (timeout or network error)"
        record_check "deepgram_api" "fail" "Connection failed" "http_code=${http_code}"
        return 2
    elif [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
        log_fail "Deepgram API: authentication failed (HTTP ${http_code})"
        record_check "deepgram_api" "fail" "Auth failed: HTTP ${http_code}"
        return 2
    else
        log_warn "Deepgram API: unexpected HTTP ${http_code}"
        record_check "deepgram_api" "warn" "Unexpected response: HTTP ${http_code}"
        return 1
    fi
}

check_azure_tts() {
    log_info "Checking Azure TTS API..."

    if [[ -z "$AZURE_SPEECH_KEY" || -z "$AZURE_REGION" ]]; then
        log_fail "AZURE_SPEECH_KEY or AZURE_REGION not set in .env"
        record_check "azure_tts_api" "fail" "API key or region not configured"
        return 2
    fi

    local response http_code
    response="$(curl -s -w "\n%{http_code}" \
        --max-time "$CURL_TIMEOUT" \
        -H "Ocp-Apim-Subscription-Key: ${AZURE_SPEECH_KEY}" \
        "https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list" 2>/dev/null || echo -e "\n000")"

    http_code="$(echo "$response" | tail -1)"
    local body
    body="$(echo "$response" | sed '$d')"

    if [[ "$http_code" != "200" ]]; then
        if [[ "$http_code" == "000" ]]; then
            log_fail "Azure TTS API: connection failed"
            record_check "azure_tts_api" "fail" "Connection failed"
        elif [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
            log_fail "Azure TTS API: authentication failed (HTTP ${http_code})"
            record_check "azure_tts_api" "fail" "Auth failed: HTTP ${http_code}"
        else
            log_fail "Azure TTS API: HTTP ${http_code}"
            record_check "azure_tts_api" "fail" "Unexpected response: HTTP ${http_code}"
        fi
        return 2
    fi

    log_ok "Azure TTS API: HTTP ${http_code}"
    record_check "azure_tts_api" "ok" "API reachable: HTTP ${http_code}"

    # Check for Goran voice
    if echo "$body" | grep -q "bs-BA-GoranNeural"; then
        log_ok "Azure TTS: bs-BA-GoranNeural voice available"
        record_check "azure_voice_goran" "ok" "Voice available"
    else
        log_fail "Azure TTS: bs-BA-GoranNeural voice NOT found in voice list"
        record_check "azure_voice_goran" "fail" "Voice not available"
    fi

    # Check for Vesna voice
    if echo "$body" | grep -q "sr-RS-SophieNeural"; then
        log_ok "Azure TTS: sr-RS-SophieNeural voice available"
        record_check "azure_voice_vesna" "ok" "Voice available"
    else
        log_fail "Azure TTS: sr-RS-SophieNeural voice NOT found in voice list"
        record_check "azure_voice_vesna" "fail" "Voice not available"
    fi

    return 0
}

check_openai() {
    log_info "Checking OpenAI API..."

    if [[ -z "$OPENAI_API_KEY" ]]; then
        log_fail "OPENAI_API_KEY not set in .env"
        record_check "openai_api" "fail" "API key not configured"
        return 2
    fi

    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$CURL_TIMEOUT" \
        -H "Authorization: Bearer ${OPENAI_API_KEY}" \
        "https://api.openai.com/v1/models" 2>/dev/null || echo "000")"

    if [[ "$http_code" == "200" ]]; then
        log_ok "OpenAI API: HTTP ${http_code}"
        record_check "openai_api" "ok" "API reachable: HTTP ${http_code}"
        return 0
    elif [[ "$http_code" == "000" ]]; then
        log_fail "OpenAI API: connection failed"
        record_check "openai_api" "fail" "Connection failed"
        return 2
    elif [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
        log_fail "OpenAI API: authentication failed (HTTP ${http_code})"
        record_check "openai_api" "fail" "Auth failed: HTTP ${http_code}"
        return 2
    else
        log_warn "OpenAI API: unexpected HTTP ${http_code}"
        record_check "openai_api" "warn" "Unexpected response: HTTP ${http_code}"
        return 1
    fi
}

check_vonage_webhooks() {
    log_info "Checking Vonage webhook endpoint..."

    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$CURL_TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -d '{"from":"test","to":"test","conversation_uuid":"test","uuid":"test"}' \
        "http://localhost:3000/vonage/answer" 2>/dev/null || echo "000")"

    if [[ "$http_code" == "200" ]]; then
        log_ok "Vonage answer endpoint: HTTP ${http_code}"
        record_check "vonage_webhook" "ok" "Endpoint reachable: HTTP ${http_code}"
        return 0
    elif [[ "$http_code" == "000" ]]; then
        log_fail "Vonage answer endpoint: connection refused (orchestrator down?)"
        record_check "vonage_webhook" "fail" "Connection refused" "http_code=${http_code}"
        return 2
    else
        # Many non-200 codes are acceptable (e.g. 400 for invalid input) as long as the endpoint responds
        if (( http_code >= 400 && http_code < 500 )); then
            log_ok "Vonage answer endpoint responds: HTTP ${http_code} (expected for test data)"
            record_check "vonage_webhook" "ok" "Endpoint responds: HTTP ${http_code}" "4xx expected for test payload"
            return 0
        elif (( http_code >= 500 )); then
            log_fail "Vonage answer endpoint: server error HTTP ${http_code}"
            record_check "vonage_webhook" "fail" "Server error: HTTP ${http_code}"
            return 2
        else
            log_ok "Vonage answer endpoint responds: HTTP ${http_code}"
            record_check "vonage_webhook" "ok" "Endpoint responds: HTTP ${http_code}"
            return 0
        fi
    fi
}

check_tts_cache() {
    log_info "Checking TTS cache..."
    local container="voice-system-redis-1"

    local cache_count
    cache_count="$(docker exec "$container" redis-cli KEYS "tts:cache:*" 2>/dev/null | wc -l | tr -d '[:space:]')"

    if [[ -z "$cache_count" || "$cache_count" == "0" ]]; then
        log_fail "TTS cache: 0 entries found (expected >=32)"
        record_check "tts_cache_count" "fail" "No cached entries" "count=0"
        return 2
    elif (( cache_count < 32 )); then
        log_warn "TTS cache: ${cache_count} entries (expected >=32)"
        record_check "tts_cache_count" "warn" "Low cache count: ${cache_count}" "expected>=32"
        return 1
    else
        log_ok "TTS cache: ${cache_count} entries"
        record_check "tts_cache_count" "ok" "Cache populated: ${cache_count} entries"
        return 0
    fi
}

check_ring_buffer() {
    log_info "Checking ring buffer configuration..."

    if [[ -z "$RING_BUFFER_SIZE_KB" ]]; then
        log_warn "RING_BUFFER_SIZE_KB not set in .env"
        record_check "ring_buffer" "warn" "Not configured in .env"
        return 1
    fi

    if [[ "$RING_BUFFER_SIZE_KB" == "200" ]]; then
        log_ok "Ring buffer: ${RING_BUFFER_SIZE_KB}KB"
        record_check "ring_buffer" "ok" "Correct size: ${RING_BUFFER_SIZE_KB}KB"
        return 0
    else
        log_warn "Ring buffer: ${RING_BUFFER_SIZE_KB}KB (expected 200KB for 6s Deepgram latency coverage)"
        record_check "ring_buffer" "warn" "Non-optimal size: ${RING_BUFFER_SIZE_KB}KB" "expected=200"
        return 1
    fi
}

check_vad_config() {
    log_info "Checking VAD configuration..."
    local overall=0

    # Helper: validate a VAD parameter is within range
    # Usage: validate_vad_param "name" "value" min max
    validate_vad_param() {
        local name="$1"
        local value="$2"
        local min="$3"
        local max="$4"

        if [[ -z "$value" ]]; then
            log_warn "VAD: ${name} not set in .env"
            record_check "vad_${name}" "warn" "Not configured"
            return 1
        fi

        if ! [[ "$value" =~ ^[0-9]+$ ]]; then
            log_fail "VAD: ${name}=${value} is not a valid number"
            record_check "vad_${name}" "fail" "Invalid value: ${value}"
            return 2
        fi

        if (( value < min || value > max )); then
            log_warn "VAD: ${name}=${value} outside recommended range [${min}-${max}]"
            record_check "vad_${name}" "warn" "Out of range: ${value}" "recommended=[${min}-${max}]"
            return 1
        else
            log_ok "VAD: ${name}=${value} (range [${min}-${max}])"
            record_check "vad_${name}" "ok" "In range: ${value}" "range=[${min}-${max}]"
            return 0
        fi
    }

    local ret

    validate_vad_param "ENDPOINTING_MS" "$VAD_ENDPOINTING_MS" 200 500 || ret=$?
    if [[ ${ret:-0} -gt $overall ]]; then overall=${ret:-0}; fi

    validate_vad_param "GRACE_MS" "$VAD_GRACE_MS" 100 300 || ret=$?
    if [[ ${ret:-0} -gt $overall ]]; then overall=${ret:-0}; fi

    validate_vad_param "BARGE_IN_MIN_MS" "$VAD_BARGE_IN_MIN_MS" 100 250 || ret=$?
    if [[ ${ret:-0} -gt $overall ]]; then overall=${ret:-0}; fi

    validate_vad_param "SILENCE_TIMEOUT_MS" "$VAD_SILENCE_TIMEOUT_MS" 5000 15000 || ret=$?
    if [[ ${ret:-0} -gt $overall ]]; then overall=${ret:-0}; fi

    return $overall
}

# ---------------------------------------------------------------------------
# Phase 3: Voice / Stimme
# ---------------------------------------------------------------------------

check_agent_config() {
    log_info "Checking agent voice configuration..."
    local overall=0

    # TTS_VOICE_BS
    if [[ -z "$TTS_VOICE_BS" ]]; then
        log_fail "TTS_VOICE_BS not set in .env"
        record_check "agent_voice_bs" "fail" "Not configured"
        overall=2
    elif [[ "$TTS_VOICE_BS" == "bs-BA-GoranNeural" ]]; then
        log_ok "TTS_VOICE_BS: ${TTS_VOICE_BS} (Goran)"
        record_check "agent_voice_bs" "ok" "Correct: ${TTS_VOICE_BS}"
    else
        log_fail "TTS_VOICE_BS: ${TTS_VOICE_BS} (expected bs-BA-GoranNeural)"
        record_check "agent_voice_bs" "fail" "Wrong voice: ${TTS_VOICE_BS}" "expected=bs-BA-GoranNeural"
        overall=2
    fi

    # TTS_VOICE_SR
    if [[ -z "$TTS_VOICE_SR" ]]; then
        log_fail "TTS_VOICE_SR not set in .env"
        record_check "agent_voice_sr" "fail" "Not configured"
        overall=2
    elif [[ "$TTS_VOICE_SR" == "sr-RS-SophieNeural" ]]; then
        log_ok "TTS_VOICE_SR: ${TTS_VOICE_SR} (Vesna)"
        record_check "agent_voice_sr" "ok" "Correct: ${TTS_VOICE_SR}"
    else
        log_fail "TTS_VOICE_SR: ${TTS_VOICE_SR} (expected sr-RS-SophieNeural)"
        record_check "agent_voice_sr" "fail" "Wrong voice: ${TTS_VOICE_SR}" "expected=sr-RS-SophieNeural"
        overall=2
    fi

    return $overall
}

check_tts_synthesis_goran() {
    log_info "Testing TTS synthesis for Goran (bs-BA)..."

    if [[ -z "$AZURE_SPEECH_KEY" || -z "$AZURE_REGION" ]]; then
        log_fail "Azure credentials not available, skipping TTS synthesis test"
        record_check "tts_synth_goran" "fail" "Azure credentials missing"
        return 2
    fi

    local output_file="/tmp/autofix_tts_goran.raw"
    local ssml='<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="bs-BA"><voice name="bs-BA-GoranNeural">Dobar dan, kako Vam mogu pomoći?</voice></speak>'

    local response time_total http_code
    response="$(curl -s -w "\n%{http_code}\n%{time_total}" \
        --max-time "$TTS_CURL_TIMEOUT" \
        -H "Ocp-Apim-Subscription-Key: ${AZURE_SPEECH_KEY}" \
        -H "Content-Type: application/ssml+xml" \
        -H "X-Microsoft-OutputFormat: raw-16khz-16bit-mono-pcm" \
        -d "$ssml" \
        "https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1" \
        -o "$output_file" 2>/dev/null || echo -e "\n000\n0")"

    http_code="$(echo "$response" | tail -2 | head -1)"
    time_total="$(echo "$response" | tail -1)"

    if [[ "$http_code" != "200" ]]; then
        log_fail "TTS synthesis Goran: HTTP ${http_code}"
        record_check "tts_synth_goran" "fail" "Synthesis failed: HTTP ${http_code}"
        return 2
    fi

    local file_size=0
    if [[ -f "$output_file" ]]; then
        file_size="$(stat -c%s "$output_file" 2>/dev/null || stat -f%z "$output_file" 2>/dev/null || echo "0")"
    fi

    if (( file_size == 0 )); then
        log_fail "TTS synthesis Goran: empty response"
        record_check "tts_synth_goran" "fail" "Empty audio output" "file_size=0"
        return 2
    fi

    # Check response time
    local time_ms
    time_ms="$(echo "$time_total" | awk '{printf "%.0f", $1 * 1000}')"

    if (( time_ms > 2000 )); then
        log_warn "TTS synthesis Goran: ${file_size} bytes in ${time_total}s (>2s)"
        record_check "tts_synth_goran" "warn" "Slow synthesis: ${time_total}s" "size=${file_size}, time_ms=${time_ms}"
        return 1
    else
        log_ok "TTS synthesis Goran: ${file_size} bytes in ${time_total}s"
        record_check "tts_synth_goran" "ok" "Synthesis successful: ${file_size} bytes in ${time_total}s"
        return 0
    fi
}

check_tts_synthesis_vesna() {
    log_info "Testing TTS synthesis for Vesna (sr-RS)..."

    if [[ -z "$AZURE_SPEECH_KEY" || -z "$AZURE_REGION" ]]; then
        log_fail "Azure credentials not available, skipping TTS synthesis test"
        record_check "tts_synth_vesna" "fail" "Azure credentials missing"
        return 2
    fi

    local output_file="/tmp/autofix_tts_vesna.raw"
    local ssml
    # Using Cyrillic Serbian text for Vesna
    ssml='<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="sr-RS"><voice name="sr-RS-SophieNeural">Добар дан, како Вам могу помоћи?</voice></speak>'

    local response time_total http_code
    response="$(curl -s -w "\n%{http_code}\n%{time_total}" \
        --max-time "$TTS_CURL_TIMEOUT" \
        -H "Ocp-Apim-Subscription-Key: ${AZURE_SPEECH_KEY}" \
        -H "Content-Type: application/ssml+xml" \
        -H "X-Microsoft-OutputFormat: raw-16khz-16bit-mono-pcm" \
        -d "$ssml" \
        "https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1" \
        -o "$output_file" 2>/dev/null || echo -e "\n000\n0")"

    http_code="$(echo "$response" | tail -2 | head -1)"
    time_total="$(echo "$response" | tail -1)"

    if [[ "$http_code" != "200" ]]; then
        log_fail "TTS synthesis Vesna: HTTP ${http_code}"
        record_check "tts_synth_vesna" "fail" "Synthesis failed: HTTP ${http_code}"
        return 2
    fi

    local file_size=0
    if [[ -f "$output_file" ]]; then
        file_size="$(stat -c%s "$output_file" 2>/dev/null || stat -f%z "$output_file" 2>/dev/null || echo "0")"
    fi

    if (( file_size == 0 )); then
        log_fail "TTS synthesis Vesna: empty response"
        record_check "tts_synth_vesna" "fail" "Empty audio output" "file_size=0"
        return 2
    fi

    local time_ms
    time_ms="$(echo "$time_total" | awk '{printf "%.0f", $1 * 1000}')"

    if (( time_ms > 2000 )); then
        log_warn "TTS synthesis Vesna: ${file_size} bytes in ${time_total}s (>2s)"
        record_check "tts_synth_vesna" "warn" "Slow synthesis: ${time_total}s" "size=${file_size}, time_ms=${time_ms}"
        return 1
    else
        log_ok "TTS synthesis Vesna: ${file_size} bytes in ${time_total}s"
        record_check "tts_synth_vesna" "ok" "Synthesis successful: ${file_size} bytes in ${time_total}s"
        return 0
    fi
}

check_greeting_cache() {
    log_info "Checking greeting cache sizes..."
    local container="voice-system-redis-1"
    local overall=0

    # Goran greeting cache
    local goran_size
    goran_size="$(docker exec "$container" redis-cli GET "tts:cache:greeting:bs" 2>/dev/null | wc -c | tr -d '[:space:]')"

    if [[ -z "$goran_size" || "$goran_size" == "0" ]]; then
        log_fail "Greeting cache Goran (bs): empty or missing"
        record_check "greeting_cache_goran" "fail" "Cache empty" "size=0"
        overall=2
    elif (( goran_size < 129000 )); then
        log_warn "Greeting cache Goran (bs): ${goran_size} bytes (expected ~129000+)"
        record_check "greeting_cache_goran" "warn" "Smaller than expected: ${goran_size}" "expected>=129000"
        if [[ $overall -lt 1 ]]; then overall=1; fi
    else
        log_ok "Greeting cache Goran (bs): ${goran_size} bytes"
        record_check "greeting_cache_goran" "ok" "Cache populated: ${goran_size} bytes"
    fi

    # Vesna greeting cache
    local vesna_size
    vesna_size="$(docker exec "$container" redis-cli GET "tts:cache:greeting:sr" 2>/dev/null | wc -c | tr -d '[:space:]')"

    if [[ -z "$vesna_size" || "$vesna_size" == "0" ]]; then
        log_fail "Greeting cache Vesna (sr): empty or missing"
        record_check "greeting_cache_vesna" "fail" "Cache empty" "size=0"
        overall=2
    elif (( vesna_size < 154000 )); then
        log_warn "Greeting cache Vesna (sr): ${vesna_size} bytes (expected ~154000+)"
        record_check "greeting_cache_vesna" "warn" "Smaller than expected: ${vesna_size}" "expected>=154000"
        if [[ $overall -lt 1 ]]; then overall=1; fi
    else
        log_ok "Greeting cache Vesna (sr): ${vesna_size} bytes"
        record_check "greeting_cache_vesna" "ok" "Cache populated: ${vesna_size} bytes"
    fi

    return $overall
}

check_phonetics() {
    log_info "Checking phonetics in cached greetings..."
    local container="voice-system-redis-1"
    local overall=0

    # Check for the forbidden "Step2Job" pattern in all TTS cache keys
    # The correct phonetic spelling is "Step Tu Džob-a"
    local cache_content
    cache_content="$(docker exec "$container" redis-cli KEYS "tts:cache:*" 2>/dev/null)"

    if [[ -z "$cache_content" ]]; then
        log_warn "No TTS cache keys found, skipping phonetics check"
        record_check "phonetics_step2job" "warn" "No cache keys to check"
        return 1
    fi

    local found_bad=0
    local bad_keys=""

    while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        local value
        value="$(docker exec "$container" redis-cli GET "$key" 2>/dev/null || echo "")"
        if echo "$value" | grep -qi "Step2Job"; then
            found_bad=1
            bad_keys="${bad_keys} ${key}"
        fi
    done <<< "$cache_content"

    if (( found_bad )); then
        log_fail "Phonetics: found 'Step2Job' in cached greetings (should be 'Step Tu Džob-a')"
        record_check "phonetics_step2job" "fail" "Bad phonetics found" "keys=${bad_keys}"
        overall=2
    else
        log_ok "Phonetics: no 'Step2Job' found in cache (correct: 'Step Tu Džob-a')"
        record_check "phonetics_step2job" "ok" "No forbidden patterns found"
    fi

    return $overall
}

check_language_routing() {
    log_info "Checking language routing configuration..."

    if [[ -z "$VONAGE_DEFAULT_LANGUAGE" ]]; then
        log_warn "VONAGE_DEFAULT_LANGUAGE not set in .env"
        record_check "language_routing" "warn" "Not configured in .env"
        return 1
    fi

    if [[ "$VONAGE_DEFAULT_LANGUAGE" == "bs" ]]; then
        log_ok "Default language: ${VONAGE_DEFAULT_LANGUAGE} (Bosnian/Goran)"
        record_check "language_routing" "ok" "Correct default: ${VONAGE_DEFAULT_LANGUAGE}"
        return 0
    else
        log_warn "Default language: ${VONAGE_DEFAULT_LANGUAGE} (expected 'bs')"
        record_check "language_routing" "warn" "Unexpected default: ${VONAGE_DEFAULT_LANGUAGE}" "expected=bs"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

generate_report() {
    mkdir -p "$LOG_BASE"

    local total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
    local overall_status="ok"
    if (( FAIL_COUNT > 0 )); then
        overall_status="fail"
    elif (( WARN_COUNT > 0 )); then
        overall_status="warn"
    fi

    local report
    if command -v jq &>/dev/null; then
        report="$(jq -nc \
            --arg version "$SCRIPT_VERSION" \
            --arg mode "$MODE" \
            --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg hostname "$(hostname)" \
            --arg status "$overall_status" \
            --argjson pass "$PASS_COUNT" \
            --argjson warn "$WARN_COUNT" \
            --argjson fail "$FAIL_COUNT" \
            --argjson fixed "$FIX_APPLIED" \
            --argjson total "$total" \
            --argjson checks "$JSON_CHECKS" \
            '{
                version: $version,
                mode: $mode,
                timestamp: $ts,
                hostname: $hostname,
                overall_status: $status,
                summary: {
                    total: $total,
                    passed: $pass,
                    warnings: $warn,
                    failures: $fail,
                    fixed: $fixed
                },
                checks: $checks
            }')"
    else
        # Fallback without jq
        report=$(cat <<REPORTEOF
{
  "version": "${SCRIPT_VERSION}",
  "mode": "${MODE}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(hostname)",
  "overall_status": "${overall_status}",
  "summary": {
    "total": ${total},
    "passed": ${PASS_COUNT},
    "warnings": ${WARN_COUNT},
    "failures": ${FAIL_COUNT},
    "fixed": ${FIX_APPLIED}
  },
  "checks": ${JSON_CHECKS}
}
REPORTEOF
)
    fi

    echo "$report" > "$REPORT_FILE"
    ln -sf "$REPORT_FILE" "$LATEST_LINK"

    log_info "Report saved to ${REPORT_FILE}"
    log_info "Latest symlink: ${LATEST_LINK}"
}

print_summary() {
    local total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
    printf "\n${C_BOLD}--- Summary ---${C_RESET}\n"
    printf "${C_GREEN}%d checks passed${C_RESET}, " "$PASS_COUNT"
    printf "${C_YELLOW}%d warnings${C_RESET}, " "$WARN_COUNT"
    printf "${C_RED}%d failures${C_RESET}" "$FAIL_COUNT"
    if (( FIX_APPLIED > 0 )); then
        printf ", ${C_GREEN}%d fixed${C_RESET}" "$FIX_APPLIED"
    fi
    printf " (total: %d)\n" "$total"
}

# ---------------------------------------------------------------------------
# Email notification
# ---------------------------------------------------------------------------

send_email_report() {
    # Only send if mail/sendmail is available
    local mailer=""
    if command -v mail &>/dev/null; then
        mailer="mail"
    elif command -v sendmail &>/dev/null; then
        mailer="sendmail"
    elif command -v msmtp &>/dev/null; then
        mailer="msmtp"
    else
        log_warn "No mail command found (mail/sendmail/msmtp). Skipping email."
        return 1
    fi

    local total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
    local overall_status="OK"
    local urgency=""
    if (( FAIL_COUNT > 0 )); then
        overall_status="FAIL"
        urgency=" *** ACTION REQUIRED ***"
    elif (( WARN_COUNT > 0 )); then
        overall_status="WARN"
    fi

    local subject="${EMAIL_SUBJECT_PREFIX} ${overall_status}: ${PASS_COUNT} ok, ${WARN_COUNT} warn, ${FAIL_COUNT} fail${urgency}"

    # Build plain-text email body
    local body=""
    body+="Voice System Auto-Fix Report"$'\n'
    body+="=============================="$'\n'
    body+="Mode:      ${MODE}"$'\n'
    body+="Time:      $(date)"$'\n'
    body+="Host:      $(hostname)"$'\n'
    body+="Status:    ${overall_status}"$'\n'
    body+=""$'\n'
    body+="Summary"$'\n'
    body+="-------"$'\n'
    body+="Passed:    ${PASS_COUNT}"$'\n'
    body+="Warnings:  ${WARN_COUNT}"$'\n'
    body+="Failures:  ${FAIL_COUNT}"$'\n'
    body+="Fixed:     ${FIX_APPLIED}"$'\n'
    body+="Total:     ${total}"$'\n'
    body+=""$'\n'

    # List failures and warnings
    if (( FAIL_COUNT > 0 || WARN_COUNT > 0 )); then
        body+="Issues"$'\n'
        body+="------"$'\n'

        if command -v jq &>/dev/null && [[ -f "$REPORT_FILE" ]]; then
            # Extract failures
            local failures
            failures="$(jq -r '.checks[] | select(.status == "fail") | "  [FAIL] \(.name): \(.message) \(if .detail != "" then "(\(.detail))" else "" end)"' "$REPORT_FILE" 2>/dev/null || echo "")"
            if [[ -n "$failures" ]]; then
                body+=""$'\n'"FAILURES:"$'\n'"${failures}"$'\n'
            fi

            # Extract warnings
            local warnings
            warnings="$(jq -r '.checks[] | select(.status == "warn") | "  [WARN] \(.name): \(.message) \(if .detail != "" then "(\(.detail))" else "" end)"' "$REPORT_FILE" 2>/dev/null || echo "")"
            if [[ -n "$warnings" ]]; then
                body+=""$'\n'"WARNINGS:"$'\n'"${warnings}"$'\n'
            fi
        else
            body+="  (install jq for detailed issue listing)"$'\n'
        fi
        body+=""$'\n'
    fi

    body+="Full JSON report: ${REPORT_FILE}"$'\n'
    body+="Latest symlink:   ${LATEST_LINK}"$'\n'
    body+=""$'\n'
    body+="-- "$'\n'
    body+="autofix.sh v${SCRIPT_VERSION}"$'\n'

    # Send via available mailer
    case "$mailer" in
        mail)
            echo "$body" | mail -s "$subject" "$EMAIL_TO"
            ;;
        msmtp)
            {
                echo "From: ${EMAIL_FROM}"
                echo "To: ${EMAIL_TO}"
                echo "Subject: ${subject}"
                echo "Content-Type: text/plain; charset=utf-8"
                echo ""
                echo "$body"
            } | msmtp "$EMAIL_TO"
            ;;
        sendmail)
            {
                echo "From: ${EMAIL_FROM}"
                echo "To: ${EMAIL_TO}"
                echo "Subject: ${subject}"
                echo "Content-Type: text/plain; charset=utf-8"
                echo ""
                echo "$body"
            } | sendmail -t
            ;;
    esac

    local send_rc=$?
    if [[ $send_rc -eq 0 ]]; then
        log_ok "Email report sent to ${EMAIL_TO}"
    else
        log_warn "Email send failed (exit code ${send_rc})"
    fi
    return $send_rc
}

# ---------------------------------------------------------------------------
# Phase runners
# ---------------------------------------------------------------------------

run_phase1() {
    log_header "Phase 1: Server Health"

    check_docker_containers || true
    check_disk_space || true
    check_log_rotation || true
    check_postgres || true
    check_redis || true
    check_ssl || true
    check_dns || true
}

run_phase2() {
    log_header "Phase 2: Call Pipeline"

    check_deepgram || true
    check_azure_tts || true
    check_openai || true
    check_vonage_webhooks || true
    check_tts_cache || true
    check_ring_buffer || true
    check_vad_config || true
}

run_phase3() {
    log_header "Phase 3: Voice / Stimme"

    check_agent_config || true
    check_tts_synthesis_goran || true
    check_tts_synthesis_vesna || true
    check_greeting_cache || true
    check_phonetics || true
    check_language_routing || true
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <mode>

Modes:
  check       Read-only diagnostics, no changes
  fix         Diagnose + auto-repair where possible
  voice-test  Voice/TTS checks only (Phase 3)

Options:
  -h, --help  Show this help message
  -v, --version  Show version

Exit codes:
  0  All checks passed
  1  Issues found and fixed (fix mode only)
  2  Manual intervention required

EOF
}

main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 2
    fi

    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            echo "autofix.sh v${SCRIPT_VERSION}"
            exit 0
            ;;
        check|fix|voice-test)
            MODE="$1"
            ;;
        *)
            echo "Error: unknown mode '$1'"
            usage
            exit 2
            ;;
    esac

    printf "${C_BOLD}Voice System Auto-Fix v${SCRIPT_VERSION}${C_RESET}\n"
    printf "Mode: ${C_BOLD}%s${C_RESET} | Time: %s | Host: %s\n" "$MODE" "$(date)" "$(hostname)"
    printf "Project: %s\n" "$PROJECT_DIR"

    # Load environment
    load_env || true

    case "$MODE" in
        check)
            run_phase1
            run_phase2
            run_phase3
            ;;
        fix)
            run_phase1
            run_phase2
            run_phase3
            ;;
        voice-test)
            run_phase3
            ;;
    esac

    generate_report
    print_summary
    send_email_report || true

    # Determine exit code
    if (( FAIL_COUNT > 0 )); then
        exit 2
    elif (( FIX_APPLIED > 0 )); then
        exit 1
    else
        exit 0
    fi
}

main "$@"
