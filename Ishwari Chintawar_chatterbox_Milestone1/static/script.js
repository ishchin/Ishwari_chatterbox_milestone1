let username = null;
let room = null;
let ws = null;

const messages = document.getElementById("messages");
const input = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const leaveBtn = document.getElementById("leaveBtn");
const typingIndicator = document.getElementById("typingIndicator");
const userList = document.getElementById("userList");
const userCount = document.getElementById("userCount");
const roomLabel = document.getElementById("roomLabel");
const chatTitle = document.getElementById("chatTitle");
const emojiBtn = document.getElementById("emojiBtn");
const attachBtn = document.getElementById("attachBtn");
const cameraBtn = document.getElementById("cameraBtn");
const audioBtn = document.getElementById("audioBtn");
const fileInput = document.getElementById("fileInput");
const cameraInput = document.getElementById("cameraInput");
const emojiPanel = document.getElementById("emojiPanel");
const pinnedArea = document.getElementById("pinnedArea");
const searchInput = document.getElementById("searchInput");
const roomsList = document.getElementById("roomsList");
const loginScreen = document.getElementById("loginScreen");
const appShell = document.getElementById("appShell");
const loginName = document.getElementById("loginName");
const loginPassword = document.getElementById("loginPassword");
const loginRoomSelect = document.getElementById("loginRoomSelect");
const loginRoom = document.getElementById("loginRoom");
const loginBtn = document.getElementById("loginBtn");
const loginHint = document.getElementById("loginHint");
const connStatus = document.getElementById("connStatus");
const clearChatBtn = document.getElementById("clearChatBtn");

const typingUsers = new Set();
let iAmTyping = false;
let typingStopTimer = null;
let pendingTypingState = null; // boolean | null
let pendingJoin = null;
let replyToId = null;

const messageIndex = new Map(); // id -> { data, row }
const lastActive = new Map(); // username -> Date
let mediaRecorder = null;
let audioChunks = [];

const EMOJIS = [
    "😀","😁","😂","🤣","😊","😍","😘","😎",
    "🙂","😉","😅","🥹","😭","😤","😡","🤯",
    "👍","👎","🙏","👏","💪","🔥","✨","🎉",
    "❤️","💙","💚","💛","💜","🖤","🤍","💯",
    "🙌","🤝","👌","🤞","✌️","🤗","🤔","😴",
    "🍕","🍔","☕","🍫","🎁","🎶","⚽","🏏"
];

function escapeText(s) {
    return (s ?? "").toString();
}

function formatTime(isoTs) {
    if (!isoTs) return "";
    try {
        const d = new Date(isoTs);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
        return "";
    }
}

function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
}

function addSystem(text) {
    const system = document.createElement("div");
    system.className = "system-message";
    system.innerText = text;
    messages.appendChild(system);
    scrollToBottom();
}

