// Nodejs dependencies
const Tesseract = require('tesseract.js');

let worker = null;
let workerReady = false;
let messageQueue = [];

// Initialize worker async
(async () => {
  try {
    worker = await Tesseract.createWorker();
    workerReady = true;
    
    // Process any queued messages
    while (messageQueue.length > 0) {
      processMessage(messageQueue.shift());
    }
  } catch (error) {
    console.error("Worker init error:", error);
    process.send(["error", "Worker initialization failed: " + error.toString()]);
  }
})();

function processMessage(message) {
  if (!worker || !workerReady) {
    process.send(["error", "Worker not initialized"]);
    return;
  }
  
  let action = message.shift();
  switch(action) {
    case "recognize":
      let imageBase64 = message.shift();
      let langs = message.shift();
      
      try {
        (async () => {
          try {
            // Convert Base64 to Data URI for Tesseract.js
            const imageDataURI = "data:image/png;base64," + imageBase64;
            const result = await worker.recognize(imageDataURI, langs);
            process.send(["success", {
              confidence: result.data.confidence,
              text: result.data.text
            }]);
          } catch (error) {
            process.send(["error", error.toString()]);
          }
        })();
      } catch (error) {
        process.send(["error", error.toString()]);
      }
      break;
  }
}

// send incoming messages from the main process to the app
process.on("message", (message) => {
  if (!workerReady) {
    messageQueue.push(message);
    return;
  }
  processMessage(message);
});