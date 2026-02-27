# User Stories

## Story 1: Import Audio
**As a user**, I want to import a spoken-word audio file into the application, so that I can begin editing it.

### Acceptance Criteria
- The user can select a local audio file (e.g., WAV, MP3, M4A).
- The audio loads successfully and can be played back.
- The project remembers the audio file reference.
- Basic transport controls (play / pause / seek) work.

## Story 2: Generate Local Transcript
**As a user**, I want to generate a transcript of the audio locally, so that I can edit the recording using text.

### Acceptance Criteria
- Transcription runs entirely on the local machine.
- The transcript includes word-level timestamps.
- Progress is visible during transcription.
- The resulting transcript is stored with the project.

## Story 3: Transcript-Based Navigation
**As a user**, I want to click on any word in the transcript and hear the audio from that point, so that I can navigate by reading instead of scrubbing.

### Acceptance Criteria
- Clicking a word seeks playback to the correct timestamp.
- Playback begins with minimal latency.
- The active word is visually highlighted.
- The transcript auto-scrolls during playback to keep the cursor visible.

## Story 4: Transcript-Driven Deletion
**As a user**, I want to delete words or sentences directly from the transcript, so that the corresponding audio is removed automatically.

### Acceptance Criteria
- Selecting text and pressing Delete removes it from the transcript.
- Playback skips the corresponding audio segment.
- Remaining audio plays continuously (no silence gaps).
- The original audio file remains unchanged.

## Story 5: Non-Destructive Editing with Undo
**As a user**, I want all edits to be undoable, so that I can experiment without fear of losing data.

### Acceptance Criteria
- All transcript edits are non-destructive.
- Undo and redo restore previous transcript and audio states.
- Undo / redo works across multiple edits.
- The system never modifies the source media.

## Story 6: Contextual Waveform Visualization
**As a user**, I want to see a waveform aligned with the transcript, so that I can visually confirm timing and pauses without editing by waveform.

### Acceptance Criteria
- A waveform is displayed contextually alongside transcript regions.
- The waveform highlights the currently playing segment.
- Waveform view stays synchronized with transcript playback.
- Waveform is read-only in MVP.

## Story 7: Reordering Transcript Sections
**As a user**, I want to move a selected sentence or paragraph to a different position in the transcript, so that I can rearrange the audio content.

### Acceptance Criteria
- Transcript text can be cut and pasted.
- Audio playback reflects the new ordering.
- Word-to-audio alignment remains correct.
- Operation is undoable.

## Story 8: Save and Load Projects
**As a user**, I want to save and load my project, so that I can stop working and later resume editing without losing any progress.

### Acceptance Criteria
- The application allows the user to save the current project state to disk.
- The saved project captures all essential state, including:
  - Reference to the source media file(s)
  - Transcript data (including word-level timing)
  - Any user-refined word boundaries or regions
  - Edit decisions made so far (e.g., cuts, rearrangements, muted sections)
- A previously saved project can be loaded at a later time.
- After loading, the project appears in the same logical state as when it was saved:
  - Transcript content and ordering are preserved
  - Refined boundaries and selections are restored
  - The editor timeline reflects all prior edits
- Saving and loading does not modify the original media files.

## Story 9: Export Edited Audio
**As a user**, I want to export the edited audio to a standard format, so that I can use it outside the application.

### Acceptance Criteria
- The edited result can be exported (e.g., WAV or MP3).
- Export reflects all transcript edits.
- Export completes successfully for multi-minute audio.
- The exported duration matches the edited transcript.

## Story 10: App Remains Responsive

As a user, I want the application to remain responsive during long-running operations (such as transcription or export), and I want to be able to pause or cancel those operations, so that I stay in control of my work and my time.

### Acceptance Criteria
- The user interface remains responsive while long-running operations are in progress.
- Long-running operations (e.g., transcription, alignment, waveform generation, export) provide visible progress feedback.
- The user can cancel a long-running operation at any time.
- Canceling an operation stops processing promptly and releases system resources without corrupting the project state.
- The application never requires a force quit to recover from a stalled operation.

## Story 11: Transcript Search (Find / Ctrl + F)

As a user, I want to search for words or phrases in the transcript using a find bar (Ctrl + F), so that I can quickly navigate large transcripts without scrolling manually.

### Acceptance Criteria

- Pressing Ctrl + F (or Cmd + F on macOS) opens a find bar in the editor.
- The find bar allows the user to type a search query.
- Pressing Enter selects the next matching word in the transcript.
- Repeated presses of Enter cycle through all matching results.
- When a match is selected:
    The word is visually highlighted.
    Audio playback seeks to the word’s start time.
    The transcript scrolls to keep the word visible.
- Changing the search query resets the search position.
- Closing the find bar clears the active search state.
- The feature works for both short and large transcripts.

