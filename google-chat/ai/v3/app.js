// app.js
/* =========================
   Settings and globals
   ========================= */
const SETTINGS_KEY = "hp_chat_settings_v1";
const DEFAULT_SETTINGS = { theme: "system", sounds: true, volume: 80, motion: true, muted: false, randomness: 0.2 };

let messages = []; // chronological
let messagesById = {};
let messagesIndex = {};
let invertedIndex = {}; // token -> Set(ids)
let selectedPersona = null;
let sessionWindow = []; // recent message ids
const SESSION_WINDOW_SIZE = 40;

/* =========================
   Utilities
   ========================= */
function el(id) { return document.getElementById(id); }
function safeText(m) { return (m.text || m.message?.text || m.content || "").toString(); }
function normalize(text) { return (text || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim(); }
function tokensFor(text) {
    const words = normalize(text).split(" ").filter(Boolean);
    const tokens = new Set();
    for (const w of words) tokens.add(w);
    for (let i = 0; i < words.length - 1; i++) tokens.add(words[i] + " " + words[i + 1]);
    return Array.from(tokens);
}
function weightedPick(items, scoreKey = 'score') {
    if (!items || !items.length) return null;
    const total = items.reduce((s, i) => s + Math.max(0, i[scoreKey] || 0), 0);
    if (total <= 0) return items[Math.floor(Math.random() * items.length)];
    let r = Math.random() * total;
    for (const it of items) {
        r -= Math.max(0, it[scoreKey] || 0);
        if (r <= 0) return it;
    }
    return items[items.length - 1];
}

/* =========================
   Theme & settings
   ========================= */
function loadSettings() { try { const raw = localStorage.getItem(SETTINGS_KEY); return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : DEFAULT_SETTINGS; } catch { return DEFAULT_SETTINGS; } }
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function applyTheme(theme) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
    else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (prefersDark) document.documentElement.setAttribute("data-theme", "dark");
        else document.documentElement.removeAttribute("data-theme");
    }
}

/* =========================
   WebAudio beep engine (synthesized tones)
   ========================= */
const beepSettings = {
    sent: { freq: 1800, dur: 0.03, type: "sine", gain: 0.18 },
    received: { freq: 880, dur: 0.14, type: "sine", gain: 0.16 },
    loaded: { freq: 1200, dur: 0.09, type: "sine", gain: 0.16 },
    error: { freq: 320, dur: 0.09, type: "sine", gain: 0.18 }
};
let audioCtx = null, masterGain = null, audioUnlocked = false;
function ensureAudioContext() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 1;
        masterGain.connect(audioCtx.destination);
    } catch (e) { audioCtx = null; }
}
function unlockAudioOnGesture() {
    if (audioUnlocked) return;
    ensureAudioContext();
    if (!audioCtx) return;
    audioCtx.resume && audioCtx.resume().catch(() => { });
    const g = audioCtx.createGain(); g.gain.value = 0; g.connect(audioCtx.destination);
    const o = audioCtx.createOscillator(); o.frequency.value = 440; o.connect(g); o.start();
    setTimeout(() => { try { o.stop(); g.disconnect(); } catch (e) { } }, 50);
    audioUnlocked = true;
    document.removeEventListener("click", unlockAudioOnGesture);
    document.removeEventListener("keydown", unlockAudioOnGesture);
}
document.addEventListener("click", unlockAudioOnGesture, { once: true });
document.addEventListener("keydown", unlockAudioOnGesture, { once: true });

function playBeep(opts = {}, settings = { sounds: true, muted: false, volume: 80 }) {
    if (!settings || !settings.sounds || settings.muted) return;
    ensureAudioContext();
    if (!audioCtx) return;
    if (!audioUnlocked) { try { audioCtx.resume && audioCtx.resume(); } catch (e) { } }
    const cfg = Object.assign({ attack: 0.005, release: 0.02 }, opts);
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = cfg.type || "sine";
    osc.frequency.value = cfg.freq || 880;
    const vol = (settings.volume ?? 80) / 100;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime((cfg.gain || 0.12) * vol, now + cfg.attack);
    g.gain.setValueAtTime((cfg.gain || 0.12) * vol, now + cfg.attack + (cfg.dur || 0.1) - cfg.release);
    g.gain.linearRampToValueAtTime(0.0001, now + (cfg.dur || 0.1) + cfg.release);
    osc.connect(g); g.connect(masterGain || audioCtx.destination);
    osc.start(now); osc.stop(now + (cfg.dur || 0.1) + cfg.release + 0.01);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) { } };
}
function playSound(name, settings) { const s = beepSettings[name]; if (!s) return; playBeep({ freq: s.freq, dur: s.dur, type: s.type, gain: s.gain }, settings); }

