# Transcript-Based Audio Editing Architecture (Transcript-Primary Model)

## Edit Decision List

As the user edits the transcript, the application records those changes without ever modifying the original audio. The **transcript is the primary editable object**. All edits—such as deleting words, reordering content, or refining word boundaries—are applied directly to the transcript and its associated word-level audio spans.

From this transcript state, the application derives an **Edit Decision List (EDL)** that describes how the final audio should be assembled.

### Core idea

- The source audio is never modified.
- Each word in the transcript owns a specific range of audio in the source file, including any gaps or pauses.
- Editing the transcript (deleting or reordering words) implicitly edits the audio.
- The EDL is a derived, ordered sequence of audio ranges generated from the current transcript state.

### Overview

An **Edit Decision List (EDL)** represents the current edited form of the audio as implied by the transcript. Conceptually, it is an ordered list of **audio segments**, where each segment is a reference to a time range in the original audio file.

When an audio file is first loaded and transcribed, the transcript contains all words in their original order, and the derived EDL consists of a single segment spanning the entire source file. As the user edits the transcript, the set and ordering of words changes. The EDL is then regenerated to reflect the owned audio ranges of the remaining words, merged and ordered according to the edited transcript.

The source audio itself is never altered. Whenever audio is played back or exported, the application walks the derived EDL in order and assembles the final result by concatenating the referenced source ranges. In this way, the EDL serves as a faithful, non-destructive representation of the edited audio while remaining entirely secondary to the transcript.

---

## 1. Concepts and Terminology

This document describes a transcript-based, non-destructive audio editing system in which the **transcript is the primary editable object** and audio edits are derived from transcript edits.

### Transcript
The **transcript** is the canonical representation of the edited content. It consists of an ordered list of words, where each word corresponds to a portion of the source audio. Editing operations such as deletion, reordering, or boundary refinement are applied directly to the transcript.

### Word
A **word** is the smallest editable unit in the transcript. Each word has a stable identifier, textual content, and an associated **word-owned audio span** in the source audio. Words do not overlap in time and collectively account for all audio in the source file, including pauses and gaps.

### Word-Owned Audio Span
A **word-owned audio span** is the contiguous range of time in the source audio that is assigned to a specific word. These spans collectively cover the entire source audio timeline. Users may refine these spans to improve alignment or pacing, but the source audio itself is never modified.

### Source Timeline
The **source timeline** refers to the original, unedited audio timeline of the source media file. All word-owned audio spans are defined in terms of source time.

### Edited Timeline
The **edited timeline** is the logical audio timeline that results from the current transcript ordering. It is formed by concatenating the word-owned audio spans of the transcript in their edited order.

### Edit Decision List (EDL)
An **Edit Decision List (EDL)** is a derived representation of the edited audio. It consists of an ordered list of audio segments, each referencing a range of time in the source audio. The EDL is regenerated from the transcript as needed and serves as the authoritative input for audio playback and export.

### Segment
A **segment** is an entry in the EDL that references a contiguous range of the source audio. Segments may correspond to one or more words whose audio spans are adjacent in source time and have been merged for efficient playback or export.

### Derived State
**Derived state** refers to data structures that are computed from the transcript rather than directly edited by the user. This includes the EDL, playback timelines, and various runtime caches. Derived state can always be discarded and rebuilt from the transcript.

### Command
A **command** represents a single, undoable editing operation applied to the transcript, such as deleting a range of words, moving words to a new position, or refining audio boundaries. Commands are used to implement undo and redo.

### Undo / Redo
**Undo** and **redo** allow the user to step backward and forward through previously applied commands. Undo and redo operate on transcript state. Any derived state affected by these operations is recomputed automatically.

### Non-Destructive Editing
**Non-destructive editing** means that the source audio file is never modified. All edits are represented as changes to the transcript and its associated metadata. Playback and export are performed by assembling audio from the source file according to the derived EDL.

---

## 2. High-Level Architecture Overview

