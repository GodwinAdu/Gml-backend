import type { Server as HttpServer } from "http"
import { Server, type Socket } from "socket.io"

interface User {
    id: string
    name: string
    role: "admin" | "supervisor" | "worker"
    sessionId: string
    joinedAt: string
    lastSeen: string
    status: "online" | "away" | "offline"
    location: any
    accuracy?: number
    speed?: number
    heading?: number
    trail: Array<{
        latitude: number
        longitude: number
        timestamp: string
    }>
    isTyping: boolean
    connectionHealth?: any
}

interface ConnectionHealth {
    connectedAt: number
    lastPing: number
    pingCount: number
    reconnectCount: number
    isHealthy: boolean
    latency?: number
}

/**
 * Initializes a Socket.IO server with enhanced stability for Render deployment.
 * @param {HttpServer} server - The HTTP server to attach the Socket.IO server to.
 * @returns {Server} The initialized Socket.IO server.
 */
export const initSocket = (server: HttpServer): Server => {
    const io = new Server(server, {
        cors: {
            origin: [
                "http://localhost:3000",
                "https://carpentary2025.vercel.app",
                /\.vercel\.app$/,
                /\.netlify\.app$/,
                /\.render\.com$/,
            ],
            methods: ["GET", "POST"],
            credentials: true,
        },
        // Enhanced transport settings for Render stability
        transports: ["websocket", "polling"],
        allowEIO3: true,

        // Optimized connection settings for cloud deployment
        pingTimeout: 180000, // 3 minutes - increased for Render
        pingInterval: 25000, // 25 seconds
        upgradeTimeout: 45000, // 45 seconds for slower connections
        maxHttpBufferSize: 1e6, // 1MB

        // Enhanced compression for better performance
        perMessageDeflate: {
            threshold: 1024,
            concurrencyLimit: 10,
            memLevel: 7,
            serverMaxWindowBits: 15,
            clientMaxWindowBits: 15,
        },

        // Connection management optimizations
        allowUpgrades: true,
        cookie: false,

        // Additional stability settings
        serveClient: false,
        path: "/socket.io/",
        connectTimeout: 45000,

        // Engine.IO specific settings for Render
        allowRequest: (req: import("http").IncomingMessage, callback: (err: any, success: boolean) => void) => {
            // Add custom validation if needed
            callback(null, true)
        }
    })

    // Enhanced data storage with cleanup mechanisms
    const connectedUsers = new Map<string, User>()
    const trackingSessions = new Map<string, Set<string>>()
    const typingUsers = new Map<string, NodeJS.Timeout>()
    const connectionHealth = new Map<string, ConnectionHealth>()
    const messageBuffer = new Map<string, any[]>() // Buffer messages for reconnection

    // Utility functions
    const generateUserId = (): string => Math.random().toString(36).substr(2, 9)
    const getCurrentTimestamp = (): string => new Date().toISOString()

    // Enhanced connection health monitoring
    const monitorConnection = (socket: Socket): void => {
        const connectionId = socket.id
        const healthData: ConnectionHealth = {
            connectedAt: Date.now(),
            lastPing: Date.now(),
            pingCount: 0,
            reconnectCount: 0,
            isHealthy: true,
        }

        connectionHealth.set(connectionId, healthData)

        // Adaptive ping monitoring based on connection quality
        let pingIntervalTime = 30000 // Start with 30 seconds

        const pingInterval = setInterval(() => {
            if (socket.connected) {
                const startTime = Date.now()
                socket.emit("ping", {
                    timestamp: startTime,
                    serverLoad: process.cpuUsage(),
                    memoryUsage: process.memoryUsage().heapUsed,
                })

                const timeout = setTimeout(() => {
                    const health = connectionHealth.get(connectionId)
                    if (health) {
                        health.isHealthy = false
                        health.reconnectCount++
                        connectionHealth.set(connectionId, health)

                        // Increase ping frequency for unhealthy connections
                        pingIntervalTime = Math.max(15000, pingIntervalTime - 5000)
                        console.warn(`⚠️ Unhealthy connection detected: ${connectionId}`)
                    }
                }, 15000) // 15 second timeout

                socket.once("pong", (data: any) => {
                    clearTimeout(timeout)
                    const health = connectionHealth.get(connectionId)
                    if (health) {
                        const latency = Date.now() - startTime
                        health.lastPing = Date.now()
                        health.pingCount++
                        health.isHealthy = true
                        health.latency = latency
                        connectionHealth.set(connectionId, health)

                        // Adjust ping frequency based on latency
                        if (latency < 100) {
                            pingIntervalTime = Math.min(60000, pingIntervalTime + 5000) // Decrease frequency for good connections
                        } else if (latency > 1000) {
                            pingIntervalTime = Math.max(15000, pingIntervalTime - 2000) // Increase frequency for slow connections
                        }
                    }
                })
            }
        }, pingIntervalTime)

        // Cleanup on disconnect
        socket.on("disconnect", () => {
            clearInterval(pingInterval)
            connectionHealth.delete(connectionId)
        })
    }

    // Enhanced graceful shutdown with connection preservation
    const gracefulShutdown = (): void => {
        console.log("🔄 Graceful shutdown initiated...")

        // Save current state for quick recovery
        const serverState = {
            users: Array.from(connectedUsers.entries()),
            sessions: Array.from(trackingSessions.entries()),
            timestamp: getCurrentTimestamp(),
        }

        // Notify all clients about server shutdown with recovery info
        io.emit("server-shutdown", {
            message: "Server is restarting, please reconnect in a moment",
            timestamp: getCurrentTimestamp(),
            recoveryData: serverState,
            expectedDowntime: 30000, // 30 seconds
        })

        // Gracefully close connections
        const closeTimeout = setTimeout(() => {
            console.log("⚠️ Force closing connections...")
            io.close()
        }, 5000)

        io.close(() => {
            clearTimeout(closeTimeout)
            console.log("✅ All connections closed gracefully")

            server.close(() => {
                console.log("✅ Server closed")
                process.exit(0)
            })
        })

        // Ultimate force exit
        setTimeout(() => {
            console.log("⚠️ Forcing exit...")
            process.exit(1)
        }, 15000)
    }

    // Enhanced process signal handling
    const signals = ["SIGTERM", "SIGINT", "SIGUSR2", "SIGHUP"]
    signals.forEach((signal) => {
        process.on(signal, () => {
            console.log(`📡 Received ${signal}, initiating graceful shutdown...`)
            gracefulShutdown()
        })
    })

    // Enhanced error handling
    process.on("uncaughtException", (error) => {
        console.error("❌ Uncaught Exception:", error)
        // Don't immediately shutdown, try to recover
        setTimeout(() => {
            if (process.listenerCount("uncaughtException") <= 1) {
                gracefulShutdown()
            }
        }, 1000)
    })

    process.on("unhandledRejection", (reason, promise) => {
        console.error("❌ Unhandled Rejection at:", promise, "reason:", reason)
        // Log but don't shutdown for unhandled rejections
    })

    // Memory management and cleanup
    const performCleanup = (): void => {
        const now = Date.now()
        const staleThreshold = 10 * 60 * 1000 // 10 minutes
        let cleanedCount = 0

        // Clean up stale connections
        connectionHealth.forEach((health, socketId) => {
            if (now - health.lastPing > staleThreshold) {
                connectionHealth.delete(socketId)
                connectedUsers.delete(socketId)
                typingUsers.delete(socketId)
                cleanedCount++
            }
        })

        // Clean up empty sessions
        trackingSessions.forEach((users, sessionId) => {
            if (users.size === 0) {
                trackingSessions.delete(sessionId)
            }
        })

        // Clean up message buffers
        messageBuffer.forEach((messages, userId) => {
            if (messages.length > 100) {
                messageBuffer.set(userId, messages.slice(-50))
            }
        })

        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} stale connections`)
        }

        // Force garbage collection if available
        if (global.gc) {
            global.gc()
        }
    }

    // Run cleanup every 2 minutes
    setInterval(performCleanup, 120000)

    // Enhanced connection handling
    io.on("connection", (socket: Socket) => {
        console.log(`✅ Client connected: ${socket.id} from ${socket.handshake.address}`)

        // Start enhanced connection monitoring
        monitorConnection(socket)

        // Send enhanced connection confirmation
        socket.emit("connection-confirmed", {
            socketId: socket.id,
            timestamp: getCurrentTimestamp(),
            serverTime: Date.now(),
            serverVersion: "2.0.0",
            features: ["typing-indicators", "reactions", "presence", "reconnection"],
        })

        // Enhanced user joining with validation
        socket.on("join-tracking", (data) => {
            try {
                const { name, role, sessionId, location, speed, accuracy, heading } = data

                // Validate input
                if (!name || typeof name !== "string" || name.trim().length === 0) {
                    socket.emit("error", { message: "Invalid name provided" })
                    return
                }

                if (!["admin", "supervisor", "worker", "new"].includes(role)) {
                    socket.emit("error", { message: "Invalid role provided" })
                    return
                }

                const trimmedName = name.trim()
                const sid = sessionId || "tracking-users"

                // ❗ Prevent duplicate: check if user with same name and session already exists
                const isAlreadyJoined = Array.from(connectedUsers.values()).some(
                    user => user.name === trimmedName && user.sessionId === sid
                )

                if (isAlreadyJoined) {
                    socket.emit("error", { message: "User already joined the session" })
                    return
                }

                console.log(`🔗 User joining:`, { name: trimmedName, role, sessionId: sid })

                const userData: User = {
                    id: socket.id,
                    name: trimmedName,
                    role: role || "worker",
                    sessionId: sid,
                    joinedAt: getCurrentTimestamp(),
                    lastSeen: getCurrentTimestamp(),
                    status: "online",
                    location: location || null,
                    accuracy: accuracy || null,
                    speed: speed || null,
                    heading: heading || null,
                    trail: [],
                    isTyping: false,
                    connectionHealth: connectionHealth.get(socket.id),
                }

                // Store user data
                connectedUsers.set(socket.id, userData)

                // Manage session tracking
                if (!trackingSessions.has(userData.sessionId)) {
                    trackingSessions.set(userData.sessionId, new Set())
                }
                trackingSessions.get(userData.sessionId)!.add(socket.id)

                // Join the tracking room
                socket.join(`tracking-${userData.sessionId}`)

                // Notify others in the room
                socket.to(`tracking-${userData.sessionId}`).emit("user-joined", userData)

                // Send current users list to the new user
                const roomUsers = Array.from(connectedUsers.values()).filter((user) => user.sessionId === userData.sessionId)
                socket.emit("users-list", roomUsers)

                // Send buffered messages if any
                const bufferedMessages = messageBuffer.get(socket.id) || []
                if (bufferedMessages.length > 0) {
                    socket.emit("buffered-messages", bufferedMessages)
                    messageBuffer.delete(socket.id)
                }

                // Send updated user count to all users in room
                io.to(`tracking-${userData.sessionId}`).emit("user-count", roomUsers.length)

                console.log(`👤 ${userData.name} joined tracking session: ${userData.sessionId}`)
            } catch (error) {
                console.error("❌ Error in join-tracking:", error)
                socket.emit("error", { message: "Failed to join tracking session", code: "JOIN_ERROR" })
            }
        })


        // Enhanced location updates with throttling
        let lastLocationUpdate = 0
        const locationUpdateThrottle = 1000 // 1 second minimum between updates

        socket.on("location-update", (locationData) => {
            try {
                const now = Date.now()
                if (now - lastLocationUpdate < locationUpdateThrottle) {
                    return // Throttle location updates
                }
                lastLocationUpdate = now

                const user = connectedUsers.get(socket.id)
                if (!user) {
                    socket.emit("error", { message: "User not found", code: "USER_NOT_FOUND" })
                    return
                }

                // Validate location data
                if (locationData.location) {
                    const { latitude, longitude } = locationData.location
                    if (
                        typeof latitude !== "number" ||
                        typeof longitude !== "number" ||
                        latitude < -90 ||
                        latitude > 90 ||
                        longitude < -180 ||
                        longitude > 180
                    ) {
                        socket.emit("error", { message: "Invalid location coordinates", code: "INVALID_LOCATION" })
                        return
                    }
                }

                // Add to trail with optimization
                if (locationData.location) {
                    const trailPoint = {
                        latitude: locationData.location.latitude,
                        longitude: locationData.location.longitude,
                        timestamp: getCurrentTimestamp(),
                    }

                    user.trail.push(trailPoint)

                    // Keep only last 30 trail points to reduce memory usage
                    if (user.trail.length > 30) {
                        user.trail = user.trail.slice(-30)
                    }
                }

                // Update user location data
                const updatedUser: User = {
                    ...user,
                    location: locationData.location,
                    accuracy: locationData.accuracy,
                    speed: locationData.speed,
                    heading: locationData.heading,
                    lastSeen: getCurrentTimestamp(),
                    status: "online",
                    trail: user.trail,
                }

                connectedUsers.set(socket.id, updatedUser)

                // Broadcast location update to others in the same session
                const updatePayload = {
                    userId: socket.id,
                    location: locationData.location,
                    accuracy: locationData.accuracy,
                    speed: locationData.speed,
                    heading: locationData.heading,
                    timestamp: getCurrentTimestamp(),
                }

                socket.to(`tracking-${user.sessionId}`).emit("location-update", updatePayload)

                // Update user in users list for all users in session
                io.to(`tracking-${user.sessionId}`).emit("user-updated", updatedUser)
            } catch (error) {
                console.error("❌ Error in location-update:", error)
                socket.emit("error", { message: "Failed to update location", code: "LOCATION_UPDATE_ERROR" })
            }
        })

        // Enhanced typing indicators with improved debouncing
        socket.on("typing-start", () => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                // Update user typing status
                user.isTyping = true
                connectedUsers.set(socket.id, user)

                // Broadcast typing status to others in the session
                socket.to(`tracking-${user.sessionId}`).emit("user-typing", {
                    userId: socket.id,
                    userName: user.name,
                    isTyping: true,
                    timestamp: getCurrentTimestamp(),
                })

                // Clear any existing typing timeout for this user
                if (typingUsers.has(socket.id)) {
                    clearTimeout(typingUsers.get(socket.id)!)
                }

                // Set timeout to automatically stop typing after 3 seconds
                const timeout = setTimeout(() => {
                    const currentUser = connectedUsers.get(socket.id)
                    if (currentUser && currentUser.isTyping) {
                        currentUser.isTyping = false
                        connectedUsers.set(socket.id, currentUser)

                        socket.to(`tracking-${currentUser.sessionId}`).emit("user-typing", {
                            userId: socket.id,
                            userName: currentUser.name,
                            isTyping: false,
                            timestamp: getCurrentTimestamp(),
                        })
                    }
                    typingUsers.delete(socket.id)
                }, 3000)

                typingUsers.set(socket.id, timeout)
            } catch (error) {
                console.error("❌ Error in typing-start:", error)
            }
        })

        socket.on("typing-stop", () => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                user.isTyping = false
                connectedUsers.set(socket.id, user)

                if (typingUsers.has(socket.id)) {
                    clearTimeout(typingUsers.get(socket.id)!)
                    typingUsers.delete(socket.id)
                }

                socket.to(`tracking-${user.sessionId}`).emit("user-typing", {
                    userId: socket.id,
                    userName: user.name,
                    isTyping: false,
                    timestamp: getCurrentTimestamp(),
                })
            } catch (error) {
                console.error("❌ Error in typing-stop:", error)
            }
        })

        // Enhanced message handling with validation and rate limiting
        let lastMessageTime = 0
        const messageRateLimit = 500 // 500ms between messages

        socket.on("send-message", (messageData) => {
            try {
                const now = Date.now()
                if (now - lastMessageTime < messageRateLimit) {
                    socket.emit("error", { message: "Message rate limit exceeded", code: "RATE_LIMIT" })
                    return
                }
                lastMessageTime = now

                const user = connectedUsers.get(socket.id)
                if (!user) {
                    socket.emit("error", { message: "User not found", code: "USER_NOT_FOUND" })
                    return
                }

                // Validate message
                if (
                    !messageData.message ||
                    typeof messageData.message !== "string" ||
                    messageData.message.trim().length === 0 ||
                    messageData.message.length > 1000
                ) {
                    socket.emit("error", { message: "Invalid message content", code: "INVALID_MESSAGE" })
                    return
                }

                // Stop typing when message is sent
                user.isTyping = false
                connectedUsers.set(socket.id, user)

                if (typingUsers.has(socket.id)) {
                    clearTimeout(typingUsers.get(socket.id)!)
                    typingUsers.delete(socket.id)
                }

                // Broadcast typing stop
                socket.to(`tracking-${user.sessionId}`).emit("user-typing", {
                    userId: socket.id,
                    userName: user.name,
                    isTyping: false,
                    timestamp: getCurrentTimestamp(),
                })

                const message = {
                    id: generateUserId(),
                    userId: socket.id,
                    userName: user.name,
                    userRole: user.role,
                    message: messageData.message.trim(),
                    timestamp: getCurrentTimestamp(),
                    location: user.location,
                    messageType: messageData.messageType || "text",
                    edited: false,
                    reactions: {},
                }

                // Buffer message for offline users
                const sessionUsers = trackingSessions.get(user.sessionId) || new Set()
                sessionUsers.forEach((userId) => {
                    if (!connectedUsers.has(userId)) {
                        if (!messageBuffer.has(userId)) {
                            messageBuffer.set(userId, [])
                        }
                        messageBuffer.get(userId)!.push(message)
                    }
                })

                // Broadcast message to all users in the session
                io.to(`tracking-${user.sessionId}`).emit("new-message", message)

                console.log(
                    `💬 Message from ${user.name}: ${messageData.message.substring(0, 50)}${messageData.message.length > 50 ? "..." : ""}`,
                )
            } catch (error) {
                console.error("❌ Error in send-message:", error)
                socket.emit("error", { message: "Failed to send message", code: "MESSAGE_ERROR" })
            }
        })

        // Enhanced message reactions
        socket.on("message-reaction", (reactionData) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                const { messageId, emoji, action } = reactionData

                // Validate reaction data
                if (!messageId || !emoji || !["add", "remove"].includes(action)) {
                    socket.emit("error", { message: "Invalid reaction data", code: "INVALID_REACTION" })
                    return
                }

                // Broadcast reaction to all users in the session
                io.to(`tracking-${user.sessionId}`).emit("message-reaction-update", {
                    messageId,
                    userId: socket.id,
                    userName: user.name,
                    emoji,
                    action,
                    timestamp: getCurrentTimestamp(),
                })
            } catch (error) {
                console.error("❌ Error in message-reaction:", error)
            }
        })

        // Enhanced status and presence updates
        socket.on("status-update", (status) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                if (!["online", "away", "offline"].includes(status)) {
                    socket.emit("error", { message: "Invalid status", code: "INVALID_STATUS" })
                    return
                }

                const updatedUser: User = {
                    ...user,
                    status,
                    lastSeen: getCurrentTimestamp(),
                }

                connectedUsers.set(socket.id, updatedUser)

                socket.to(`tracking-${user.sessionId}`).emit("user-status-changed", {
                    userId: socket.id,
                    status,
                    timestamp: getCurrentTimestamp(),
                })

                io.to(`tracking-${user.sessionId}`).emit("user-updated", updatedUser)
            } catch (error) {
                console.error("❌ Error in status-update:", error)
            }
        })

        socket.on("presence-update", (presenceData) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                const { isActive, lastActivity } = presenceData

                const updatedUser: User = {
                    ...user,
                    lastSeen: getCurrentTimestamp(),
                }

                connectedUsers.set(socket.id, updatedUser)

                socket.to(`tracking-${user.sessionId}`).emit("user-presence-changed", {
                    userId: socket.id,
                    isActive: Boolean(isActive),
                    lastActivity: lastActivity || getCurrentTimestamp(),
                    timestamp: getCurrentTimestamp(),
                })
            } catch (error) {
                console.error("❌ Error in presence-update:", error)
            }
        })

        // Enhanced ping/pong handling
        socket.on("ping", (data) => {
            try {
                const health = connectionHealth.get(socket.id)
                socket.emit("pong", {
                    timestamp: getCurrentTimestamp(),
                    serverTime: Date.now(),
                    clientTime: data?.timestamp,
                    connectionHealth: health
                        ? {
                            latency: health.latency,
                            pingCount: health.pingCount,
                            isHealthy: health.isHealthy,
                        }
                        : null,
                })
            } catch (error) {
                console.error("❌ Error in ping:", error)
            }
        })

        // Enhanced reconnection handling
        socket.on("reconnect-request", (data) => {
            try {
                console.log(`🔄 Reconnection request from ${socket.id}`)

                const user = connectedUsers.get(socket.id)
                const health = connectionHealth.get(socket.id)

                socket.emit("reconnect-response", {
                    success: true,
                    timestamp: getCurrentTimestamp(),
                    serverTime: Date.now(),
                    userData: user,
                    connectionHealth: health,
                    bufferedMessages: messageBuffer.get(socket.id) || [],
                })
            } catch (error) {
                console.error("❌ Error in reconnect-request:", error)
            }
        })

        // Enhanced disconnection handling
        socket.on("disconnect", (reason) => {
            try {
                console.log(`❌ Client disconnected: ${socket.id}, reason: ${reason}`)

                const user = connectedUsers.get(socket.id)
                if (user) {
                    // Clear typing timeout
                    if (typingUsers.has(socket.id)) {
                        clearTimeout(typingUsers.get(socket.id)!)
                        typingUsers.delete(socket.id)
                    }

                    // Remove from session tracking
                    const sessionUsers = trackingSessions.get(user.sessionId)
                    if (sessionUsers) {
                        sessionUsers.delete(socket.id)
                        if (sessionUsers.size === 0) {
                            trackingSessions.delete(user.sessionId)
                        }
                    }

                    // Notify others in the room
                    socket.to(`tracking-${user.sessionId}`).emit("user-left", {
                        userId: socket.id,
                        userName: user.name,
                        timestamp: getCurrentTimestamp(),
                        reason: reason,
                    })

                    // Update user count
                    const remainingUsers = Array.from(connectedUsers.values()).filter(
                        (u) => u.sessionId === user.sessionId && u.id !== socket.id,
                    )

                    io.to(`tracking-${user.sessionId}`).emit("user-count", remainingUsers.length)

                    console.log(`👋 ${user.name} left session: ${user.sessionId}`)

                    // Keep user data for potential reconnection (for 5 minutes)
                    setTimeout(
                        () => {
                            connectedUsers.delete(socket.id)
                            messageBuffer.delete(socket.id)
                        },
                        5 * 60 * 1000,
                    )
                }

                connectionHealth.delete(socket.id)
            } catch (error) {
                console.error("❌ Error in disconnect:", error)
            }
        })

        // Enhanced error handling
        socket.on("error", (error) => {
            console.error(`❌ Socket error for ${socket.id}:`, error)

            // Try to recover from certain errors
            if (error.message.includes("transport")) {
                socket.emit("connection-recovery", {
                    message: "Transport error detected, attempting recovery",
                    timestamp: getCurrentTimestamp(),
                })
            }
        })
    })

    // Server health monitoring
    const logServerHealth = () => {
        const memUsage = process.memoryUsage()
        const cpuUsage = process.cpuUsage()

        console.log(
            `💓 Server Health - Users: ${connectedUsers.size}, Sessions: ${trackingSessions.size}, Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        )

        // Alert if memory usage is high
        if (memUsage.heapUsed > 500 * 1024 * 1024) {
            // 500MB
            console.warn(`⚠️ High memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`)
            performCleanup()
        }
    }

    // Log server health every 30 seconds
    setInterval(logServerHealth, 30000)

    console.log("🚀 Enhanced Socket.IO Server initialized with stability improvements")

    return io
}
