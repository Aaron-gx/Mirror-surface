let currentCharacter = null;
let currentConversationId = null;
let isGenerating = false;
let apiConfig = null;
let charactersCache = [];
let currentUser = null;
let hallSelectedCharacters = [];
let isHallGenerating = false;
let hallMode = 'roundtable';
let debateMode = 'topic';
let debateTopic = '';
let hallRoundCounter = 0;
let isDistilling = false;
let debateProSide = [];
let debateConSide = [];
let debateStage = '';
let debateHistory = [];
let debateFreeRound = 0;
let debateProPosition = '';
let debateConPosition = '';
let currentScenarioSessionId = null;
const DEBATE_FREE_MAX_ROUNDS = 4;
let distillPollTimer = null;
let distillRenderedEventIds = new Set();

const HALL_MAX_PARTICIPANTS = 6;
const charColors = [
    '#6d28d9', '#0891b2', '#d97706', '#059669', '#dc2626',
    '#db2777', '#4f46e5', '#0d9488', '#ea580c', '#9333ea',
    '#0284c7', '#65a30d', '#be123c', '#7c3aed', '#06b6d4', '#ca8a04'
];

const characterSelection = document.getElementById('character-selection');
const chatPage = document.getElementById('chat-page');
const charactersGrid = document.getElementById('characters-grid');
const backBtn = document.getElementById('back-btn');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const currentCharacterName = document.getElementById('current-character-name');
const currentCharacterDesc = document.getElementById('current-character-desc');
const chatAvatar = document.getElementById('chat-avatar');
const settingsBtn = document.getElementById('settings-btn');
const chatSettingsBtn = document.getElementById('chat-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettings = document.getElementById('close-settings');
const settingsForm = document.getElementById('settings-form');
const apiType = document.getElementById('api-type');
const baseUrlGroup = document.getElementById('base-url-group');
const modelListPanel = document.getElementById('model-list-panel');
const modelListItems = document.getElementById('model-list-items');
const closeModelList = document.getElementById('close-model-list');
const charIntroCard = document.getElementById('char-intro-card');
const charIntroName = document.getElementById('char-intro-name');
const charIntroDesc = document.getElementById('char-intro-desc');
const charIntroBody = document.getElementById('char-intro-body');
const charIntroToggle = document.getElementById('char-intro-toggle');
const charIntroArrow = document.getElementById('char-intro-arrow');
const historyBtn = document.getElementById('history-btn');
const chatHistoryBtn = document.getElementById('chat-history-btn');
const historyPanel = document.getElementById('history-panel');
const historyOverlay = document.getElementById('history-overlay');
const closeHistory = document.getElementById('close-history');
const historyList = document.getElementById('history-list');
const debateTopicModal = document.getElementById('debate-topic-modal');

async function init() {
    setupAuthListeners();
    await applyLoginSettings();
    const loggedIn = await checkAuth();
    if (!loggedIn) {
        showPage('login-page');
        return;
    }
    showPage('character-selection');
    await loadApiConfig();
    await loadCharacters();
    setupEventListeners();
    await restoreDistillProgress();
}

async function applyLoginSettings() {
    try {
        const resp = await fetch('/api/auth/public-settings');
        const s = await resp.json();
        const pwDisabled = s.password_login_disabled;
        const ssoEnabled = s.sso_enabled;
        const accountTab = document.querySelector('[data-login-tab="account"]');
        const ssoTab = document.querySelector('[data-login-tab="sso"]');
        const accountPanel = document.getElementById('login-account-panel');
        const ssoPanel = document.getElementById('login-sso-panel');
        if (pwDisabled && ssoEnabled) {
            if (accountTab) accountTab.style.display = 'none';
            if (ssoTab) { ssoTab.classList.add('active'); ssoTab.click(); }
        }
        if (!ssoEnabled) {
            if (ssoTab) ssoTab.style.display = 'none';
        }
    } catch (e) {}
}

// ═══════════════════════════════════════
// Auth
// ═══════════════════════════════════════

async function checkAuth() {
    try {
        const resp = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (!resp.ok) return false;
        const data = await resp.json();
        if (data.user) {
            currentUser = data.user;
            const nameEl = document.getElementById('user-display-name');
            if (nameEl) nameEl.textContent = currentUser.display_name || currentUser.username;
            const adminBtn = document.getElementById('admin-btn');
            if (adminBtn) adminBtn.style.display = currentUser.is_admin ? '' : 'none';
            return true;
        }
        return false;
    } catch (e) {
        console.error('checkAuth error:', e);
        return false;
    }
}

function setupAuthListeners() {
    document.querySelectorAll('[data-login-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-login-tab]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.loginTab;
            document.getElementById('login-account-panel').style.display = target === 'account' ? '' : 'none';
            document.getElementById('login-sso-panel').style.display = target === 'sso' ? '' : 'none';
        });
    });

    const loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        if (!username || !password) return;
        try {
            const resp = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await resp.json();
            if (!resp.ok) {
                showLoginError(data.error || '登录失败');
                return;
            }
            currentUser = data.user;
            window.location.href = '/';
        } catch (err) {
            showLoginError('网络错误');
        }
    });

    const showRegister = document.getElementById('show-register');
    if (showRegister) showRegister.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('register-modal').classList.add('active');
    });

    const closeRegister = document.getElementById('close-register');
    if (closeRegister) closeRegister.addEventListener('click', () => {
        document.getElementById('register-modal').classList.remove('active');
    });

    const registerModal = document.getElementById('register-modal');
    if (registerModal) registerModal.addEventListener('click', (e) => {
        if (e.target === registerModal) registerModal.classList.remove('active');
    });

    const registerForm = document.getElementById('register-form');
    if (registerForm) registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('register-username').value.trim();
        const password = document.getElementById('register-password').value;
        const password2 = document.getElementById('register-password2').value;
        if (password !== password2) {
            showLoginError('两次密码不一致');
            return;
        }
        try {
            const resp = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await resp.json();
            if (!resp.ok) {
                showLoginError(data.error || '注册失败');
                return;
            }
            currentUser = data.user;
            window.location.href = '/';
        } catch (err) {
            showLoginError('网络错误');
        }
    });

    const ssoBtn = document.getElementById('sso-login-btn');
    if (ssoBtn) ssoBtn.addEventListener('click', () => {
        window.location.href = '/sso/login';
    });

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        currentUser = null;
        window.location.href = '/';
    });
}

function showLoginError(msg) {
    const el = document.getElementById('login-error');
    if (el) {
        el.textContent = msg;
        el.style.display = '';
        setTimeout(() => { el.style.display = 'none'; }, 4000);
    }
}

// Admin
async function loadAdminUsers() {
    const listEl = document.getElementById('admin-user-list');
    const charListEl = document.getElementById('admin-char-list');
    const settingsEl = document.getElementById('admin-settings');
    if (!listEl) return;
    listEl.innerHTML = '<div class="admin-loading">加载中...</div>';
    if (charListEl) charListEl.innerHTML = '<div class="admin-loading">加载中...</div>';
    try {
        const [usersResp, settingsResp, charsResp] = await Promise.all([
            fetch('/api/admin/users', { credentials: 'same-origin' }),
            fetch('/api/admin/settings', { credentials: 'same-origin' }),
            fetch('/api/admin/characters', { credentials: 'same-origin' })
        ]);
        if (!usersResp.ok) { listEl.innerHTML = '<div class="admin-loading">无权限</div>'; return; }
        const users = await usersResp.json();
        const settings = settingsResp.ok ? await settingsResp.json() : {};

        if (settingsEl) {
            settingsEl.innerHTML = '<label class="admin-toggle-label"><input type="checkbox" id="admin-disable-pw"' + (settings.password_login_disabled ? ' checked' : '') + '> 禁用账号密码登录（仅允许单点登录）</label>';
            document.getElementById('admin-disable-pw').addEventListener('change', async (e) => {
                await fetch('/api/admin/settings', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password_login_disabled: e.target.checked })
                });
            });
        }

        // Characters list
        if (charsResp.ok && charListEl) {
            const chars = await charsResp.json();
            if (!chars.length) {
                charListEl.innerHTML = '<div class="admin-loading">暂无人物</div>';
            } else {
                charListEl.innerHTML = '<table class="admin-table"><thead><tr><th>人物名</th><th>简介</th><th>操作</th></tr></thead><tbody>'
                    + chars.map(c => '<tr><td>' + escapeHtml(c.name) + '</td><td>' + escapeHtml(c.description || '-') + '</td><td><button class="admin-del-btn" data-del-char="' + escapeHtml(c.id) + '">删除</button></td></tr>').join('')
                    + '</tbody></table>';
                charListEl.querySelectorAll('[data-del-char]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        if (!confirm('确定删除人物「' + btn.closest('tr').querySelector('td').textContent + '」？相关对话记录不会被删除。')) return;
                        const cid = btn.dataset.delChar;
                        const r = await fetch('/api/admin/characters/' + encodeURIComponent(cid), { method: 'DELETE', credentials: 'same-origin' });
                        const d = await r.json();
                        if (r.ok) loadAdminUsers();
                        else alert(d.error || '删除失败');
                    });
                });
            }
        }

        if (!users.length) { listEl.innerHTML = '<div class="admin-loading">暂无用户</div>'; return; }
        listEl.innerHTML = '<table class="admin-table"><thead><tr><th>ID</th><th>用户名</th><th>显示名</th><th>来源</th><th>注册时间</th><th>操作</th></tr></thead><tbody>'
            + users.map(u => {
                const source = u.sso_id ? '单点登录' : '本地';
                const adminTag = u.is_admin ? ' <span class="admin-badge">管理员</span>' : '';
                const cantDelete = u.id === currentUser.id;
                const delBtn = cantDelete ? '' : '<button class="admin-del-btn" data-del-user="' + u.id + '">删除</button>';
                const adminBtnText = u.is_admin ? '取消管理员' : '设为管理员';
                const bindBtn = u.sso_id ? '' : '<button class="admin-bind-btn" data-bind-sso="' + u.id + '">绑定SSO</button>';
                return '<tr><td>' + u.id + '</td><td>' + escapeHtml(u.username) + adminTag + '</td><td>' + escapeHtml(u.display_name || '-') + '</td><td>' + source + '</td><td>' + (u.created_at || '-') + '</td><td>' + bindBtn + delBtn + '<button class="admin-toggle-btn" data-toggle-admin="' + u.id + '">' + adminBtnText + '</button></td></tr>';
            }).join('')
            + '</tbody></table>';
        listEl.querySelectorAll('[data-bind-sso]').forEach(btn => {
            btn.addEventListener('click', () => {
                const uid = btn.dataset.bindSso;
                window.location.href = '/sso/login?bind_user_id=' + uid;
            });
        });
        listEl.querySelectorAll('[data-del-user]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('确定删除该用户？')) return;
                const uid = btn.dataset.delUser;
                const r = await fetch('/api/admin/users/' + uid, { method: 'DELETE', credentials: 'same-origin' });
                const d = await r.json();
                if (r.ok) loadAdminUsers();
                else alert(d.error || '删除失败');
            });
        });
        listEl.querySelectorAll('[data-toggle-admin]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = btn.dataset.toggleAdmin;
                await fetch('/api/admin/users/' + uid + '/toggle-admin', { method: 'POST', credentials: 'same-origin' });
                loadAdminUsers();
            });
        });
    } catch (e) {
        listEl.innerHTML = '<div class="admin-loading">加载失败</div>';
    }
}


