import express from "express";
import { createServer } from "http";
import cors from "cors"

import { log } from "./utils/logger";
import { initSocket } from "./sockets";

const app = express();
const server = createServer(app);
// Enable CORS for Express
app.use(
    cors({
        origin: [
            "http://localhost:3000",
            "https://carpentary2025.vercel.app", // Add your actual frontend domain
            /\.vercel\.app$/,
            /\.netlify\.app$/,
        ],
        credentials: true,
    }),
)

app.use(express.json())

// Health check endpoint to keep server alive
// app.get("/health", (req, res) => {
//     res.status(200).json({
//         status: "ok",
//         timestamp: new Date().toISOString(),
//         uptime: process.uptime(),
//         connectedUsers: connectedUsers.size,
//         activeTypingUsers: typingUsers.size,
//         memory: process.memoryUsage(),
//     })
// })

// Keep-alive endpoint for monitoring services
app.get("/ping", (req, res) => {
    res.status(200).send("pong")
})

initSocket(server);

const PORT = 4000;

app.get("/", (req, res) => {
    res.send("Hello from Express + Socket.IO!");
});

server.listen(PORT, () => {
    log.info(`Server is running at http://localhost:${PORT}`);
});
