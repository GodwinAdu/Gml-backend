export const log = {
  info: (message: string, ...args: any[]) => {
    console.log(`ℹ️ [${new Date().toISOString()}] ${message}`, ...args)
  },

  warn: (message: string, ...args: any[]) => {
    console.warn(`⚠️ [${new Date().toISOString()}] ${message}`, ...args)
  },

  error: (message: string, ...args: any[]) => {
    console.error(`❌ [${new Date().toISOString()}] ${message}`, ...args)
  },

  success: (message: string, ...args: any[]) => {
    console.log(`✅ [${new Date().toISOString()}] ${message}`, ...args)
  },

  debug: (message: string, ...args: any[]) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`🐛 [${new Date().toISOString()}] ${message}`, ...args)
    }
  },
}