/* =========================
   File load, normalize, index
   ========================= */
function detectSystemMessage(m) {
    const t = (m._norm || "").trim();
    if (!t) return true;
    if (t.length < 6) return true;
    const sysPhrases = ["updated room membership", "joined the space", "left the space", "created the space", "added", "removed", "changed the topic", "space updated"];
    for (const p of sysPhrases) if (t.includes(p)) return true;
    if (!m.authorEmail) return true;
    return false;
}

async function loadFile(file) {
    const fileStatus = el("fileStatus"), progressContainer = el("progressContainer"), progressBar = el("progressBar");
    fileStatus.textContent = "Reading file...";
    progressContainer.style.display = "block"; progressBar.style.width = "0%";
    let raw;
    try { const text = await file.text(); raw = JSON.parse(text); } catch (err) { fileStatus.textContent = "Invalid JSON file."; progressContainer.style.display = "none"; playSound('error', loadSettings()); return; }

    let rawMessages = [];
    if (Array.isArray(raw)) rawMessages = raw;
    else if (Array.isArray(raw.messages)) rawMessages = raw.messages;
    else if (Array.isArray(raw.conversations)) {
        for (const conv of raw.conversations) {
            if (!Array.isArray(conv.events)) continue;
            for (const ev of conv.events) {
                const m = ev.message || ev;
                const text = m.text || m.message?.text || m.content || "";
                rawMessages.push(Object.assign({}, m, { text }));
            }
        }
    } else { console.warn("Unknown JSON shape", raw); }

    messages = []; messagesById = {}; messagesIndex = {}; invertedIndex = {};
    const chunkSize = 500;
    for (let i = 0; i < rawMessages.length; i += chunkSize) {
        const chunk = rawMessages.slice(i, i + chunkSize);
        for (const m of chunk) {
            m.text = safeText(m);
            m._norm = normalize(m.text);
            m._tokens = tokensFor(m.text);
            m._len = m._norm.length;
            m.authorEmail = (m.creator && m.creator.email) || (m.sender && m.sender.email) || (m.message && m.message.sender && m.message.sender.email) || null;
            m.authorName = (m.creator && m.creator.name) || (m.sender && m.sender.name) || (m.message && m.message.sender && m.message.sender.name) || null;
            m.ts = m.ts || m.timestamp || m.time || Date.now();
            m.isSystem = detectSystemMessage(m);
            m.id = m.id || m.messageId || `m_${i}_${Math.random().toString(36).slice(2, 9)}`;
            messagesById[m.id] = m;
            messages.push(m);
        }
        const pct = Math.min(100, Math.floor(((i + chunk.length) / Math.max(1, rawMessages.length)) * 100));
        progressBar.style.width = pct + "%";
        await new Promise(requestAnimationFrame);
    }

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        messagesIndex[m.id] = i;
        for (const t of m._tokens) {
            if (!invertedIndex[t]) invertedIndex[t] = new Set();
            invertedIndex[t].add(m.id);
        }
    }

    progressBar.style.width = "100%";
    fileStatus.textContent = `Loaded ${messages.length} messages.`;
    el("messagesMeta").textContent = `Messages: ${messages.length}`;
    const people = extractPeople(raw, messages);
    renderPeopleList(people);
    fileStatus.textContent = `Loaded ${messages.length} messages and ${people.length} people.`;
    playSound('loaded', loadSettings());
}

/* =========================
   People extraction & UI
   ========================= */
