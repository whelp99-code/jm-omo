#!/usr/bin/env python3
"""Recover bots without a person: canonical launchers, occupied terminals preserved.

Only restart authority. No task takeover, no replay, no resend of an uncertain alert.
"""
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
HERDR = Path.home() / '.local/bin/herdr'
STATE = ROOT / 'recovery-health.json'
EVENTS = ROOT / 'recovery-events.jsonl'
PROC = Path('/proc')
CGROUP = Path('/sys/fs/cgroup')
BUN = Path.home() / '.bun/bin/bun'
SYSTEMCTL = '/usr/bin/systemctl'
SESSIONS = Path.home() / '.omo/agent/sessions'
ALERT_CHANNEL = 'C0C6HJM0BV5'  # Gajaeway answers every Omonyang post in C0C5Z4SJ309 (engagement: open)
ALERT_THREAD = '1791862782.427319'  # existing thread self-unpause.sh already alerts in
OWNER_MENTION = '<@U0B833NMP5J>'
CONFIRM_TICKS = 2       # a deliberate restart gets one timer interval before we act
MAX_ATTEMPTS = 3
CRASH_WINDOW = 1800
LOOP_QUIET = 300
VERIFY_TIMEOUT = 600
RESUME_WINDOW = 900
WAKE_AFTER = 60
MAX_RESUMES = 3
RECEIVER_TICKS = 3
BLOCKED_SCREEN = re.compile(r'Trust project folder|Paste the code|No API key found')
WAKE_TEXT = ('자동 복구 안내: 세션이 재시작됐습니다. 체크포인트 NEXT_ACTION대로 이어가세요. '
             '끊긴 전송은 재전송하지 말고 영수증으로 대조하세요. 이 안내는 새 승인이 아닙니다.')

OMONYANG = {'id': 'omonyang', 'name': '오모냥', 'kind': 'pane', 'workspace': '오모냥', 'tab': '오모냥-runtime',
            'sessions': '--home-jm-.omo-omonyang--', 'receiver': 'slack-listen.mjs', 'wake': False}
DORI = {'id': 'dori', 'name': '도리', 'kind': 'pane', 'workspace': '도리', 'tab': None,
        'cwd': '/home/jm/.dori', 'session': None,  # resolved per run; a fixed id is stale within hours,
        'sessions': '--home-jm-.dori--', 'lock': '/home/jm/.dori/runtime-launch.lock',
        'launch': 'bash /home/jm/.dori/scripts/start-runtime.sh', 'receiver': 'dori-slack-watch.ts', 'wake': True}
GAJAEWAY_DIST = Path.home() / '.local/share/gajaegun/gajaeway/stage-gajae-runtime-upgrade-1792374995/candidate-v0.3.2-gajaegun/dist/gajaeway'
HERDR_BOT = {'id': 'herdr', 'name': 'herdr', 'kind': 'service', 'units': ['herdr.service']}
GAJAEWAY = {'id': 'gajaeway', 'name': 'Gajaeway', 'kind': 'service',
            'units': ['gajaeway-broker.service', 'gajaeway-gateway.service', 'gajaeway-adapter-slack.service'],
            'viewer': {'workspace': '가재군', 'tab': '가재 봇',
                       'command': f'export HOME=/home/jm GAJAEWAY_HOME=/home/jm/.gajaegun/gajaeway GJC_SDK_BROKER_AUTOSTART=0; {GAJAEWAY_DIST} chat'}}
DINO = {'id': 'dino', 'name': '디노봇', 'kind': 'service', 'units': ['dinobot.service'],
        'viewer': {'workspace': '디노봇', 'tab': None,
                   'command': 'systemctl --user is-active --quiet dinobot.service && /home/jm/.local/bin/dinobot tui --config /home/jm/.config/dinobot/migrated-20261024.yaml --resume'}}
BOTS = [HERDR_BOT, OMONYANG, DORI, GAJAEWAY, DINO]