This system implements a **transcript-first, non-destructive audio editing architecture**. The transcript is the primary editable artifact, and all audio behavior—playback, export, and timing—is derived from the transcript state.

### 2.1 Source Media Ingestion
- The user selects an audio file (e.g., WAV, MP3, M4A).
- The file is treated as immutable source media.
- Metadata (duration, sample rate, channels) is recorded.
- The project stores a robust media reference to support relinking.

### 2.2 Local Transcription and Word Alignment
- Transcription runs locally.
- Each word is assigned a **word-owned audio span**.
- Word spans collectively cover the full source timeline, including pauses.
- Users may refine spans when needed.

### 2.3 Transcript as Primary Editable State
All editing actions modify transcript state:
- Delete words → remove words from transcript ordering.
- Reorder words → splice/move words in transcript ordering.
- Refine boundaries → adjust word-owned spans.

### 2.4 Derived Edit Decision List (EDL)
- The EDL is regenerated from the transcript as needed.
- Adjacent spans may be merged into segments for efficiency.
- The EDL is not edited directly and is not the primary persisted artifact.

### 2.5 Playback Pipeline
- Playback traverses the derived EDL in order.
- Seeking and word-click navigation map between edited time and source time.
- Highlighting maps current playback position back to words.

### 2.6 Export Pipeline
- Export walks the derived EDL from start to finish.
- Audio is decoded from source ranges and concatenated into an output stream.
- Encoding produces the desired output format (e.g., WAV/MP3).

### 2.7 Undo, Redo, and Responsiveness
- User edits are represented as command objects.
- Undo/redo applies or reverses those commands on transcript state.
- Long-running jobs (transcription, waveform generation, export) run asynchronously and are cancellable.

---

## 3. Core Data Structures

Core structures fall into:
- **Authoritative state**: persisted and directly edited (the transcript and word spans).
- **Derived state**: computed from authoritative state (EDL, caches).

### 3.1 Project and Media References
A media reference includes:
- Path/URI
- Optional hash/size/mtime for validation
- Optional audio metadata

### 3.2 Transcript Document (Primary State)
The transcript consists of:
- A stable dictionary of word records
- An editable ordering of word IDs (the edited transcript)

### 3.3 Word-Owned Audio Spans
- Each word owns a contiguous span of source audio time.
- Users may refine spans; refinements are undoable.

### 3.4 Derived Edit Decision List (EDL)
- An ordered list of segments referencing source time ranges.
- Derived by walking transcript order and merging adjacent spans.

### 3.5 Edited Timeline
- The timeline formed by concatenating EDL segments in order.
- Used for playback position and seeking.

### 3.6 Derived Runtime Structures
Examples:
- Segment prefix sums for fast seek
- Word index maps
- Segment-to-word association for highlighting

### 3.7 Command Objects (Undo / Redo)
- Each user edit is an invertible command.
- Undo/redo operates on transcript state.
- Derived structures are recomputed after any edit/undo/redo.

### 3.8 Persistence Boundaries
Persisted:
- Media references
- Words and ordering
- Word spans and refinements

Rebuilt on load:
- EDL
- Playback caches
- Index structures
- Undo/redo stacks (MVP)

---

# Remaining Sections

## 4. Editing Operations on the Transcript

This section defines how user-visible edits modify primary transcript state and how those changes imply audio edits.

### 4.1 Deleting Words
**User intent:** Remove words from the transcript so their corresponding audio is removed.

**Primary-state change:**
- Remove the selected word IDs from `Transcript.order`.
- Word records remain in `wordsById` (optional) or may be garbage-collected later.

**Audio implication:**
- The word-owned spans for removed words are no longer present in the edited timeline.
- The derived EDL will omit those spans; playback/export skips them.

**Notes:**
- Deleting a contiguous word range does not require time arithmetic; the spans are already owned by words.
- If deletion is by selecting characters, the UI should snap to word boundaries in MVP.