function extractPeople(raw, messagesArray = []) {
    const people = new Map();
    function add(name, email) { if (!email) return; if (!people.has(email)) people.set(email, name || "(no name)"); }
    if (Array.isArray(raw.messages)) for (const m of raw.messages) if (m.creator && m.creator.email) add(m.creator.name, m.creator.email);
    if (Array.isArray(raw.conversations)) for (const conv of raw.conversations) {
        if (!Array.isArray(conv.events)) continue;
        for (const ev of conv.events) {
            const msg = ev.message || ev;
            const sender = msg.sender || msg.creator || msg.user || {};
            const name = sender.name || sender.displayName || sender.fullName || null;
            const email = sender.email || sender.emailAddress || sender.userEmail || null;
            add(name, email);
        }
    }
    for (const m of messagesArray) {
        if (m.creator && m.creator.email) add(m.creator.name, m.creator.email);
        const sender = m.sender || m.message?.sender || m.creator || {};
        const name = sender.name || sender.displayName || null;
        const email = sender.email || sender.emailAddress || null;
        add(name, email);
    }
    return Array.from(people.entries()).map(([email, name]) => ({ name, email }));
}

function renderPeopleList(people) {
    const list = el("peopleList"), meta = el("peopleMeta");
    if (!list) return;
    list.innerHTML = "";
    people.sort((a, b) => (a.name || "").localeCompare(b.name || "")).forEach(p => {
        const li = document.createElement("li");
        li.textContent = p.name + " — " + p.email;
        li.classList.add("person-hover");
        li.addEventListener("click", () => {
            Array.from(list.children).forEach(c => c.classList.remove("selected-persona"));
            li.classList.add("selected-persona");
            selectedPersona = p;
            // load persona profile if exists
            const profile = loadPersonaProfile(p.email);
            selectedPersona = Object.assign({}, p, profile);
            el("selectedPersonaLabel").textContent = "Persona: " + (selectedPersona.name || selectedPersona.email);
        });
        list.appendChild(li);
    });
    meta.textContent = people.length ? `${people.length} people` : "No people found";
}

/* =========================
   Retrieval, scoring, context fusion
   ========================= */
const STOPWORDS = new Set(["the", "and", "is", "a", "an", "of", "to", "in", "on", "for", "with", "that", "this", "it", "you", "how", "are", "i", "me", "my", "we", "us", "hi", "hey", "ok", "okay"]);
function extractKeywords(text) { if (!text) return []; return normalize(text).split(/\s+/).filter(Boolean).filter(w => !STOPWORDS.has(w)); }