function addChatMessage(msg) {
    const { id, username: sender, text, ts, replyTo, reactions, receipts, media } = msg;

    const existing = id && messageIndex.get(id);
    if (existing) {
        // Update existing bubble (used for reactions)
        renderReactions(existing.row, reactions || {});
        return;
    }

    const row = document.createElement("div");
    row.className = "message-row";
    const mine = sender === username;
    if (mine) row.classList.add("mine");

    if (id) {
        row.dataset.id = id;
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (!mine) {
        const header = document.createElement("div");
        header.className = "msg-header";
        header.innerText = escapeText(sender);
        bubble.appendChild(header);
    }

    if (replyTo && messageIndex.has(replyTo)) {
        const original = messageIndex.get(replyTo).data;
        const reply = document.createElement("div");
        reply.className = "reply-snippet";
        reply.innerText = `${original.username}: ${original.text.slice(0, 40)}${original.text.length > 40 ? "…" : ""}`;
        bubble.appendChild(reply);
    }

    const msgText = document.createElement("div");
    msgText.className = "msg-text";
    msgText.innerText = escapeText(text);
    bubble.appendChild(msgText);

    if (media && media.url) {
        const ct = (media.content_type || "").toLowerCase();
        if (ct.startsWith("image/")) {
            const img = document.createElement("img");
            img.className = "media-thumb";
            img.src = media.url;
            img.alt = media.filename || "image";
            bubble.appendChild(img);
        } else if (ct.startsWith("audio/")) {
            const audio = document.createElement("audio");
            audio.controls = true;
            audio.src = media.url;
            bubble.appendChild(audio);
        } else {
            const link = document.createElement("a");
            link.className = "media-link";
            link.href = media.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.innerText = media.filename || "Download file";
            bubble.appendChild(link);
        }
    }

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    bubble.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "msg-action-btn";
    replyBtn.innerText = "↩";
    replyBtn.title = "Reply";
    replyBtn.onclick = () => {
        if (!id) return;
        replyToId = id;
        showReplyPreview(msg);
        input.focus();
    };
    actions.appendChild(replyBtn);

    const reactBtn = document.createElement("button");
    reactBtn.type = "button";
    reactBtn.className = "msg-action-btn";
    reactBtn.innerText = "❤️";
    reactBtn.title = "Toggle heart reaction";
    reactBtn.onclick = () => toggleReaction(id, "❤️");
    actions.appendChild(reactBtn);

    if (mine) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "msg-action-btn";
        delBtn.innerText = "🗑";
        delBtn.title = "Delete for me";
        delBtn.onclick = () => {
            row.style.display = "none";
        };
        actions.appendChild(delBtn);
    }

    bubble.appendChild(actions);

    const reactionsRow = document.createElement("div");
    reactionsRow.className = "msg-reactions";
    bubble.appendChild(reactionsRow);

    renderReactions(row, reactions || {});

    updateMetaFor(row, msg);

    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToBottom();
    if (id) {
        messageIndex.set(id, { data: msg, row });
    }
}

function computeTickStatus(msg) {
    const receipts = msg.receipts || {};
    const entries = Object.entries(receipts);
    if (!entries.length) return "single";
    const others = entries.filter(([user]) => user !== msg.username);
    if (!others.length) return "single";
    const anySeen = others.some(([, r]) => r && r.seen);
    if (anySeen) return "blue-double";
    return "double";
}

function renderTicks(status) {
    if (status === "single") {
        return '<span class="tick">✓</span>';
    }
    if (status === "double") {
        return '<span class="tick">✓✓</span>';
    }
    if (status === "blue-double") {
        return '<span class="tick tick-blue">✓✓</span>';
    }
    return "";
}

function updateMetaFor(row, msg) {
    const meta = row.querySelector(".msg-meta");
    if (!meta) return;
    const timeStr = formatTime(msg.ts);
    if (msg.username === username) {
        const status = computeTickStatus(msg);
        meta.innerHTML = `${timeStr} ${renderTicks(status)}`;
    } else {
        meta.innerText = timeStr;
    }
}

function renderReactions(row, reactions) {
    const bubble = row.querySelector(".bubble");
    if (!bubble) return;
    const host = bubble.querySelector(".msg-reactions");
    if (!host) return;

    host.innerHTML = "";
    const entries = Object.entries(reactions || {});
    if (!entries.length) return;

    const strip = document.createElement("div");
    strip.className = "reaction-strip";

    for (const [emoji, users] of entries) {
        if (!Array.isArray(users) || !users.length) continue;
        const pill = document.createElement("span");
        pill.className = "reaction-pill";
        if (users.includes(username)) pill.classList.add("mine");
        pill.innerText = `${emoji} ${users.length}`;
        strip.appendChild(pill);
    }

    if (strip.childElementCount) host.appendChild(strip);
}

function showReplyPreview(msg) {
    let bar = document.getElementById("replyPreview");
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "replyPreview";
        bar.className = "reply-preview";
        input.parentElement.insertBefore(bar, input);
    }
    bar.innerText = `Replying to ${msg.username}: ${msg.text.slice(0, 60)}${msg.text.length > 60 ? "…" : ""}`;
}

function clearReplyPreview() {
    replyToId = null;
    const bar = document.getElementById("replyPreview");
    if (bar) bar.remove();
}

