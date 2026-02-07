# Understanding Electron

Electron allows developers to build desktop applications using web technologies (HTML, CSS, JavaScript) while still providing access to platform-native services such as file dialogs, menus, and system processes. Internally, Electron runs a sandboxed Chromium-based UI alongside a Node.js process that manages operating system integration.

An Electron app has:
+	Main process: OS access, lifecycle, heavy lifting
+	Renderer process: UI, DOM, user interaction
+	Preload script: secure, explicit bridge between the two
+	Interprocess communication (IPC): the glue that holds it together

Electron apps run code in three distinct environments, each with different responsibilities and privileges:

```
┌───────────────────────────────────────────┐
│              Main Process                 │
│  (Node.js, OS access, app lifecycle)      │
└───────────────────────────────────────────┘
                │ IPC
                ▼
┌───────────────────────────────────────────┐
│            Preload Script                 │
│  (secure bridge, controlled API)          │
└───────────────────────────────────────────┘
                │ Direct JavaScript Calls
                ▼
┌───────────────────────────────────────────┐
│            Renderer Process               │
│  (Chromium, DOM, UI, JS, CSS)             │
└───────────────────────────────────────────┘
```

## 1️⃣ Main Process

**What it is**:

+	A Node.js process
+	Started by Electron itself
+	There is exactly one main process per app

**What it does**

+	Manage App lifecycle from start to quit
+	Create windows (BrowserWindow)
+	Native OS UI (menus, dialogs, dock, tray)
+	Filesystem access
+	Spawning child processes (ffmpeg, Python, etc.)

**What it does not do**

+	No DOM
+	No direct UI rendering
+	No HTML/CSS

**Usage in our PoC**

+	Creates the window
+	Runs ffmpeg / ffprobe
+	Spawns Whisper transcription
+	Handles file dialogs
+	Implements IPC handlers

## 2️⃣ Renderer Process (the “browser tab”)

**What it is**

+	A Chromium renderer, just like a Chrome tab
+	One renderer per window (or per <webview>)

**What it does**

+	HTML, CSS, TS
+	UI logic
+	Event handling
+	Drawing waveforms
+	Displaying transcript text

**What it does not have (by default)**

+	No filesystem access
+	No require("fs")
+	No child processes
+ This is intentional for security

**Usage in our PoC**

Our `src/renderer.ts`:

+	Handles WaveSurfer
+	Renders transcript words
+	Responds to user clicks
+	Calls window.otter.* for privileged work

## 3️⃣ Preload Script (the bridge to native functionality)

**What it is**

+	Runs before the renderer loads
+	Has access to:
	+	limited Node APIs
	+	the browser window
+	Executes in a special isolated context

**What it does**

+	Defines a safe API that the renderer can call
+	Bridges renderer ↔ main via IPC
+	Prevents renderer from accessing arbitrary Node APIs

**Why it exists**

Because Electron wants:

+	UI code to be safe
+	OS access to be explicit
+	Attack surface to be minimal

**Usage in our PoC**

Our `src/preload.ts`:

+	Exposes window.otter
+	Wraps IPC calls
+	Converts buffers to ArrayBuffers
+	Enforces clean separation

## Putting it all together (OTTER PoC flow)

```
+---------------------------------------------------+
|                   Main Process                    |
|  (Node.js, OS access, app lifecycle)              |
|                                                   |
|  • Create application windows                     |
|  • Show native dialogs (File → Open)              |
|  • Run ffmpeg / ffprobe                           |
|  • Spawn transcription process (Whisper)          |
+---------------------------▲-----------------------+
                            │ IPC (invoke / events)
                            │
+---------------------------┴-----------------------+
|                Preload Script                     |
|          (Secure, explicit API boundary)          |
|                                                   |
|  • Exposes window.otter API                       |
|  • Bridges renderer ↔ main via IPC                |
|  • Prevents direct Node.js access                 |
+---------------------------▲-----------------------+
                            │
                            │
+---------------------------┴-----------------------+
|                Renderer Process                   |
|      (Chromium: HTML / CSS / JavaScript)          |
|                                                   |
|  • Audio waveform display (WaveSurfer.js)         |
|  • Transcript rendering and interaction           |
|  • Detail waveform + region highlighting          |
|  • User input handling                            |
+---------------------------------------------------+
```

Here’s what happens when a user clicks a word:

1.	Renderer
	+ User clicks transcript word
	+ UI updates immediately
2.	Renderer → Preload
	+	Calls window.otter.makeSnippet(...)
3.	Preload → Main
	+	IPC invokes make-snippet
4.	Main
	+	Runs ffmpeg
	+	Writes WAV file
	+	Returns path
5.	Main → Renderer
	+	Promise resolves
6.	Renderer
	+	Loads snippet into WaveSurfer
	+	Creates region
	+	Updates UI