function retrieveCandidates(userText, maxCandidates = 200) {
    const toks = tokensFor(userText);
    const counts = new Map();
    for (const t of toks) {
        const set = invertedIndex[t];
        if (!set) continue;
        for (const id of set) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const userLen = (userText || "").length;
    const scored = [];
    for (const [id, matchCount] of counts.entries()) {
        const m = messagesById[id];
        if (!m || m.isSystem) continue;
        const lenScore = 1 / (1 + Math.abs(m._len - userLen));
        const recency = Math.exp(-(Date.now() - (m.ts || Date.now())) / (1000 * 60 * 60 * 24));
        const score = matchCount * 100 + lenScore * 10 + recency * 5 - (m._len < 20 ? 10 : 0);
        scored.push({ id, score, matchCount });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxCandidates);
}

function harvestReplies(candidates, personaEmail, lookahead = 60) {
    const replies = [];
    for (const c of candidates) {
        const startIdx = messagesIndex[c.id];
        if (startIdx == null) continue;
        for (let i = startIdx + 1; i < Math.min(messages.length, startIdx + 1 + lookahead); i++) {
            const m = messages[i];
            if (!m) continue;
            const email = m.authorEmail || null;
            if (!email) continue;
            if (email === personaEmail && !m.isSystem && (m._len || 0) > 6) {
                replies.push({ text: m.text, sourceId: c.id, score: c.score, ts: m.ts });
                break;
            }
        }
    }
    return replies;
}

function buildSessionContext(lookback = 6) {
    const ids = sessionWindow.slice(-lookback);
    return ids.map(id => {
        const m = messagesById[id];
        if (!m) return "";
        const who = (m.authorEmail === selectedPersona?.email) ? (selectedPersona.name || "Persona") : "User";
        return `${who}: ${m.text}`;
    }).filter(Boolean).join("\n");
}

function rewriteForPersona(text, persona, sessionContext = "") {
    if (!persona) return text;
    let out = text;
    if (persona.preferShortReplies) out = out.split(/[\.\!\?]\s/)[0];
    if (sessionContext && /meeting|schedule|deadline/.test(sessionContext) && /ok|sure|will do/i.test(out)) {
        out = "About that — " + out;
    }
    out = out.replace(/\bI will\b/gi, "I'll").replace(/\bI am\b/gi, "I'm").trim();
    return out;
}

function pickReplyForUser(userText) {
    if (!selectedPersona) return null;
    const keywords = extractKeywords(userText);
    if (!keywords.length) return null;
    const candidates = retrieveCandidates(userText, 200);
    if (!candidates.length) return null;
    const sessionSet = new Set(sessionWindow);
    for (const c of candidates) if (sessionSet.has(c.id)) c.score *= 1.25;
    const replies = harvestReplies(candidates, selectedPersona.email, 60);
    if (!replies.length) return null;
    for (const r of replies) {
        const recency = Math.exp(-(Date.now() - (r.ts || Date.now())) / (1000 * 60 * 60 * 24));
        r.score = (r.score || 0) * 0.7 + recency * 10 + Math.min(1, (r.text || "").length / 200) * 5;
    }
    const chosen = weightedPick(replies, 'score');
    if (!chosen) return null;
    const sessionContext = buildSessionContext(6);
    return rewriteForPersona(chosen.text, selectedPersona, sessionContext);
}

/* =========================
   Composer flow & UI helpers
   ========================= */
function addMessage(whoClass, whoLabel, text, opts = {}) {
    const chat = el("chat");
    if (!chat) return;
    const div = document.createElement("div");
    div.className = "msg " + (whoClass === "user" ? "user" : "bot");
    if (opts.animate && loadSettings().motion) div.classList.add("fade-slide-up", "in");
    const who = document.createElement("span"); who.className = "who"; who.textContent = whoLabel;
    const body = document.createElement("div"); body.textContent = text;
    div.appendChild(who); div.appendChild(body);
    chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
}

function showTypingIndicator() {
    const chat = el("chat"); if (!chat) return null;
    const div = document.createElement("div"); div.className = "msg bot typing-wrap";
    const who = document.createElement("span"); who.className = "who"; who.textContent = selectedPersona ? (selectedPersona.name || selectedPersona.email) : "Persona";
    const bubble = document.createElement("div"); bubble.className = "typing"; bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    div.appendChild(who); div.appendChild(bubble); chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
    return div;
}
function removeTypingIndicator(node) { if (!node) return; node.remove(); }

function handleUserSend() {
    const input = el("msgInput"); const text = (input.value || "").trim(); if (!text) return;
    addMessage("user", "You", text, { animate: true });
    playSound('sent', loadSettings());
    input.value = "";
    const syntheticId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionWindow.push(syntheticId); if (sessionWindow.length > SESSION_WINDOW_SIZE) sessionWindow.shift();
    const typingNode = showTypingIndicator();
    setTimeout(() => {
        const reply = pickReplyForUser(text);
        const settings = loadSettings();
        removeTypingIndicator(typingNode);
        if (reply) {
            playSound('received', settings);
            addMessage("bot", selectedPersona ? (selectedPersona.name || selectedPersona.email) : "Persona", reply, { animate: true });
        } else {
            playSound('received', settings);
            const fallback = selectedPersona ? `${selectedPersona.name}: I don't have a matching reply right now.` : "I don't have a matching reply right now.";
            addMessage("bot", selectedPersona ? (selectedPersona.name || selectedPersona.email) : "Persona", fallback, { animate: true });
        }
    }, 350 + Math.random() * 400);
}

/* =========================
   Persona profile storage & feedback
   ========================= */
function savePersonaProfile(profile) { if (!profile || !profile.email) return; localStorage.setItem('hp_persona_' + profile.email, JSON.stringify(profile)); }
function loadPersonaProfile(email) { try { const raw = localStorage.getItem('hp_persona_' + email); return raw ? JSON.parse(raw) : { tone: 'neutral', preferShortReplies: false, commonPhrases: [] }; } catch { return { tone: 'neutral', preferShortReplies: false, commonPhrases: [] }; } }

function logFeedback(replyText, accepted) {
    const key = 'hp_feedback';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.push({ ts: Date.now(), persona: selectedPersona?.email, reply: replyText, accepted: !!accepted });
    localStorage.setItem(key, JSON.stringify(arr));
}

/* =========================
   Clear & settings UI wiring
   ========================= */
function clearAll() {
    messages = []; messagesById = {}; messagesIndex = {}; invertedIndex = {}; selectedPersona = null; sessionWindow = [];
    el("chat").innerHTML = ""; el("peopleList").innerHTML = ""; el("fileStatus").textContent = "No file loaded"; el("peopleMeta").textContent = "—";
    el("selectedPersonaLabel").textContent = "No persona selected"; el("messagesMeta").textContent = "Messages: 0"; el("progressBar").style.width = "0%"; el("progressContainer").style.display = "none"; el("fileInput").value = "";
}

function wireSettingsUI() {
    const settings = loadSettings();
    const themeSelect = el("themeSelect"), soundsToggle = el("soundsToggle"), volumeSlider = el("volumeSlider"), motionToggle = el("motionToggle");
    const settingsBtn = el("settingsBtn"), modal = el("settingsModal"), closeBtn = el("closeSettings"), saveBtn = el("saveSettings");
    const muteBtn = el("muteBtn"), themeToggle = el("themeToggle");
    if (themeSelect) themeSelect.value = settings.theme;
    if (soundsToggle) soundsToggle.checked = settings.sounds;
    if (volumeSlider) volumeSlider.value = settings.volume;
    if (motionToggle) motionToggle.checked = settings.motion;
    if (muteBtn) muteBtn.textContent = settings.muted ? "🔇" : "🔈";
    applyTheme(settings.theme);

    if (settingsBtn) settingsBtn.addEventListener("click", () => { modal.setAttribute("aria-hidden", "false"); modal.querySelector(".modal-content")?.classList.add("fade-slide-up", "in"); });
    if (closeBtn) closeBtn.addEventListener("click", () => { modal.setAttribute("aria-hidden", "true"); modal.querySelector(".modal-content")?.classList.remove("in"); });
    if (saveBtn) saveBtn.addEventListener("click", () => {
        const s = loadSettings();
        s.theme = themeSelect?.value || s.theme;
        s.sounds = soundsToggle?.checked ?? s.sounds;
        s.volume = Number(volumeSlider?.value ?? s.volume);
        s.motion = motionToggle?.checked ?? s.motion;
        saveSettings(s); applyTheme(s.theme); modal.setAttribute("aria-hidden", "true");
    });
    if (muteBtn) muteBtn.addEventListener("click", () => { const s = loadSettings(); s.muted = !s.muted; saveSettings(s); muteBtn.textContent = s.muted ? "🔇" : "🔈"; });
    if (themeToggle) themeToggle.addEventListener("click", () => { const s = loadSettings(); s.theme = (s.theme === "dark") ? "light" : "dark"; saveSettings(s); applyTheme(s.theme); themeSelect.value = s.theme; });
}

/* =========================
   Wiring & startup
   ========================= */
document.addEventListener("DOMContentLoaded", () => {
    const input = el("msgInput"), sendBtn = el("sendBtn"), fileInput = el("fileInput"), clearBtn = el("clearBtn");
    if (fileInput) fileInput.addEventListener("change", () => { const f = fileInput.files[0]; if (f) loadFile(f); });
    if (sendBtn && input) { sendBtn.addEventListener("click", handleUserSend); input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleUserSend(); } }); }
    if (clearBtn) clearBtn.addEventListener("click", clearAll);
    wireSettingsUI();
    addMessage("bot", "System", "Upload a JSON export, select a persona, then type to chat. Use Settings for theme and sounds.");
});