async function loadApiConfig() {
    try {
        const resp = await fetch('/api/config');
        const data = await resp.json();
        if (data && data.apiKey) {
            apiConfig = data;
            localStorage.setItem('apiConfig', JSON.stringify(apiConfig));
            populateConfigForm(apiConfig);
            return;
        }
        localStorage.removeItem('apiConfig');
        apiConfig = null;
        populateConfigForm({});
    } catch (error) {}
}

function populateConfigForm(cfg) {
    document.getElementById('api-type').value = cfg.type || 'anthropic';
    document.getElementById('api-key').value = cfg.apiKey || '';
    document.getElementById('base-url').value = cfg.baseUrl || '';
    document.getElementById('model-name').value = cfg.model || '';
    baseUrlGroup.style.display = cfg.type === 'openai' ? 'block' : 'none';
}

function saveApiConfig(event) {
    event.preventDefault();

    const modelValue = document.getElementById('model-name').value.trim();
    if (!modelValue) {
        showStatus('请输入模型名称', true);
        return;
    }

    apiConfig = {
        type: document.getElementById('api-type').value,
        apiKey: document.getElementById('api-key').value,
        baseUrl: document.getElementById('base-url').value,
        model: modelValue
    };

    localStorage.setItem('apiConfig', JSON.stringify(apiConfig));
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiConfig)
    }).catch(() => {});

    showStatus('配置已保存', false);
    setTimeout(() => settingsModal.classList.remove('active'), 800);
}

async function fetchModels() {
    const type = document.getElementById('api-type').value;
    const apiKeyValue = document.getElementById('api-key').value.trim();
    const baseUrlValue = document.getElementById('base-url').value.trim();
    const fetchBtn = document.getElementById('fetch-models-btn');

    if (!apiKeyValue) {
        showStatus('请先填写密钥', true);
        return;
    }
    if (type === 'openai' && !baseUrlValue) {
        showStatus('请先填写接口地址', true);
        return;
    }

    fetchBtn.disabled = true;
    fetchBtn.textContent = '获取中...';

    try {
        const response = await fetch('/api/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_type: type, api_key: apiKeyValue, base_url: baseUrlValue })
        });
        const data = await response.json();

        if (data.error) {
            showStatus(data.error, true);
            return;
        }

        const models = Array.isArray(data.models) ? data.models : [];
        if (!models.length) {
            showStatus('未找到可用模型', true);
            return;
        }

        modelListItems.innerHTML = '';
        models.forEach((model) => {
            const item = document.createElement('div');
            item.className = 'model-item';
            item.textContent = model;
            item.addEventListener('click', () => {
                document.getElementById('model-name').value = model;
                modelListPanel.style.display = 'none';
            });
            modelListItems.appendChild(item);
        });
        modelListPanel.style.display = 'block';
    } catch (error) {
        showStatus(`获取失败: ${error.message}`, true);
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '获取列表';
    }
}

function showStatus(message, isError) {
    const el = document.getElementById('api-status');
    const txt = document.getElementById('status-text');
    el.style.display = 'flex';
    el.className = `status-bar${isError ? ' error' : ''}`;
    txt.textContent = message;
    if (!isError) {
        setTimeout(() => {
            el.style.display = 'none';
        }, 3000);
    }
}

async function loadCharacters() {
    try {
        const response = await fetch('/api/characters');
        const characters = await response.json();
        charactersCache = characters;
        charactersGrid.innerHTML = '';
        characters.forEach((character, index) => {
            charactersGrid.appendChild(createCharacterCard(character, index));
        });
    } catch (error) {
        charactersGrid.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:40px;">加载失败，请刷新重试</p>';
    }
}

function createCharacterCard(character, index) {
    const card = document.createElement('div');
    card.className = 'character-card';
    const color = charColors[index % charColors.length];
    card.innerHTML = `
        <h3><span class="card-dot" style="background:${color}"></span>${escapeHtml(character.name)}</h3>
        <p>${escapeHtml(character.description || '暂无描述')}</p>
    `;
    card.addEventListener('click', () => selectCharacter(character, color));
    return card;
}

function selectCharacter(character, color) {
    currentCharacter = character;
    currentConversationId = null;
    currentCharacterName.textContent = character.name;
    currentCharacterDesc.textContent = '';
    chatAvatar.textContent = character.name.charAt(0).toUpperCase();
    chatAvatar.style.background = `linear-gradient(135deg, ${color}, ${color}bb)`;
    chatMessages.innerHTML = '';

    charIntroCard.style.display = 'block';
    charIntroName.textContent = character.name;
    charIntroDesc.textContent = character.description || '暂无详细描述';
    charIntroBody.classList.remove('collapsed');
    charIntroArrow.textContent = '收起 ▼';

    showPage('chat-page');
    chatInput.focus();
}

function goBack() {
    currentCharacter = null;
    currentConversationId = null;
    charIntroCard.style.display = 'none';
    showPage('character-selection');
}

async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message || isGenerating) return;

    if (!apiConfig || !apiConfig.apiKey) {
        showStatus('请先配置密钥', true);
        settingsModal.classList.add('active');
        return;
    }

    addMessage('user', message);
    chatInput.value = '';
    autoResizeInput();
    sendBtn.classList.remove('ready');
    isGenerating = true;
    sendBtn.disabled = true;

    charIntroBody.classList.add('collapsed');
    charIntroArrow.textContent = '展开 ▼';

    const loadingMsg = addMessage('assistant', '<div class="loading"><span></span></div>');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                character_id: currentCharacter.id,
                message,
                conversation_id: currentConversationId,
                api_config: apiConfig
            })
        });

        if (!response.ok) {
            loadingMsg.remove();
            let errMsg = `请求失败 (${response.status})`;
            try {
                const errData = await response.json();
                errMsg = errData.error || errMsg;
            } catch (error) {}
            addMessage('assistant', `<span style="color:var(--red)">${escapeHtml(errMsg)}</span>`);
            return;
        }

        loadingMsg.remove();
        const assistantMsg = addMessage('assistant', '');
        await streamResponseIntoMessage(response, assistantMsg, (data) => {
            if (data.conversation_id) {
                currentConversationId = data.conversation_id;
            }
        });
    } catch (error) {
        loadingMsg.remove();
        addMessage('assistant', `<span style="color:var(--red)">发送失败: ${escapeHtml(error.message)}</span>`);
    } finally {
        isGenerating = false;
        sendBtn.disabled = false;
        chatInput.focus();
    }
}

function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = formatMessage(content);
    chatMessages.appendChild(div);
    scrollToBottom();
    return div;
}

function formatMessage(text) {
    return renderMarkdown(text);
}

function renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
        marked.setOptions({ breaks: true, gfm: true });
        let html = marked.parse(text);
        html = html.replace(/\*\*([^*<]+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*<]+?)\*/g, '<em>$1</em>');
        return html;
    }

    return text
        .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
}

async function openHistory() {
    historyPanel.classList.add('active');
    historyOverlay.classList.add('active');
    await loadHistory();
}

function closeHistoryPanel() {
    historyPanel.classList.remove('active');
    historyOverlay.classList.remove('active');
}

async function loadHistory() {
    historyList.innerHTML = '<div class="history-empty">加载中...</div>';
    try {
        const [convResp, sessResp] = await Promise.all([
            fetch('/api/conversations'),
            fetch('/api/scenario-sessions')
        ]);
        const conversations = await convResp.json();
        const scenarioSessions = await sessResp.json();

        const allItems = [];

        conversations.forEach(conv => {
            allItems.push({
                type: 'normal',
                created_at: conv.created_at,
                data: conv
            });
        });

        scenarioSessions.forEach(sess => {
            allItems.push({
                type: 'scenario',
                created_at: sess.created_at,
                data: sess
            });
        });

        allItems.sort((a, b) => new Date(b.created_at + 'Z') - new Date(a.created_at + 'Z'));

        if (!allItems.length) {
            historyList.innerHTML = '<div class="history-empty">暂无历史对话</div>';
            return;
        }

        historyList.innerHTML = '';
        allItems.forEach(item => {
            const el = document.createElement('div');
            el.className = 'history-item';

            if (item.type === 'scenario') {
                const sess = item.data;
                const mode = sess.mode === 'debate' ? '辩论' : '圆桌';
                const count = (sess.participants || []).length;
                const badgeClass = sess.mode === 'debate' ? 'debate' : 'roundtable';
                el.innerHTML = `
                    <div class="history-item-name">
                        <span class="history-item-badge history-item-badge--${badgeClass}">${mode} · ${count}人</span>
                        ${escapeHtml(sess.topic || mode + '讨论')}
                    </div>
                    <div class="history-item-preview">${escapeHtml(sess.last_message || '暂无消息')}</div>
                    <div class="history-item-time">${formatTime(sess.created_at)}</div>
                `;
                el.addEventListener('click', () => loadScenarioSession(sess.id));
            } else {
                const conv = item.data;
                el.innerHTML = `
                    <div class="history-item-name">${escapeHtml(getCharacterName(conv.character_id))}</div>
                    <div class="history-item-preview">${escapeHtml(conv.last_message || '暂无消息')}</div>
                    <div class="history-item-time">${formatTime(conv.created_at)}</div>
                `;
                el.addEventListener('click', () => loadConversation(conv));
            }
            historyList.appendChild(el);
        });
    } catch (error) {
        historyList.innerHTML = '<div class="history-empty">加载失败</div>';
    }
}