def _live_dori_session():
    import json as _json
    import subprocess as _sp
    try:
        r = _sp.run(["/home/jm/.bun/bin/bun",
                     "/home/jm/.bun/install/global/node_modules/omo-ai/bin/omo.js",
                     "host", "session", "list", "--json"],
                    capture_output=True, text=True, timeout=45)
    except (OSError, _sp.SubprocessError):
        return None
    out = r.stdout or ""
    start = out.find("{")
    if start < 0:
        return None
    try:
        doc = _json.loads(out[start:])
    except ValueError:
        return None
    if doc.get("action") == "error":
        return None
    for row in doc.get("sessions") or []:
        if (row.get("cwd") or "").rstrip("/").endswith(".dori"):
            return row.get("durableSessionId")
    return None

def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)

def event(kind, **details):
    with EVENTS.open('a') as stream:
        stream.write(json.dumps({'at': time.time(), 'event': kind, **details}, ensure_ascii=False) + '\n')
    EVENTS.chmod(0o600)

def previous_state():
    try:
        value = json.loads(STATE.read_text())
        if not isinstance(value, dict):
            raise ValueError('health state must be an object')
        return value
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, ValueError):
        event('recovery_error', error='corrupt health state; rebuilding')
        return {}

def is_runtime(args, session):
    """The session's engine process: not its flock wrapper, not a `-p` memory or task child."""
    if not args or Path(args[0]).name == 'flock' or '-p' in args:
        return False
    if not any(arg.endswith('/senpi/dist/bundle/cli.js') for arg in args):
        return False
    if '--session-id' in args and args[args.index('--session-id') + 1:args.index('--session-id') + 2] == [session]:
        return True
    return '--session' in args and any(session in arg for arg in args[args.index('--session') + 1:args.index('--session') + 2])

def runtime_pids(session):
    found = []
    for path in PROC.iterdir():
        if not path.name.isdigit():
            continue
        try:
            args = (path / 'cmdline').read_bytes().decode().split('\0')
            if not is_runtime(args, session):
                continue
            stat = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if stat[0] != 'Z':
                found.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            raise RuntimeError('process inspection denied; refusing to assume runtime absent')
    return found

def receiver_running(name):
    for path in PROC.iterdir():
        if not path.name.isdigit():
            continue
        try:
            if any(arg.endswith(name) for arg in (path / 'cmdline').read_bytes().decode().split('\0')):
                return True
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return False

class Herdr:
    def call(self, *args):
        result = subprocess.run([str(HERDR), *args], capture_output=True, text=True, timeout=12)
        if result.returncode:
            raise RuntimeError('Herdr command failed: ' + ' '.join(args[:2]))
        if not result.stdout.strip():
            raise RuntimeError('Herdr returned empty JSON: ' + ' '.join(args[:2]))
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError('Herdr returned invalid JSON') from exc
        if 'result' not in data or 'error' in data:
            raise RuntimeError('Herdr returned an error')
        return data['result']

    def start(self, pane, command=None):
        # pane run intentionally has an empty success response.
        result = subprocess.run([str(HERDR), 'pane', 'run', pane,
                                 command or 'bash ' + str(ROOT / 'recovery-20261004/run-isolated.sh')],
                                capture_output=True, text=True, timeout=12)
        if result.returncode:
            raise RuntimeError('Herdr runtime launch failed')

    def read(self, pane):
        result = subprocess.run([str(HERDR), 'pane', 'read', pane, '--source', 'visible'],
                                capture_output=True, text=True, timeout=12)
        if result.returncode:
            raise RuntimeError('Herdr pane read failed')
        return result.stdout

    def send(self, pane, text):
        for args in (['send-text', pane, text], ['send-keys', pane, 'Enter']):
            result = subprocess.run([str(HERDR), 'pane', *args], capture_output=True, text=True, timeout=12)
            if result.returncode:
                raise RuntimeError('Herdr pane input failed')

def shell_only(api, pane_id):
    info = api.call('pane', 'process-info', '--pane', pane_id)['process_info']
    foreground = info.get('foreground_processes', [])
    return bool(foreground) and all(p['pid'] == info['shell_pid'] and p.get('name') in ('bash', 'zsh', 'fish')
                                    for p in foreground)

