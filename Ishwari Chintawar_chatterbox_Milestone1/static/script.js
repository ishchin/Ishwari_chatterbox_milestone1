const username = prompt("Enter your name:");

const ws = new WebSocket("ws://127.0.0.1:8000/ws");

const messages = document.getElementById("messages");
const input = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

ws.onmessage = function(event) {
    addMessage(event.data, false);
};

function addMessage(text, mine) {
    const div = document.createElement("div");
    div.className = "message " + (mine ? "sent" : "received");
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    const fullMessage = username + ": " + text;

    ws.send(fullMessage);
    addMessage(fullMessage, true);

    input.value = "";
}

sendBtn.onclick = sendMessage;

input.addEventListener("keypress", e => {
    if (e.key === "Enter") sendMessage();
});