function getCharacterName(id) {
    const character = charactersCache.find((item) => item.id === id);
    return character ? character.name : id;
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(`${ts}Z`);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
    return d.toLocaleDateString('zh-CN');
}

async function loadConversation(conv) {
    closeHistoryPanel();
    try {
        const resp = await fetch(`/api/conversations/${conv.id}`);
        const data = await resp.json();

        const character = charactersCache.find((item) => item.id === data.character_id);
        if (!character) return;

        const idx = charactersCache.indexOf(character);
        const color = charColors[idx % charColors.length];

        currentCharacter = character;
        currentConversationId = conv.id;
        currentCharacterName.textContent = character.name;
        currentCharacterDesc.textContent = '';
        chatAvatar.textContent = character.name.charAt(0).toUpperCase();
        chatAvatar.style.background = `linear-gradient(135deg, ${color}, ${color}bb)`;
        chatMessages.innerHTML = '';

        charIntroCard.style.display = 'block';
        charIntroName.textContent = character.name;
        charIntroDesc.textContent = character.description || '';
        charIntroBody.classList.add('collapsed');
        charIntroArrow.textContent = '展开 ▼';

        data.messages.forEach((msg) => addMessage(msg.role, msg.content));
        showPage('chat-page');
        chatInput.focus();
    } catch (error) {
        console.error('加载对话失败:', error);
    }
}

async function loadScenarioSession(sessionId) {
    closeHistoryPanel();
    try {
        const resp = await fetch('/api/scenario-sessions/' + sessionId);
        const session = await resp.json();

        hallMode = session.mode;
        debateTopic = session.topic || '';
        debateProPosition = session.pro_position || '';
        debateConPosition = session.con_position || '';
        currentScenarioSessionId = session.id;
        debateHistory = [];

        function resolveCharacter(id) {
            const c = charactersCache.find(item => item.id === id);
            if (c) return c;
            return { id: id, name: id, color: '#888', description: '' };
        }

        hallSelectedCharacters = (session.participants || []).map(resolveCharacter);

        if (session.mode === 'debate') {
            debateProSide = (session.pro_side || []).map(resolveCharacter);
            debateConSide = (session.con_side || []).map(resolveCharacter);
        } else {
            debateProSide = [];
            debateConSide = [];
        }

        showPage('hall-chat-page');
        prepareScenarioStage();

        const roundsEl = document.getElementById('hall-rounds');
        if (!roundsEl) return;

        const messages = session.messages || [];
        let maxRound = 0;

        const rounds = {};
        for (const msg of messages) {
            const rn = msg.round_number;
            if (rn > maxRound) maxRound = rn;
            if (!rounds[rn]) rounds[rn] = [];
            rounds[rn].push(msg);
        }

        const sortedRounds = Object.keys(rounds).map(Number).sort((a, b) => a - b);

        for (const rn of sortedRounds) {
            const roundMsgs = rounds[rn];
            const moderatorMsg = roundMsgs.find(m => m.role === 'moderator');
            const speakerMsgs = roundMsgs.filter(m => m.role === 'speaker');
            const stage = speakerMsgs.length > 0 ? speakerMsgs[0].stage : null;

            if (session.mode === 'debate') {
                const stageTitles = {
                    topic: ['辩题', moderatorMsg ? moderatorMsg.content : ''],
                    opening: ['开篇立论', '双方一辩分别发表立场与核心论点'],
                    rebuttal: ['攻辩 / 驳立论', '双方互相驳斥对方立论'],
                    free: ['自由辩论', '双方交替发言'],
                    closing: ['总结陈词', '双方最后陈述'],
                    qa: ['主持人追问', moderatorMsg ? moderatorMsg.content : '']
                };
                const titleDesc = stageTitles[stage] || ['第 ' + rn + ' 轮', ''];
                const roundEl = createDebateStageRound(titleDesc[0], titleDesc[1]);
                if (!roundEl) continue;

                for (const smsg of speakerMsgs) {
                    const char = resolveCharacter(smsg.character_id);
                    const side = smsg.side || 'pro';
                    const sideLabel = side === 'pro' ? '正方' : '反方';
                    const ph = createDebateReplyPlaceholder(roundEl, char, side, sideLabel);
                    ph.status.textContent = '已完成';
                    if (smsg.content) {
                        renderStreamingReply(ph.replyDiv, smsg.content, '', true);
                    }
                    setParticipantStatus(char.id, '已完成');

                    debateHistory.push({
                        speakerId: char.id,
                        speakerName: char.name,
                        side: side,
                        stage: stage,
                        content: smsg.content || ''
                    });
                }
            } else {
                const questionText = moderatorMsg ? moderatorMsg.content : '';
                const roundEl = createHallRound(questionText);
                if (!roundEl) continue;

                for (const smsg of speakerMsgs) {
                    const char = resolveCharacter(smsg.character_id);
                    const placeholder = createHallReplyPlaceholder(roundEl, char);
                    placeholder.status.textContent = '已完成';
                    if (smsg.content) {
                        renderStreamingReply(placeholder.replyDiv, smsg.content, '', true);
                    }
                    setParticipantStatus(char.id, '已完成');
                }
            }
        }

        hallRoundCounter = maxRound;

        if (session.mode === 'debate') {
            const lastStage = messages.length > 0
                ? messages[messages.length - 1].stage
                : '';
            debateStage = lastStage === 'qa' ? 'done' : (lastStage || 'done');
            debateMode = 'qa';
            updateStageIndicator();
        }

        configureScenarioChatUi();
    } catch (error) {
        console.error('加载场景会话失败:', error);
    }
}

function enterHall() {
    enterScenarioMode('roundtable');
}

function enterDebate() {
    enterScenarioMode('debate');
}

function enterScenarioMode(mode) {
    hallMode = mode;
    debateMode = 'topic';
    debateTopic = '';
    hallSelectedCharacters = [];
    hallRoundCounter = 0;
    currentScenarioSessionId = null;
    renderHallSelection();
    showPage('hall-page');
}

function renderHallSelection() {
    const grid = document.getElementById('hall-characters-grid');
    const title = document.getElementById('hall-page-title');
    const subtitle = document.getElementById('hall-page-subtitle');
    const badge = document.getElementById('hall-mode-badge');
    const confirmBtn = document.getElementById('hall-confirm-btn');

    document.getElementById('hall-mode-roundtable').classList.toggle('active', hallMode === 'roundtable');
    document.getElementById('hall-mode-debate').classList.toggle('active', hallMode === 'debate');

    if (hallMode === 'debate') {
        badge.textContent = '辩论模式';
        title.textContent = '选择辩论人物';
        subtitle.textContent = '选择 2-6 位人物，设定议题后让他们围绕同一命题开辩';
        confirmBtn.textContent = '确认开始辩论';
    } else {
        badge.textContent = '圆桌模式';
        title.textContent = '选择入席角色';
        subtitle.textContent = '选择 2-6 位人物，开启你问他们各自答的圆桌问答';
        confirmBtn.textContent = '确认开始';
    }

    grid.innerHTML = '';
    charactersCache.forEach((character, index) => {
        const card = document.createElement('div');
        card.className = 'character-card';
        const color = charColors[index % charColors.length];
        const selected = hallSelectedCharacters.find((item) => item.id === character.id);
        if (selected) card.classList.add('selected');

        card.innerHTML = `
            <h3><span class="card-dot" style="background:${color}"></span>${escapeHtml(character.name)}</h3>
            <p>${escapeHtml(character.description || '暂无描述')}</p>
        `;
        card.addEventListener('click', () => toggleHallCharacter(character, index, card, color));
        grid.appendChild(card);
    });

    updateHallCounter();
}

function toggleHallCharacter(character, idx, card, color) {
    const exists = hallSelectedCharacters.find((item) => item.id === character.id);
    if (exists) {
        hallSelectedCharacters = hallSelectedCharacters.filter((item) => item.id !== character.id);
        card.classList.remove('selected');
    } else {
        if (hallSelectedCharacters.length >= HALL_MAX_PARTICIPANTS) return;
        hallSelectedCharacters.push({ ...character, color, idx });
        card.classList.add('selected');
    }
    updateHallCounter();
}

function updateHallCounter() {
    const label = hallMode === 'debate' ? '位辩手' : '位';
    document.getElementById('hall-counter').textContent = `已选 ${hallSelectedCharacters.length} / ${HALL_MAX_PARTICIPANTS} ${label}`;
    document.getElementById('hall-confirm-btn').disabled = hallSelectedCharacters.length < 2;
}

async function confirmHall() {
    if (hallSelectedCharacters.length < 2) return;

    if (hallMode === 'debate') {
        debateProSide = [];
        debateConSide = [];
        openDebateTeamsModal();
        return;
    }

    showPage('hall-chat-page');
    prepareScenarioStage();
    configureScenarioChatUi();
    const hallInput = document.getElementById('hall-input');
    if (hallInput) hallInput.focus();
}

function prepareScenarioStage() {
    hallRoundCounter = 0;
    ensureHallStageNodes();
    if (hallMode === 'debate') {
        renderDebateParticipants();
    } else {
        renderHallParticipants();
    }
    const roundsEl = document.getElementById('hall-rounds');
    if (!roundsEl) return;
    roundsEl.innerHTML = `
        <div class="rt-empty">
            <div class="rt-empty-tag">准备就绪</div>
            <p>会场已经准备好。抛出第一个问题后，这里会按回合展开所有参与者的完整回答。</p>
        </div>
    `;
}

