import express from "express";
import { createServer } from "http";

import { log } from "./utils/logger";
import { initSocket } from "./sockets";

const app = express();
const server = createServer(app);

initSocket(server);

const PORT = 4000;

app.get("/", (req, res) => {
    res.send("Hello from Express + Socket.IO!");
});

server.listen(PORT, () => {
    log.info(`Server is running at http://localhost:${PORT}`);
});
