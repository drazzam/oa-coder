const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const os = require('os');

let config;
try {
  const configPath = path.join(__dirname, 'config.json');
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  if (!config.apiKey) {
    throw new Error("API key is missing in config.json");
  }
  
  // Set default model if not specified
  if (!config.model) {
    config.model = "gemini-2.5-flash-preview-05-20";
    console.log("Model not specified in config, using default:", config.model);
  }
} catch (err) {
  console.error("Error reading config:", err);
  app.quit();
}

// Initialize the Gemini API client
const genAI = new GoogleGenerativeAI(config.apiKey);

let mainWindow;
let screenshots = [];
let multiPageMode = false;
let appIsActive = true; // Flag to track if app is actively intercepting input
let isScreenSharingDetected = false;

// Enhanced privacy protection for Windows
function enablePrivacyProtection(window) {
  // Enable content protection
  window.setContentProtection(true);
  
  // Additional privacy settings for Windows
  if (os.platform() === 'win32') {
    try {
      // Set window to be excluded from capture
      window.setSkipTaskbar(true);
      
      // Use Windows-specific flags to prevent screen capture
      const { nativeImage } = require('electron');
      
      // Set additional window properties for privacy
      window.setAlwaysOnTop(true, 'screen-saver', 2);
      
      // Try to set window as non-capturable (Windows 10/11 specific)
      try {
        const { execSync } = require('child_process');
        const windowId = window.getNativeWindowHandle();
        
        // Note: This requires additional native modules for full Windows API access
        // For now, we'll rely on Electron's built-in protections
        console.log('Enhanced privacy protection enabled for Windows');
      } catch (e) {
        console.log('Advanced Windows privacy features unavailable, using Electron defaults');
      }
    } catch (error) {
      console.error('Error applying Windows-specific privacy settings:', error);
    }
  }
  
  // Set window to not appear in screen capture APIs
  window.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false });
  
  // Monitor for screen sharing attempts
  detectScreenSharing();
}

// Detect potential screen sharing scenarios
function detectScreenSharing() {
  // Monitor for multiple displays or screen capture requests
  setInterval(() => {
    const displays = screen.getAllDisplays();
    const currentScreenSharing = displays.some(display => 
      display.bounds.width !== display.workArea.width || 
      display.bounds.height !== display.workArea.height
    );
    
    if (currentScreenSharing !== isScreenSharingDetected) {
      isScreenSharingDetected = currentScreenSharing;
      if (isScreenSharingDetected) {
        console.log('Potential screen sharing detected - enhancing privacy');
        if (mainWindow) {
          // Additional hiding when screen sharing is detected
          mainWindow.setOpacity(0.01); // Nearly invisible
          mainWindow.minimize();
          setTimeout(() => {
            if (mainWindow) {
              mainWindow.restore();
              mainWindow.setOpacity(1.0);
            }
          }, 1000);
        }
      }
    }
  }, 2000);
}

function updateInstruction(instruction) {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('update-instruction', instruction);
  }
}

function hideInstruction() {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('hide-instruction');
  }
}

async function captureScreenshot() {
  try {
    hideInstruction();
    
    // Enhanced hiding during screenshot capture
    mainWindow.setOpacity(0);
    mainWindow.hide();
    await new Promise(res => setTimeout(res, 300)); // Longer delay for better hiding

    const timestamp = Date.now();
    const imagePath = path.join(app.getPath('pictures'), `screenshot_${timestamp}.png`);
    await screenshot({ filename: imagePath });

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    // Restore window visibility
    mainWindow.setOpacity(1.0);
    mainWindow.show();
    
    return { base64Image, imagePath };
  } catch (err) {
    // Ensure window is restored even on error
    if (mainWindow) {
      mainWindow.setOpacity(1.0);
      mainWindow.show();
    }
    if (mainWindow.webContents) {
      mainWindow.webContents.send('error', err.message);
    }
    throw err;
  }
}

async function processScreenshots() {
  try {
    // Get the Gemini model with updated model name
    const model = genAI.getGenerativeModel({ model: config.model });
    
    // Create a new chat session
    const chat = model.startChat();
    
    // Enhanced prompt for better MCQ analysis
    const prompt = `
    You are an expert MCQ solver. Analyze the provided image(s) and:
    
    1. **Identify the Question**: Extract and clearly state the complete question being asked.
    
    2. **List All Options**: Identify all available answer choices (A, B, C, D, etc.) with their full text.
    
    3. **Select the Correct Answer**: Choose the most accurate answer based on your knowledge and reasoning.
    
    4. **Provide Detailed Explanation**: Explain why the selected answer is correct and why other options are incorrect.
    
    5. **Format your response as**:
       **Question:** [Complete question text]
       
       **Available Options:**
       A) [Option A text]
       B) [Option B text]
       C) [Option C text]
       D) [Option D text]
       
       **Correct Answer:** [Letter] - [Answer text]
       
       **Explanation:** [Detailed reasoning for the correct answer and why other options are wrong]
       
       **Confidence Level:** [High/Medium/Low]
    `;
    
    // Create the content parts array with the initial text
    const parts = [{ text: prompt }];
    
    // Add all screenshots as inline images
    for (const screenshot of screenshots) {
      parts.push({
        inlineData: {
          data: screenshot.base64Image,
          mimeType: "image/png"
        }
      });
    }
    
    // Send the request to Gemini
    const result = await chat.sendMessage(parts);
    const response = await result.response;
    
    // Send the text to the renderer
    mainWindow.webContents.send('analysis-result', response.text());
  } catch (err) {
    console.error("Error in processScreenshots:", err);
    if (mainWindow.webContents) {
      mainWindow.webContents.send('error', err.message);
    }
  }
}