function ensureHallStageNodes() {
    const stageShell = document.querySelector('.rt-body');
    if (!stageShell) return;

    let participantsEl = document.getElementById('hall-participants');
    if (!participantsEl) {
        const panel = stageShell.querySelector('.rt-seats-card');
        if (panel) {
            const head = panel.querySelector('.rt-card-head');
            participantsEl = document.createElement('div');
            participantsEl.id = 'hall-participants';
            participantsEl.className = 'rt-seats';
            panel.appendChild(participantsEl);
            if (head) panel.insertBefore(participantsEl, head.nextSibling);
        }
    }

    let roundsEl = document.getElementById('hall-rounds');
    if (!roundsEl) {
        const shell = stageShell.querySelector('.rt-main');
        if (shell) {
            const head = shell.querySelector('.rt-main-head');
            roundsEl = document.createElement('div');
            roundsEl.id = 'hall-rounds';
            roundsEl.className = 'rt-rounds';
            shell.appendChild(roundsEl);
            if (head) shell.insertBefore(roundsEl, head.nextSibling);
        }
    }
}

function renderHallParticipants() {
    const participantsEl = document.getElementById('hall-participants');
    if (!participantsEl) return;
    participantsEl.innerHTML = '';

    hallSelectedCharacters.forEach((character, index) => {
        const item = document.createElement('div');
        item.className = 'rt-seat';
        item.dataset.charId = character.id;
        item.innerHTML = `
            <div class="rt-seat-avatar" style="background:linear-gradient(135deg,${character.color},${character.color}bb)">${character.name.charAt(0)}</div>
            <div class="rt-seat-copy">
                <div class="rt-seat-name">${escapeHtml(character.name)}</div>
                <div class="rt-seat-role">席位 ${index + 1}</div>
            </div>
            <div class="rt-seat-status" data-participant-status>待开始</div>
        `;
        participantsEl.appendChild(item);
    });
}

function setParticipantStatus(characterId, text, active = false) {
    const item = document.querySelector(`.rt-seat[data-char-id="${characterId}"]`);
    if (!item) return;
    const status = item.querySelector('[data-participant-status]');
    if (status) status.textContent = text;
    item.classList.toggle('is-active', active);
}

function createHallRound(message) {
    const roundsEl = document.getElementById('hall-rounds');
    if (!roundsEl) return null;
    hallRoundCounter += 1;

    if (roundsEl.querySelector('.rt-empty')) {
        roundsEl.innerHTML = '';
    }

    const round = document.createElement('section');
    round.className = 'rt-round';
    round.dataset.round = String(hallRoundCounter);
    round.innerHTML = `
        <div class="rt-round-head">
            <div class="rt-round-index">第 ${hallRoundCounter} 轮</div>
            <div class="rt-round-question">${escapeHtml(message)}</div>
        </div>
        <div class="rt-round-grid"></div>
    `;
    roundsEl.appendChild(round);
    roundsEl.scrollTop = roundsEl.scrollHeight;
    return round;
}

function createHallReplyPlaceholder(roundEl, character) {
    const grid = roundEl.querySelector('.rt-round-grid');
    const card = document.createElement('article');
    card.className = 'rt-reply-card';
    card.dataset.charId = character.id;
    card.innerHTML = `
        <div class="rt-reply-card-head">
            <div class="rt-reply-author">
                <div class="rt-reply-avatar" style="background:linear-gradient(135deg,${character.color},${character.color}bb)">${character.name.charAt(0)}</div>
                <div class="rt-reply-author-copy">
                    <div class="rt-reply-name">${escapeHtml(character.name)}</div>
                    <div class="rt-reply-meta">独立回答</div>
                </div>
            </div>
            <div class="rt-reply-status" data-status>准备中</div>
        </div>
        <div class="rt-reply-body">
            <div class="rt-reply-content"><div class="loading"><span></span></div></div>
        </div>
    `;
    grid.appendChild(card);
    return {
        status: card.querySelector('[data-status]'),
        replyDiv: card.querySelector('.rt-reply-content')
    };
}

function openDebateTopicModal() {
    const input = document.getElementById('debate-topic-input');
    if (!debateTopicModal || !input) return;
    input.value = debateTopic || '';
    debateTopicModal.classList.add('active');
    setTimeout(() => input.focus(), 0);
}

function closeDebateTopicModal() {
    if (!debateTopicModal) return;
    debateTopicModal.classList.remove('active');
}

async function submitDebateTopic() {
    const input = document.getElementById('debate-topic-input');
    if (!input) return;

    const topic = input.value.trim();
    const proPos = (document.getElementById('debate-pro-position').value || '').trim();
    const conPos = (document.getElementById('debate-con-position').value || '').trim();

    if (!topic && !(proPos && conPos)) {
        if (!proPos && !conPos) input.focus();
        else if (!proPos) document.getElementById('debate-pro-position').focus();
        else document.getElementById('debate-con-position').focus();
        return;
    }

    if (topic) {
        debateTopic = topic;
        debateProPosition = proPos;
        debateConPosition = conPos;
    } else {
        debateProPosition = proPos;
        debateConPosition = conPos;
        debateTopic = '正方：' + proPos + ' vs 反方：' + conPos;
    }

    debateMode = 'topic';
    closeDebateTopicModal();

    showPage('hall-chat-page');
    prepareScenarioStage();
    configureScenarioChatUi();
    await runDebateCompetition(debateTopic);
}

function configureScenarioChatUi() {
    ensureHallStageNodes();

    const titleEl = document.getElementById('hall-chat-title');
    const input = document.getElementById('hall-input');
    const currentQuestionEl = document.getElementById('hall-current-question');
    const questionLabel = document.getElementById('hall-question-label');
    const composeTitle = document.getElementById('hall-compose-title');
    const composeHint = document.getElementById('hall-compose-hint');
    const stageBadge = document.getElementById('hall-stage-badge');
    const stageDescription = document.getElementById('hall-stage-description');

    if (hallMode === 'debate') {
        if (titleEl) titleEl.textContent = '多人辩论';
        if (stageBadge) stageBadge.textContent = '辩论';
        if (stageDescription) stageDescription.textContent = '围绕同一辩题展开立场陈述与交锋，先开场，再继续追问。';
        if (questionLabel) questionLabel.textContent = debateMode === 'topic' ? '当前辩题' : '当前追问';
        if (input) input.placeholder = debateMode === 'topic' ? '输入一个明确辩题...' : '继续追问这一场辩论...';
        if (composeTitle) composeTitle.textContent = debateMode === 'topic' ? '设定辩题' : '继续追问';
        if (composeHint) composeHint.textContent = debateMode === 'topic'
            ? '先给出一个清晰命题，再让所有人围绕同一问题开辩。'
            : '每次只追问一个点，方便比较每位辩手的回应。';
        if (currentQuestionEl) {
            currentQuestionEl.textContent = debateTopic
                ? `辩题：${debateTopic}`
                : '请先设定一个明确的辩题。';
        }
    } else {
        if (titleEl) titleEl.textContent = '圆桌讨论';
        if (stageBadge) stageBadge.textContent = '圆桌';
        if (stageDescription) stageDescription.textContent = '让多位 AI 在同一回合里各自完整作答，方便横向对照。';
        if (questionLabel) questionLabel.textContent = '当前焦点';
        if (input) input.placeholder = '输入你想抛给圆桌的问题...';
        if (composeTitle) composeTitle.textContent = '向圆桌发问';
        if (composeHint) composeHint.textContent = '问题尽量单一明确，这样每个人的回答会更集中、更容易比较。';
        if (currentQuestionEl) {
            currentQuestionEl.textContent = '还没开始，先抛出一个真正值得讨论的问题。';
        }
    }
}

function exitHall() {
    hallSelectedCharacters = [];
    debateTopic = '';
    debateProPosition = '';
    debateConPosition = '';
    debateMode = 'topic';
    hallRoundCounter = 0;
    currentScenarioSessionId = null;
    closeDebateTopicModal();
    showPage('character-selection');
}

function exitHallChat() {
    showPage('character-selection');
}

function showPage(pageId) {
    document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
}

function appendHallUserMessage(message) {
    const currentQuestionEl = document.getElementById('hall-current-question');
    if (!currentQuestionEl) return;
    currentQuestionEl.textContent = hallMode === 'debate' && debateMode === 'topic'
        ? `辩题：${message}`
        : message;
}

function renderStreamingReply(replyDiv, fullText, reasoningText, isReasoningDone) {
    let html = '';

    if (reasoningText) {
        const openClass = isReasoningDone ? '' : ' open';
        html += `<div class="reasoning-block${openClass}" onclick="this.classList.toggle('open')">`
            + '<div class="reasoning-toggle"><span class="reasoning-toggle-icon">▶</span> 思考过程</div>'
            + `<div class="reasoning-content">${escapeHtml(reasoningText)}</div></div>`;
    }

    if (fullText) {
        html += `<div class="answer-content">${renderMarkdown(fullText)}</div>`;
    } else if (reasoningText && !isReasoningDone) {
        html += '<div class="thinking-hint"><div class="loading"><span></span></div> 正在思考...</div>';
    }

    replyDiv.innerHTML = html || '<span style="color:var(--text-3)">思考中...</span>';
}

async function streamResponseIntoMessage(response, targetEl, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let reasoningText = '';
    let buffer = '';
    let isReasoningDone = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;

            try {
                const data = JSON.parse(trimmed.slice(6));
                if (data.reasoning) {
                    reasoningText += data.reasoning;
                    renderStreamingReply(targetEl, fullText, reasoningText, isReasoningDone);
                }
                if (data.text) {
                    if (!isReasoningDone && reasoningText) isReasoningDone = true;
                    fullText += data.text;
                    renderStreamingReply(targetEl, fullText, reasoningText, isReasoningDone);
                }
                if (data.error) {
                    targetEl.innerHTML = `<span style="color:var(--red)">错误: ${escapeHtml(data.error)}</span>`;
                }
                if (onChunk) onChunk(data);
            } catch (error) {}
        }
    }

    if (fullText || reasoningText) {
        renderStreamingReply(targetEl, fullText, reasoningText, true);
    } else {
        targetEl.innerHTML = '<span style="color:var(--text-3)">未收到回复</span>';
    }

    return fullText;
}