def choose_pane(api, bot=OMONYANG):
    cwd = bot.get('cwd') or str(ROOT)
    matches = [w for w in api.call('workspace', 'list')['workspaces'] if w.get('label') == bot['workspace']]
    if len(matches) > 1:
        raise RuntimeError('ambiguous ' + bot['workspace'] + ' workspace')
    if matches:
        workspace = matches[0]['workspace_id']
    else:
        workspace = api.call('workspace', 'create', '--cwd', cwd, '--label', bot['workspace'],
                             '--no-focus')['workspace']['workspace_id']
    tabs = api.call('tab', 'list', '--workspace', workspace)['tabs']
    allowed = {t['tab_id'] for t in tabs if bot['tab'] is None or t.get('label') == bot['tab']}
    panes = api.call('pane', 'list', '--workspace', workspace)['panes']
    candidates = [p for p in panes if p.get('tab_id') in allowed and p.get('cwd') == cwd]
    for pane in candidates:
        if shell_only(api, pane['pane_id']):
            return pane['pane_id']
    if candidates:
        raise RuntimeError('runtime tab occupied or foreground unknown; refusing to send input')
    return api.call('tab', 'create', '--workspace', workspace, '--cwd', cwd,
                    '--label', bot['tab'] or bot['workspace'], '--no-focus')['root_pane']['pane_id']