### 4.2 Reordering Words (Cut / Paste / Move)
**User intent:** Rearrange words (or larger selections) to change the audio ordering.

**Primary-state change:**
- Splice the selected range of word IDs within `Transcript.order` to a new location.

**Audio implication:**
- The edited timeline becomes the concatenation of spans in the new transcript order.
- The derived EDL will reorder the corresponding spans (and merged segments) accordingly.

**Notes:**
- Reordering does not change spans or word IDs, only ordering.
- This model naturally supports “storytelling rearrangement” for spoken word.

### 4.3 Refining Word Audio Boundaries
**User intent:** Adjust which exact audio belongs to a word (often to improve pacing or fix alignment).

**Primary-state change:**
- Update the word’s `span.srcStart/srcEnd`.
- If the system enforces full coverage / no overlap, neighbor spans may be adjusted as well.

**Audio implication:**
- Playback/export uses updated spans immediately via regenerated EDL.
- Boundary refinements are fully non-destructive and reversible.

**Recommended constraints (documented, enforceable):**
- `srcStart < srcEnd`
- `0 <= srcStart/srcEnd <= mediaDuration`
- Optional strict mode: adjacent spans tile the timeline with no gaps/overlaps.
- Optional permissive mode: allow small overlaps/gaps during edits, then “Normalize” to fix.

### 4.4 Consistency and Validation
Implement validation at two levels:
- **Immediate validation** on every edit (reject invalid spans/order operations).
- **Normalization tools** to repair or optimize spans (merge tiny gaps, resolve overlaps, etc.).

---

## 5. Worked Examples

The examples below use source time in seconds and show how transcript edits imply audio edits.

### 5.1 Initial State (Unedited Transcript)
Source audio: 12.0 seconds

Words (each owns a span, including pauses):
| Word | Span (srcStart–srcEnd) |
|------|-------------------------|
| “Hello” | [0.00–1.20) |
| “world” | [1.20–2.40) |
| “this”  | [2.40–3.10) |
| “is”    | [3.10–3.50) |
| “OTTER” | [3.50–5.00) |
| “demo”  | [5.00–12.00) |

Transcript order (initial):  
`Hello, world, this, is, OTTER, demo`

Derived EDL (merged):  
`[0.00–12.00)` (single segment, because spans are adjacent and cover entire file)

### 5.2 Delete Example
User deletes: “world this”

Transcript order becomes:  
`Hello, is, OTTER, demo`

Audio implication: remove spans `[1.20–2.40)` and `[2.40–3.10)` from the edited timeline.

Derived EDL segments (one possible result):
- Segment A: `[0.00–1.20)` (Hello)
- Segment B: `[3.10–12.00)` (is, OTTER, demo)

Playback now jumps directly from 1.20s to 3.10s in source time, with no silence inserted.

### 5.3 Cut and Paste Example
User cuts “OTTER” and pastes it at the beginning.

Original order:  
`Hello, world, this, is, OTTER, demo`

New order:  
`OTTER, Hello, world, this, is, demo`

Audio implication: spans are concatenated in the new order.

Derived EDL segments (not merged due to reordering):
- `[3.50–5.00)` (OTTER)
- `[0.00–3.50)` (Hello world this is)
- `[5.00–12.00)` (demo)

### 5.4 Boundary Refinement Example
User feels a pause is too long at the start of “demo” and shortens it from `[5.00–12.00)` to `[5.20–12.00)`.

Now “demo” starts later. The edited output removes `[5.00–5.20)` from the final audio (because it is no longer owned by any word).

If strict coverage is enforced, the removed time must be re-assigned (typically to the previous word), or the system disallows the refinement unless the neighbor is adjusted simultaneously.

---

## 6. Audio Playback After Edits

Playback is implemented by traversing the derived EDL.

### 6.1 Playback Model
At any moment, playback maintains:
- Current EDL segment index `i`
- Current position within that segment
- A mapping between edited time and source time