async function saveScenarioMessage(params) {
    try {
        const resp = await fetch('/api/scenario/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await resp.json();
        if (data.session_id) currentScenarioSessionId = data.session_id;
    } catch (e) {
        console.error('saveScenarioMessage failed:', e);
    }
}

async function streamCharacterReply(character, message, replyDiv, statusEl) {
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                character_id: character.id,
                message,
                conversation_id: null,
                api_config: apiConfig,
                scenario_mode: true
            })
        });

        if (!response.ok) {
            let errMsg = `请求失败 (${response.status})`;
            try {
                const data = await response.json();
                errMsg = data.error || errMsg;
            } catch (error) {}
            replyDiv.innerHTML = `<span style="color:var(--red)">${escapeHtml(errMsg)}</span>`;
            statusEl.textContent = '失败';
            setParticipantStatus(character.id, '失败');
            return;
        }

        const fullText = await streamResponseIntoMessage(response, replyDiv);
        statusEl.textContent = '已完成';
        setParticipantStatus(character.id, '已完成');

        if (hallMode && currentScenarioSessionId) {
            await saveScenarioMessage({
                session_id: currentScenarioSessionId,
                round_number: hallRoundCounter,
                character_id: character.id,
                character_name: character.name,
                role: 'speaker',
                content: fullText || ''
            });
        }
    } catch (error) {
        replyDiv.innerHTML = `<span style="color:var(--red)">发送失败: ${escapeHtml(error.message)}</span>`;
        statusEl.textContent = '失败';
        setParticipantStatus(character.id, '失败');
    }
}

function buildRoundtablePrompt(message, speaker) {
    return `你正在被用户单独提问。\n你的身份是：${speaker}\n\n用户问题：${message}\n\n请直接从你的身份与判断出发回答，并遵守这些要求：\n1. 不要假设你知道其他人的回答。\n2. 不要提到你在和其他人协作、讨论或共享信息。\n3. 不要写舞台说明。\n4. 尽量给出有观点、有推理的完整回答。`;
}

async function sendHallMessage() {
    const input = document.getElementById('hall-input');
    const sendBtn = document.getElementById('hall-send-btn');
    if (!input || !sendBtn) return;
    const message = input.value.trim();
    if (!message || isHallGenerating) return;

    if (!apiConfig || !apiConfig.apiKey) {
        showStatus('请先配置密钥', true);
        settingsModal.classList.add('active');
        return;
    }

    appendHallUserMessage(message);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.classList.remove('ready');
    isHallGenerating = true;
    sendBtn.disabled = true;

    try {
        if (hallMode === 'debate') {
            debateMode = 'qa';
            configureScenarioChatUi();
            await runDebateFollowupQa(message);
        } else {
            await runRoundtable(message);
        }
    } finally {
        isHallGenerating = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

async function runRoundtable(message) {
    if (!currentScenarioSessionId) {
        await saveScenarioMessage({
            session_id: null,
            mode: 'roundtable',
            participants: hallSelectedCharacters.map(c => c.id),
            round_number: 0,
            character_name: 'user',
            role: 'moderator',
            content: message
        });
    } else {
        await saveScenarioMessage({
            session_id: currentScenarioSessionId,
            round_number: hallRoundCounter,
            character_name: 'user',
            role: 'moderator',
            content: message
        });
    }
    const roundEl = createHallRound(message);
    if (!roundEl) return;
    for (const character of hallSelectedCharacters) {
        setParticipantStatus(character.id, '回答中', true);
        const placeholder = createHallReplyPlaceholder(roundEl, character);
        placeholder.status.textContent = '回答中';
        const prompt = buildRoundtablePrompt(message, character.name);
        await streamCharacterReply(character, prompt, placeholder.replyDiv, placeholder.status);
    }
}

/* ═══════════════════════════════════════
   DEBATE TEAMS ASSIGNMENT
   ═══════════════════════════════════════ */

function openDebateTeamsModal() {
    debateProSide = [];
    debateConSide = [];
    const modal = document.getElementById('debate-teams-modal');
    if (modal) modal.classList.add('active');
    renderDebateTeamsModal();
}

function closeDebateTeamsModal() {
    const modal = document.getElementById('debate-teams-modal');
    if (modal) modal.classList.remove('active');
}

function renderDebateTeamsModal() {
    const proSlots = document.getElementById('debate-pro-slots');
    const conSlots = document.getElementById('debate-con-slots');
    const unassigned = document.getElementById('debate-unassigned');
    const submitBtn = document.getElementById('debate-teams-submit');
    if (!proSlots || !conSlots || !unassigned || !submitBtn) return;

    const assignedIds = new Set([
        ...debateProSide.map(c => c.id),
        ...debateConSide.map(c => c.id)
    ]);

    proSlots.innerHTML = debateProSide.map(c => '<div class="debate-team-member"><span>' + escapeHtml(c.name) + '</span><button class="debate-team-member-remove" data-remove-side="pro" data-remove-id="' + c.id + '">&times;</button></div>').join('');

    conSlots.innerHTML = debateConSide.map(c => '<div class="debate-team-member"><span>' + escapeHtml(c.name) + '</span><button class="debate-team-member-remove" data-remove-side="con" data-remove-id="' + c.id + '">&times;</button></div>').join('');

    const pool = hallSelectedCharacters.filter(c => !assignedIds.has(c.id));
    unassigned.innerHTML = pool.map(c => '<div class="debate-unassigned-chip"><span class="debate-unassigned-chip-name">' + escapeHtml(c.name) + '</span><div class="debate-unassigned-assign-btns"><button class="debate-unassigned-assign-btn debate-unassigned-assign-btn--pro" data-assign-id="' + c.id + '" data-assign-side="pro">正方</button><button class="debate-unassigned-assign-btn debate-unassigned-assign-btn--con" data-assign-id="' + c.id + '" data-assign-side="con">反方</button></div></div>').join('');

    submitBtn.disabled = debateProSide.length < 1 || debateConSide.length < 1;

    proSlots.querySelectorAll('[data-remove-side]').forEach(btn => {
        btn.addEventListener('click', () => {
            debateProSide = debateProSide.filter(c => c.id !== btn.dataset.removeId);
            renderDebateTeamsModal();
        });
    });
    conSlots.querySelectorAll('[data-remove-side]').forEach(btn => {
        btn.addEventListener('click', () => {
            debateConSide = debateConSide.filter(c => c.id !== btn.dataset.removeId);
            renderDebateTeamsModal();
        });
    });
    unassigned.querySelectorAll('[data-assign-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.assignId;
            const side = btn.dataset.assignSide;
            const ch = hallSelectedCharacters.find(c => c.id === id);
            if (!ch) return;
            if (side === 'pro') debateProSide.push(ch);
            else debateConSide.push(ch);
            renderDebateTeamsModal();
        });
    });
}

function autoAssignSides() {
    debateProSide = [];
    debateConSide = [];
    const chars = [...hallSelectedCharacters];
    const half = Math.floor(chars.length / 2);
    for (let i = 0; i < chars.length; i++) {
        if (i < half) debateProSide.push(chars[i]);
        else debateConSide.push(chars[i]);
    }
    renderDebateTeamsModal();
}

function confirmDebateTeams() {
    if (debateProSide.length < 1 || debateConSide.length < 1) return;
    closeDebateTeamsModal();
    openDebateTopicModal();
}

/* ═══════════════════════════════════════
   DEBATE PROMPT BUILDERS
   ═══════════════════════════════════════ */

function formatDebateHistory(history) {
    const stageLabels = {
        opening: '开篇立论', rebuttal: '驳立论',
        free: '自由辩论', closing: '总结陈词', qa: '追问回答'
    };
    return history.map(entry => {
        const sideTag = entry.side === 'pro' ? '【正方】' : '【反方】';
        const stageTag = stageLabels[entry.stage] || entry.stage;
        return sideTag + entry.speakerName + '（' + stageTag + '）：\n' + entry.content;
    }).join('\n\n---\n\n');
}

function buildDebateOpeningPrompt(topic, speaker, side, teammates, opponents) {
    const sideLabel = side === 'pro' ? '正方（支持辩题）' : '反方（反对辩题）';
    const role = side === 'pro' ? '正方一辩' : '反方一辩';
    const tmNames = teammates.filter(m => m.name !== speaker).map(m => m.name).join('、') || '无';
    const oppNames = opponents.map(m => m.name).join('、');
    let prompt = '【辩论赛 - 开篇立论】\n\n辩题：' + topic;
    if (debateProPosition) prompt += '\n正方核心观点：' + debateProPosition;
    if (debateConPosition) prompt += '\n反方核心观点：' + debateConPosition;
    prompt += '\n你的身份：' + speaker + '\n你的立场：**' + sideLabel + '**\n你的角色：' + role + '\n你的队友：' + tmNames + '\n对方辩手：' + oppNames;
    if (side === 'pro' && debateProPosition) prompt += '\n\n请注意：正方的核心观点是"' + debateProPosition + '"，你的立论应围绕这一观点展开。';
    if (side === 'con' && debateConPosition) prompt += '\n\n请注意：反方的核心观点是"' + debateConPosition + '"，你的立论应围绕这一观点展开。';
    prompt += '\n\n请发表开篇立论陈词，要求：\n1. 明确亮明' + (side === 'pro' ? '正方' : '反方') + '立场，提出 2-3 个核心论点。\n2. 为每个论点提供有力论据或例证。\n3. 保持你一贯的说话风格和思维特点。\n4. 控制在 3-5 段内。\n5. 不要写"作为AI"或舞台说明。直接开始发言。';
    return prompt;
}

