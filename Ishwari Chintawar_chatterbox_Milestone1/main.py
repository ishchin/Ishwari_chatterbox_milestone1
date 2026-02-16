from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI()

clients = []

@app.get("/")
async def get():
    return FileResponse("index.html")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.append(websocket)

    try:
        while True:
            data = await websocket.receive_text()

            # send to other clients only
            for client in clients:
                if client != websocket:
                    await client.send_text(data)

    except WebSocketDisconnect:
        clients.remove(websocket)

app.mount("/static", StaticFiles(directory="static"), name="static")