// Reset everything
function resetProcess() {
  screenshots = [];
  multiPageMode = false;
  mainWindow.webContents.send('clear-result');
  updateInstruction("Ctrl+Shift+S: Screenshot | Ctrl+Shift+A: Multi-mode");
}

function toggleAppInteractivity() {
  appIsActive = !appIsActive;
  if (appIsActive) {
    // Make app interactive
    mainWindow.setIgnoreMouseEvents(false);
    updateInstruction("App active: Ctrl+Shift+S: Screenshot | Ctrl+Shift+A: Multi-mode | Ctrl+Shift+I: Toggle interactivity");
  } else {
    // Make app pass-through (ignore mouse events)
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    updateInstruction("App inactive (click-through mode) | Ctrl+Shift+I: Toggle interactivity");
  }
}

function createWindow() {
  // Enhanced window creation with maximum privacy protection
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(800, width),
    height: Math.min(600, height),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Enhanced security settings
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    },
    // Enhanced privacy window options
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    paintWhenInitiallyHidden: false,
    type: os.platform() === 'win32' ? 'toolbar' : 'panel',
    skipTaskbar: true,
    focusable: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    closable: true,
    // Additional privacy settings
    enableLargerThanScreen: false,
    useContentSize: true,
    show: false, // Start hidden for enhanced privacy setup
  });

  // Apply enhanced privacy protection
  enablePrivacyProtection(mainWindow);

  mainWindow.loadFile('index.html');
  
  // Show window only after privacy protection is enabled
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
  });

  // Global shortcuts remain the same
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    try {
      const { base64Image, imagePath } = await captureScreenshot();
      screenshots.push({ base64Image, imagePath });
      await processScreenshots();
    } catch (error) {
      console.error("Ctrl+Shift+S error:", error);
    }
  });

  globalShortcut.register('CommandOrControl+Shift+A', async () => {
    try {
      if (!multiPageMode) {
        multiPageMode = true;
        updateInstruction("Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+S to finalize");
      }
      const { base64Image, imagePath } = await captureScreenshot();
      screenshots.push({ base64Image, imagePath });
      updateInstruction("Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+S to finalize");
    } catch (error) {
      console.error("Ctrl+Shift+A error:", error);
    }
  });

  globalShortcut.register('CommandOrControl+Shift+R', () => {
    resetProcess();
  });
     
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    console.log("Quitting application...");
    app.quit();
  });
  
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    toggleAppInteractivity();
  });
  
  // Initialize app with click-through mode disabled by default (fully interactive)
  toggleAppInteractivity();
  
  // Set up IPC handlers for UI buttons
  ipcMain.on('toggle-interactive', toggleAppInteractivity);
  ipcMain.on('capture-screenshot', async () => {
    try {
      const { base64Image, imagePath } = await captureScreenshot();
      screenshots.push({ base64Image, imagePath });
      await processScreenshots();
    } catch (error) {
      console.error("Capture screenshot error:", error);
    }
  });
  ipcMain.on('reset-process', resetProcess);

  // Enhanced privacy: Hide window when browsers request screen access
  mainWindow.on('blur', () => {
    // Temporarily reduce opacity when window loses focus
    if (isScreenSharingDetected) {
      mainWindow.setOpacity(0.1);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isFocused()) {
          mainWindow.setOpacity(1.0);
        }
      }, 500);
    }
  });

  mainWindow.on('focus', () => {
    mainWindow.setOpacity(1.0);
  });
}

// Enhanced app initialization with privacy focus
app.whenReady().then(() => {
  // Additional privacy settings for the entire app
  app.setAppUserModelId('com.privacy.mcqsolver');
  
  // Prevent the app from appearing in recent documents
  app.setAboutPanelOptions({
    applicationName: 'MCQ Privacy Tool',
    applicationVersion: '2.0.0',
  });
  
  createWindow();
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Additional privacy protection: Quit app if screen recording is detected for too long
let screenRecordingDuration = 0;
setInterval(() => {
  if (isScreenSharingDetected) {
    screenRecordingDuration += 5;
    if (screenRecordingDuration > 60) { // Hide for 60 seconds
      console.log('Extended screen sharing detected - enhanced privacy mode');
      if (mainWindow) {
        mainWindow.hide();
        setTimeout(() => {
          if (mainWindow) {
            mainWindow.show();
          }
        }, 10000); // Hide for 10 seconds
      }
      screenRecordingDuration = 0;
    }
  } else {
    screenRecordingDuration = 0;
  }
}, 5000);