function buildDebateRebuttalPrompt(topic, speaker, side, history) {
    const sideLabel = side === 'pro' ? '正方（支持辩题）' : '反方（反对辩题）';
    const historyText = formatDebateHistory(history);
    let prompt = '【辩论赛 - 攻辩 / 驳立论】\n\n辩题：' + topic;
    if (debateProPosition) prompt += '\n正方核心观点：' + debateProPosition;
    if (debateConPosition) prompt += '\n反方核心观点：' + debateConPosition;
    prompt += '\n你的身份：' + speaker + '\n你的立场：**' + sideLabel + '**\n\n以下是到目前为止的辩论记录：\n' + historyText + '\n\n---\n你现在的任务是驳立论。请针对对方的立论进行反驳，要求：\n1. 先概括对方核心论点（指出对方最关键的 1-2 个论点）。\n2. 逐一反驳，指出逻辑漏洞、事实错误或视角盲区。\n3. 可以补充己方新的论据来强化反驳。\n4. 保持你一贯的说话风格。\n5. 控制在 3-5 段内。\n6. 不要写"作为AI"或舞台说明。直接开始发言。';
    return prompt;
}

function buildDebateFreeDebatePrompt(topic, speaker, side, history) {
    const sideLabel = side === 'pro' ? '正方（支持辩题）' : '反方（反对辩题）';
    const historyText = formatDebateHistory(history);
    let p = '【辩论赛 - 自由辩论】\n\n辩题：' + topic;
    if (debateProPosition) p += '\n正方核心观点：' + debateProPosition;
    if (debateConPosition) p += '\n反方核心观点：' + debateConPosition;
    p += '\n你的身份：' + speaker + '\n你的立场：**' + sideLabel + '**\n\n以下是到目前为止的辩论记录：\n' + historyText + '\n\n---\n自由辩论环节。请针对当前辩论局势发言，要求：\n1. 可以反驳对方刚才的发言，或回应对方对你的质疑。\n2. 可以提出新的论据或角度。\n3. 语言要犹利、有力，像真实辩论一样直接交锋。\n4. 可以点名引用对方某位辩手的具体观点并反驳。\n5. 控制在 2-4 段内（自由辩论节奏更快）。\n6. 不要写“作为AI”或舞台说明。直接开始发言。';
    return p;
}

function buildDebateClosingPrompt(topic, speaker, side, history) {
    const sideLabel = side === 'pro' ? '正方（支持辩题）' : '反方（反对辩题）';
    const historyText = formatDebateHistory(history);
    let p = '【辩论赛 - 总结陈词】\n\n辩题：' + topic;
    if (debateProPosition) p += '\n正方核心观点：' + debateProPosition;
    if (debateConPosition) p += '\n反方核心观点：' + debateConPosition;
    p += '\n你的身份：' + speaker + '\n你的立场：**' + sideLabel + '**\n\n以下是整场辩论的完整记录：\n' + historyText + '\n\n---\n你是' + (side === 'pro' ? '正方' : '反方') + '的总结陈词人。请做总结陈词，要求：\n1. 总结己方在整个辩论中的核心论点。\n2. 指出对方论点的关键弱点。\n3. 用一个有力的结尾升华己方立场。\n4. 保持你一贯的说话风格。\n5. 控制在 3-5 段内。\n6. 不要写“作为AI”或舞台说明。直接开始发言。';
    return p;
}
function createDebateStageRound(stageTitle, stageDesc) {
    const roundsEl = document.getElementById('hall-rounds');
    if (!roundsEl) return null;
    hallRoundCounter += 1;
    const empty = roundsEl.querySelector('.rt-empty');
    if (empty) empty.remove();

    const round = document.createElement('section');
    round.className = 'rt-round rt-round--debate';
    round.dataset.round = String(hallRoundCounter);
    round.innerHTML = '<div class="rt-round-head rt-round-head--debate"><div class="rt-round-index">第 ' + hallRoundCounter + ' 阶段</div><div class="rt-round-stage-title">' + escapeHtml(stageTitle) + '</div><div class="rt-round-stage-desc">' + escapeHtml(stageDesc) + '</div></div><div class="rt-round-grid rt-round-grid--debate"></div>';
    roundsEl.appendChild(round);
    roundsEl.scrollTop = roundsEl.scrollHeight;
    return round;
}

function createDebateReplyPlaceholder(roundEl, character, side, roleLabel) {
    const grid = roundEl.querySelector('.rt-round-grid');
    if (!grid) return { status: null, replyDiv: null };
    const card = document.createElement('article');
    card.className = 'rt-reply-card rt-reply-card--' + side;
    card.dataset.charId = character.id;

    const sideBadge = side === 'pro'
        ? '<span class="debate-side-badge debate-side-badge--pro">正方</span>'
        : '<span class="debate-side-badge debate-side-badge--con">反方</span>';

    card.innerHTML = '<div class="rt-reply-card-head rt-reply-card-head--' + side + '"><div class="rt-reply-author"><div class="rt-reply-avatar" style="background:linear-gradient(135deg,' + character.color + ',' + character.color + 'bb)">' + character.name.charAt(0) + '</div><div class="rt-reply-author-copy"><div class="rt-reply-name">' + escapeHtml(character.name) + '</div><div class="rt-reply-meta">' + sideBadge + ' ' + escapeHtml(roleLabel) + '</div></div></div><div class="rt-reply-status" data-status>准备中</div></div><div class="rt-reply-body"><div class="rt-reply-content"><div class="loading"><span></span></div></div></div>';
    grid.appendChild(card);
    grid.scrollTop = grid.scrollHeight;
    return {
        status: card.querySelector('[data-status]'),
        replyDiv: card.querySelector('.rt-reply-content')
    };
}

function renderDebateParticipants() {
    const participantsEl = document.getElementById('hall-participants');
    if (!participantsEl) return;
    participantsEl.innerHTML = '';

    if (debateProSide.length > 0) {
        const proHeader = document.createElement('div');
        proHeader.className = 'debate-sidebar-group-header debate-sidebar-group-header--pro';
        proHeader.textContent = '正方';
        participantsEl.appendChild(proHeader);
        debateProSide.forEach(c => participantsEl.appendChild(createDebateSeat(c, 'pro')));
    }

    if (debateConSide.length > 0) {
        const conHeader = document.createElement('div');
        conHeader.className = 'debate-sidebar-group-header debate-sidebar-group-header--con';
        conHeader.textContent = '反方';
        participantsEl.appendChild(conHeader);
        debateConSide.forEach(c => participantsEl.appendChild(createDebateSeat(c, 'con')));
    }
}

function createDebateSeat(character, side) {
    const item = document.createElement('div');
    item.className = 'rt-seat rt-seat--' + side;
    item.dataset.charId = character.id;
    item.innerHTML = '<div class="rt-seat-avatar" style="background:linear-gradient(135deg,' + character.color + ',' + character.color + 'bb)">' + character.name.charAt(0) + '</div><div class="rt-seat-copy"><div class="rt-seat-name">' + escapeHtml(character.name) + '</div><div class="rt-seat-role">' + (side === 'pro' ? '正方' : '反方') + '</div></div><div class="rt-seat-status" data-participant-status>待开始</div>';
    return item;
}

function updateStageIndicator() {
    const indicator = document.getElementById('debate-stage-indicator');
    if (!indicator || hallMode !== 'debate') {
        if (indicator) indicator.style.display = 'none';
        return;
    }
    indicator.style.display = 'flex';
    const stages = ['opening', 'rebuttal', 'free', 'closing'];
    const currentIdx = stages.indexOf(debateStage);
    indicator.querySelectorAll('.debate-stage-step').forEach(step => {
        const stepStage = step.dataset.stage;
        const stepIdx = stages.indexOf(stepStage);
        step.classList.remove('is-active', 'is-done');
        if (stepStage === debateStage) step.classList.add('is-active');
        else if (currentIdx >= 0 && stepIdx < currentIdx) step.classList.add('is-done');
    });
}

/* ═══════════════════════════════════════
   DEBATE STREAMING (captures history)
   ═══════════════════════════════════════ */

async function streamDebateReply(character, prompt, placeholder, side, stage) {
    if (!placeholder.replyDiv || !placeholder.status) return;

    setParticipantStatus(character.id, '发言中', true);
    placeholder.status.textContent = '发言中';

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                character_id: character.id,
                message: prompt,
                conversation_id: null,
                api_config: apiConfig,
                scenario_mode: true
            })
        });

        if (!response.ok) {
            let errMsg = '请求失败 (' + response.status + ')';
            try { const d = await response.json(); errMsg = d.error || errMsg; } catch(e) {}
            placeholder.replyDiv.innerHTML = '<span style="color:var(--red)">' + escapeHtml(errMsg) + '</span>';
            placeholder.status.textContent = '失败';
            return;
        }

        let fullText = '';
        let reasoningText = '';
        let isReasoningDone = false;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(trimmed.slice(6));
                    if (data.reasoning) {
                        reasoningText += data.reasoning;
                        renderStreamingReply(placeholder.replyDiv, fullText, reasoningText, isReasoningDone);
                    }
                    if (data.text) {
                        if (!isReasoningDone && reasoningText) isReasoningDone = true;
                        fullText += data.text;
                        renderStreamingReply(placeholder.replyDiv, fullText, reasoningText, isReasoningDone);
                    }
                    if (data.error) {
                        placeholder.replyDiv.innerHTML = '<span style="color:var(--red)">错误: ' + escapeHtml(data.error) + '</span>';
                    }
                } catch(e) {}
            }
        }

        if (fullText || reasoningText) {
            renderStreamingReply(placeholder.replyDiv, fullText, reasoningText, true);
        } else {
            placeholder.replyDiv.innerHTML = '<span style="color:var(--text-3)">未收到回复</span>';
        }

        placeholder.status.textContent = '已完成';
        setParticipantStatus(character.id, '已完成');

        if (fullText) {
            debateHistory.push({
                speakerId: character.id,
                speakerName: character.name,
                side: side,
                stage: stage,
                content: fullText
            });
            if (currentScenarioSessionId) {
                await saveScenarioMessage({
                    session_id: currentScenarioSessionId,
                    round_number: hallRoundCounter,
                    stage: stage,
                    character_id: character.id,
                    character_name: character.name,
                    side: side,
                    role: 'speaker',
                    content: fullText
                });
            }
        }
    } catch (error) {
        placeholder.replyDiv.innerHTML = '<span style="color:var(--red)">错误: ' + escapeHtml(error.message) + '</span>';
        placeholder.status.textContent = '失败';
        setParticipantStatus(character.id, '失败');
    }
}

