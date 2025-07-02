import express from "express"
import { createServer } from "http"
import cors from "cors"
import { initSocket } from "./sockets"


const app = express()
const server = createServer(app)

// Enhanced CORS configuration
app.use(
    cors({
        origin: [
            "http://localhost:3000",
            "https://carpentary2025.vercel.app",
            /\.vercel\.app$/,
            /\.netlify\.app$/,
            /\.render\.com$/,
        ],
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    }),
)

app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }))

// Initialize Socket.IO with enhanced stability
const io = initSocket(server)

// Enhanced health check endpoint
app.get("/health", (req, res) => {
    const memUsage = process.memoryUsage()
    const uptime = process.uptime()

    res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024),
            total: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
        },
        connections: io.engine.clientsCount,
        version: "2.0.0",
        environment: process.env.NODE_ENV || "development",
    })
})

// Keep-alive endpoint for monitoring services
app.get("/ping", (req, res) => {
    res.status(200).json({
        message: "pong",
        timestamp: new Date().toISOString(),
        serverTime: Date.now(),
    })
})

// Server statistics endpoint
app.get("/api/stats", (req, res) => {
    const stats = {
        connections: io.engine.clientsCount,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        version: "2.0.0",
        transport: {
            websocket: 0,
            polling: 0,
        },
    }

    // Count transport types
    Object.values(io.sockets.sockets).forEach((socket: any) => {
        const transportName = socket.conn.transport.name
        if (transportName === "websocket") {
            stats.transport.websocket++
        } else if (transportName === "polling") {
            stats.transport.polling++
        }
    })

    res.json(stats)
})

// Root endpoint
app.get("/", (req, res) => {
    res.json({
        message: "Real-time Tracking Server v2.0",
        status: "running",
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        connections: io.engine.clientsCount,
        features: [
            "Enhanced stability for Render",
            "Connection health monitoring",
            "Automatic reconnection",
            "Message buffering",
            "Rate limiting",
            "Memory optimization",
        ],
    })
})

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("❌ Express error:", err)
    res.status(500).json({
        error: "Internal server error",
        timestamp: new Date().toISOString(),
    })
})

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: "Not found",
        path: req.path,
        timestamp: new Date().toISOString(),
    })
})

const PORT = process.env.PORT || 4000

// Enhanced server startup
server.listen(PORT, () => {
    console.log(`🚀 Enhanced Server running on port ${PORT}`)
    console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`)
    console.log(`📊 Process ID: ${process.pid}`)
    console.log(`💾 Node version: ${process.version}`)

    // Log initial memory usage
    const memUsage = process.memoryUsage()
    console.log(`💾 Initial memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`)
})

// Handle server errors
server.on("error", (error: any) => {
    console.error("❌ Server error:", error)

    if (error.code === "EADDRINUSE") {
        console.error(`❌ Port ${PORT} is already in use`)
        process.exit(1)
    }
})

// Export for testing
export { app, server, io }