The edited timeline is the concatenation of segment durations:
- `segDuration = (srcEnd - srcStart)`
- `editedDuration = sum(segDuration)`

### 6.2 Seeking
Seeking can be initiated by:
- Clicking a word in the transcript
- Dragging a playhead / scrubber (if present)
- Jump commands (next/prev word, etc.)

**Word-click seek**:
- Find the clicked word’s owned span start time in source time.
- Determine where that word appears in the edited ordering.
- Seek by locating the segment (or span) that contains that word in the derived playback structure.

Implementation tip:
- Maintain a derived index: `wordId -> (segmentIndex, offsetWithinSegment)` built when EDL is generated.

### 6.3 Segment Traversal
During playback:
1. Decode and play the current segment’s source range.
2. When reaching `srcEnd`, advance to the next segment.
3. Repeat until end of EDL.

This provides continuous playback with no “gaps” unless gaps exist in the owned spans.

### 6.4 Transcript Highlighting and Auto-Scroll
To highlight the active word:
- Track current edited time (or current source time + segment index).
- Use derived maps to find the active word quickly.
- Update UI highlight and auto-scroll to keep the active word visible.

Latency considerations:
- Prebuffer around seek targets.
- Cache decoded PCM chunks for nearby segments.
- Keep merges coarse enough to avoid excessive segment churn, but fine enough to support accurate mapping.

---

## 7. Audio Export

Export produces a new audio file reflecting the edited transcript.

### 7.1 Export Pipeline
Export is a streaming render:
1. Generate or refresh derived EDL from transcript.
2. Create output encoder (WAV/MP3/etc.).
3. For each segment in EDL:
   - Decode source audio range
   - Append decoded audio to encoder
4. Finalize output file.

### 7.2 Rendering Algorithm (Conceptual)
For each segment:
- Convert `srcStart/srcEnd` to sample offsets (based on sample rate).
- Decode that range from the source audio.
- Write to output stream.

The export engine must not load the entire output into memory; it should stream.

### 7.3 Export Guarantees
- **Non-destructive**: source file unchanged.
- **Deterministic**: same transcript state → same output.
- **Correct duration**: output duration equals sum of owned spans of the edited transcript (after merges).

### 7.4 Progress and Cancellation
Export must:
- Report progress (segments completed, bytes written).
- Be cancellable and leave partial output in a safe state (e.g., delete temp output on cancel).

---

## 8. Undo and Redo Architecture

Undo/redo operates on the transcript (primary state). The EDL and caches are derived and rebuilt after each operation.

### 8.1 Command-Based Editing
Each user action is represented as a command with:
- `apply(state)`
- `unapply(state)`

Commands store enough information to reverse themselves exactly without recomputing the edit.

### 8.2 Undo/Redo Stacks
- `undoStack`: commands that have been applied and can be undone.
- `redoStack`: commands that have been undone and can be redone.

Rules:
- Applying a new command clears `redoStack`.
- Undo pops from `undoStack` and calls `unapply`.
- Redo pops from `redoStack` and calls `apply`.

### 8.3 Command Types (Minimum Set)
- **DeleteWordsCommand**: removes a contiguous range of word IDs from transcript order.
- **InsertWordsCommand**: inserts word IDs at an index (paste).
- **MoveRangeCommand**: moves a range within transcript order.
- **UpdateWordSpanCommand**: updates one or more word spans (including neighbor adjustments).
- **CompositeCommand**: groups multiple commands into one undo step (transactions).

### 8.4 Undo/Redo and Derived State
After any apply/unapply:
- Mark derived EDL/caches dirty (or rebuild immediately).
- Restore cursor/selection if commands capture those snapshots.

### 8.5 Grouping (Transactions)
Some UI operations generate many micro-edits (e.g., dragging a boundary). Group these into one undo step so undo feels natural.

---

## 9. Responsiveness and Long-Running Operations

To remain responsive, long-running tasks must run off the UI thread.