/* ═══════════════════════════════════════
   DEBATE COMPETITION ORCHESTRATOR
   ═══════════════════════════════════════ */

async function runDebateCompetition(topic) {
    debateHistory = [];
    debateFreeRound = 0;
    debateStage = '';
    currentScenarioSessionId = null;
    updateStageIndicator();

    const allParticipants = [...debateProSide, ...debateConSide];
    await saveScenarioMessage({
        session_id: null,
        mode: 'debate',
        topic: topic,
        pro_position: debateProPosition,
        con_position: debateConPosition,
        participants: allParticipants.map(c => c.id),
        pro_side: debateProSide.map(c => c.id),
        con_side: debateConSide.map(c => c.id),
        round_number: 0,
        stage: 'topic',
        character_name: 'moderator',
        role: 'moderator',
        content: '辩题：' + topic
    });

    appendHallUserMessage('辩题：' + topic);

    const hallInput = document.getElementById('hall-input');
    const hallSendBtn = document.getElementById('hall-send-btn');
    if (hallInput) hallInput.disabled = true;
    if (hallSendBtn) hallSendBtn.disabled = true;
    isHallGenerating = true;

    try {
        await runDebateOpening(topic);
        await runDebateRebuttal(topic);
        await runDebateFreeDebate(topic);
        await runDebateClosing(topic);
        debateStage = 'done';
        updateStageIndicator();
    } finally {
        isHallGenerating = false;
        if (hallInput) hallInput.disabled = false;
        if (hallSendBtn) hallSendBtn.disabled = false;
        debateMode = 'qa';
        configureScenarioChatUi();
        if (hallInput) hallInput.focus();
    }
}

async function runDebateOpening(topic) {
    debateStage = 'opening';
    updateStageIndicator();
    const roundEl = createDebateStageRound('开篇立论', '双方一辩分别发表立场与核心论点');
    if (!roundEl) return;

    const proSpeaker = debateProSide[0];
    if (proSpeaker) {
        const ph = createDebateReplyPlaceholder(roundEl, proSpeaker, 'pro', '正方一辩');
        const prompt = buildDebateOpeningPrompt(topic, proSpeaker.name, 'pro', debateProSide, debateConSide);
        await streamDebateReply(proSpeaker, prompt, ph, 'pro', 'opening');
    }

    const conSpeaker = debateConSide[0];
    if (conSpeaker) {
        const ph = createDebateReplyPlaceholder(roundEl, conSpeaker, 'con', '反方一辩');
        const prompt = buildDebateOpeningPrompt(topic, conSpeaker.name, 'con', debateConSide, debateProSide);
        await streamDebateReply(conSpeaker, prompt, ph, 'con', 'opening');
    }
}

async function runDebateRebuttal(topic) {
    debateStage = 'rebuttal';
    updateStageIndicator();
    const roundEl = createDebateStageRound('攻辩 / 驳立论', '双方互相驳斥对方立论');
    if (!roundEl) return;

    const conRebutter = debateConSide[Math.min(1, debateConSide.length - 1)];
    if (conRebutter) {
        const ph = createDebateReplyPlaceholder(roundEl, conRebutter, 'con', '反方驳立论');
        const prompt = buildDebateRebuttalPrompt(topic, conRebutter.name, 'con', debateHistory);
        await streamDebateReply(conRebutter, prompt, ph, 'con', 'rebuttal');
    }

    const proRebutter = debateProSide[Math.min(1, debateProSide.length - 1)];
    if (proRebutter) {
        const ph = createDebateReplyPlaceholder(roundEl, proRebutter, 'pro', '正方驳立论');
        const prompt = buildDebateRebuttalPrompt(topic, proRebutter.name, 'pro', debateHistory);
        await streamDebateReply(proRebutter, prompt, ph, 'pro', 'rebuttal');
    }
}

async function runDebateFreeDebate(topic) {
    debateStage = 'free';
    updateStageIndicator();
    const roundEl = createDebateStageRound('自由辩论', '双方交替发言，共 ' + DEBATE_FREE_MAX_ROUNDS + ' 轮');
    if (!roundEl) return;

    for (let i = 0; i < DEBATE_FREE_MAX_ROUNDS; i++) {
        debateFreeRound = i + 1;

        const proSpeaker = debateProSide[i % debateProSide.length];
        if (proSpeaker) {
            const ph = createDebateReplyPlaceholder(roundEl, proSpeaker, 'pro', '正方·第' + (i + 1) + '轮');
            const prompt = buildDebateFreeDebatePrompt(topic, proSpeaker.name, 'pro', debateHistory);
            await streamDebateReply(proSpeaker, prompt, ph, 'pro', 'free');
        }

        const conSpeaker = debateConSide[i % debateConSide.length];
        if (conSpeaker) {
            const ph = createDebateReplyPlaceholder(roundEl, conSpeaker, 'con', '反方·第' + (i + 1) + '轮');
            const prompt = buildDebateFreeDebatePrompt(topic, conSpeaker.name, 'con', debateHistory);
            await streamDebateReply(conSpeaker, prompt, ph, 'con', 'free');
        }
    }
}

async function runDebateClosing(topic) {
    debateStage = 'closing';
    updateStageIndicator();
    const roundEl = createDebateStageRound('总结陈词', '双方最后陈述');
    if (!roundEl) return;

    const conCloser = debateConSide[debateConSide.length - 1];
    if (conCloser) {
        const ph = createDebateReplyPlaceholder(roundEl, conCloser, 'con', '反方总结陈词');
        const prompt = buildDebateClosingPrompt(topic, conCloser.name, 'con', debateHistory);
        await streamDebateReply(conCloser, prompt, ph, 'con', 'closing');
    }

    const proCloser = debateProSide[debateProSide.length - 1];
    if (proCloser) {
        const ph = createDebateReplyPlaceholder(roundEl, proCloser, 'pro', '正方总结陈词');
        const prompt = buildDebateClosingPrompt(topic, proCloser.name, 'pro', debateHistory);
        await streamDebateReply(proCloser, prompt, ph, 'pro', 'closing');
    }
}

async function runDebateFollowupQa(question) {
    if (currentScenarioSessionId) {
        await saveScenarioMessage({
            session_id: currentScenarioSessionId,
            round_number: hallRoundCounter,
            stage: 'qa',
            character_name: 'moderator',
            role: 'moderator',
            content: question
        });
    }
    const roundEl = createDebateStageRound('主持人追问', question);
    if (!roundEl) return;

    const allParticipants = [...debateProSide, ...debateConSide];
    for (const character of allParticipants) {
        const side = debateProSide.find(m => m.id === character.id) ? 'pro' : 'con';
        const sideLabel = side === 'pro' ? '正方' : '反方';
        setParticipantStatus(character.id, '作答中', true);
        const ph = createDebateReplyPlaceholder(roundEl, character, side, sideLabel + '·追问回答');
        const historyText = formatDebateHistory(debateHistory);

        let prompt = '【辩论赛后追问】\n\n辩题：' + debateTopic;
        if (debateProPosition) prompt += '\n正方核心观点：' + debateProPosition;
        if (debateConPosition) prompt += '\n反方核心观点：' + debateConPosition;
        prompt += '\n你的身份：' + character.name + '\n你的立场：**' + (side === 'pro' ? '正方（支持辩题）' : '反方（反对辩题）') + '**\n\n以下是整场辩论的完整记录：\n' + historyText + '\n\n---\n主持人追问：' + question + '\n\n请基于你在辩论中的立场回答这个问题。可以引用之前的论点，也可以补充新的论据。保持 2-4 段。不要写"作为AI"或舞台说明。直接开始发言。';

        await streamDebateReply(character, prompt, ph, side, 'qa');
    }
}

async function startDistill() {
    const queryInput = document.getElementById('distill-query');
    const query = queryInput.value.trim();
    if (!query || isDistilling) return;

    if (!apiConfig || !apiConfig.apiKey) {
        showStatus('请先配置 API Key', true);
        settingsModal.classList.add('active');
        return;
    }

    const checkResp = await fetch('/api/distill/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    const checkData = await checkResp.json();
    if (!checkData.can_distill) {
        openDistillProgress();
        setDistillStatus(checkData.reason || '当前不能蒸馏');
        appendDistillMsg('error', checkData.reason || '当前不能蒸馏');
        return;
    }

    resetDistillProgressView();
    setDistillUiState(true);
    setDistillStatus(`正在蒸馏「${query}」`);

    try {
        const response = await fetch('/api/distill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, api_config: apiConfig })
        });

        if (!response.ok) {
            let errMsg = `请求失败 (${response.status})`;
            try {
                const data = await response.json();
                errMsg = data.error || errMsg;
            } catch (error) {}
            appendDistillMsg('error', errMsg);
            setDistillUiState(false);
            setDistillStatus(errMsg);
            return;
        }

        await pollDistillProgress(true);
    } catch (error) {
        appendDistillMsg('error', `发送失败: ${error.message}`);
        setDistillUiState(false);
        setDistillStatus(`发送失败: ${error.message}`);
    }
}

function getDistillElements() {
    return {
        modal: document.getElementById('distill-modal'),
        queryInput: document.getElementById('distill-query'),
        startBtn: document.getElementById('distill-start-btn'),
        cancelBtn: document.getElementById('distill-cancel-btn'),
        statusEl: document.getElementById('distill-status'),
        progressEl: document.getElementById('distill-progress')
    };
}

function openDistillProgress() {
    const { modal, progressEl } = getDistillElements();
    modal.classList.add('active');
    progressEl.style.display = 'flex';
}