function renderTypingIndicator() {
    if (!typingIndicator) return;
    const names = Array.from(typingUsers);
    if (names.length === 0) {
        typingIndicator.innerText = "";
        typingIndicator.style.display = "none";
        return;
    }
    typingIndicator.style.display = "block";
    if (names.length === 1) typingIndicator.innerText = `${names[0]} is typing...`;
    else if (names.length === 2) typingIndicator.innerText = `${names[0]} and ${names[1]} are typing...`;
    else typingIndicator.innerText = `${names.slice(0, 2).join(", ")} and ${names.length - 2} others are typing...`;
}

function sendTyping(isTyping) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingTypingState = isTyping;
        return;
    }
    ws.send(JSON.stringify({ type: "typing", isTyping }));
}

function markTyping() {
    if (!iAmTyping) {
        iAmTyping = true;
        sendTyping(true);
    }
    if (typingStopTimer) clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => {
        iAmTyping = false;
        sendTyping(false);
    }, 800);
}

function stopTypingNow() {
    if (typingStopTimer) clearTimeout(typingStopTimer);
    typingStopTimer = null;
    if (iAmTyping) {
        iAmTyping = false;
        sendTyping(false);
    }
}

function sendJoin() {
    if (!ws) return;
    if (!username) {
        alert("Username is required to join the chat.");
        ws.close();
        return;
    }
    const payload = { type: "join", username, room };
    pendingJoin = payload;
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        pendingJoin = null;
    }
}

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    ws = new WebSocket("ws://127.0.0.1:8000/ws");

    ws.onopen = () => {
        if (connStatus) connStatus.innerText = "Connected";
        if (sendBtn) sendBtn.disabled = false;
        sendJoin();

        if (pendingTypingState !== null) {
            try {
                ws.send(JSON.stringify({ type: "typing", isTyping: pendingTypingState }));
            } catch {}
            pendingTypingState = null;
        }
    };

    ws.onclose = () => {
        if (connStatus) connStatus.innerText = "Disconnected";
        if (sendBtn) sendBtn.disabled = true;
        typingUsers.clear();
        renderTypingIndicator();
        if (userList) userList.innerHTML = "";
        if (userCount) userCount.innerText = "0 online";
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            addSystem(event.data);
            return;
        }

        if (data.type === "history" && Array.isArray(data.messages)) {
            // Render past messages
            for (const msg of data.messages) {
                if (msg && msg.type === "chat") {
                    lastActive.set(msg.username, new Date());
                    addChatMessage(msg);
                }
            }
            return;
        }

        if (data.type === "rooms" && Array.isArray(data.rooms)) {
            if (roomsList) {
                roomsList.innerHTML = "";
                for (const r of data.rooms) {
                    const item = document.createElement("div");
                    item.className = "room-pill" + (r.name === room ? " active" : "");
                    item.innerText = `${r.name} (${r.count})`;
                    item.onclick = () => {
                        if (r.name === room) return;
                        room = r.name;
                        if (roomLabel) roomLabel.innerText = `Room: ${room}`;
                        if (chatTitle) chatTitle.innerText = `💬 Room: ${room}`;
                        messages.innerHTML = "";
                        messageIndex.clear();
                        connect();
                    };
                    roomsList.appendChild(item);
                }
            }
            return;
        }

        if (data.type === "presence") {
            const users = Array.isArray(data.users) ? data.users : [];
            if (userCount) userCount.innerText = `${users.length} online`;
            if (userList) {
                userList.innerHTML = "";
                for (const u of users) {
                    const pill = document.createElement("div");
                    pill.className = "user-pill" + (u === username ? " me" : "");

                    const dot = document.createElement("div");
                    dot.className = "user-dot";
                    dot.innerText = (u[0] || "?").toUpperCase();

                    const main = document.createElement("div");
                    main.className = "user-main";
                    const name = document.createElement("div");
                    name.className = "user-name";
                    name.innerText = u === username ? `${u} (You)` : u;

                    const status = document.createElement("div");
                    status.className = "user-status";
                    if (typingUsers.has(u)) status.innerText = "typing…";
                    else {
                        const last = lastActive.get(u);
                        if (last) {
                            status.innerText = `online • ${last.toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                            })}`;
                        } else {
                            status.innerText = "online";
                        }
                    }

                    main.appendChild(name);
                    main.appendChild(status);

                    pill.appendChild(dot);
                    pill.appendChild(main);
                    userList.appendChild(pill);
                }
            }
            return;
        }

        if (data.type === "typing") {
            const who = data.username;
            const isTyping = Boolean(data.isTyping);
            if (who && who !== username) {
                if (isTyping) typingUsers.add(who);
                else typingUsers.delete(who);
                renderTypingIndicator();
            }
            return;
        }

        if (data.type === "system") {
            addSystem(data.text);
            return;
        }

        if (data.type === "chat") {
            if (data.username) {
                lastActive.set(data.username, new Date());
            }
            if (data.username && data.username !== username) {
                typingUsers.delete(data.username);
                renderTypingIndicator();
            }
            addChatMessage(data);
        // Send delivery / seen receipts for messages from others
        if (data.id && data.username !== username && ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: "delivered", messageId: data.id }));
                if (document.visibilityState === "visible") {
                    ws.send(JSON.stringify({ type: "seen", messageId: data.id }));
                }
            } catch {}
        }
            return;
        }

        if (data.type === "reaction") {
            const id = data.messageId;
            const stored = id && messageIndex.get(id);
            if (stored) {
                stored.data.reactions = data.reactions || {};
                renderReactions(stored.row, stored.data.reactions);
            }
            return;
        }

    if (data.type === "receipt") {
        const id = data.messageId;
        const stored = id && messageIndex.get(id);
        if (stored) {
            stored.data.receipts = data.receipts || {};
            updateMetaFor(stored.row, stored.data);
        }
        return;
    }
    };
}

