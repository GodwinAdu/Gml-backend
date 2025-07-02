import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { log } from "../utils/logger";

/**
 * Initializes a Socket.IO server.
 * @param {HttpServer} server - The HTTP server to attach the Socket.IO server to.
 * @returns {Server} The initialized Socket.IO server.
 */

export const initSocket = (server: HttpServer) => {
    const io = new Server(server, {
        cors: {
            origin: [
                "http://localhost:3000",
                "https://carpentary2025.vercel.app", // Add your actual frontend domain
                /\.vercel\.app$/,
                /\.netlify\.app$/,
            ],
            methods: ["GET", "POST"],
            credentials: true,
        },
        // Production-optimized transport settings
        transports: ["websocket", "polling"],
        allowEIO3: true,

        // Connection stability settings
        pingTimeout: 120000, // 2 minutes - increased for unstable connections
        pingInterval: 25000, // 25 seconds
        upgradeTimeout: 30000, // 30 seconds for transport upgrade
        maxHttpBufferSize: 1e6, // 1MB - reduced for better performance

        // Compression settings
        perMessageDeflate: {
            threshold: 1024,
            concurrencyLimit: 10,
            memLevel: 7,
        },

        // Connection management
        allowUpgrades: true,
        cookie: false, // Disable cookies for better performance

        // Heartbeat settings for Render
    });
    // Store connected users and their data
    const connectedUsers = new Map()
    const trackingSessions = new Map()
    const typingUsers = new Map()
    const connectionHealth = new Map() // Track connection health

    // Utility functions
    const generateUserId = () => Math.random().toString(36).substr(2, 9)
    const getCurrentTimestamp = () => new Date().toISOString()

    // Connection health monitoring
    const monitorConnection = (socket: Socket) => {
        const connectionId = socket.id
        const healthData = {
            connectedAt: Date.now(),
            lastPing: Date.now(),
            pingCount: 0,
            reconnectCount: 0,
            isHealthy: true,
        }

        connectionHealth.set(connectionId, healthData)

        // Ping monitoring
        const pingInterval = setInterval(() => {
            if (socket.connected) {
                const startTime = Date.now()
                socket.emit("ping", { timestamp: startTime })

                const timeout = setTimeout(() => {
                    // Mark as unhealthy if no pong received
                    const health = connectionHealth.get(connectionId)
                    if (health) {
                        health.isHealthy = false
                        connectionHealth.set(connectionId, health)
                    }
                }, 10000) // 10 second timeout

                socket.once("pong", (data: any) => {
                    clearTimeout(timeout)
                    const health = connectionHealth.get(connectionId)
                    if (health) {
                        health.lastPing = Date.now()
                        health.pingCount++
                        health.isHealthy = true
                        health.latency = Date.now() - startTime
                        connectionHealth.set(connectionId, health)
                    }
                })
            }
        }, 30000) // Ping every 30 seconds

        // Cleanup on disconnect
        socket.on("disconnect", () => {
            clearInterval(pingInterval)
            connectionHealth.delete(connectionId)
        })
    }

    // Graceful shutdown handling
    const gracefulShutdown = () => {
        console.log("🔄 Graceful shutdown initiated...")

        // Notify all clients about server shutdown
        io.emit("server-shutdown", {
            message: "Server is restarting, please reconnect in a moment",
            timestamp: getCurrentTimestamp(),
        })

        // Close all connections
        io.close(() => {
            console.log("✅ All connections closed")
            server.close(() => {
                console.log("✅ Server closed")
                process.exit(0)
            })
        })

        // Force exit after 10 seconds
        setTimeout(() => {
            console.log("⚠️ Forcing exit...")
            process.exit(1)
        }, 10000)
    }

    // Handle process signals
    process.on("SIGTERM", gracefulShutdown)
    process.on("SIGINT", gracefulShutdown)
    process.on("SIGUSR2", gracefulShutdown) // Render uses SIGUSR2

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
        console.error("❌ Uncaught Exception:", error)
        gracefulShutdown()
    })

    process.on("unhandledRejection", (reason, promise) => {
        console.error("❌ Unhandled Rejection at:", promise, "reason:", reason)
        gracefulShutdown()
    })

    console.log("🚀 Socket.IO Server starting...")

    io.on("connection", (socket) => {
        console.log(`✅ Client connected: ${socket.id}`)

        // Start connection monitoring
        monitorConnection(socket)

        // Send connection confirmation
        socket.emit("connection-confirmed", {
            socketId: socket.id,
            timestamp: getCurrentTimestamp(),
            serverTime: Date.now(),
        })

        // Handle user joining tracking session
        socket.on("join-tracking", (data) => {
            try {
                const { name, role, sessionId, location, speed, accuracy, heading } = data

                console.log(`🔗 User joining:`, { name, role, sessionId })

                // Create user data
                const userData = {
                    id: socket.id,
                    name: name || `User ${socket.id.substr(0, 6)}`,
                    role: role || "worker",
                    sessionId: sessionId || "tracking-users",
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

                // Join the tracking room
                socket.join(`tracking-${userData.sessionId}`)

                // Notify others in the room
                socket.to(`tracking-${userData.sessionId}`).emit("user-joined", userData)

                // Send current users list to the new user
                const roomUsers = Array.from(connectedUsers.values()).filter((user) => user.sessionId === userData.sessionId)
                socket.emit("users-list", roomUsers)

                // Send updated user count to all users in room
                io.to(`tracking-${userData.sessionId}`).emit("user-count", roomUsers.length)

                console.log(`👤 ${userData.name} joined tracking session: ${userData.sessionId}`)
            } catch (error) {
                console.error("❌ Error in join-tracking:", error)
                socket.emit("error", { message: "Failed to join tracking session" })
            }
        })

        // Handle location updates with error handling
        socket.on("location-update", (locationData) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) {
                    socket.emit("error", { message: "User not found" })
                    return
                }

                // Add to trail
                if (locationData.location) {
                    const trailPoint = {
                        latitude: locationData.location.latitude,
                        longitude: locationData.location.longitude,
                        timestamp: getCurrentTimestamp(),
                    }

                    user.trail.push(trailPoint)

                    // Keep only last 50 trail points to reduce memory usage
                    if (user.trail.length > 50) {
                        user.trail = user.trail.slice(-50)
                    }
                }

                // Update user location data
                const updatedUser = {
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
                socket.to(`tracking-${user.sessionId}`).emit("location-update", {
                    userId: socket.id,
                    location: locationData.location,
                    accuracy: locationData.accuracy,
                    speed: locationData.speed,
                    heading: locationData.heading,
                    timestamp: getCurrentTimestamp(),
                })

                // Update user in users list for all users in session
                io.to(`tracking-${user.sessionId}`).emit("user-updated", updatedUser)
            } catch (error) {
                console.error("❌ Error in location-update:", error)
                socket.emit("error", { message: "Failed to update location" })
            }
        })

        // Handle typing indicators with debouncing
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
                    clearTimeout(typingUsers.get(socket.id))
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

                // Update user typing status
                user.isTyping = false
                connectedUsers.set(socket.id, user)

                // Clear timeout
                if (typingUsers.has(socket.id)) {
                    clearTimeout(typingUsers.get(socket.id))
                    typingUsers.delete(socket.id)
                }

                // Broadcast typing status to others in the session
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

        // Handle chat messages
        socket.on("send-message", (messageData) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) {
                    socket.emit("error", { message: "User not found" })
                    return
                }

                // Stop typing when message is sent
                user.isTyping = false
                connectedUsers.set(socket.id, user)

                // Clear typing timeout
                if (typingUsers.has(socket.id)) {
                    clearTimeout(typingUsers.get(socket.id))
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
                    message: messageData.message,
                    timestamp: getCurrentTimestamp(),
                    location: user.location,
                    messageType: messageData.messageType || "text",
                    edited: false,
                    reactions: {},
                }

                // Broadcast message to all users in the session
                io.to(`tracking-${user.sessionId}`).emit("new-message", message)

                console.log(`💬 Message from ${user.name}: ${messageData.message}`)
            } catch (error) {
                console.error("❌ Error in send-message:", error)
                socket.emit("error", { message: "Failed to send message" })
            }
        })

        // Handle message reactions
        socket.on("message-reaction", (reactionData) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                const { messageId, emoji, action } = reactionData

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

        // Handle status updates
        socket.on("status-update", (status) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                const updatedUser = {
                    ...user,
                    status,
                    lastSeen: getCurrentTimestamp(),
                }

                connectedUsers.set(socket.id, updatedUser)

                // Broadcast status update
                socket.to(`tracking-${user.sessionId}`).emit("user-status-changed", {
                    userId: socket.id,
                    status,
                    timestamp: getCurrentTimestamp(),
                })

                // Update user in users list
                io.to(`tracking-${user.sessionId}`).emit("user-updated", updatedUser)
            } catch (error) {
                console.error("❌ Error in status-update:", error)
            }
        })

        // Handle presence updates
        socket.on("presence-update", (presenceData) => {
            try {
                const user = connectedUsers.get(socket.id)
                if (!user) return

                const { isActive, lastActivity } = presenceData

                const updatedUser = {
                    ...user,
                    isActive,
                    lastActivity: lastActivity || getCurrentTimestamp(),
                    lastSeen: getCurrentTimestamp(),
                }

                connectedUsers.set(socket.id, updatedUser)

                // Broadcast presence update
                socket.to(`tracking-${user.sessionId}`).emit("user-presence-changed", {
                    userId: socket.id,
                    isActive,
                    lastActivity: updatedUser.lastActivity,
                    timestamp: getCurrentTimestamp(),
                })
            } catch (error) {
                console.error("❌ Error in presence-update:", error)
            }
        })

        // Enhanced ping/pong handling
        socket.on("ping", (data) => {
            try {
                socket.emit("pong", {
                    timestamp: getCurrentTimestamp(),
                    serverTime: Date.now(),
                    clientTime: data?.timestamp,
                })
            } catch (error) {
                console.error("❌ Error in ping:", error)
            }
        })

        // Handle client reconnection
        socket.on("reconnect-request", (data) => {
            try {
                console.log(`🔄 Reconnection request from ${socket.id}`)

                socket.emit("reconnect-response", {
                    success: true,
                    timestamp: getCurrentTimestamp(),
                    serverTime: Date.now(),
                })
            } catch (error) {
                console.error("❌ Error in reconnect-request:", error)
            }
        })

        // Handle disconnection
        socket.on("disconnect", (reason) => {
            try {
                console.log(`❌ Client disconnected: ${socket.id}, reason: ${reason}`)

                const user = connectedUsers.get(socket.id)
                if (user) {
                    // Clear typing timeout
                    if (typingUsers.has(socket.id)) {
                        clearTimeout(typingUsers.get(socket.id))
                        typingUsers.delete(socket.id)
                    }

                    // Notify others in the room
                    socket.to(`tracking-${user.sessionId}`).emit("user-left", {
                        userId: socket.id,
                        userName: user.name,
                        timestamp: getCurrentTimestamp(),
                    })

                    // Update user count
                    const remainingUsers = Array.from(connectedUsers.values()).filter(
                        (u) => u.sessionId === user.sessionId && u.id !== socket.id,
                    )

                    io.to(`tracking-${user.sessionId}`).emit("user-count", remainingUsers.length)

                    console.log(`👋 ${user.name} left session: ${user.sessionId}`)

                    // Remove user from connected users
                    connectedUsers.delete(socket.id)
                }

                // Cleanup connection health
                connectionHealth.delete(socket.id)
            } catch (error) {
                console.error("❌ Error in disconnect:", error)
            }
        })

        // Handle connection errors
        socket.on("error", (error) => {
            console.error(`❌ Socket error for ${socket.id}:`, error)
        })

    });

    // Periodic cleanup of stale data
    setInterval(() => {
        const now = Date.now()
        const staleThreshold = 5 * 60 * 1000 // 5 minutes

        // Clean up stale connections
        connectionHealth.forEach((health, socketId) => {
            if (now - health.lastPing > staleThreshold) {
                console.log(`🧹 Cleaning up stale connection: ${socketId}`)
                connectionHealth.delete(socketId)
                connectedUsers.delete(socketId)
                typingUsers.delete(socketId)
            }
        })
    }, 60000) // Run every minute

    return io;
};
