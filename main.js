const path = require('path');
const { app, ipcMain, BrowserWindow, screen } = require('electron');
const Twig = require('twig');
const fork = require('child_process').fork;

if (require('electron-squirrel-startup')) return app.quit();

// Disable GPU acceleration to fix crashes
app.disableHardwareAcceleration();

const Installer = require("./src/installer.js");
if (Installer.handleSquirrelEvent()) {
    // squirrel event handled and app will exit in 1000ms, so don't do anything else
    return;
}

function createWindow () {
    // Get all displays and select the first one (HP 25x)
    const displays = screen.getAllDisplays();
    console.log("[Main] Found " + displays.length + " display(s)");
    displays.forEach((display, index) => {
        console.log("[Main] Display " + index + ": " + display.label + " - bounds: x=" + display.bounds.x + ", y=" + display.bounds.y + ", width=" + display.bounds.width + ", height=" + display.bounds.height);
    });

    // Always use Display 0 (HP 25x)
    let targetDisplay = displays[0];
    console.log("[Main] Opening app on primary display (HP 25x): " + targetDisplay.bounds.width + "x" + targetDisplay.bounds.height);

    // Get the bounds of the target display
    const displayBounds = targetDisplay.bounds;

    // Erstelle das Browser-Fenster auf Display 0 (HP 25x)
    let win = new BrowserWindow({
        x: displayBounds.x + 10,
        y: displayBounds.y + 10,
        width: 1400,
        height: 780,
        frame: false,
        icon: path.join(__dirname, 'build/icon_64x64.png'),
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: false,
            sandbox: false
        }
    });

    win.loadFile(path.join(__dirname, 'gui/index.html')).catch((err) => {
        console.error('Failed to load GUI:', err);
        win.loadURL('data:text/html,<h1>Error loading GUI</h1><p>' + err.toString() + '</p>');
    });
    
    win.setMenuBarVisibility(false);

    win.once('ready-to-show', () => {
        win.show();
    });
    // DevTools zum Debuggen
    //win.webContents.openDevTools();

    let backend = fork("./src/backend.js");
    let backendCallback = function(message) {
        win.webContents.send(...message);
    };
    backend.on("error", (error) => {
        console.error("Backend error:", error);
    });
    backend.on("message", backendCallback);
    
    // Store backend reference globally for IPC handler
    global.backend = backend;
    global.mainWindow = win;
}

app.on('ready', createWindow);

// IPC Handlers for file/directory dialogs
const { dialog } = require('electron');

ipcMain.on("gui", (event, type, ...parameters) => {
    if (type === "quit") {
        if (global.backend) {
            global.backend.kill();
        }
        app.quit();
        return;
    }
    if (global.backend) {
        global.backend.send([type, parameters]);
    }
});

ipcMain.handle('open-directory-dialog', async (event, options) => {
    return await dialog.showOpenDialog({
        properties: ['openDirectory'],
        defaultPath: options.defaultPath || ''
    });
});

ipcMain.handle('open-file-dialog', async (event, options) => {
    return await dialog.showOpenDialog({
        properties: ['openFile'],
        defaultPath: options.defaultPath || ''
    });
});
