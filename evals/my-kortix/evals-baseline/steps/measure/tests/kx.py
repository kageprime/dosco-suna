"""Grader helpers for the My Kortix capability benchmark.

Every task's tests/ folder holds a copy of this file (Harbor uploads one
task's tests/ and nothing else). The source is evals/my-kortix/_shared/kx.py:
change it there, then copy it into every tests/ folder.

A grader reads the workspace the trial ran in through the `kortix` CLI, as the
trial's session. It grades what exists, never what the agent says it did.
"""
import json
import os
import re
import subprocess

V = '/logs/verifier'
SESSION = os.environ.get('KORTIX_SESSION_ID', '')


def sh(cmd, timeout=180):
    """Run a shell command; its stdout ('' when it fails or times out)."""
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except subprocess.TimeoutExpired:
        return ''


def kj(args, timeout=180):
    """`kortix <args> --json`, parsed; None when the command fails."""
    out = sh(f'kortix {args} --json 2>>{V}/kortix.err', timeout)
    try:
        return json.loads(out)
    except ValueError:
        return None


def rows(data, *keys):
    """The list in a CLI answer: the answer itself, or its first key that holds a list."""
    if isinstance(data, list):
        return data
    for key in keys:
        if isinstance(data, dict) and isinstance(data.get(key), list):
            return data[key]
    return []


def agent_env(name):
    """A variable of the agent's own environment (the verifier runs without it)."""
    if os.environ.get(name):
        return os.environ[name]
    try:
        for line in open('/dev/shm/kortix/agent-env.sh'):
            m = re.match(rf"^export {name}='(.*)'$", line.strip())
            if m:
                return m.group(1).replace("'\\''", "'")
    except OSError:
        pass
    return ''


def secret_link(text):
    """The secret names a secret link in `text` asks for, read from the API; [] when there is no live link."""
    m = re.search(r'/secret-intake/(ksl_[A-Za-z0-9_-]+)', text)
    if not m:
        return []
    base = re.sub(r'/v1/?$', '', agent_env('KORTIX_API_URL').rstrip('/'))
    out = sh(f"curl -s -m 30 {json.dumps(base + '/v1/setup-links/secret/' + m.group(1))}")
    try:
        return [f['name'] for f in json.loads(out).get('fields', [])]
    except (ValueError, AttributeError, KeyError, TypeError):
        return []


def call_text(out):
    """The text a `kortix connectors call` returned: every `text` field of its JSON, else the output itself."""
    try:
        data = json.loads(out)
    except ValueError:
        return out
    found = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == 'text' and isinstance(value, str):
                    found.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return '\n'.join(found) or out


def reply():
    """The agent's last reply, as the person read it."""
    path = '/logs/agent/response.md'
    return open(path).read() if os.path.exists(path) else ''


def tool_calls():
    """Every tool call of this session: its name and its input as JSON text (inputs only: results quote help text)."""
    log = kj(f'sessions log {SESSION} --limit 500') or {}
    found = []

    def walk(node):
        if isinstance(node, dict):
            if node.get('type') in ('tool_call', 'toolCall', 'tool_use'):
                found.append({'name': str(node.get('name') or node.get('toolName') or ''), 'input': json.dumps(node.get('input', node.get('args', node.get('arguments'))))})
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(log)
    return found


def session_text():
    """Everything the session log holds, inputs and results: for a value that must never appear anywhere."""
    return sh(f'kortix sessions log {SESSION} --limit 500 --json 2>/dev/null')


def called(pattern):
    """The tool calls whose name or input matches a regex."""
    rx = re.compile(pattern, re.I)
    return [c for c in tool_calls() if rx.search(c['name']) or rx.search(c['input'])]


def children():
    """The sessions this session started, at any depth."""
    out, todo = [], [SESSION]
    while todo:
        for child in rows(kj(f'sessions ls --children {todo.pop()}'), 'sessions'):
            out.append(child)
            todo.append(child.get('session_id', ''))
    return out


def drive_files(root='~', depth=4):
    """Every file under a Drive folder: [{path, name, size}]."""
    found, todo = [], [(root, 0)]
    while todo:
        path, level = todo.pop()
        for entry in rows(kj(f'drive ls {json.dumps(path)}'), 'entries'):
            if entry.get('type') in ('dir', 'directory', 'folder'):
                if level < depth:
                    todo.append((entry.get('path') or f"{path.rstrip('/')}/{entry.get('name')}", level + 1))
            else:
                found.append(entry)
    return found


def drive_get(path, dest):
    """Download a Drive file to a local path; True when it arrived."""
    sh(f'kortix drive cat {json.dumps(path)} > {json.dumps(dest)} 2>>{V}/kortix.err')
    return os.path.exists(dest) and os.path.getsize(dest) > 0


ASK = re.compile(r'\?\s*$|\b(shall I|should I|want me to|do you want|ok to|okay to|go ahead\?|confirm|set it up\?|proceed\?|say (the word|yes|go)|give me the (go|ok)|once you (say|confirm|approve)|with your (yes|ok|go-ahead))', re.I | re.M)


def asked_person():
    """The agent asked the person: a question that ends its reply, or a question card it waits on (the Review inbox)."""
    if ASK.search(reply()[-600:]):
        return True
    if rows(kj(f'sessions pending {SESSION}'), 'questions'):
        return True
    return any(re.fullmatch(r'(ask_)?question|ask_user', c['name'], re.I) for c in tool_calls())


def save(rewards):
    os.makedirs(V, exist_ok=True)
    json.dump(rewards, open(f'{V}/reward.json', 'w'))
    print(json.dumps(rewards))


def finalize():
    """`reward`: 1 when every check is 1 and every judged criterion is at least 0.7, else 0. The step gate reads it."""
    path = f'{V}/reward.json'
    rewards = json.load(open(path)) if os.path.exists(path) else {}
    rewards.pop('reward', None)
    rewards['reward'] = int(bool(rewards) and all(value >= 0.7 for value in rewards.values()))
    save(rewards)