function sendMessage() {
    const text = input.value.trim();
    if (!text) {
        addSystem("⚠️ Empty message not sent");
        return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addSystem("⚠️ Not connected yet. Please wait…");
        return;
    }

    stopTypingNow();
    ws.send(JSON.stringify({ type: "chat", text, replyTo: replyToId }));
    clearReplyPreview();
    input.value = "";
}

sendBtn.onclick = sendMessage;

input.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMessage();
});

input.addEventListener("input", () => {
    if (input.value.trim().length === 0) {
        stopTypingNow();
        return;
    }
    markTyping();
});

input.addEventListener("blur", () => {
    stopTypingNow();
});

function toggleEmojiPanel(forceOpen) {
    if (!emojiPanel) return;
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !emojiPanel.classList.contains("open");
    emojiPanel.classList.toggle("open", shouldOpen);
    emojiPanel.setAttribute("aria-hidden", shouldOpen ? "false" : "true");
}

function insertAtCursor(el, text) {
    if (!el) return;
    try {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        if (typeof el.setRangeText === "function") {
            el.setRangeText(text, start, end, "end");
        } else {
            // Fallback for older browsers
            el.value = el.value.slice(0, start) + text + el.value.slice(end);
            el.selectionStart = el.selectionEnd = start + text.length;
        }
    } catch {
        el.value += text;
    }
    el.focus();
    markTyping();
}

function buildEmojiPanel() {
    if (!emojiPanel) return;
    emojiPanel.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "emoji-grid";

    for (const e of EMOJIS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emoji-item";
        btn.innerText = e;
        btn.onclick = () => {
            insertAtCursor(input, e);
        };
        grid.appendChild(btn);
    }

    emojiPanel.appendChild(grid);
}

buildEmojiPanel();

if (emojiBtn) {
    emojiBtn.onclick = () => toggleEmojiPanel();
}

async function uploadAndSendFile(file) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addSystem("⚠️ Cannot upload while disconnected.");
        return;
    }

    try {
        addSystem(`Uploading "${file.name}"...`);
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/upload", { method: "POST", body: form });
        if (!res.ok) {
            addSystem(`⚠️ Upload failed (status ${res.status}).`);
            console.error("Upload failed:", res.status, await res.text());
            return;
        }
        const data = await res.json();
        const media = {
            url: data.url,
            filename: data.filename,
            content_type: data.content_type,
        };
        let text = data.filename || "";
        if (file.type && file.type.startsWith("image/")) {
            text = text || "Image";
        } else {
            text = text || "File";
        }
        ws.send(JSON.stringify({ type: "chat", text, media }));
    } catch (err) {
        addSystem("⚠️ Upload failed. See console for details.");
        console.error("Upload error:", err);
    }
}