def memory_health(previous):
    values = {}
    for line in (PROC / 'meminfo').read_text().splitlines():
        fields = line.split()
        if fields[0] in ('MemTotal:', 'MemAvailable:', 'SwapTotal:', 'SwapFree:'):
            values[fields[0][:-1]] = int(fields[1])
    pressure = values['MemAvailable'] < max(1024 * 1024, values['MemTotal'] // 10)
    strikes = previous.get('memory', {}).get('consecutive_low', 0) + 1 if pressure else 0
    old = previous.get('memory', {}).get('warning', False)
    warning = pressure and (old or strikes >= 3)
    if warning and not old:
        event('memory_pressure', available_mb=values['MemAvailable'] // 1024,
              total_mb=values['MemTotal'] // 1024)
    elif old and not pressure:
        event('memory_pressure_cleared')
    return {**values, 'consecutive_low': strikes, 'warning': warning}

def runtime_resources(pid, previous):
    lines = (PROC / str(pid) / 'cgroup').read_text().splitlines()
    groups = [line.split(':', 2)[2] for line in lines if line.startswith('0::')]
    if not groups:
        return {}
    group = CGROUP / groups[0].lstrip('/')
    counters = dict((name, int(value)) for name, value in
                    (line.split() for line in (group / 'memory.events').read_text().splitlines()))
    old = previous.get('resources', {}).get('oom_kill')
    if old is not None and counters.get('oom_kill', 0) > old:
        event('oom_kill_observed', delta=counters['oom_kill'] - old)
    return {'oom_kill': counters.get('oom_kill', 0),
            'memory_current_bytes': int((group / 'memory.current').read_text())}

def recover(api, previous, session, bot=OMONYANG):
    pids = runtime_pids(session)
    if len(pids) > 1:
        raise RuntimeError('multiple runtimes present; refusing automatic changes')
    if pids:
        return {'status': 'running', 'runtime_pid': pids[0], 'pane': previous.get('pane')}
    lock_path = Path(bot['lock']) if bot.get('lock') else ROOT / 'recovery-20261004/omonyang-runtime.lock'
    with lock_path.open('a') as runtime_lock:
        try:
            fcntl.flock(runtime_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('runtime lock held; refusing duplicate launch')
    pane = choose_pane(api, bot) if bot is not OMONYANG else choose_pane(api)
    pids = runtime_pids(session)
    if pids:
        return {'status': 'running', 'runtime_pid': pids[0], 'pane': pane}
    if bot.get('launch'):
        api.start(pane, bot['launch'])
    else:
        api.start(pane)
    for _ in range(15):
        pids = runtime_pids(session)
        if len(pids) == 1:
            event('runtime_recovered', pane=pane, runtime_pid=pids[0], bot=bot['id'])
            return {'status': 'recovered', 'runtime_pid': pids[0], 'pane': pane}
        if len(pids) > 1:
            raise RuntimeError('multiple runtimes after launch')
        time.sleep(1)
    raise RuntimeError('runtime did not start; next timer run will retry')

def clock(now):
    return datetime.fromtimestamp(now).strftime('%H:%M:%S')

def session_view(bot, session):
    """Latest pause state and assistant time from the tail of the session log."""
    view = {'paused': False, 'assistant_at': 0.0, 'state': None}
    matches = sorted((SESSIONS / bot['sessions']).glob(f'*{session}.jsonl'))
    if not matches:
        return view
    with matches[-1].open('rb') as stream:
        size = stream.seek(0, os.SEEK_END)
        stream.seek(max(0, size - 3_000_000))
        lines = stream.read().decode('utf-8', 'ignore').splitlines()[1:]
    for line in lines:
        if '"session-lifecycle"' not in line and '"assistant"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get('customType') == 'session-lifecycle':
            view['paused'] = bool(entry['data'].get('runPaused'))
            view['state'] = entry['data'].get('state')
        elif entry.get('type') == 'message' and entry['message'].get('role') == 'assistant':
            view['assistant_at'] = datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00')).timestamp()
    return view

def input_empty(screen):
    prompts = [line.strip() for line in screen.splitlines() if line.lstrip().startswith('❯')]
    return bool(prompts) and prompts[-1] == '❯'

def runtime_pane(api, pid):
    for pane in api.call('pane', 'list')['panes']:
        info = api.call('pane', 'process-info', '--pane', pane['pane_id'])['process_info']
        if any(p['pid'] == pid for p in info.get('foreground_processes', [])):
            return pane['pane_id']
    return None

def escalate(bot, s, alerts, now, why, need):
    if s.get('escalated_for') != why:
        s['escalated_for'] = why
        alerts.append((bot['id'], 'escalated', f'{OWNER_MENTION} [자동 복구] {bot["name"]}: {why}. '
                       f'자동 재시작은 멈췄습니다. {need} ({clock(now)})'))
    s['status'] = 'escalated'

def mark_up(bot, s, alerts, now):
    if s.get('down_since'):
        alerts.append((bot['id'], 'recovered', f'[자동 복구] {bot["name"]} 복구됨. 응답을 확인했습니다. '
                       f'(멈춤 감지 {clock(s["down_since"])}, 복구 {clock(now)})'))
    s.update(status='up', attempts=0, down_count=0, down_since=None, restart_at=None, escalated_for=None,
             resumes=0, wake_sent=False, tick_error=None)

def tick_pane(api, bot, s, alerts, now, session):
    if (ROOT / f'recovery-{bot["id"]}.disabled').exists():
        s.update(status='disabled', down_count=0)
        return
    pids = runtime_pids(session)
    if len(pids) > 1:
        escalate(bot, s, alerts, now, '실행 중인 세션이 2개 이상입니다', '하나만 남기도록 확인이 필요합니다.')
        s['status'] = 'conflict'
        return
    if pids:
        s['down_count'] = 0
        s['pid'] = pids[0]
        if s.get('status') == 'disabled':
            s['status'] = 'up'
        if s.get('status') in ('down', 'escalated', 'conflict') and not s.get('restart_at'):
            s['restart_at'] = now
            s['status'] = 'verifying'
        if s.get('restart_at'):
            verify_pane(api, bot, s, alerts, now, session)
        elif s.get('status') != 'up':
            s['status'] = 'up'
        check_receiver(bot, s, alerts, now)
        return
    # No runtime.
    s['pid'] = None
    if s.get('status') == 'escalated':
        return
    s['down_count'] = s.get('down_count', 0) + 1
    if s['down_count'] < CONFIRM_TICKS:
        return
    restarts = [t for t in s.get('restart_times', []) if now - t < CRASH_WINDOW]
    s['restart_times'] = restarts
    if len(restarts) >= MAX_ATTEMPTS:
        escalate(bot, s, alerts, now, f'{CRASH_WINDOW // 60}분 사이 {len(restarts)}번 재시작 후에도 다시 멈췄습니다',
                 '반복 원인 확인이 필요합니다.')
        return
    if s.get('attempts', 0) >= MAX_ATTEMPTS:
        escalate(bot, s, alerts, now, f'재시작 {s["attempts"]}회 실패', f'마지막 오류: {s.get("tick_error")}.')
        return
    if not s.get('down_since'):
        s['down_since'] = now
        alerts.append((bot['id'], 'down', f'[자동 복구] {bot["name"]} 멈춤 감지. 표준 실행 방법으로 재시작합니다. ({clock(now)})'))
    s['status'] = 'down'
    s['attempts'] = s.get('attempts', 0) + 1
    result = recover(api, s, session, bot) if bot is not OMONYANG else recover(api, s, session)
    s.update(pane=result.get('pane'), pid=result.get('runtime_pid'), restart_at=now, status='verifying',
             resumes=0, wake_sent=False, tick_error=None)
    s['restart_times'] = restarts + [now]

def verify_pane(api, bot, s, alerts, now, session):
    pane = s.get('pane')
    if not pane or not any(p['pane_id'] == pane for p in api.call('pane', 'list')['panes']):
        pane = runtime_pane(api, s['pid'])
        s['pane'] = pane
    screen = api.read(pane) if pane else ''
    if BLOCKED_SCREEN.search(screen):
        escalate(bot, s, alerts, now, '시작 화면이 사람 입력을 기다립니다', f'{pane} 화면 확인이 필요합니다.')
        return
    view = session_view(bot, session)
    if view['assistant_at'] > s['restart_at'] and not view['paused']:
        mark_up(bot, s, alerts, now)
        return
    if pane and now - s['restart_at'] < RESUME_WINDOW:
        if view['paused']:
            if s.get('resumes', 0) < MAX_RESUMES and input_empty(screen):
                api.send(pane, '/resume')
                s['resumes'] = s.get('resumes', 0) + 1
            return
        if (bot['wake'] and not s.get('wake_sent') and now - s['restart_at'] >= WAKE_AFTER
                and 'esc to interrupt' not in screen and input_empty(screen)):
            api.send(pane, WAKE_TEXT)
            s['wake_sent'] = True
            return
    if now - s['restart_at'] > VERIFY_TIMEOUT:
        escalate(bot, s, alerts, now, '프로세스는 떴지만 응답을 확인하지 못했습니다', f'{pane} 화면 확인이 필요합니다.')
        s['status'] = 'verifying'

def check_receiver(bot, s, alerts, now):
    if s.get('status') != 'up' or not bot.get('receiver'):
        return
    if receiver_running(bot['receiver']):
        if s.get('receiver_missing', 0) >= RECEIVER_TICKS:
            alerts.append((bot['id'], 'receiver-back', f'[자동 복구] {bot["name"]} Slack 수신기 복귀. ({clock(now)})'))
        s['receiver_missing'] = 0
        return
    s['receiver_missing'] = s.get('receiver_missing', 0) + 1
    if s['receiver_missing'] == RECEIVER_TICKS:
        alerts.append((bot['id'], 'receiver-missing', f'{OWNER_MENTION} [자동 복구] {bot["name"]}는 떠 있지만 '
                       f'Slack 수신기가 없습니다. 재시작하지 않았고 확인이 필요합니다. ({clock(now)})'))

def service_states(units):
    result = subprocess.run([SYSTEMCTL, '--user', 'is-active', *units], capture_output=True, text=True, timeout=12)
    return dict(zip(units, result.stdout.split()))

def service_restart_count(units):
    result = subprocess.run([SYSTEMCTL, '--user', 'show', *units, '-p', 'NRestarts', '--value'],
                            capture_output=True, text=True, timeout=12)
    return sum(int(line) for line in result.stdout.split() if line.isdigit())

def crash_looping(bot, s, alerts, now, all_active):
    """systemd restarts a crashing unit by itself, so 'active' alone can hide a loop."""
    count = service_restart_count(bot['units'])
    previous = s.get('restart_count')
    s['restart_count'] = count
    events = [t for t in s.get('restart_events', []) if now - t < CRASH_WINDOW]
    if previous is not None and count > previous:
        events += [now] * min(count - previous, MAX_ATTEMPTS)
    s['restart_events'] = events
    if len(events) < MAX_ATTEMPTS:
        return False
    if all_active and now - events[-1] >= LOOP_QUIET:
        s['restart_events'] = []
        mark_up(bot, s, alerts, now)
        return True
    if s.get('status') != 'crash-loop':
        s['down_since'] = s.get('down_since') or now
        escalate(bot, s, alerts, now, f'{CRASH_WINDOW // 60}분 사이 {len(events)}번 이상 죽고 다시 뜨기를 반복합니다',
                 f'{bot["units"][0]} 로그 확인이 필요합니다.')
        s['status'] = 'crash-loop'
    return True

def service_start(unit):
    subprocess.run([SYSTEMCTL, '--user', 'reset-failed', unit], capture_output=True, text=True, timeout=12)
    result = subprocess.run([SYSTEMCTL, '--user', 'start', '--no-block', unit], capture_output=True, text=True, timeout=12)
    if result.returncode:
        raise RuntimeError(f'{unit} start failed: {result.stderr.strip()[:120]}')

def tick_service(bot, s, alerts, now):
    if (ROOT / f'recovery-{bot["id"]}.disabled').exists():
        s.update(status='disabled', down_count=0)
        return
    states = service_states(bot['units'])
    if len(states) != len(bot['units']):
        raise RuntimeError('unit state unknown')
    down = [unit for unit, state in states.items() if state not in ('active', 'activating', 'reloading')]
    if crash_looping(bot, s, alerts, now, all(state == 'active' for state in states.values())):
        return
    if not down:
        if all(state == 'active' for state in states.values()):
            mark_up(bot, s, alerts, now)
        return
    if s.get('status') == 'escalated':
        return
    s['down_count'] = s.get('down_count', 0) + 1
    if s['down_count'] < CONFIRM_TICKS:
        return
    restarts = [t for t in s.get('restart_times', []) if now - t < CRASH_WINDOW]
    s['restart_times'] = restarts
    if s.get('attempts', 0) >= MAX_ATTEMPTS or len(restarts) >= MAX_ATTEMPTS:
        escalate(bot, s, alerts, now, f'재시작 {MAX_ATTEMPTS}회로 복구되지 않았습니다 ({", ".join(down)})', '원인 확인이 필요합니다.')
        return
    if not s.get('down_since'):
        s['down_since'] = now
        alerts.append((bot['id'], 'down', f'[자동 복구] {bot["name"]} 멈춤 감지({", ".join(down)}). 재시작합니다. ({clock(now)})'))
    s['status'] = 'down'
    s['attempts'] = s.get('attempts', 0) + 1
    s['restart_times'] = restarts + [now]
    for unit in down:
        service_start(unit)

def restore_viewer(api, bot, s):
    """Reopen a status view only after a herdr restart emptied it; a busy pane is never touched."""
    viewer = bot['viewer']
    matches = [w for w in api.call('workspace', 'list')['workspaces'] if w.get('label') == viewer['workspace']]
    if len(matches) != 1:
        s['viewer_pending'] = False
        event('viewer_skipped', bot=bot['id'], reason='workspace')
        return
    workspace = matches[0]['workspace_id']
    tabs = api.call('tab', 'list', '--workspace', workspace)['tabs']
    allowed = {t['tab_id'] for t in tabs if viewer['tab'] is None or t.get('label') == viewer['tab']}
    panes = [p for p in api.call('pane', 'list', '--workspace', workspace)['panes'] if p.get('tab_id') in allowed]
    s['viewer_pending'] = False
    if panes and shell_only(api, panes[0]['pane_id']):
        api.start(panes[0]['pane_id'], viewer['command'])
        event('viewer_restored', bot=bot['id'], pane=panes[0]['pane_id'])
    else:
        event('viewer_skipped', bot=bot['id'], reason='occupied or missing')

def herdr_main_pid():
    result = subprocess.run([SYSTEMCTL, '--user', 'show', 'herdr.service', '-p', 'MainPID', '--value'],
                            capture_output=True, text=True, timeout=12)
    return result.stdout.strip()

def post_alert(text):
    """One attempt per state change. A failed or uncertain post is logged, never retried."""
    try:
        result = subprocess.run([str(BUN), '.omo/slackpost.mjs', '--unlinked', ALERT_CHANNEL, ALERT_THREAD, text,
                                 '--purpose', 'progress', '--delivery', 'verified'],
                                cwd=str(ROOT), capture_output=True, text=True, timeout=25)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

def tick_all(api, previous, now):
    bots = previous.get('bots', {})
    alerts = []
    herdr_pid = herdr_main_pid()
    restarted = previous.get('herdr_pid') not in (None, herdr_pid)
    errors = []
    for bot in BOTS:
        s = bots.setdefault(bot['id'], {'status': 'up'})
        try:
            if bot['kind'] == 'service':
                tick_service(bot, s, alerts, now)
                if bot.get('viewer'):
                    if restarted:
                        s['viewer_pending'] = True
                    if s.get('viewer_pending') and s.get('status') == 'up':
                        restore_viewer(api, bot, s)
            else:
                session = (_live_dori_session() if bot.get('id') == 'dori' else None) or bot.get('session') or (ROOT / 'session-id').read_text().strip()
                tick_pane(api, bot, s, alerts, now, session)
        except (RuntimeError, OSError, subprocess.TimeoutExpired, KeyError, ValueError) as exc:
            s['tick_error'] = str(exc)
            if s.get('reported_error') != str(exc):
                event('recovery_error', bot=bot['id'], error=str(exc))
                s['reported_error'] = str(exc)
            errors.append(f'{bot["id"]}: {exc}')
    return {'bots': bots, 'herdr_pid': herdr_pid, 'errors': errors}, alerts

def main():
    os.umask(0o077)
    with (ROOT / 'recovery-launch.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        previous = previous_state()
        if (ROOT / 'recovery.disabled').exists():
            write_json(STATE, {**previous, 'status': 'paused', 'checked_at': time.time()})
            return 0
        now = time.time()
        result = {'checked_at': now, 'session_id': (ROOT / 'session-id').read_text().strip(),
                  'resources': previous.get('resources', {}), 'memory': previous.get('memory', {})}
        alerts = []
        try:
            result['memory'] = memory_health(previous)
            ticked, alerts = tick_all(Herdr(), previous, now)
            result.update(ticked)
            primary = ticked['bots'].get('omonyang', {})
            result['status'] = 'running' if primary.get('status') == 'up' else primary.get('status')
            if primary.get('pid'):
                result['runtime_pid'] = primary['pid']
                result['resources'] = runtime_resources(primary['pid'], previous)
        except (RuntimeError, OSError, subprocess.TimeoutExpired, KeyError, ValueError) as exc:
            result.update(status='error', error=str(exc), bots=previous.get('bots', {}))
            if previous.get('error') != result['error']:
                event('recovery_error', error=result['error'])
            write_json(STATE, result)
            print(result['error'], file=sys.stderr)
            return 1
        # State first: a crash after this point can lose an alert but can never repeat one.
        write_json(STATE, result)
        for bot_id, kind, text in alerts:
            delivered = post_alert(text)
            event('alert' if delivered else 'alert_uncertain', bot=bot_id, alert=kind)
        if result['errors']:
            print('; '.join(result['errors']), file=sys.stderr)
            return 1
        return 0

if __name__ == '__main__':
    sys.exit(main())
