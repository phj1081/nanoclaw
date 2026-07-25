#!/usr/bin/env python3
"""EJClaw status board — 구 EJClaw Status 대시보드 후계 (EJClaw 소유, 헤르메스 비의존).

#status 채널의 메시지 1개를 편집. 오너 봇(NanoClaw .env의 DISCORD_BOT_TOKEN)으로 게시.
구독 사용량:
- Claude/Codex: CLIProxyAPI Management auth-files + api-call (JSON). OAuth 파일을 보드가 직접 파싱하지 않는다.
- Grok SuperGrok 주간 크레딧%: grok.com gRPC-web GetGrokCreditsConfig.
  Management api-call은 바이너리 gRPC body를 전달하지 못해, CPA auth-dir의 xai-*.json access_token만 읽어 동일 호스트에서 직접 프로브한다
  (외부 onWatch/CodexBar 데몬 없이 cliproxy 자격증명 재사용). 실패 시 grok-inspection 라벨 폴백.
관리 키는 1Password에서 런타임 조회한다.
구 unified-dashboard.ts 파리티:
- 사용량 테이블 (5h/7d, 5칸 바, 리셋 sub-line, 모바일 고정폭)
- Grok 주간 크레딧% (7d 칸) 또는 순검 라벨 폴백
- 에이전트 상태 (Native Claude SQLite / systemd health)
- 서버 블록 (CPU/Load/Memory/Disk/Uptime)
Tribunal 소속이던 모델구성(Owner/Reviewer/Arbiter/MoA) 블록은 은퇴로 제외.

systemd user timer(ejclaw-status-board.timer)가 5분마다 실행. 침묵=정상.
"""
import base64, json, os, re, shutil, sqlite3, subprocess, sys, urllib.request, urllib.error, datetime, pathlib, time

CHANNEL_ID = "1481063226224672930"  # #status
NANOCLAW_ENV = pathlib.Path.home()/'NanoClaw'/'.env'
STATE_DIR = pathlib.Path.home()/'.local'/'state'/'ejclaw'
STATE = STATE_DIR/'status-board.json'
QUOTA_CACHE = STATE_DIR/'cliproxy-quota-cache.json'
NATIVE_CLAUDE_STATE = pathlib.Path.home()/'.local'/'state'/'claude-native'/'state.sqlite'
NATIVE_CLAUDE_ROUTES = pathlib.Path.home()/'.config'/'claude-native'/'routes.json'
GROK_RESULTS = pathlib.Path(os.environ.get(
    'GROK_INSPECTION_RESULTS',
    str(pathlib.Path.home()/'cliproxyapi'/'data'/'grok-inspection'/'results.json')))
CLIPROXY_AUTH_DIR = pathlib.Path(os.environ.get(
    'CLIPROXY_AUTH_DIR', str(pathlib.Path.home()/'.cli-proxy-api')))
GROK_CREDITS_URL = os.environ.get(
    'GROK_CREDITS_URL',
    'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig')
GROK_CREDITS_CACHE = STATE_DIR/'grok-credits-cache.json'
CLIPROXY_MANAGEMENT_BASE = os.environ.get(
    'CLIPROXY_MANAGEMENT_BASE', 'http://172.17.0.1:8317/v0/management').rstrip('/')
CLIPROXY_MANAGEMENT_KEY_REF = os.environ.get(
    'CLIPROXY_MANAGEMENT_KEY_REF',
    'op://person-service/xp6ijk75xjz2nde7ztd43yqc3u/password')
UA = 'DiscordBot (https://eyejoker.com, ejclaw-status/1)'
_GROK_LABELS = {
    'healthy': 'ok',
    'quota_exhausted': '한도소진',
    'permission_denied': '권한거부',
    'reauth': '재로그인',
    'model_unavailable': '모델불가',
    'error': '이상',
    'other': '이상',
}


