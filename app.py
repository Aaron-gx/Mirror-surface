"""
人物蒸馏对话系统 - 主应用
"""
import os
import json
import sqlite3
import hashlib
import hmac
import base64
import secrets
import time
from pathlib import Path
from datetime import datetime, timedelta
import threading
import shutil
import uuid
from functools import wraps
from flask import Flask, render_template, request, jsonify, Response, redirect, session, make_response
from flask_cors import CORS
from dotenv import load_dotenv
import anthropic
import requests as http_requests
from openai import OpenAI
import sys
import re

sys.path.insert(0, str(Path(__file__).parent))
from web_search import search as mimo_search, format_result as mimo_format

load_dotenv()

app = Flask(__name__, static_folder='static', static_url_path='/static')
CORS(app, supports_credentials=True)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
app.secret_key = os.getenv('SECRET_KEY', 'mirror-dev-secret')

ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')
MIMO_API_KEY = os.getenv('MIMO_API_KEY')
DB_PATH = 'chat_history.db'
CONFIG_PATH = 'user_config.json'
DISTILL_PROGRESS_PATH = 'distill_progress.json'
SKILLS_DIR = Path('.agents/skills/huashu-nuwa/examples')

SSO_SHARED_SECRET = os.getenv('FUNPROMOTION_SSO_SHARED_SECRET', '')
SSO_URL = os.getenv('FUNPROMOTION_SSO_URL', '')
PUBLIC_URL = os.getenv('PUBLIC_URL', '')
SESSION_TTL_DAYS = 7
SESSION_COOKIE_NAME = 'mirror_session'

distill_lock = threading.Lock()
distill_thread = None