### 9.1 Job Model
Long-running operations are modeled as jobs:
- Transcription
- Alignment / span generation
- Waveform generation
- Export

Each job exposes:
- Progress reporting
- Cancel
- Optional pause/resume

### 9.2 Cancellation Semantics
Cancellation must be cooperative:
- Jobs check a cancellation token at safe points.
- On cancel, jobs stop promptly and release resources.
- Partially produced derived artifacts are discarded unless explicitly committed.

### 9.3 Interaction with Document State
Jobs should not corrupt primary transcript state:
- Transcription results should be committed atomically (all-or-nothing) into the transcript.
- Export reads the transcript/EDL but does not modify them.
- If the user edits while a job runs, either snapshot the document at job start or cancel/restart the job (policy choice).

---

## 10. Persistence: Save and Load

Projects must support saving and resuming later with identical logical state.

### 10.1 What Is Saved
Persisted project data includes:
- Media reference (path + optional hash/size/mtime)
- Word records: text + word-owned spans
- Transcript ordering (edited order)
- Any user refinements (span edits, text edits)

Optionally persisted:
- Cursor/selection position
- UI preferences

### 10.2 What Is Rebuilt on Load
Derived data is not persisted in MVP:
- EDL segments
- Playback caches
- Index maps

On load:
1. Validate schema version
2. Resolve or relink media
3. Load transcript words and ordering
4. Rebuild derived EDL and caches

### 10.3 Schema Versioning
Include:
- `schemaVersion` in project file
- Migration support for older versions

### 10.4 Relinking Media
If the source file is missing or mismatched:
- Prompt user to locate the correct file.
- Verify via hash/size/duration (policy choice).
- Preserve transcript edits regardless of relinking outcome.

---

## 11. Design Tradeoffs and Rationale

### 11.1 Why Transcript Is Primary
Pros:
- Editing is intuitive and text-centric.
- Delete/reorder operations are simple list operations.
- Undo/redo is naturally defined on transcript edits.
- Audio output is deterministic and derived.

Cons:
- Requires robust mapping between transcript and playback timing.
- Boundary refinement rules must be carefully designed to avoid confusing outcomes.

### 11.2 Why Word-Owned Spans Matter
Assigning all audio (including pauses) to words:
- preserves pacing by default
- makes deletion/reorder unambiguous
- avoids midpoint heuristics and accidental removal of pauses

### 11.3 Why Keep a Derived EDL
Even though the transcript is primary, the EDL:
- provides an efficient representation for playback/export
- enables fast seeking and time mapping
- isolates audio assembly logic from editing logic

### 11.4 Alternative Models Considered
- EDL as primary (DAW-style): more complex to keep transcript view consistent.
- Region/paragraph primary: useful later, but not required for MVP.
- Sample-level destructive editing: rejected due to risk and complexity.

---

## 12. Future Extensions (Non-Goals for MVP)

- Higher-level structure (sentences/paragraphs) as first-class objects
- Crossfades at segment boundaries
- Gain automation, mute regions, effects
- Multi-track audio and music beds
- Speaker diarization and speaker-based edits
- Collaborative editing and merge conflict resolution
- Partial export (ranges), stems, and interchange formats

---

## Appendix: Suggested JSON Shapes (Informative)

### A.1 Project File (Conceptual)
```json
{
  "schemaVersion": 1,
  "projectId": "uuid-v4",
  "media": {
    "id": "uuid-v4",
    "path": "/path/to/audio.m4a",
    "contentHash": "sha256...",
    "durationSec": 1234.56
  },
  "transcript": {
    "words": [
      { "id": "uuid-v4", "text": "Hello", "span": { "srcStart": 0.0, "srcEnd": 1.2 } }
    ],
    "order": ["uuid-v4"]
  }
}
```

### A.2 Command Log (Optional, Not Required for MVP)
Projects typically do not persist undo stacks in MVP, but an optional edit log can be useful for debugging or analytics.