function resetDistillProgressView() {
    const { progressEl } = getDistillElements();
    openDistillProgress();
    progressEl.innerHTML = '';
    distillRenderedEventIds = new Set();
}

function setDistillStatus(text = '') {
    const { statusEl } = getDistillElements();
    if (!text) {
        statusEl.style.display = 'none';
        statusEl.textContent = '';
        return;
    }
    statusEl.style.display = 'block';
    statusEl.textContent = text;
}

function appendDistillMsg(type, text) {
    const { progressEl } = getDistillElements();
    openDistillProgress();

    if (type === 'text') {
        const last = progressEl.querySelector('.distill-msg.text-stream');
        if (last) {
            last._raw += text;
            last.innerHTML = renderMarkdown(last._raw);
        } else {
            const div = document.createElement('div');
            div.className = 'distill-msg info text-stream';
            div._raw = text;
            div.innerHTML = renderMarkdown(text);
            progressEl.appendChild(div);
        }
        progressEl.scrollTop = progressEl.scrollHeight;
        return;
    }

    const div = document.createElement('div');
    div.className = `distill-msg ${type}`;
    if (type === 'search_result') {
        div.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    } else {
        div.textContent = text;
    }
    progressEl.appendChild(div);
    progressEl.scrollTop = progressEl.scrollHeight;
}

function renderDistillState(state) {
    const events = Array.isArray(state.events) ? state.events : [];
    for (const event of events) {
        if (!event.id || distillRenderedEventIds.has(event.id)) continue;
        distillRenderedEventIds.add(event.id);
        appendDistillMsg(event.type || 'info', event.text || '');
    }

    if (state.query) {
        getDistillElements().queryInput.value = state.query;
    }

    if (state.status === 'running' || state.status === 'cancelling') {
        setDistillStatus(state.status === 'cancelling' ? `正在取消「${state.query || ''}」` : `正在蒸馏「${state.query || ''}」`);
        setDistillUiState(true);
    } else if (state.status === 'done') {
        setDistillUiState(false);
        setDistillStatus(state.name ? `已完成并保存为 ${state.name}` : '蒸馏已完成');
    } else if (state.status === 'cancelled') {
        setDistillUiState(false);
        setDistillStatus('蒸馏已取消');
    } else if (state.status === 'error') {
        setDistillUiState(false);
        setDistillStatus(state.error || '蒸馏失败');
    } else {
        setDistillUiState(false);
    }
}

function stopDistillPolling() {
    if (distillPollTimer) {
        clearTimeout(distillPollTimer);
        distillPollTimer = null;
    }
}

function setDistillUiState(running) {
    const { startBtn, cancelBtn } = getDistillElements();
    isDistilling = running;
    startBtn.disabled = running;
    startBtn.textContent = running ? '蒸馏中...' : '开始蒸馏';
    cancelBtn.style.display = running ? 'inline-flex' : 'none';
    cancelBtn.disabled = false;
    if (!running) stopDistillPolling();
}

async function pollDistillProgress(immediate = false) {
    stopDistillPolling();

    const run = async () => {
        try {
            const response = await fetch('/api/distill/progress');
            const state = await response.json();
            if (!state || state.status === 'none') {
                setDistillUiState(false);
                return;
            }

            renderDistillState(state);

            if (state.status === 'running' || state.status === 'cancelling') {
                distillPollTimer = setTimeout(() => pollDistillProgress(true), 1200);
            } else {
                if (state.status === 'done') await loadCharacters();
                stopDistillPolling();
            }
        } catch (error) {
            distillPollTimer = setTimeout(() => pollDistillProgress(true), 2000);
        }
    };

    if (immediate) {
        await run();
    } else {
        distillPollTimer = setTimeout(run, 0);
    }
}

async function cancelDistill() {
    if (!isDistilling) return;
    const { cancelBtn } = getDistillElements();
    cancelBtn.disabled = true;
    try {
        await fetch('/api/distill/cancel', { method: 'POST' });
        setDistillStatus('正在取消蒸馏...');
        await pollDistillProgress(true);
    } catch (error) {
        appendDistillMsg('error', `取消失败: ${error.message}`);
        cancelBtn.disabled = false;
    }
}

async function restoreDistillProgress() {
    try {
        const response = await fetch('/api/distill/progress');
        const state = await response.json();
        if (!state || state.status === 'none') return;
        if (state.status === 'running' || state.status === 'cancelling') {
            if (!Array.isArray(state.events) || state.events.length === 0) return;
            resetDistillProgressView();
            renderDistillState(state);
            await pollDistillProgress(true);
        }
    } catch (error) {}
}

function setupEventListeners() {
    const bind = (id, event, handler) => {
        const el = document.getElementById(id);
        if (!el) {
            console.warn(`Missing element: ${id}`);
            return null;
        }
        el.addEventListener(event, handler);
        return el;
    };

    backBtn.addEventListener('click', goBack);
    sendBtn.addEventListener('click', sendMessage);
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('active'));
    chatSettingsBtn.addEventListener('click', () => settingsModal.classList.add('active'));
    closeSettings.addEventListener('click', () => settingsModal.classList.remove('active'));
    settingsForm.addEventListener('submit', saveApiConfig);
    bind('fetch-models-btn', 'click', fetchModels);
    closeModelList.addEventListener('click', () => { modelListPanel.style.display = 'none'; });

    apiType.addEventListener('change', (event) => {
        baseUrlGroup.style.display = event.target.value === 'openai' ? 'block' : 'none';
    });

    settingsModal.addEventListener('click', (event) => {
        if (event.target === settingsModal) settingsModal.classList.remove('active');
    });

    chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    chatInput.addEventListener('input', () => {
        autoResizeInput();
        sendBtn.classList.toggle('ready', chatInput.value.trim().length > 0);
    });

    charIntroToggle.addEventListener('click', () => {
        const collapsed = charIntroBody.classList.toggle('collapsed');
        charIntroArrow.textContent = collapsed ? '展开 ▼' : '收起 ▼';
    });

    historyBtn.addEventListener('click', openHistory);
    chatHistoryBtn.addEventListener('click', openHistory);
    closeHistory.addEventListener('click', closeHistoryPanel);
    historyOverlay.addEventListener('click', closeHistoryPanel);

    bind('hall-btn', 'click', enterHall);
    bind('debate-btn', 'click', enterDebate);
    bind('hall-back-btn', 'click', exitHall);
    bind('hall-confirm-btn', 'click', confirmHall);
    bind('hall-chat-back', 'click', exitHallChat);
    bind('hall-send-btn', 'click', sendHallMessage);
    bind('hall-chat-settings', 'click', () => settingsModal.classList.add('active'));
    bind('hall-mode-roundtable', 'click', () => {
        if (hallMode !== 'roundtable') enterScenarioMode('roundtable');
    });
    bind('hall-mode-debate', 'click', () => {
        if (hallMode !== 'debate') enterScenarioMode('debate');
    });

    bind('close-debate-topic', 'click', closeDebateTopicModal);
    bind('debate-topic-cancel', 'click', closeDebateTopicModal);
    bind('debate-topic-submit', 'click', submitDebateTopic);
    if (debateTopicModal) {
        debateTopicModal.addEventListener('click', (event) => {
            if (event.target === debateTopicModal) closeDebateTopicModal();
        });
    }

    // Debate teams modal bindings
    bind('close-debate-teams', 'click', closeDebateTeamsModal);
    bind('debate-teams-cancel', 'click', closeDebateTeamsModal);
    bind('debate-teams-submit', 'click', confirmDebateTeams);
    bind('debate-auto-assign', 'click', autoAssignSides);
    const debateTeamsModal = document.getElementById('debate-teams-modal');
    if (debateTeamsModal) {
        debateTeamsModal.addEventListener('click', (event) => {
            if (event.target === debateTeamsModal) closeDebateTeamsModal();
        });
    }

    document.querySelectorAll('[data-topic-suggestion]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const input = document.getElementById('debate-topic-input');
            if (!input) return;
            input.value = chip.dataset.topicSuggestion || '';
            const proInput = document.getElementById('debate-pro-position');
            const conInput = document.getElementById('debate-con-position');
            if (proInput) proInput.value = chip.dataset.pro || '';
            if (conInput) conInput.value = chip.dataset.con || '';
            input.focus();
        });
    });

    const debateTopicInput = document.getElementById('debate-topic-input');
    if (debateTopicInput) {
        debateTopicInput.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                submitDebateTopic();
            }
        });
    }

    const hallInput = document.getElementById('hall-input');
    if (hallInput) {
        hallInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendHallMessage();
            }
        });
        hallInput.addEventListener('input', () => {
            hallInput.style.height = 'auto';
            hallInput.style.height = `${Math.min(hallInput.scrollHeight, 120)}px`;
            const hallSendBtn = document.getElementById('hall-send-btn');
            if (hallSendBtn) {
                hallSendBtn.classList.toggle('ready', hallInput.value.trim().length > 0);
            }
        });
    }

    const adminModal = document.getElementById('admin-modal');
    bind('admin-btn', 'click', () => {
        adminModal.classList.add('active');
        loadAdminUsers();
    });
    bind('close-admin', 'click', () => adminModal.classList.remove('active'));
    if (adminModal) adminModal.addEventListener('click', (event) => {
        if (event.target === adminModal) adminModal.classList.remove('active');
    });

    const distillModal = document.getElementById('distill-modal');
    bind('distill-btn', 'click', () => {
        distillModal.classList.add('active');
        document.getElementById('distill-query').focus();
    });
    bind('close-distill', 'click', () => {
        if (!isDistilling) distillModal.classList.remove('active');
    });
    distillModal.addEventListener('click', (event) => {
        if (event.target === distillModal && !isDistilling) distillModal.classList.remove('active');
    });
    bind('distill-start-btn', 'click', startDistill);
    bind('distill-cancel-btn', 'click', cancelDistill);
    const distillQuery = document.getElementById('distill-query');
    if (distillQuery) {
        distillQuery.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                startDistill();
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', init);