def get_bot_token():
    for line in open(NANOCLAW_ENV):
        m = re.match(r'DISCORD_BOT_TOKEN=(.+)', line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


# ── 사용량 렌더러 (구 renderUsageTable 이식) ──

def bar(pct):
    filled = max(0, min(5, round(pct/20)))
    return '█'*filled + '░'*(5-filled)

def vw(s):
    return sum(2 if ord(c) > 0x7f else 1 for c in s)

def compact_reset(ts):
    if ts is None: return ''
    try:
        if isinstance(ts, str):
            dt = datetime.datetime.fromisoformat(ts.replace('Z','+00:00'))
        else:
            dt = datetime.datetime.fromtimestamp(int(ts), tz=datetime.timezone.utc)
        left = (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        if left <= 0: return '지남'
        d = int(left//86400); h = int(left%86400//3600); m = int(left%3600//60)
        # 분 단독은 단위 없으면 "12"만 보여 헷갈림 → 12m
        return f"{d}d{h}h" if d else (f"{h}h{m:02d}" if h else f"{m}m")
    except Exception:
        return '?'

EMPTY_CELL = '─'*5 + '    '

def render_usage_table(claude_rows, codex_rows, grok_rows=None):
    grok_rows = grok_rows or []
    all_rows = claude_rows + codex_rows
    if not all_rows and not grok_rows:
        return ['_조회 불가_']
    names = [r[0] for r in all_rows] + [r[0] for r in grok_rows]
    name_w = max(8, *(vw(n) for n in names)) + 1
    pad = lambda s: s + ' '*max(0, name_w - vw(s))
    lines = ['```']
    if all_rows:
        lines.append(' '*name_w + '5h' + ' '*8 + '7d')

    def emit(rows):
        for name, h5p, h5r, d7p, d7r, stale in rows:
            h5 = f"{bar(h5p)}{h5p:3d}%" if h5p >= 0 else EMPTY_CELL
            d7 = f"{bar(d7p)}{d7p:3d}%" if d7p >= 0 else EMPTY_CELL
            suffix = f" ({stale}m)" if stale is not None else ''
            lines.append(f"{pad(name)}{h5} {d7}{suffix}")
            r5 = compact_reset(h5r) if h5p >= 0 else ''
            r7 = compact_reset(d7r) if d7p >= 0 else ''
            if r5 or r7:
                reset_line = ' '*name_w + (r5 or '')
                reset_line = reset_line.ljust(name_w + 10) + (r7 or '')
                lines.append(reset_line.rstrip())

    emit(claude_rows)
    if claude_rows and codex_rows:
        lines.append('─'*(name_w + 20))
    emit(codex_rows)
    if grok_rows:
        if all_rows:
            lines.append('─'*(name_w + 20))
        # credit rows: same 6-tuple as Claude/Codex → bars in 7d
        # label rows: (name, label, probe, stale, classification)
        credit = [r for r in grok_rows if _is_grok_credit_row(r)]
        labels = [r for r in grok_rows if not _is_grok_credit_row(r)]
        if credit and not all_rows:
            lines.append(' '*name_w + '5h' + ' '*8 + '7d')
        if credit:
            emit(credit)
        for name, label, probe, stale, _cls in labels:
            # 5h 칸 너비(~9)에 상태, 7d 칸에 probe 힌트.
            # 순검 결과 나이: 1시간 이상일 때만 (Nm)
            status = label + ' '*max(0, 9 - vw(label))
            probe_cell = probe or ''
            suffix = ''
            if stale is not None and stale >= 60:
                suffix = f" ({stale}m)"
            lines.append(f"{pad(name)}{status} {probe_cell}{suffix}".rstrip())
    lines.append('```')
    return lines


def _pct(value):
    """Quota upstreams already return percentages, including values <= 1."""
    if not isinstance(value, (int, float)):
        return -1
    return max(0, min(100, int(round(value))))


def _jwt_payload(token):
    try:
        part = token.split('.')[1]
        part += '=' * ((4 - len(part) % 4) % 4)
        value = json.loads(base64.urlsafe_b64decode(part))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _codex_account_id(auth_file):
    for box in (auth_file, auth_file.get('metadata') or {}, auth_file.get('attributes') or {}):
        if not isinstance(box, dict):
            continue
        for key in ('account_id', 'chatgpt_account_id', 'chatgptAccountId'):
            if box.get(key):
                return str(box[key])
        claims = _jwt_payload(str(box.get('id_token') or ''))
        auth = claims.get('https://api.openai.com/auth') or claims
        if isinstance(auth, dict):
            for key in ('chatgpt_account_id', 'chatgptAccountId'):
                if auth.get(key):
                    return str(auth[key])
    return ''


def _management_key():
    if os.environ.get('CLIPROXY_MANAGEMENT_KEY'):
        return os.environ['CLIPROXY_MANAGEMENT_KEY']
    op = shutil.which('op')
    if not op:
        raise RuntimeError('op CLI not found')
    result = subprocess.run(
        [op, 'read', CLIPROXY_MANAGEMENT_KEY_REF],
        capture_output=True, text=True, timeout=20)
    key = result.stdout.strip()
    if result.returncode != 0 or not key:
        raise RuntimeError('CLIProxyAPI management key lookup failed')
    return key


def _management_fetch(path, payload=None, key=None):
    key = key or _management_key()
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        CLIPROXY_MANAGEMENT_BASE + path,
        data=data,
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json',
            'User-Agent': UA,
        },
        method='POST' if payload is not None else 'GET')
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def _claude_windows(usage):
    h5 = d7 = None
    limits = usage.get('limits') or []
    if limits:
        for limit in limits:
            kind = limit.get('kind')
            pct = limit.get('used_percent')
            if pct is None:
                pct = limit.get('percent')
            if pct is None:
                pct = limit.get('utilization')
            window = (_pct(pct), limit.get('resets_at') or limit.get('reset_at'))
            if kind in ('session', 'five_hour'):
                h5 = window
            elif kind in ('weekly_all', 'seven_day'):
                d7 = window
    else:
        for key, target in (('five_hour', 'h5'), ('seven_day', 'd7')):
            window = usage.get(key)
            if not window:
                continue
            value = (_pct(window.get('utilization')), window.get('resets_at') or window.get('reset_at'))
            if target == 'h5':
                h5 = value
            else:
                d7 = value
    return h5, d7


def _codex_windows(usage):
    h5 = d7 = None
    rate = usage.get('rate_limit') or {}
    for key in ('primary_window', 'secondary_window'):
        window = rate.get(key)
        if not window:
            continue
        value = (_pct(window.get('used_percent')), window.get('reset_at') or window.get('resets_at'))
        seconds = window.get('limit_window_seconds')
        if isinstance(seconds, (int, float)) and seconds <= 86400:
            h5 = value
        else:
            d7 = value
    return h5, d7


def _codex_plan_hint(auth_file):
    name = str(auth_file.get('name') or '').lower()
    for plan in ('team', 'k12', 'pro', 'plus', 'max', 'free'):
        if name.endswith(f'-{plan}.json'):
            return plan
    return ''


def _quota_capable_auth_files(files):
    available = [f for f in files
                 if not f.get('disabled') and f.get('type') in ('claude', 'codex')
                 and f.get('auth_index')]
    claude = []
    codex = []
    for auth_file in available:
        if auth_file.get('type') == 'claude':
            label = str(auth_file.get('label') or '').lower()
            name = str(auth_file.get('name') or '').lower()
            if label.endswith('@local') or 'onecli-direct' in name:
                continue
            claude.append(auth_file)
        else:
            codex.append(auth_file)
    claude.sort(key=lambda item: item.get('name') or '')
    codex.sort(key=lambda item: (
        _codex_plan_hint(item) in ('team', 'k12'),
        item.get('name') or '',
    ))
    return claude, codex


def collect_cliproxy_quota_rows(warn, fetch=None):
    """Collect subscription quota through CLIProxyAPI without reading OAuth files."""
    if fetch is None:
        management_key = _management_key()

        def live_fetch(path, payload=None):
            return _management_fetch(path, payload, management_key)

        fetch = live_fetch

    files = (fetch('/auth-files') or {}).get('files') or []
    claude_files, codex_files = _quota_capable_auth_files(files)
    targets = [
        ('claude', index, auth_file, '')
        for index, auth_file in enumerate(claude_files, 1)
    ] + [
        ('codex', index, auth_file, _codex_plan_hint(auth_file))
        for index, auth_file in enumerate(codex_files, 1)
    ]
    claude_rows = []
    codex_rows = []

    for provider, index, auth_file, plan_hint in targets:
        row_name = f'Claude{index}' if provider == 'claude' else (
            f"Codex{index}{' ' + plan_hint[:4] if plan_hint else ''}")
        try:
            headers = {'Authorization': 'Bearer $TOKEN$', 'User-Agent': 'aiusage/1'}
            if provider == 'claude':
                url = 'https://api.anthropic.com/api/oauth/usage'
                headers['anthropic-beta'] = 'oauth-2025-04-20'
            else:
                url = 'https://chatgpt.com/backend-api/wham/usage'
                headers['User-Agent'] = 'codex_cli_rs/0.76.0'
                account_id = _codex_account_id(auth_file)
                if account_id:
                    headers['Chatgpt-Account-Id'] = account_id
            response = fetch('/api-call', {
                'auth_index': auth_file['auth_index'],
                'method': 'GET',
                'url': url,
                'header': headers,
            }) or {}
            if response.get('status_code') != 200:
                raise RuntimeError(f"upstream HTTP {response.get('status_code')}")
            usage = json.loads(response.get('body') or '{}')
            if provider == 'claude':
                h5, d7 = _claude_windows(usage)
                if not h5 and not d7:
                    raise ValueError('empty Claude quota response')
                claude_rows.append((
                    row_name,
                    h5[0] if h5 else -1, h5[1] if h5 else '',
                    d7[0] if d7 else -1, d7[1] if d7 else '', None))
            else:
                h5, d7 = _codex_windows(usage)
                if not h5 and not d7:
                    raise ValueError('empty Codex quota response')
                plan = str(usage.get('plan_type') or plan_hint).strip().lower()[:4]
                row_name = f"Codex{index}{' ' + plan if plan else ''}"
                codex_rows.append((
                    row_name,
                    h5[0] if h5 else -1, h5[1] if h5 else '',
                    d7[0] if d7 else -1, d7[1] if d7 else '', None))
                for extra in usage.get('additional_rate_limits') or []:
                    extra_h5, extra_d7 = _codex_windows({
                        'rate_limit': extra.get('rate_limit') or {},
                    })
                    values = [v for v in (extra_h5, extra_d7) if v and v[0] > 0]
                    if not values:
                        continue
                    raw_name = extra.get('limit_name') or '?'
                    extra_name = 'Spark' if 'Spark' in raw_name else raw_name[:6]
                    codex_rows.append((
                        f'{extra_name}{index}',
                        extra_h5[0] if extra_h5 else -1,
                        extra_h5[1] if extra_h5 else '',
                        extra_d7[0] if extra_d7 else -1,
                        extra_d7[1] if extra_d7 else '',
                        None,
                    ))
        except Exception as exc:
            print(
                'cliproxy quota probe failed: '
                f'provider={provider} account={index} '
                f'error={type(exc).__name__} detail={exc}',
                file=sys.stderr,
            )
            row = (row_name, -1, '', -1, '', None)
            if provider == 'claude':
                claude_rows.append(row)
            else:
                codex_rows.append(row)

    _append_quota_warnings(warn, claude_rows, codex_rows)
    return claude_rows, codex_rows


def _append_quota_warnings(warn, claude_rows, codex_rows):
    for name, h5p, _h5r, d7p, _d7r, _stale in claude_rows + codex_rows:
        if h5p >= 80:
            warn.append(f'{name.split()[0]} 5h {h5p}%')
        if d7p >= 80:
            warn.append(f'{name.split()[0]} 7d {d7p}%')


def _write_quota_cache(cache_path, claude_rows, codex_rows, now):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({
        'at': now,
        'claude_rows': claude_rows,
        'codex_rows': codex_rows,
    }, ensure_ascii=False, separators=(',', ':'))
    temporary = cache_path.with_name(f'.{cache_path.name}.{os.getpid()}.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(payload)
        os.replace(temporary, cache_path)
        os.chmod(cache_path, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def _stale_rows(rows, stale_minutes):
    return [tuple(list(row[:5]) + [stale_minutes]) for row in rows]


def _row_key(row):
    return str(row[0]).split()[0]


def _row_missing(row):
    return row[1] < 0 and row[3] < 0


def _merge_cached_rows(live_rows, cached_rows, stale_minutes):
    cached_by_name = {_row_key(row): row for row in cached_rows}
    merged = []
    had_failure = False
    for row in live_rows:
        if not _row_missing(row):
            merged.append(row)
            continue
        had_failure = True
        cached = cached_by_name.get(_row_key(row))
        merged.append(
            tuple(list(cached[:5]) + [stale_minutes]) if cached else row
        )
    return merged, had_failure


def collect_quota_rows(warn, fetch=None, cache_path=QUOTA_CACHE, now=None):
    """Prefer live CLIProxyAPI quota; isolate failures with a secret-free row cache."""
    clock = now or time.time
    warning_count = len(warn)
    try:
        claude_rows, codex_rows = collect_cliproxy_quota_rows(warn, fetch=fetch)
        if not claude_rows and not codex_rows:
            raise RuntimeError('no quota-capable CLIProxyAPI credentials')

        cached_claude = []
        cached_codex = []
        stale = 0
        try:
            with open(cache_path) as stream:
                cached = json.load(stream)
            stale = max(0, int((clock() - float(cached['at'])) // 60))
            cached_claude = cached.get('claude_rows') or []
            cached_codex = cached.get('codex_rows') or []
        except Exception:
            pass

        claude_rows, claude_failed = _merge_cached_rows(
            claude_rows, cached_claude, stale)
        codex_rows, codex_failed = _merge_cached_rows(
            codex_rows, cached_codex, stale)
        del warn[warning_count:]
        _append_quota_warnings(warn, claude_rows, codex_rows)
        if not claude_failed and not codex_failed:
            _write_quota_cache(cache_path, claude_rows, codex_rows, clock())
        return claude_rows, codex_rows
    except Exception:
        del warn[warning_count:]
        try:
            with open(cache_path) as stream:
                cached = json.load(stream)
            stale = max(0, int((clock() - float(cached['at'])) // 60))
            claude_rows = _stale_rows(cached.get('claude_rows') or [], stale)
            codex_rows = _stale_rows(cached.get('codex_rows') or [], stale)
            if not claude_rows and not codex_rows:
                raise ValueError('empty quota cache')
            _append_quota_warnings(warn, claude_rows, codex_rows)
            return claude_rows, codex_rows
        except Exception:
            return (
                [('Claude', -1, '', -1, '', None)],
                [('Codex', -1, '', -1, '', None)],
            )


def _is_grok_credit_row(row):
    """Credit rows mirror Claude/Codex: (name, h5p, h5r, d7p, d7r, stale)."""
    return (
        isinstance(row, (list, tuple))
        and len(row) >= 6
        and isinstance(row[1], int)
        and isinstance(row[3], int)
    )


def _grpc_web_frames(body: bytes):
    msgs = []
    trailers = b''
    i = 0
    while i + 5 <= len(body):
        flags = body[i]
        length = int.from_bytes(body[i + 1:i + 5], 'big')
        i += 5
        chunk = body[i:i + length]
        i += length
        if flags & 0x80:
            trailers = chunk
        else:
            msgs.append(chunk)
    return msgs, trailers.decode('utf-8', 'replace')


def _proto_varint(buf: bytes, i: int):
    shift = 0
    result = 0
    while True:
        if i >= len(buf):
            raise ValueError('truncated varint')
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7
        if shift > 70:
            raise ValueError('varint too long')


def _walk_proto_fields(data: bytes, path: str = ''):
    i = 0
    fields = []
    while i < len(data):
        try:
            key, i = _proto_varint(data, i)
        except Exception:
            break
        field_num = key >> 3
        wire = key & 7
        if wire == 0:
            val, i = _proto_varint(data, i)
            fields.append((path + str(field_num), 'varint', val))
        elif wire == 1:
            if i + 8 > len(data):
                break
            i += 8
        elif wire == 2:
            ln, i = _proto_varint(data, i)
            chunk = data[i:i + ln]
            i += ln
            nested = _walk_proto_fields(chunk, path + str(field_num) + '.')
            if nested:
                fields.append((path + str(field_num), 'message', nested))
        elif wire == 5:
            if i + 4 > len(data):
                break
            raw = data[i:i + 4]
            i += 4
            import struct as _struct
            fields.append((path + str(field_num), 'fixed32', _struct.unpack('<f', raw)[0]))
        else:
            break
    return fields


def parse_grok_credits_protobuf(body: bytes):
    """Parse GetGrokCreditsConfig grpc-web response → used% + resets_at unix.

    Observed schema (wrapper field 1):
      1: float credit_usage_percent (used)
      4: Timestamp period start
      5: Timestamp period end / reset
    """
    msgs, trailers = _grpc_web_frames(body)
    if 'grpc-status:0' not in trailers.replace(' ', '') and trailers:
        # tolerate missing trailer if message present
        if 'grpc-status:' in trailers and 'grpc-status:0' not in trailers:
            raise RuntimeError(f'grok credits grpc error: {trailers[:120]}')
    if not msgs:
        raise RuntimeError('empty grok credits response')
    fields = _walk_proto_fields(msgs[0])
    used = None
    resets_at = None
    period_start = None

    def visit(items):
        nonlocal used, resets_at, period_start
        for p, t, v in items:
            if t == 'fixed32' and p in ('1.1', '1.7.2'):
                if isinstance(v, float) and 0.0 <= v <= 100.0:
                    used = v
            elif t == 'varint' and p in ('1.5.1', '1.8.3.1'):
                if 1_600_000_000 < v < 2_100_000_000:
                    resets_at = v
            elif t == 'varint' and p in ('1.4.1', '1.8.2.1'):
                if 1_600_000_000 < v < 2_100_000_000:
                    period_start = v
            elif t == 'message':
                visit(v)

    visit(fields)
    if used is None:
        raise ValueError('credit_usage_percent missing')
    return {
        'used_percent': _pct(used),
        'resets_at': resets_at,
        'period_start': period_start,
    }


def _probe_grok_credits(access_token, url=GROK_CREDITS_URL, opener=None):
    frame = b'\x00\x00\x00\x00\x00'
    req = urllib.request.Request(
        url,
        data=frame,
        headers={
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/grpc-web+proto',
            'x-grpc-web': '1',
            'accept': '*/*',
            'origin': 'https://grok.com',
            'referer': 'https://grok.com/',
            'User-Agent': 'ejclaw-status/1',
        },
        method='POST')
    open_url = opener or urllib.request.urlopen
    with open_url(req, timeout=20) as response:
        body = response.read()
    return parse_grok_credits_protobuf(body)


def _list_cpa_xai_auth_files(auth_dir=CLIPROXY_AUTH_DIR):
    root = pathlib.Path(auth_dir)
    files = []
    try:
        paths = sorted(root.glob('xai-*.json'))
    except Exception:
        return []
    for path in paths:
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        if data.get('disabled'):
            continue
        if str(data.get('type') or data.get('provider') or '').lower() not in ('xai', 'grok', ''):
            # still accept xai-*.json even if type missing
            if data.get('type') not in (None, '', 'xai'):
                continue
        token = data.get('access_token')
        if not token:
            continue
        files.append({'path': path, 'email': data.get('email') or path.name, 'access_token': token})
    return files


def collect_grok_credit_rows(auth_dir=CLIPROXY_AUTH_DIR, probe=None, cache_path=GROK_CREDITS_CACHE, now=None):
    """Probe SuperGrok weekly credits via CPA xai auth tokens. Secret-free cache."""
    clock = now or time.time
    probe = probe or _probe_grok_credits
    accounts = _list_cpa_xai_auth_files(auth_dir)
    if not accounts:
        return []
    rows = []
    live_ok = False
    for index, account in enumerate(accounts, 1):
        name = f'Grok{index}'
        try:
            usage = probe(account['access_token'])
            rows.append((
                name,
                -1, '',
                usage['used_percent'], usage.get('resets_at') or '',
                None,
            ))
            live_ok = True
        except Exception:
            rows.append((name, -1, '', -1, '', None))
    if live_ok:
        try:
            cache_path = pathlib.Path(cache_path)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({
                'at': clock(),
                'rows': [[r[0], r[1], r[2], r[3], r[4], None] for r in rows],
            }, ensure_ascii=False, separators=(',', ':'))
            temporary = cache_path.with_name(f'.{cache_path.name}.{os.getpid()}.tmp')
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                with os.fdopen(fd, 'w') as stream:
                    stream.write(payload)
                os.replace(temporary, cache_path)
                os.chmod(cache_path, 0o600)
            finally:
                if temporary.exists():
                    temporary.unlink()
        except Exception:
            pass
        # fill missing from cache partial
        try:
            cached = json.loads(pathlib.Path(cache_path).read_text())
            stale = max(0, int((clock() - float(cached['at'])) // 60))
            by_name = {r[0]: r for r in (cached.get('rows') or [])}
            merged = []
            for row in rows:
                if row[3] >= 0:
                    merged.append(row)
                elif row[0] in by_name and by_name[row[0]][3] >= 0:
                    c = by_name[row[0]]
                    merged.append((c[0], c[1], c[2], c[3], c[4], stale))
                else:
                    merged.append(row)
            return merged
        except Exception:
            return rows
    # all failed → cache
    try:
        cached = json.loads(pathlib.Path(cache_path).read_text())
        stale = max(0, int((clock() - float(cached['at'])) // 60))
        cached_rows = cached.get('rows') or []
        if cached_rows:
            return _stale_rows(cached_rows, stale)
    except Exception:
        pass
    return []


def _grok_probe_tag(result):
    """Weak probe-route hint only — not SuperGrok plan name."""
    raw = ''
    em = result.get('error_message')
    if isinstance(em, str) and em.strip().startswith('{'):
        try:
            body = json.loads(em)
            raw = str(body.get('model') or '')
        except Exception:
            raw = ''
    if not raw:
        raw = str(result.get('model') or '')
    raw = raw.strip().lower()
    if not raw:
        return ''
    if 'build-free' in raw:
        return 'build-free'
    if 'build' in raw:
        return 'build'
    if raw.startswith('grok-'):
        return raw.replace('grok-', '', 1)[:12]
    return raw[:12]


def _grok_finished_unix(payload, result_path):
    for key in ('finished_at', 'saved_at', 'started_at'):
        value = payload.get(key)
        if not value:
            continue
        try:
            return datetime.datetime.fromisoformat(
                str(value).replace('Z', '+00:00')).timestamp()
        except Exception:
            pass
    try:
        return result_path.stat().st_mtime
    except Exception:
        return None


def collect_grok_inspection_rows(result_path=GROK_RESULTS, now=None):
    """Read grok-inspection results.json labels. Fallback when credits probe fails."""
    clock = now or time.time
    path = pathlib.Path(result_path)
    try:
        payload = json.loads(path.read_text())
    except Exception:
        return []
    results = payload.get('results') or []
    if not isinstance(results, list) or not results:
        return []
    finished = _grok_finished_unix(payload, path)
    stale = None
    if finished is not None:
        stale = max(0, int((clock() - float(finished)) // 60))
    rows = []
    for index, item in enumerate(results, 1):
        if not isinstance(item, dict):
            continue
        classification = str(item.get('classification') or 'other').strip().lower()
        label = _GROK_LABELS.get(classification, classification or '이상')
        rows.append((
            f'Grok{index}',
            label,
            _grok_probe_tag(item),
            stale,
            classification,
        ))
    return rows


def collect_grok_rows(result_path=GROK_RESULTS, auth_dir=CLIPROXY_AUTH_DIR, now=None, probe=None):
    """Prefer SuperGrok weekly credit %; fall back to inspection status labels."""
    credit_rows = collect_grok_credit_rows(auth_dir=auth_dir, probe=probe, now=now)
    if any(row[3] >= 0 for row in credit_rows):
        return credit_rows
    return collect_grok_inspection_rows(result_path=result_path, now=now)


def render_grok_table(rows):
    """Backward-compatible helper: same fence as usage table, Grok only. """
    return render_usage_table([], [], grok_rows=rows)


# ── 에이전트/서버 블록 (구 status-dashboard 파리티) ──

def _native_route_count(routes_path):
    try:
        routes = json.loads(pathlib.Path(routes_path).read_text()).get('routes') or []
        return len([
            route for route in routes
            if isinstance(route, dict) and route.get('id') != 'native-pilot'
        ])
    except Exception:
        return None


def _native_service_active():
    try:
        result = subprocess.run(
            ['systemctl', '--user', 'is-active', 'claude-native-bridge.service'],
            capture_output=True, text=True, timeout=10)
        return result.returncode == 0 and result.stdout.strip() == 'active'
    except Exception:
        return False


def _heartbeat_stalled(value, now):
    if not value:
        return True
    try:
        heartbeat = datetime.datetime.fromisoformat(
            str(value).replace('Z', '+00:00')).timestamp()
        return now - heartbeat > 45
    except Exception:
        return True


def agent_status_line(
        native_state=NATIVE_CLAUDE_STATE,
        native_routes=NATIVE_CLAUDE_ROUTES,
        service_active=None,
        now=None):
    """Render Native Claude jobs; never infer agent work from Docker rows."""
    state_path = pathlib.Path(native_state)
    if not state_path.exists():
        return None
    groups = _native_route_count(native_routes)
    suffix = f' / {groups}' if groups is not None else ''
    if service_active is None:
        service_active = _native_service_active()
    if not service_active:
        return f'🔴 **에이전트 상태** — runtime 중단{suffix}'

    try:
        connection = sqlite3.connect(f'file:{state_path}?mode=ro', uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT status, heartbeat_at FROM jobs "
            "WHERE status IN ('running','queued','delivering')"
        ).fetchall()
        connection.close()
    except Exception:
        return f'🔴 **에이전트 상태** — 상태 조회 실패{suffix}'

    counts = {
        status: sum(1 for row in rows if row['status'] == status)
        for status in ('running', 'queued', 'delivering')
    }
    clock = now or time.time
    current = float(clock())
    stalled = sum(
        1 for row in rows
        if row['status'] == 'running'
        and _heartbeat_stalled(row['heartbeat_at'], current)
    )
    if not any(counts.values()):
        return f'📊 **에이전트 상태** — 대기{suffix}'

    parts = []
    if counts['running']:
        parts.append(f"실행 {counts['running']}")
    if counts['queued']:
        parts.append(f"대기 {counts['queued']}")
    if counts['delivering']:
        parts.append(f"전달 {counts['delivering']}")
    if stalled:
        parts.append(f'정체 {stalled}')
    icon = '🔴' if stalled else '📊'
    return f"{icon} **에이전트 상태** — {' · '.join(parts)}{suffix}"


def server_block():
    try:
        # CPU%: /proc/stat 2회 샘플
        def cpu_sample():
            f = open('/proc/stat').readline().split()[1:]
            v = list(map(int, f))
            return sum(v), v[3] + (v[4] if len(v) > 4 else 0)
        t1, i1 = cpu_sample(); time.sleep(0.4); t2, i2 = cpu_sample()
        cpu = int(round(100*(1-(i2-i1)/max(1,(t2-t1)))))
        load1 = open('/proc/loadavg').read().split()[0]
        ncpu = os.cpu_count() or 1
        mem = {}
        for l in open('/proc/meminfo'):
            k, v = l.split(':')[0], l.split()[1]
            mem[k] = int(v)
        mt, ma = mem['MemTotal'], mem.get('MemAvailable', 0)
        mem_pct = int(round(100*(mt-ma)/mt))
        used_gb, tot_gb = (mt-ma)/1048576, mt/1048576
        du = shutil.disk_usage('/')
        disk_pct = int(round(100*du.used/du.total))
        up = float(open('/proc/uptime').read().split()[0])
        upd, uph = int(up//86400), int(up%86400//3600)
        lines = ['🖥️ **서버**', '```']
        lines.append(f"CPU     {bar(cpu)} {cpu:3d}%")
        lines.append(f"Load    {load1}/{ncpu}cpu")
        lines.append(f"Memory  {bar(mem_pct)} {mem_pct:3d}%  {used_gb:.1f}/{tot_gb:.1f}GB")
        lines.append(f"Disk    {bar(disk_pct)} {disk_pct:3d}%  {du.used//2**30}/{du.total//2**30}GB")
        lines.append(f"Uptime  {upd}d{uph}h")
        lines.append('```')
        return '\n'.join(lines)
    except Exception:
        return None


def build_content():
    warn = []
    claude_rows, codex_rows = collect_quota_rows(warn)
    grok_rows = collect_grok_rows()
    now = datetime.datetime.now().strftime('%m-%d %H:%M')
    parts = [f"📊 **사용량** · {now}"]
    parts.append("\n".join(render_usage_table(claude_rows, codex_rows, grok_rows)))
    ag = agent_status_line()
    if ag: parts.append(ag)
    sv = server_block()
    if sv: parts.append(sv)
    return "\n".join(parts)


def main():
    tok = get_bot_token()
    if not tok:
        print("NanoClaw .env에서 봇 토큰 읽기 실패"); return
    body = build_content()
    st = {}
    if STATE.exists():
        try: st = json.load(open(STATE))
        except Exception: st = {}
    mid = st.get('message_id')
    hdr = {'Authorization': f'Bot {tok}', 'Content-Type': 'application/json', 'User-Agent': UA}
    payload = json.dumps({'content': body}).encode()
    if mid:
        req = urllib.request.Request(
            f'https://discord.com/api/v10/channels/{CHANNEL_ID}/messages/{mid}',
            data=payload, headers=hdr, method='PATCH')
        try:
            urllib.request.urlopen(req, timeout=15)
            return
        except urllib.error.HTTPError as e:
            if e.code != 404: print(f"편집 실패 HTTP {e.code}"); return
    req = urllib.request.Request(
        f'https://discord.com/api/v10/channels/{CHANNEL_ID}/messages',
        data=payload, headers=hdr, method='POST')
    try:
        d = json.load(urllib.request.urlopen(req, timeout=15))
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        json.dump({'message_id': d['id']}, open(STATE,'w'))
    except urllib.error.HTTPError as e:
        print(f"생성 실패 HTTP {e.code}: {e.read().decode()[:120]}")


if __name__ == '__main__':
    main()