def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        user_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        sso_id TEXT,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    try:
        c.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0')
    except Exception:
        pass
    try:
        c.execute('ALTER TABLE conversations ADD COLUMN user_id INTEGER')
    except Exception:
        pass
    try:
        c.execute('ALTER TABLE scenario_sessions ADD COLUMN user_id INTEGER')
    except Exception:
        pass
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS scenario_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        topic TEXT,
        pro_position TEXT,
        con_position TEXT,
        participants TEXT NOT NULL,
        pro_side TEXT,
        con_side TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS scenario_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        round_number INTEGER NOT NULL,
        stage TEXT,
        character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        side TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES scenario_sessions(id) ON DELETE CASCADE
    )''')
    conn.commit()
    conn.close()


# --- Auth helpers ---

def hash_password(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def verify_password(password, password_hash):
    return hash_password(password) == password_hash

def create_session(user_id):
    token = secrets.token_hex(48)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    expires = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).isoformat()
    c.execute('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', (token, user_id, expires))
    conn.commit()
    conn.close()
    return token

def get_current_user(req):
    token = req.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT user_id, expires_at FROM sessions WHERE token = ?', (token,))
    row = c.fetchone()
    if not row:
        conn.close()
        return None
    user_id, expires_at = row
    if datetime.utcnow().isoformat() > expires_at:
        c.execute('DELETE FROM sessions WHERE token = ?', (token,))
        conn.commit()
        conn.close()
        return None
    c.execute('SELECT id, username, display_name, sso_id, is_admin FROM users WHERE id = ?', (user_id,))
    user = c.fetchone()
    conn.close()
    if not user:
        return None
    return {'id': user[0], 'username': user[1], 'display_name': user[2], 'sso_id': user[3], 'is_admin': bool(user[4])}

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user(request)
        if not user:
            return jsonify({'error': '未登录'}), 401
        request.current_user = user
        return f(*args, **kwargs)
    return decorated

def set_session_cookie(response, token):
    response.set_cookie(SESSION_COOKIE_NAME, token, max_age=SESSION_TTL_DAYS * 86400, httponly=True, samesite='Lax', path='/')

def clear_session_cookie(response):
    response.set_cookie(SESSION_COOKIE_NAME, '', max_age=0, path='/')


# --- Auth routes ---

@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    if get_setting('password_login_disabled', '0') == '1':
        return jsonify({'error': '已禁用账号密码注册'}), 403
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()
    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400
    if len(username) < 2 or len(username) > 32:
        return jsonify({'error': '用户名长度 2-32 个字符'}), 400
    if len(password) < 4:
        return jsonify({'error': '密码至少 4 个字符'}), 400
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT id FROM users WHERE username = ?', (username,))
    if c.fetchone():
        conn.close()
        return jsonify({'error': '用户名已存在'}), 409
    c.execute('SELECT COUNT(*) FROM users')
    is_first = c.fetchone()[0] == 0
    pw_hash = hash_password(password)
    c.execute('INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)',
              (username, pw_hash, username, 1 if is_first else 0))
    user_id = c.lastrowid
    conn.commit()
    conn.close()
    token = create_session(user_id)
    resp = jsonify({'ok': True, 'user': {'id': user_id, 'username': username, 'display_name': username, 'is_admin': is_first}})
    set_session_cookie(resp, token)
    return resp

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    if get_setting('password_login_disabled', '0') == '1':
        return jsonify({'error': '已禁用账号密码登录，请使用 SSO 登录'}), 403
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()
    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT id, username, password_hash, display_name FROM users WHERE username = ?', (username,))
    row = c.fetchone()
    conn.close()
    if not row or not verify_password(password, row[2]):
        return jsonify({'error': '用户名或密码错误'}), 401
    user_id, uname, pw_hash, display = row
    token = create_session(user_id)
    resp = jsonify({'ok': True, 'user': {'id': user_id, 'username': uname, 'display_name': display or uname}})
    set_session_cookie(resp, token)
    return resp

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        conn = sqlite3.connect(DB_PATH)
        conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
        conn.commit()
        conn.close()
    resp = jsonify({'ok': True})
    clear_session_cookie(resp)
    return resp

@app.route('/api/auth/public-settings', methods=['GET'])
def auth_public_settings():
    return jsonify({
        'password_login_disabled': get_setting('password_login_disabled', '0') == '1',
        'sso_enabled': bool(SSO_URL and SSO_SHARED_SECRET)
    })

@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    user = get_current_user(request)
    if not user:
        return jsonify({'error': '未登录'}), 401
    return jsonify({'user': user})


# --- SSO routes ---

@app.route('/sso/login')
def sso_login():
    if not SSO_URL or not SSO_SHARED_SECRET:
        return jsonify({'error': 'SSO 未配置'}), 500
    state = secrets.token_hex(16)
    session['sso_state'] = state
    # 管理面板绑定模式
    bind_user_id = request.args.get('bind_user_id', '')
    if bind_user_id:
        session['sso_bind_user_id'] = int(bind_user_id)
    callback_url = (PUBLIC_URL.rstrip('/') if PUBLIC_URL else request.host_url.rstrip('/')) + '/sso/callback'
    authorize_url = f'{SSO_URL}/#/sso/authorize?redirect_uri={callback_url}&state={state}&client_name=镜面'
    return redirect(authorize_url)

@app.route('/sso/callback')
def sso_callback():
    payload_b64 = request.args.get('payload', '')
    sig = request.args.get('sig', '')
    state = request.args.get('state', '')
    saved_state = session.pop('sso_state', '')
    if not state or state != saved_state:
        return redirect('/?sso_error=state_mismatch')
    try:
        expected_sig = base64.urlsafe_b64encode(
            hmac.new(SSO_SHARED_SECRET.encode('utf-8'), payload_b64.encode('utf-8'), hashlib.sha256).digest()
        ).rstrip(b'=').decode('ascii')
        if not hmac.compare_digest(expected_sig, sig):
            return redirect('/?sso_error=invalid_signature')
    except Exception:
        return redirect('/?sso_error=signature_error')
    try:
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += '=' * padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return redirect('/?sso_error=invalid_payload')
    if payload.get('exp', 0) < time.time():
        return redirect('/?sso_error=token_expired')
    sso_id = payload.get('sub', '')
    name = payload.get('name', '')
    email = payload.get('email', '')
    if not sso_id:
        return redirect('/?sso_error=no_subject')
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # 先按 sso_id 查找已绑定的用户
    c.execute('SELECT id, username, display_name, is_admin FROM users WHERE sso_id = ?', (sso_id,))
    row = c.fetchone()
    if row:
        user_id = row[0]
        if name and name != row[2]:
            c.execute('UPDATE users SET display_name = ? WHERE id = ?', (name, user_id))
            conn.commit()
    else:
        # 检查是否是管理面板触发的绑定模式
        bind_user_id = session.pop('sso_bind_user_id', None)
        if bind_user_id:
            c.execute('UPDATE users SET sso_id = ? WHERE id = ?', (sso_id, bind_user_id))
            if name:
                c.execute('UPDATE users SET display_name = ? WHERE id = ?', (name, bind_user_id))
            conn.commit()
            user_id = bind_user_id
        else:
            # 完全新用户，自动创建
            username = 'sso_' + sso_id.replace('-', '_').replace(' ', '_')
            c.execute('INSERT INTO users (username, password_hash, display_name, sso_id) VALUES (?, ?, ?, ?)', (username, '', name, sso_id))
            user_id = c.lastrowid
            conn.commit()
    conn.close()
    token = create_session(user_id)
    resp = redirect('/')
    set_session_cookie(resp, token)
    return resp


# --- Admin routes ---

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user(request)
        if not user:
            return jsonify({'error': '未登录'}), 401
        if not user.get('is_admin'):
            return jsonify({'error': '无权限'}), 403
        request.current_user = user
        return f(*args, **kwargs)
    return decorated

@app.route('/api/admin/users', methods=['GET'])
@require_admin
def admin_list_users():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT id, username, display_name, sso_id, is_admin, created_at FROM users ORDER BY id')
    users = []
    for row in c.fetchall():
        users.append({
            'id': row[0], 'username': row[1], 'display_name': row[2],
            'sso_id': row[3], 'is_admin': bool(row[4]), 'created_at': row[5]
        })
    conn.close()
    return jsonify(users)

@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@require_admin
def admin_delete_user(user_id):
    if user_id == request.current_user['id']:
        return jsonify({'error': '不能删除自己'}), 400
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT id FROM users WHERE id = ?', (user_id,))
    if not c.fetchone():
        conn.close()
        return jsonify({'error': '用户不存在'}), 404
    c.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
    c.execute('DELETE FROM users WHERE id = ?', (user_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

@app.route('/api/admin/users/<int:user_id>/toggle-admin', methods=['POST'])
@require_admin
def admin_toggle_admin(user_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT is_admin FROM users WHERE id = ?', (user_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return jsonify({'error': '用户不存在'}), 404
    new_val = 0 if row[0] else 1
    c.execute('UPDATE users SET is_admin = ? WHERE id = ?', (new_val, user_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'is_admin': bool(new_val)})

def get_setting(key, default=''):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT value FROM app_settings WHERE key = ?', (key,))
    row = c.fetchone()
    conn.close()
    return row[0] if row else default

def set_setting(key, value):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', (key, value))
    conn.commit()
    conn.close()

@app.route('/api/admin/settings', methods=['GET'])
@require_admin
def admin_get_settings():
    return jsonify({
        'password_login_disabled': get_setting('password_login_disabled', '0') == '1'
    })

@app.route('/api/admin/settings', methods=['POST'])
@require_admin
def admin_save_settings():
    data = request.json or {}
    if 'password_login_disabled' in data:
        set_setting('password_login_disabled', '1' if data['password_login_disabled'] else '0')
    return jsonify({'ok': True})


@app.route('/api/admin/characters', methods=['GET'])
@require_admin
def admin_list_characters():
    characters = load_characters()
    return jsonify([{'id': c['id'], 'name': c['name'], 'description': (c['description'] or '')[:100]} for c in characters])


@app.route('/api/admin/characters/<path:char_id>', methods=['DELETE'])
@require_admin
def admin_delete_character(char_id):
    for skill_dir in SKILLS_DIR.iterdir():
        if not skill_dir.is_dir():
            continue
        skill_file = skill_dir / 'SKILL.md'
        if not skill_file.exists():
            continue
        try:
            with open(skill_file, 'r', encoding='utf-8') as f:
                content = f.read()
            # 去掉外层 markdown 代码块包裹
            stripped = content.strip()
            if stripped.startswith('```'):
                lines = stripped.split('\n')
                if lines[-1].strip() == '```':
                    content = '\n'.join(lines[1:-1])
            if content.startswith('---'):
                parts = content.split('---', 2)
                if len(parts) >= 3:
                    for line in parts[1].strip().split('\n'):
                        if line.startswith('name:'):
                            name_val = line.split('name:', 1)[1].strip()
                            if name_val == char_id:
                                shutil.rmtree(skill_dir, ignore_errors=True)
                                return jsonify({'ok': True})
        except Exception:
            continue
    return jsonify({'error': '人物不存在'}), 404


def normalize_text(value):
    return re.sub(r'[\s\-_]+', '', (value or '').strip().lower())


def make_distill_event(event_type, text=None, **extra):
    event = {
        'id': f"{datetime.utcnow().timestamp()}-{uuid.uuid4().hex[:8]}",
        'type': event_type,
        'created_at': datetime.utcnow().isoformat()
    }
    if text is not None:
        event['text'] = text
    event.update(extra)
    return event


def default_distill_state():
    return {
        'status': 'none',
        'query': '',
        'name': '',
        'skill_dir': '',
        'created_at': '',
        'updated_at': '',
        'cancel_requested': False,
        'events': []
    }


def load_distill_state():
    if not os.path.exists(DISTILL_PROGRESS_PATH):
        return default_distill_state()
    try:
        with open(DISTILL_PROGRESS_PATH, 'r', encoding='utf-8') as f:
            state = json.load(f)
        if not isinstance(state, dict):
            return default_distill_state()
        state.setdefault('status', 'none')
        state.setdefault('query', '')
        state.setdefault('name', '')
        state.setdefault('skill_dir', '')
        state.setdefault('created_at', '')
        state.setdefault('updated_at', '')
        state.setdefault('cancel_requested', False)
        state.setdefault('events', [])
        return state
    except Exception:
        return default_distill_state()


def save_distill_state(state):
    state['updated_at'] = datetime.utcnow().isoformat()
    with open(DISTILL_PROGRESS_PATH, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def append_distill_event(event_type, text=None, **extra):
    with distill_lock:
        state = load_distill_state()
        state.setdefault('events', []).append(make_distill_event(event_type, text, **extra))
        save_distill_state(state)
        return state


def update_distill_state(**updates):
    with distill_lock:
        state = load_distill_state()
        state.update(updates)
        save_distill_state(state)
        return state


def is_distill_cancel_requested():
    with distill_lock:
        return bool(load_distill_state().get('cancel_requested'))


def remove_skill_dir(path_str):
    if not path_str:
        return
    try:
        path = Path(path_str)
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


def find_existing_character(query, characters=None):
    raw_query = (query or '').strip()
    normalized_query = normalize_text(query)
    if not raw_query and not normalized_query:
        return None

    characters = characters or load_characters()
    for ch in characters:
        raw_name = (ch.get('name') or '').strip().lower()
        raw_id = (ch.get('id') or '').strip().lower()
        raw_desc = (ch.get('description') or '').strip().lower()
        raw_skill = (ch.get('skill_content') or '').strip().lower()
        raw_query_lower = raw_query.lower()
        name_key = normalize_text(ch.get('name'))
        id_key = normalize_text(ch.get('id'))
        if (
            normalized_query == name_key
            or normalized_query == id_key
            or (normalized_query and name_key and normalized_query in name_key)
            or (normalized_query and id_key and normalized_query in id_key)
            or (normalized_query and name_key and name_key in normalized_query)
            or (normalized_query and id_key and id_key in normalized_query)
            or (raw_query_lower and raw_name and raw_query_lower in raw_name)
            or (raw_query_lower and raw_id and raw_query_lower in raw_id)
        ):
            return ch
    return None

# 扫描所有人物 SKILL 文件
def load_characters():
    characters = []

    if not SKILLS_DIR.exists():
        return characters

    for skill_dir in SKILLS_DIR.iterdir():
        if not skill_dir.is_dir():
            continue

        skill_file = skill_dir / 'SKILL.md'
        if not skill_file.exists():
            continue

        try:
            with open(skill_file, 'r', encoding='utf-8') as f:
                content = f.read()

            # 去掉外层 markdown 代码块包裹
            stripped = content.strip()
            if stripped.startswith('```'):
                lines = stripped.split('\n')
                if lines[-1].strip() == '```':
                    content = '\n'.join(lines[1:-1])

            # 解析 frontmatter
            if content.startswith('---'):
                parts = content.split('---', 2)
                if len(parts) >= 3:
                    # 简单解析 YAML frontmatter
                    frontmatter = parts[1].strip()
                    body = parts[2].strip()

                    name = ''
                    description = ''

                    for line in frontmatter.split('\n'):
                        if line.startswith('name:'):
                            name = line.split('name:', 1)[1].strip()
                        elif line.startswith('description:'):
                            # 处理多行 description
                            desc_lines = [line.split('description:', 1)[1].strip()]
                            continue

                    # 提取多行 description
                    in_description = False
                    for line in frontmatter.split('\n'):
                        if line.startswith('description:'):
                            in_description = True
                            desc_text = line.split('description:', 1)[1].strip()
                            if desc_text and desc_text != '|':
                                description = desc_text
                            continue
                        if in_description:
                            if line.startswith('  ') or line.startswith('\t'):
                                description += ' ' + line.strip()
                            elif line.strip() and not line.startswith('---'):
                                if ':' in line:
                                    break
                                description += ' ' + line.strip()
                            elif not line.strip():
                                continue
                            else:
                                break

                    if name:
                        # 从 H1 标题提取显示名
                        display_name = name
                        for line in body.split('\n'):
                            if line.startswith('# '):
                                h1 = line[2:].strip()
                                # 去掉常见后缀关键词
                                for suffix in [' · 思维操作系统', '·思维操作系统', '思维操作系统', '· 思维操作系统',
                                               ' · 内容创造操作系统', '·内容创造操作系统', '内容创造操作系统',
                                               ' · 注意力收割操作系统', '·注意力收割操作系统', '注意力收割操作系统',
                                               '视角', ' · ', ' — ', ' – ']:
                                    if suffix in h1:
                                        h1 = h1.split(suffix)[0].strip()
                                # 空格分隔的情况：如 "Andrej Karpathy 思维操作系统"
                                if '思维操作系统' in h1:
                                    h1 = h1.split('思维操作系统')[0].strip()
                                if '内容创造操作系统' in h1:
                                    h1 = h1.split('内容创造操作系统')[0].strip()
                                if '注意力收割操作系统' in h1:
                                    h1 = h1.split('注意力收割操作系统')[0].strip()
                                if h1:
                                    display_name = h1
                                break

                        characters.append({
                            'id': name,
                            'name': display_name,
                            'description': description.strip(),
                            'skill_content': content
                        })
        except Exception as e:
            print(f"Error loading {skill_file}: {e}")
            continue

    return characters

# 路由
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/characters', methods=['GET'])
def get_characters():
    """获取所有人物列表"""
    characters = load_characters()
    return jsonify(characters)

@app.route('/api/chat', methods=['POST'])
def chat():
    """处理对话请求（流式返回）"""
    data = request.json
    character_id = data.get('character_id')
    message = data.get('message')
    conversation_id = data.get('conversation_id')
    api_config = data.get('api_config', {})
    scenario_mode = data.get('scenario_mode', False)

    if not character_id or not message:
        return jsonify({'error': '缺少人物或消息'}), 400

    # 验证 API 配置
    api_type = api_config.get('type', 'anthropic')
    api_key = api_config.get('apiKey')

    if not api_key:
        # 尝试使用环境变量
        if api_type == 'anthropic':
            api_key = ANTHROPIC_API_KEY
        if not api_key:
            return jsonify({'error': '缺少 API 密钥'}), 400

    # 加载人物信息
    characters = load_characters()
    character = next((c for c in characters if c['id'] == character_id), None)

    if not character:
        return jsonify({'error': '人物不存在'}), 404

    # 创建或获取对话（场景模式下不保存到 conversations 表）
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    current_user = get_current_user(request)
    user_id = current_user['id'] if current_user else None

    if scenario_mode:
        conn.close()
        messages = [{'role': 'user', 'content': message}]
        conversation_id = 0
    else:
        if not conversation_id:
            c.execute('INSERT INTO conversations (character_id, user_id) VALUES (?, ?)', (character_id, user_id))
            conversation_id = c.lastrowid
            conn.commit()

        # 保存用户消息
        c.execute('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
                  (conversation_id, 'user', message))
        conn.commit()

        # 获取历史消息
        c.execute('''
            SELECT role, content FROM messages
            WHERE conversation_id = ?
            ORDER BY created_at ASC
        ''', (conversation_id,))
        history = c.fetchall()
        conn.close()

        # 构建消息列表
        messages = [{'role': role, 'content': content} for role, content in history[:-1]]
        messages.append({'role': 'user', 'content': message})

    # 根据 API 类型调用不同的接口
    model = api_config.get('model', 'claude-sonnet-4-20250514')

    def generate():
        try:
            print(f"[chat] 开始生成: type={api_type}, model={model}, character={character_id}")
            if api_type == 'anthropic':
                yield from generate_anthropic(api_key, model, character, messages, conversation_id)
            else:  # openai
                yield from generate_openai(api_config, character, messages, conversation_id)
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype='text/event-stream')

def generate_anthropic(api_key, model, character, messages, conversation_id):
    """使用 Anthropic API 生成回复"""
    client = anthropic.Anthropic(api_key=api_key)

    with client.messages.stream(
        model=model,
        max_tokens=4096,
        system=character['skill_content'],
        messages=messages
    ) as stream:
        full_response = ''
        for text in stream.text_stream:
            full_response += text
            yield f"data: {json.dumps({'text': text})}\n\n"

        # 保存助手回复（场景模式下跳过）
        if conversation_id:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
                      (conversation_id, 'assistant', full_response))
            conn.commit()
            conn.close()

        yield f"data: {json.dumps({'done': True, 'conversation_id': conversation_id})}\n\n"

def generate_openai(api_config, character, messages, conversation_id):
    """使用 OpenAI 兼容 API 生成回复"""
    base_url = api_config.get('baseUrl', '').strip().rstrip('/')
    api_key = api_config.get('apiKey')
    model = api_config.get('model', 'gpt-4')

    if not base_url:
        raise ValueError('未配置接口地址')

    # 确保 base_url 以 /v1 结尾（OpenAI SDK 不自动加）
    if not base_url.endswith('/v1'):
        base_url = base_url + '/v1'

    print(f"[openai] base_url={base_url}, model={model}, api_key={api_key[:10]}...", flush=True)
    client = OpenAI(api_key=api_key, base_url=base_url)

    openai_messages = [
        {'role': 'system', 'content': character['skill_content']}
    ] + messages

    print(f"[openai] sending {len(openai_messages)} messages", flush=True)
    stream = client.chat.completions.create(
        model=model,
        messages=openai_messages,
        stream=True,
        max_tokens=4096
    )

    full_response = ''
    reasoning_text = ''
    chunk_count = 0
    text_count = 0
    for chunk in stream:
        chunk_count += 1
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta

        if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
            reasoning_text += delta.reasoning_content
            text_count += 1
            yield f"data: {json.dumps({'reasoning': delta.reasoning_content})}\n\n"
        elif delta.content is not None and delta.content:
            full_response += delta.content
            text_count += 1
            yield f"data: {json.dumps({'text': delta.content})}\n\n"

    print(f"[openai] done: {chunk_count} chunks, {text_count} text, response_len={len(full_response)}", flush=True)

    # 保存助手回复（场景模式下跳过）
    if conversation_id:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
                  (conversation_id, 'assistant', full_response))
        conn.commit()
        conn.close()

    yield f"data: {json.dumps({'done': True, 'conversation_id': conversation_id})}\n\n"

@app.route('/api/conversations/<int:conversation_id>', methods=['GET'])
def get_conversation(conversation_id):
    """获取单条对话历史"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('SELECT character_id, created_at FROM conversations WHERE id = ?', (conversation_id,))
    conv = c.fetchone()
    if not conv:
        conn.close()
        return jsonify({'error': '对话不存在'}), 404

    c.execute('''
        SELECT role, content, created_at FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
    ''', (conversation_id,))
    messages = [{'role': row[0], 'content': row[1], 'created_at': row[2]}
                for row in c.fetchall()]
    conn.close()
    return jsonify({
        'id': conversation_id,
        'character_id': conv[0],
        'created_at': conv[1],
        'messages': messages
    })

@app.route('/api/conversations', methods=['GET'])
def list_conversations():
    """列出当前用户的对话"""
    current_user = get_current_user(request)
    user_id = current_user['id'] if current_user else None
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    if user_id:
        c.execute('''
            SELECT c.id, c.character_id, c.created_at,
                   (SELECT content FROM messages WHERE conversation_id = c.id
                    ORDER BY created_at DESC LIMIT 1) as last_message
            FROM conversations c
            WHERE c.user_id = ?
            ORDER BY c.created_at DESC
            LIMIT 100
        ''', (user_id,))
    else:
        c.execute('''
            SELECT c.id, c.character_id, c.created_at,
                   (SELECT content FROM messages WHERE conversation_id = c.id
                    ORDER BY created_at DESC LIMIT 1) as last_message
            FROM conversations c
            WHERE c.user_id IS NULL
            ORDER BY c.created_at DESC
            LIMIT 100
        ''')
    rows = c.fetchall()
    conn.close()
    conversations = []
    for row in rows:
        conversations.append({
            'id': row[0],
            'character_id': row[1],
            'created_at': row[2],
            'last_message': (row[3][:60] + '...') if row[3] and len(row[3]) > 60 else row[3]
        })
    return jsonify(conversations)


# ═══ Scenario Session APIs ═══

@app.route('/api/scenario/save', methods=['POST'])
def scenario_save():
    """保存场景消息"""
    data = request.json
    session_id = data.get('session_id')
    mode = data.get('mode', 'roundtable')
    topic = data.get('topic', '')
    pro_position = data.get('pro_position', '')
    con_position = data.get('con_position', '')
    participants = data.get('participants', '[]')
    pro_side = data.get('pro_side', '[]')
    con_side = data.get('con_side', '[]')
    round_number = data.get('round_number', 1)
    stage = data.get('stage', '')
    character_id = data.get('character_id', '')
    character_name = data.get('character_name', '')
    side = data.get('side', '')
    role = data.get('role', 'speaker')
    content = data.get('content', '')

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    current_user = get_current_user(request)
    user_id = current_user['id'] if current_user else None

    if not session_id:
        c.execute('''INSERT INTO scenario_sessions
            (mode, topic, pro_position, con_position, participants, pro_side, con_side, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            (mode, topic, pro_position, con_position,
             json.dumps(participants) if isinstance(participants, list) else participants,
             json.dumps(pro_side) if isinstance(pro_side, list) else pro_side,
             json.dumps(con_side) if isinstance(con_side, list) else con_side,
             user_id))
        session_id = c.lastrowid
        conn.commit()

    c.execute('''INSERT INTO scenario_messages
        (session_id, round_number, stage, character_id, character_name, side, role, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
        (session_id, round_number, stage, character_id, character_name, side, role, content))
    conn.commit()
    conn.close()

    return jsonify({'session_id': session_id})


@app.route('/api/scenario-sessions', methods=['GET'])
def list_scenario_sessions():
    """列出当前用户的场景会话"""
    current_user = get_current_user(request)
    user_id = current_user['id'] if current_user else None
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    if user_id:
        c.execute('''
            SELECT s.id, s.mode, s.topic, s.participants, s.created_at,
                   (SELECT content FROM scenario_messages WHERE session_id = s.id
                    ORDER BY created_at DESC LIMIT 1) as last_message
            FROM scenario_sessions s
            WHERE s.user_id = ?
            ORDER BY s.created_at DESC
            LIMIT 100
        ''', (user_id,))
    else:
        c.execute('''
            SELECT s.id, s.mode, s.topic, s.participants, s.created_at,
                   (SELECT content FROM scenario_messages WHERE session_id = s.id
                    ORDER BY created_at DESC LIMIT 1) as last_message
            FROM scenario_sessions s
            WHERE s.user_id IS NULL
            ORDER BY s.created_at DESC
            LIMIT 100
        ''')
    rows = c.fetchall()
    conn.close()
    sessions = []
    for row in rows:
        parts = row[3]
        if isinstance(parts, str):
            try:
                parts = json.loads(parts)
            except Exception:
                parts = []
        sessions.append({
            'id': row[0],
            'mode': row[1],
            'topic': row[2],
            'participants': parts,
            'created_at': row[4],
            'last_message': (row[5][:60] + '...') if row[5] and len(row[5]) > 60 else row[5]
        })
    return jsonify(sessions)


@app.route('/api/scenario-sessions/<int:session_id>', methods=['GET'])
def get_scenario_session(session_id):
    """获取完整场景会话"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''SELECT id, mode, topic, pro_position, con_position, participants, pro_side, con_side, created_at
                 FROM scenario_sessions WHERE id = ?''', (session_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return jsonify({'error': '会话不存在'}), 404

    def parse_json(val):
        if isinstance(val, list):
            return val
        if isinstance(val, str):
            try:
                return json.loads(val)
            except Exception:
                return []
        return []

    session = {
        'id': row[0],
        'mode': row[1],
        'topic': row[2],
        'pro_position': row[3],
        'con_position': row[4],
        'participants': parse_json(row[5]),
        'pro_side': parse_json(row[6]),
        'con_side': parse_json(row[7]),
        'created_at': row[8]
    }

    c.execute('''SELECT id, round_number, stage, character_id, character_name, side, role, content, created_at
                 FROM scenario_messages WHERE session_id = ?
                 ORDER BY round_number ASC, created_at ASC''', (session_id,))
    messages = []
    for m in c.fetchall():
        messages.append({
            'id': m[0], 'round_number': m[1], 'stage': m[2],
            'character_id': m[3], 'character_name': m[4],
            'side': m[5], 'role': m[6], 'content': m[7], 'created_at': m[8]
        })
    conn.close()

    session['messages'] = messages
    return jsonify(session)


@app.route('/api/scenario-sessions/<int:session_id>', methods=['DELETE'])
def delete_scenario_session(session_id):
    """删除场景会话"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('DELETE FROM scenario_messages WHERE session_id = ?', (session_id,))
    c.execute('DELETE FROM scenario_sessions WHERE id = ?', (session_id,))
    conn.commit()
    conn.close()
    return jsonify({'status': 'ok'})
@app.route('/api/config', methods=['GET'])
def get_api_config():
    """获取服务端保存的配置"""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                return jsonify(json.load(f))
        except Exception:
            pass
    return jsonify({})

@app.route('/api/config', methods=['POST'])
def save_api_config():
    """保存配置到服务端"""
    data = request.json
    try:
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/models', methods=['POST'])
def get_models():
    """获取可用模型列表"""
    data = request.json
    api_type = data.get('api_type', 'anthropic')
    api_key = data.get('api_key')
    base_url = data.get('base_url', '')

    if not api_key:
        return jsonify({'error': '请提供 API Key'}), 400

    if api_type == 'anthropic':
        models = [
            'claude-opus-4-20250514',
            'claude-sonnet-4-20250514',
            'claude-3-5-sonnet-20241022',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307'
        ]
        return jsonify({'models': models, 'source': 'predefined'})

    # OpenAI 兼容 API
    try:
        if not base_url:
            return jsonify({'error': '请提供接口地址'}), 400
        base_url = base_url.strip().rstrip('/')

        headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }

        # 构建候选 URL 列表，覆盖各种 base_url 写法
        urls_to_try = []
        if base_url.endswith('/v1'):
            urls_to_try.append(f"{base_url}/models")
        else:
            urls_to_try.append(f"{base_url}/v1/models")
            urls_to_try.append(f"{base_url}/models")

        result = None
        tried_urls = []
        for url in urls_to_try:
            tried_urls.append(url)
            try:
                print(f"[models] 尝试: {url}")
                resp = http_requests.get(url, headers=headers, timeout=15)
                print(f"[models] -> {resp.status_code} {resp.headers.get('content-type', '')}")

                if resp.status_code == 401:
                    return jsonify({'error': 'API Key 无效或没有权限'}), 401
                if resp.status_code == 404:
                    continue  # 尝试下一个 URL
                if resp.status_code != 200:
                    continue

                # 检查 Content-Type，跳过 HTML 响应
                ct = resp.headers.get('content-type', '')
                if 'text/html' in ct:
                    print(f"[models] -> 返回 HTML，跳过")
                    continue

                # 尝试解析 JSON
                try:
                    result = resp.json()
                    break  # 解析成功，跳出循环
                except (ValueError, Exception):
                    # 200 但不是 JSON，尝试下一个 URL
                    continue

            except http_requests.exceptions.ConnectionError:
                continue
            except http_requests.exceptions.Timeout:
                continue

        if result is None:
            return jsonify({'error': f'无法获取模型列表。已尝试: {", ".join(tried_urls)}。请检查 Base URL 是否正确，或直接手动输入模型名称'}), 500

        # 提取模型列表 - 兼容多种返回格式
        models = []
        if isinstance(result, dict):
            data_list = result.get('data') or result.get('models') or []
            if isinstance(data_list, list):
                for m in data_list:
                    if isinstance(m, dict) and 'id' in m:
                        models.append(m['id'])
                    elif isinstance(m, str):
                        models.append(m)
        elif isinstance(result, list):
            for m in result:
                if isinstance(m, dict) and 'id' in m:
                    models.append(m['id'])
                elif isinstance(m, str):
                    models.append(m)

        if not models:
            snippet = str(result)[:300]
            return jsonify({'error': f'未找到可用模型，API 返回: {snippet}'}), 404

        print(f"[models] 成功获取 {len(models)} 个模型")
        return jsonify({'models': sorted(models), 'source': 'api'})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'获取失败: {str(e)}'}), 500

@app.route('/api/distill/check', methods=['POST'])
def distill_check():
    """检查是否可以蒸馏该人物（重复检测）"""
    data = request.json
    query = data.get('query', '').strip()
    if not query:
        return jsonify({'can_distill': False, 'reason': '请输入人名'})

    characters = load_characters()
    existing = find_existing_character(query, characters)
    if existing:
        return jsonify({'can_distill': False, 'reason': f'"{existing["name"]}" 已存在，无需重复蒸馏'})

    progress = load_distill_state()
    if progress.get('status') == 'running':
        return jsonify({'can_distill': False, 'reason': f'正在蒸馏 "{progress.get("query")}"，请先等待完成或取消'})

    return jsonify({'can_distill': True})


@app.route('/api/distill/cancel', methods=['POST'])
def distill_cancel():
    """取消当前蒸馏"""
    with distill_lock:
        state = load_distill_state()
        if state.get('status') not in ('running', 'cancelling'):
            if state.get('status') == 'cancelled':
                return jsonify({'status': 'cancelled'})
            return jsonify({'status': 'idle'})

        state['cancel_requested'] = True
        state['status'] = 'cancelling'
        state.setdefault('events', []).append(make_distill_event('cancelled', '正在取消蒸馏...'))
        save_distill_state(state)

    return jsonify({'status': 'cancelling'})


@app.route('/api/distill/progress', methods=['GET'])
def distill_get_progress():
    """获取当前蒸馏进度（刷新页面后恢复）"""
    return jsonify(load_distill_state())


@app.route('/api/distill', methods=['POST'])
def distill():
    """启动蒸馏任务"""
    data = request.json
    query = data.get('query', '').strip()
    api_config = data.get('api_config', {})

    if not query:
        return jsonify({'error': '请输入人名或需求'}), 400

    api_type = api_config.get('type', 'anthropic')
    api_key = api_config.get('apiKey') or ANTHROPIC_API_KEY
    if not api_key:
        return jsonify({'error': '请先配置 API Key'}), 400

    existing = find_existing_character(query)
    if existing:
        return jsonify({'error': f'"{existing["name"]}" 已存在，无需重复蒸馏'}), 400

    progress = load_distill_state()
    if progress.get('status') == 'running':
        return jsonify({'error': f'正在蒸馏 "{progress.get("query")}"，请先等待完成或取消'}), 409

    nuwa_skill_path = SKILLS_DIR.parent / 'SKILL.md'
    if not nuwa_skill_path.exists():
        return jsonify({'error': '女娲 Skill 文件不存在'}), 500

    with open(nuwa_skill_path, 'r', encoding='utf-8') as f:
        nuwa_system = f.read()

    state = {
        'status': 'running',
        'query': query,
        'name': '',
        'skill_dir': '',
        'created_at': datetime.utcnow().isoformat(),
        'updated_at': datetime.utcnow().isoformat(),
        'cancel_requested': False,
        'events': [make_distill_event('phase', f'开始蒸馏: {query}')]
    }
    with distill_lock:
        save_distill_state(state)

    def worker():
        try:
            messages = [{'role': 'user', 'content': f'蒸馏 {query}'}]
            max_rounds = 8
            final_skill_content = ''
            full_response = ''

            for round_num in range(max_rounds):
                if is_distill_cancel_requested():
                    raise InterruptedError('蒸馏已取消')

                append_distill_event('info', f'第 {round_num + 1} 轮思考...')
                full_response = ''

                if api_type == 'anthropic':
                    client = anthropic.Anthropic(api_key=api_key)
                    model = api_config.get('model', 'claude-sonnet-4-20250514')
                    with client.messages.stream(
                        model=model,
                        max_tokens=8192,
                        system=nuwa_system,
                        messages=messages
                    ) as stream:
                        for text_chunk in stream.text_stream:
                            if is_distill_cancel_requested():
                                raise InterruptedError('蒸馏已取消')
                            full_response += text_chunk
                            append_distill_event('text', text_chunk)
                else:
                    base_url = api_config.get('baseUrl', '').strip().rstrip('/')
                    if not base_url:
                        raise ValueError('未配置接口地址')
                    if not base_url.endswith('/v1'):
                        base_url = base_url + '/v1'
                    model = api_config.get('model', 'gpt-4')
                    client = OpenAI(api_key=api_key, base_url=base_url)
                    resp = client.chat.completions.create(
                        model=model,
                        messages=[{'role': 'system', 'content': nuwa_system}] + messages,
                        max_tokens=8192,
                        stream=True
                    )
                    for chunk in resp:
                        if is_distill_cancel_requested():
                            raise InterruptedError('蒸馏已取消')
                        if chunk.choices and chunk.choices[0].delta.content:
                            text_chunk = chunk.choices[0].delta.content
                            full_response += text_chunk
                            append_distill_event('text', text_chunk)

                messages.append({'role': 'assistant', 'content': full_response})

                search_matches = re.findall(r'\[SEARCH:\s*(.+?)\]', full_response)
                if search_matches:
                    for search_query in search_matches:
                        if is_distill_cancel_requested():
                            raise InterruptedError('蒸馏已取消')
                        search_query = search_query.strip()
                        append_distill_event('search', f'搜索: {search_query}')
                        try:
                            if not MIMO_API_KEY:
                                raise RuntimeError('未配置 MIMO_API_KEY，无法执行联网搜索')
                            result = mimo_search(search_query, MIMO_API_KEY)
                            search_text = mimo_format(result)
                            append_distill_event('search_result', search_text[:500])
                            messages.append({
                                'role': 'user',
                                'content': f'[搜索结果]\n{search_text}\n\n请基于以上搜索结果继续蒸馏工作。如果需要更多信息，继续用 [SEARCH: 关键词] 格式请求搜索。如果已经足够，直接输出完整的 SKILL.md 内容。'
                            })
                        except Exception as e:
                            append_distill_event('error', f'搜索失败: {str(e)}')
                            messages.append({
                                'role': 'user',
                                'content': f'搜索失败({str(e)})，请基于已有信息继续蒸馏。'
                            })
                else:
                    if '---' in full_response and ('心智模型' in full_response or '思维操作系统' in full_response):
                        final_skill_content = full_response
                        break
                    # AI 没有输出最终 SKILL.md 格式，也没有请求搜索
                    # 继续下一轮，催促 AI 直接输出完整 SKILL.md
                    messages.append({
                        'role': 'user',
                        'content': '不需要向我提问或确认，直接基于你已有的知识继续完成蒸馏。现在请直接输出完整的 SKILL.md 文件内容（包含 frontmatter 的 name 和 description 字段，以及完整的人物系统提示词）。不要再输出中间过程、计划或目录结构。'
                    })

            if is_distill_cancel_requested():
                raise InterruptedError('蒸馏已取消')

            if not final_skill_content:
                if '---' in full_response:
                    parts = full_response.split('---')
                    if len(parts) >= 3:
                        final_skill_content = '---' + '---'.join(parts[1:]) if len(parts) > 3 else full_response
                    else:
                        final_skill_content = full_response
                else:
                    final_skill_content = full_response

            name_match = re.search(r'^name:\s*(.+)$', final_skill_content, re.MULTILINE)
            if name_match:
                skill_name = name_match.group(1).strip()
            else:
                skill_name = query.lower().replace(' ', '-')

            skill_name = re.sub(r'[^\w一-鿿-]', '-', skill_name).strip('-')
            if not skill_name:
                skill_name = 'distilled-character'

            if not skill_name.endswith('-perspective'):
                skill_name = f'{skill_name}-perspective'

            output_dir = SKILLS_DIR / skill_name
            update_distill_state(skill_dir=str(output_dir))
            if output_dir.exists():
                shutil.rmtree(output_dir, ignore_errors=True)
            output_dir.mkdir(parents=True, exist_ok=True)

            with open(output_dir / 'SKILL.md', 'w', encoding='utf-8') as f:
                f.write(final_skill_content)

            update_distill_state(
                status='done',
                name=skill_name,
                skill_dir=str(output_dir),
                cancel_requested=False
            )
            append_distill_event('result', f'蒸馏完成! 已保存到 {skill_name}', name=skill_name)
        except InterruptedError:
            state = update_distill_state(status='cancelled', cancel_requested=False)
            remove_skill_dir(state.get('skill_dir'))
            append_distill_event('cancelled', '蒸馏已取消')
        except Exception as e:
            import traceback
            traceback.print_exc()
            update_distill_state(status='error', error=str(e), cancel_requested=False)
            append_distill_event('error', str(e))

    global distill_thread
    distill_thread = threading.Thread(target=worker, daemon=True)
    distill_thread.start()

    return jsonify({'status': 'running', 'query': query})


init_db()

if __name__ == '__main__':
    print("正在启动镜面...")
    print(f"已加载 {len(load_characters())} 个人物")
    app.run(debug=False, port=5000)
