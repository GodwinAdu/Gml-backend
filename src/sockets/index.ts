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
            origin: ["http://localhost:3000", "https://carpentary2025.vercel.app"],
            methods: ["GET", "POST"],
            credentials: true,
        },
        transports: ["websocket", "polling"],
        allowEIO3: true, // Allow legacy clients to connect
        pingTimeout: 60000, // Set ping timeout to 60 seconds
        pingInterval: 25000, // Set ping interval to 25 seconds
        maxHttpBufferSize: 1e7, // Set max HTTP buffer size to 10 MB
        perMessageDeflate: {
            threshold: 1024, // Enable compression for messages larger than 1 KB
        },
        allowUpgrades: true, // Allow protocol upgrades
    });

    // Store connected users and their data
    const connectedUsers = new Map()
    const trackingSessions = new Map()
    const typingUsers = new Map() // Store typing status

    // Utility functions
    const generateUserId = () => Math.random().toString(36).substr(2, 9)
    const getCurrentTimestamp = () => new Date().toISOString()

    console.log("🚀 Socket.IO Server starting...")

    io.on("connection", (socket) => {
        console.log(`Client connected: ${socket.id}`)

        // Handle user joining tracking session
        socket.on("join-tracking", (data) => {
            const { name, role, sessionId, location, speed, accuracy, heading } = data

            console.log(`🔗 User joining:`, { name, role, sessionId, location })

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
            console.log(`📊 Total users in session: ${roomUsers.length}`)
        })

        // Handle location updates
        socket.on("location-update", (locationData) => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            console.log(`📍 Location update from ${user.name}:`, locationData)

            // Add to trail
            if (locationData.location) {
                const trailPoint = {
                    latitude: locationData.location.latitude,
                    longitude: locationData.location.longitude,
                    timestamp: getCurrentTimestamp(),
                }

                user.trail.push(trailPoint)

                // Keep only last 100 trail points
                if (user.trail.length > 100) {
                    user.trail = user.trail.slice(-100)
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
        })

        // Handle typing indicators
        socket.on("typing-start", () => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            console.log(`⌨️ ${user.name} started typing`)

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
        })

        socket.on("typing-stop", () => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            console.log(`⌨️ ${user.name} stopped typing`)

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
        })

        // Handle status updates
        socket.on("status-update", (status) => {
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
        })

        // Handle chat messages
        socket.on("send-message", (messageData) => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

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
        })

        // Handle message reactions
        socket.on("message-reaction", (reactionData) => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            const { messageId, emoji, action } = reactionData // action: 'add' or 'remove'

            // Broadcast reaction to all users in the session
            io.to(`tracking-${user.sessionId}`).emit("message-reaction-update", {
                messageId,
                userId: socket.id,
                userName: user.name,
                emoji,
                action,
                timestamp: getCurrentTimestamp(),
            })

            console.log(`${action === "add" ? "👍" : "👎"} ${user.name} ${action}ed reaction ${emoji} to message ${messageId}`)
        })

        // Handle geofence alerts
        socket.on("geofence-alert", (alertData) => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            const alert = {
                id: generateUserId(),
                userId: socket.id,
                userName: user.name,
                type: alertData.type,
                geofenceName: alertData.geofenceName,
                location: alertData.location,
                timestamp: getCurrentTimestamp(),
                priority: alertData.priority || "medium",
            }

            // Broadcast alert to all users in the session
            io.to(`tracking-${user.sessionId}`).emit("geofence-alert", alert)

            console.log(`🚨 Geofence alert: ${user.name} ${alertData.type} ${alertData.geofenceName}`)
        })

        // Handle route recording
        socket.on("start-route-recording", () => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            socket.to(`tracking-${user.sessionId}`).emit("user-started-recording", {
                userId: socket.id,
                userName: user.name,
                timestamp: getCurrentTimestamp(),
            })
        })

        socket.on("stop-route-recording", (routeData) => {
            const user = connectedUsers.get(socket.id)
            if (!user) return

            socket.to(`tracking-${user.sessionId}`).emit("user-stopped-recording", {
                userId: socket.id,
                userName: user.name,
                routeData,
                timestamp: getCurrentTimestamp(),
            })
        })

        // Handle user presence updates
        socket.on("presence-update", (presenceData) => {
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
        })

        // Handle disconnection
        socket.on("disconnect", () => {
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

                console.log(`❌ ${user.name} disconnected from session: ${user.sessionId}`)

                // Remove user from connected users
                connectedUsers.delete(socket.id)
            }
        })

        // Handle ping for connection monitoring
        socket.on("ping", () => {
            socket.emit("pong", { timestamp: getCurrentTimestamp() })
        })

    });

    return io;
};
