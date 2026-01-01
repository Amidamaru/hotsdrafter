const HotsDraftApp = require("./hots-draft-app.js");

// Initialize core app class
let hotsApp = new HotsDraftApp();

// Global promise rejection handler - silently ignore, don't crash
process.on("unhandledRejection", (reason, promise) => {
  // Log but don't throw - app can continue with cached data
  console.debug("Unhandled Promise Rejection (handled gracefully):", reason);
});

// Catch uncaught exceptions too
process.on("uncaughtException", (error) => {
  console.debug("Uncaught Exception (handled gracefully):", error.message);
});

// Send incoming messages from the main process to the app
process.on("message", (message) => {
  hotsApp.handleEvent(...message);
});