if (attachBtn && fileInput) {
    attachBtn.onclick = () => {
        fileInput.value = "";
        fileInput.click();
    };

    fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        uploadAndSendFile(file);
    });
}

if (cameraBtn && cameraInput) {
    cameraBtn.onclick = () => {
        cameraInput.value = "";
        cameraInput.click();
    };

    cameraInput.addEventListener("change", () => {
        const file = cameraInput.files && cameraInput.files[0];
        if (!file) return;
        uploadAndSendFile(file);
    });
}

if (audioBtn) {
    audioBtn.onclick = async () => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            addSystem("⚠️ Audio recording not supported in this browser.");
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };
            mediaRecorder.onstop = async () => {
                const blob = new Blob(audioChunks, { type: "audio/webm" });
                const file = new File([blob], "voice-note.webm", { type: "audio/webm" });
                stream.getTracks().forEach((t) => t.stop());
                uploadAndSendFile(file);
            };
            mediaRecorder.start();
            addSystem("Recording voice note… click 🎤 again to stop.");
        } catch (err) {
            addSystem("⚠️ Could not start audio recording.");
            console.error("getUserMedia error:", err);
        }
    };
}

function toggleReaction(id, emoji) {
    if (!id || ws.readyState !== WebSocket.OPEN) return;
    const stored = messageIndex.get(id);
    const currentUsers = stored?.data?.reactions?.[emoji] || [];
    const hasReacted = currentUsers.includes(username);
    ws.send(
        JSON.stringify({
            type: "reaction",
            messageId: id,
            emoji,
            action: hasReacted ? "remove" : "add",
        }),
    );
}

if (searchInput) {
    searchInput.addEventListener("input", () => {
        const q = searchInput.value.trim().toLowerCase();
        for (const { data, row } of messageIndex.values()) {
            if (!q) {
                row.style.display = "";
                continue;
            }
            const hay = `${data.username} ${data.text}`.toLowerCase();
            row.style.display = hay.includes(q) ? "" : "none";
        }
    });
}

document.addEventListener("click", (e) => {
    if (!emojiPanel || !emojiBtn) return;
    const target = e.target;
    if (emojiPanel.contains(target) || emojiBtn.contains(target)) return;
    toggleEmojiPanel(false);
});

leaveBtn.onclick = () => {
    stopTypingNow();
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: "leave" }));
        } catch {}
    }
    if (username) {
        // Show local system info so user clearly sees they left
        addSystem(`${username} left the chat`);
    }
    if (ws) ws.close();
    if (appShell) appShell.style.display = "none";
    if (loginScreen) loginScreen.style.display = "flex";
    if (connStatus) connStatus.innerText = "Disconnected";
    if (sendBtn) sendBtn.disabled = true;
};

if (clearChatBtn) {
    clearChatBtn.onclick = () => {
        messages.innerHTML = "";
        messageIndex.clear();
        addSystem("You cleared this chat on this device only.");
    };
}

if (loginBtn) {
    loginBtn.onclick = () => {
        const nameVal = loginName.value.trim();
        const typedRoom = (loginRoom.value || "").trim();
        const selectedRoom = (loginRoomSelect?.value || "").trim();
        const roomVal = (typedRoom || selectedRoom || "general").toLowerCase();

        if (!nameVal) {
            alert("Please enter a name.");
            return;
        }

        username = nameVal;
        room = roomVal;

        if (roomLabel) roomLabel.innerText = `Room: ${room}`;
        if (chatTitle) chatTitle.innerText = `💬 Room: ${room}`;

        if (loginScreen) loginScreen.style.display = "none";
        if (appShell) appShell.style.display = "flex";

        messages.innerHTML = "";
        messageIndex.clear();
        if (connStatus) connStatus.innerText = "Connecting…";
        if (sendBtn) sendBtn.disabled = true;
        connect();
    };
}