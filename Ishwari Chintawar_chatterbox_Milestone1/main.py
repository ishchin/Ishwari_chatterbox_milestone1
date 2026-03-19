from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import json
import uuid

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Rooms (group chats). Each room holds connected websockets -> username.
rooms: dict[str, dict[WebSocket, str]] = {}

# All connected sockets (any room) for global broadcasts
all_sockets: set[WebSocket] = set()

# Reverse lookup: websocket -> (room, username)
connections: dict[WebSocket, tuple[str, str]] = {}

# In-memory message history per room (WhatsApp-like: show recent messages on join)
history: dict[str, deque[dict]] = {}
HISTORY_LIMIT = 200

DEFAULT_ROOMS = ["general", "tech", "fun"]
UPLOAD_DIR = Path("static") / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/")
async def get():
    return FileResponse("index.html")


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix or ""
    uid = uuid.uuid4().hex
    safe_name = f"{uid}{suffix}"
    dest = UPLOAD_DIR / safe_name

    contents = await file.read()
    dest.write_bytes(contents)

    return JSONResponse(
        {
            "url": f"/static/uploads/{safe_name}",
            "filename": file.filename,
            "content_type": file.content_type or "application/octet-stream",
        }
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def send_json(ws: WebSocket, payload: dict) -> None:
    await ws.send_text(json.dumps(payload))


async def broadcast_all(payload: dict) -> None:
    if not all_sockets:
        return
    data = json.dumps(payload)
    disconnected: list[WebSocket] = []
    for ws in list(all_sockets):
        try:
            await ws.send_text(data)
        except WebSocketDisconnect:
            disconnected.append(ws)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        all_sockets.discard(ws)
        con = connections.pop(ws, None)
        if con:
            room, _ = con
            rooms.get(room, {}).pop(ws, None)


async def broadcast_room(room: str, payload: dict, *, exclude: WebSocket | None = None) -> None:
    clients = rooms.get(room)
    if not clients:
        return

    data = json.dumps(payload)
    disconnected: list[WebSocket] = []

    # Iterate over a snapshot to avoid dict-size change issues
    for client in list(clients.keys()):
        if exclude is not None and client is exclude:
            continue
        try:
            await client.send_text(data)
        except WebSocketDisconnect:
            disconnected.append(client)
        except Exception:
            disconnected.append(client)

    for client in disconnected:
        # cleanup disconnected
        clients.pop(client, None)
        connections.pop(client, None)

    if not clients:
        rooms.pop(room, None)


async def broadcast_presence(room: str) -> None:
    clients = rooms.get(room, {})
    users = sorted(set(clients.values()), key=str.lower)
    await broadcast_room(room, {"type": "presence", "room": room, "users": users})


async def broadcast_rooms_overview() -> None:
    # Always include default rooms even if empty
    all_room_names = set(DEFAULT_ROOMS) | set(rooms.keys())
    overview = []
    for name in sorted(all_room_names, key=lambda x: x.lower()):
        overview.append({"name": name, "count": len(rooms.get(name, {}))})
    await broadcast_all({"type": "rooms", "rooms": overview})


def ensure_room(room: str) -> dict[WebSocket, str]:
    if room not in rooms:
        rooms[room] = {}
    if room not in history:
        history[room] = deque(maxlen=HISTORY_LIMIT)
    return rooms[room]


def find_message(room: str, message_id: str) -> dict | None:
    for msg in history.get(room, []):
        if msg.get("id") == message_id:
            return msg
    return None


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    # First message should be a join handshake:
    # { type:"join", username:"...", room:"..." }
    # Keep backward-compat: if plain text, treat it as username and use room "main".
    first = await websocket.receive_text()
    username = ""
    room = "main"

    try:
        parsed = json.loads(first)
        if isinstance(parsed, dict) and parsed.get("type") == "join":
            username = str(parsed.get("username", "")).strip()
            room = str(parsed.get("room", "main")).strip() or "main"
        else:
            username = str(first).strip()
    except Exception:
        username = str(first).strip()

    if not username:
        await send_json(websocket, {"type": "system", "text": "Username is required."})
        await websocket.close()
        return

    # track in global set
    all_sockets.add(websocket)

    # join room
    clients = ensure_room(room)
    clients[websocket] = username
    connections[websocket] = (room, username)

    # Send recent history to the new client
    await send_json(
        websocket,
        {
            "type": "history",
            "room": room,
            "messages": list(history.get(room, [])),
        },
    )

    # Notify others + presence update
    await broadcast_room(
        room,
        {"type": "system", "room": room, "text": f"{username} joined the chat"},
    )
    await broadcast_presence(room)
    await broadcast_rooms_overview()

    try:
        while True:
            raw = await websocket.receive_text()

            parsed: dict | None = None
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = None

            # Look up current room/username (in case we later add room switching)
            current = connections.get(websocket)
            if not current:
                await websocket.close()
                return
            room, username = current

            if isinstance(parsed, dict):
                ptype = parsed.get("type")
            else:
                ptype = None

            if ptype == "typing":
                is_typing = bool(parsed.get("isTyping"))
                await broadcast_room(
                    room,
                    {
                        "type": "typing",
                        "room": room,
                        "username": username,
                        "isTyping": is_typing,
                    },
                    exclude=websocket,
                )
                continue

            if ptype == "leave":
                # explicit leave: cleanup then close
                await broadcast_room(
                    room,
                    {"type": "typing", "room": room, "username": username, "isTyping": False},
                    exclude=websocket,
                )

                # remove from room
                rooms.get(room, {}).pop(websocket, None)
                connections.pop(websocket, None)
                all_sockets.discard(websocket)

                await broadcast_room(
                    room,
                    {"type": "system", "room": room, "text": f"{username} left the chat"},
                )
                await broadcast_presence(room)
                await broadcast_rooms_overview()
                await websocket.close()
                return

            if ptype == "reaction":
                message_id = str(parsed.get("messageId", "")).strip()
                emoji = str(parsed.get("emoji", "")).strip()
                action = parsed.get("action", "toggle")
                if not message_id or not emoji:
                    continue
                msg = find_message(room, message_id)
                if not msg:
                    continue
                reactions = msg.setdefault("reactions", {})
                users = reactions.setdefault(emoji, [])

                if action in ("add", "toggle") and username not in users:
                    users.append(username)
                if action in ("remove", "toggle") and username in users:
                    users.remove(username)
                    if not users:
                        reactions.pop(emoji, None)

                await broadcast_room(
                    room,
                    {
                        "type": "reaction",
                        "room": room,
                        "messageId": message_id,
                        "reactions": reactions,
                    },
                )
                continue

            if ptype == "delete":
                message_id = str(parsed.get("messageId", "")).strip()
                if not message_id:
                    continue
                msg = find_message(room, message_id)
                if not msg:
                    continue
                # Only sender can delete for everyone
                if msg.get("username") != username:
                    continue

                msg["deleted"] = True
                msg["text"] = ""
                msg.pop("media", None)

                await broadcast_room(
                    room,
                    {
                        "type": "deleted",
                        "room": room,
                        "messageId": message_id,
                    },
                )
                continue

            if ptype in {"delivered", "seen"}:
                message_id = str(parsed.get("messageId", "")).strip()
                if not message_id:
                    continue
                msg = find_message(room, message_id)
                if not msg:
                    continue
                # Skip receipts from the sender about their own message
                if msg.get("username") == username:
                    continue

                receipts = msg.setdefault("receipts", {})
                user_rec = receipts.setdefault(username, {})

                ts = now_iso()
                if ptype == "delivered":
                    user_rec.setdefault("delivered", ts)
                else:  # seen
                    user_rec.setdefault("delivered", ts)
                    user_rec["seen"] = ts

                await broadcast_room(
                    room,
                    {
                        "type": "receipt",
                        "room": room,
                        "messageId": message_id,
                        "receipts": receipts,
                    },
                )
                continue

            # Chat: JSON {type:"chat", text:"...", replyTo:"...", media:{...}} OR plain text (legacy)
            if ptype == "chat":
                message_text = str(parsed.get("text", "")).strip()
                reply_to = parsed.get("replyTo")
                media = parsed.get("media")
            else:
                message_text = str(raw).strip()
                reply_to = None
                media = None

            if not message_text and not media:
                continue

            msg = {
                "type": "chat",
                "id": str(uuid.uuid4()),
                "room": room,
                "username": username,
                "text": message_text,
                "ts": now_iso(),
                "receipts": {},
            }
            if reply_to:
                msg["replyTo"] = reply_to
            if media:
                msg["media"] = media
            history[room].append(msg)
            await broadcast_room(room, msg)

    except WebSocketDisconnect:
        pass
    finally:
        current = connections.pop(websocket, None)
        if current:
            room, username = current
            rooms.get(room, {}).pop(websocket, None)
            all_sockets.discard(websocket)
            await broadcast_room(
                room,
                {"type": "typing", "room": room, "username": username, "isTyping": False},
                exclude=websocket,
            )
            await broadcast_room(
                room,
                {"type": "system", "room": room, "text": f"{username} left the chat"},
            )
            await broadcast_presence(room)
            await broadcast_rooms_overview()


app.mount("/static", StaticFiles(directory="static"), name="static")