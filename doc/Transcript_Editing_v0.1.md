# Transcript Editing

As the user edits the transcript, the application records those changes without ever modifying the original audio. The transcript is the primary editable object. All edits such as deleting words, reordering content, or refining word boundaries—are applied directly to the transcript and its associated word-level audio spans.

The user is effectively editing the audio by editing the transcript. As edits to the transcript occur, the application maintains an **Edit Decision List** (EDL) that describes how the final audio should be assembled.

Core Ideas:

+ The source audio is never modified.
+ Each word in the transcript owns a specific range of audio in the source file, including any gaps or pauses.
+ Editing the transcript (deleting or reordering words) implicitly edits the audio.
+ The EDL is a derived, ordered sequence of audio ranges generated from the current transcript state.

The EDL represents the current edited form of the audio as implied by the transcript. Conceptually, it is an ordered list of audio segments, where each segment is a reference to a time range in the original audio file.

When an audio file is first loaded and transcribed, the transcript contains all words in their original order, and the derived EDL consists of a single segment spanning the entire source file. As the user edits the transcript, the set and ordering of words changes. The EDL is then updated to reflect the owned audio ranges of the remaining words, merged and ordered according to the edited transcript.

The source audio itself is never touched. Whenever audio is played back or exported, the application walks the EDL in order and assembles the final result by concatenating the referenced source ranges. The EDL serves as a faithful, non-destructive representation of the edited audio while remaining entirely secondary to the transcript.


## 1. Concepts and Terminology

### Transcript

The transcript is the primary representation of the edited content. It consists of an ordered list of words, where each word corresponds to a portion of the source audio. Editing operations such as deletion, reordering, or boundary refinement are applied directly to the transcript.

### Word

A word is the smallest editable unit in the transcript. Each word has a stable identifier, textual content, and an associated word-owned audio span in the source audio. Words do not overlap in time and collectively account for all audio in the source file, including pauses and gaps.

### Word-Owned Audio Span

A word-owned audio span is the contiguous range of time in the source audio that is assigned to a specific word. These spans collectively cover the entire source audio timeline. Users may refine these spans to improve alignment or pacing, but the source audio itself is never modified.

### Source Timeline

The source timeline refers to the original, unedited audio timeline of the source media file. All word-owned audio spans are defined in terms of source time.

### Edited Timeline

The edited timeline is the logical audio timeline that results from the current transcript ordering. It is formed by concatenating the word-owned audio spans of the transcript in their edited order.

### Edit Decision List (EDL)

An Edit Decision List (EDL) is a derived representation of the edited audio. It consists of an ordered list of audio segments, each referencing a range of time in the source audio. The EDL is regenerated from the transcript as needed and serves as the authoritative input for audio playback and export.

### Segment

A segment is an entry in the EDL that references a contiguous range of the source audio. Segments may correspond to one or more words whose audio spans are adjacent in source time and have been merged for efficient playback or export.

### Derived State

Derived state refers to data structures that are computed from the transcript rather than directly edited by the user. This includes the EDL, playback timelines, and various runtime caches. Derived state can always be discarded and rebuilt from the transcript.

### Undo / Redo

Undo and redo allow the user to step backward and forward through previously applied commands. Undo and redo operate on transcript state. Any derived state affected by these operations is recomputed automatically.

### Command

A command represents a single, undoable editing operation applied to the transcript, such as deleting a range of words, moving words to a new position, or refining audio boundaries. Commands are used to implement undo and redo.

### Non-Destructive Editing

Non-destructive editing means that the source audio file is never modified. All edits are represented as changes to the transcript and its associated metadata. Playback and export are performed by assembling audio from the source file according to the derived EDL.

## 2. High-Level Architecture Overview

This system implements a transcript-first, non-destructive audio editing architecture. The transcript is the primary editable artifact, and all audio behavior—playback, export, and timing—is derived from the transcript state.

**Source Media Ingestion**

The system begins with a user-selected audio file. This file is treated as immutable source media. At no point is the source audio modified.

**Local Transcription and Word Alignment**

The audio is transcribed locally to produce a transcript composed of individual words. Each word is assigned a word-owned audio span on the source timeline.

Key properties of this stage:

+ All audio, including pauses and gaps, is assigned to words.
+ Word spans collectively cover the entire source timeline.
+ Users may later refine word spans if the automatic alignment is imperfect.

The result of this stage is the initial Transcript Document, which becomes the authoritative representation of editable content.

**Transcript as Primary Editable State**

All user editing operations act directly on the transcript:

+ Deleting words removes them from the transcript order.
+ Reordering text rearranges the order of words.
+ Refining boundaries adjusts word-owned audio spans.

The transcript defines:

+ Which audio is included
+ In what order it appears
+ How long each portion lasts

No audio is edited directly. Instead, edits modify transcript structure and metadata.

**Derived Edit Decision List (EDL)**

From the current transcript state, the system derives an Edit Decision List (EDL).

The EDL:

+ Is an ordered list of source-audio ranges
+ Reflects the edited transcript order
+ May merge adjacent word spans into larger segments for efficiency

The EDL is not edited directly. It is a derived artifact that can be discarded and regenerated whenever the transcript changes. As a result, it does not need to be saved and reloaded when a project is saved.

This separation ensures that:

+ Editing logic remains simple and text-centric
+ Audio logic remains deterministic and stateless
+ Playback and export always reflect the current transcript state

**Playback Pipeline**

During playback:

+ The EDL is traversed in order.
+ Each segment references a range of the source audio.
+ Segments are decoded and played sequentially, producing continuous audio with no gaps unless explicitly implied by the transcript.

User interactions such as clicking on words are resolved by mapping between:

+ Edited timeline position
+ Source timeline position
+ Word ownership boundaries

Playback behavior is therefore fully determined by the transcript via the derived EDL.

**Export Pipeline**

Audio export follows the same conceptual path as playback but renders to a file instead of an output device.

During export:

+ The EDL is walked from beginning to end.
+ Source audio ranges are decoded and concatenated.
+ The resulting audio stream is encoded into the chosen output format.

Because export uses the same derived representation as playback, the exported audio is guaranteed to match what the user hears in the editor.

**Undo and Redo**

Editing operations are encapsulated as commands applied to the transcript. Undo and redo operate by applying and reversing these commands.

**Summary**

+ The transcript is the single source of truth for edits.
+ The EDL is a derived representation used for audio assembly.
+ Playback and export are pure functions of transcript state.
+ The source audio remains unchanged at all times.

This architecture enables precise, non-destructive editing while keeping the system conceptually simple and robust.

## 3. Core Data Structures

This section lists the core data structures used by the system. These structures fall into two categories:

+ Authoritative state, which is directly edited by the user and persisted
+ Derived state, which is computed from authoritative state and can be rebuilt at any time

The transcript is the authoritative state. All audio-related representations, including the Edit Decision List (EDL), are derived from it.

### 3.1 Transcript Document (Primary State)

The Transcript Document is the primary, editable representation of the project. It is logically an ordered list of Words.

**Word**

A Word is the smallest editable unit in the system. Each word has:

+ A stable identifier
+ Textual content
+ A word-owned audio span on the source timeline

The word-owned audio span defines the exact portion of source audio associated with the word, including any pauses or gaps. Collectively, word spans account for all audio in the source file.

Word records are stored independently of ordering to ensure identity stability across edits.

**Transcript Ordering**

The transcript maintains an explicit ordering of words:

+ The ordering defines the edited transcript
+ Deleting words removes them from the ordering
+ Reordering text rearranges this ordering
+ Undo and redo operate by restoring prior orderings

This ordering is the primary edit mechanism in the system.

**Transcript Invariants**

The system enforces the following invariants:

+ Word IDs are stable and unique within a project.
+ Each word has a valid audio span (start < end) in source time.
+ Word spans collectively represent all audio in the source file.
+ The transcript ordering fully determines the edited timeline.

### 3.2 Word-Owned Audio Spans

Each word owns a contiguous span of the source audio timeline:

+ Spans are defined in source time.
+ Spans may be refined by the user to improve alignment or pacing.
+ Refining a span updates metadata only; the source audio is unchanged.

### 3.3 Derived Edit Decision List (EDL)

The Edit Decision List (EDL) is a derived representation used for playback and export.

**Segments**

An EDL consists of an ordered list of segments, where each segment references a contiguous range of source audio.

Segments are derived by:

+ Walking the transcript ordering
+ Extracting each word’s owned audio span
+ Merging adjacent spans when possible for efficiency

Segments are not edited directly and are not persisted as authoritative state.

EDL Properties:

+ The EDL reflects the current transcript state exactly.
+ It is deterministic and reproducible.
+ It can be discarded and regenerated at any time.
+ It defines the edited timeline used for playback and export.

### 3.4 Edited Timeline

The edited timeline is the *logical* audio timeline produced by concatenating the EDL segments in order.

The edited timeline:

+ Will differ, possibly substantially, from the source timeline
+ Is used for playback position, seeking, and duration calculations
+ Is derived entirely from the transcript ordering and word spans

Mappings between edited time and source time are computed from the EDL.

### 3.5 Derived Runtime Structures

To support efficient interaction, the system maintains additional derived structures at runtime. These are not persisted and are rebuilt whenever the transcript changes.

Typical derived structures include:

+ Flattened EDL segments with cumulative durations
+ Edited-time prefix sums for fast seeking
+ Word-to-edited-position index maps
+ Segment-to-word associations for highlighting

These structures may be used to improve performance but *do not affect correctness*.

### 3.6 Command Objects (Undo / Redo)

All user edits are represented as commands.

A command:

+ Encapsulates a single logical edit
+ Can be applied and unapplied
+ Stores sufficient information to reverse itself exactly

Commands operate on transcript state and related metadata. Derived state is recomputed automatically after commands are applied or undone.

Commands *may be* grouped so that complex user actions (such as drag reordering or boundary refinement) appear as a single undoable step.

### 3.7 Summary

+ The transcript is the authoritative editable document.
+ Words own audio spans that fully define audio inclusion.
+ The EDL is a derived structure used only for audio assembly.
+ Undo and redo operate on transcript state, not audio state.
+ All derived data can be regenerated from persisted state.

## 4. Editing Operations on the Transcript

This section defines how user-visible edits modify primary transcript state and how those changes imply audio edits.

### 4.1 Deleting Words
**User intent:** Remove words from the transcript so their corresponding audio is removed.

**Primary-state change:**

- Remove the selected word IDs from the ordered list of words in the Transcript.
- Word records may be restored via an undo.
- Deleting a contiguous word range does not require time arithmetic; the spans are already owned by words.

**Audio implication:**

- The word-owned spans for removed words are no longer present in the edited timeline.
- The derived EDL will omit those spans; playback/export skips them.

### 4.2 Reordering Words (Cut / Paste / Drag)
**User intent:** Rearrange words (or larger selections) to change the audio ordering.

**Primary-state change:**

- Splice the selected range of word IDs within the ordered list of words to a new location.

**Audio implication:**

- The edited timeline becomes the concatenation of spans in the new transcript order.
- The derived EDL will reorder the corresponding spans (and merged segments) accordingly.

**Notes:**

- Reordering does not change spans or word IDs, only ordering.
- This model naturally supports “storytelling rearrangement” for spoken word.

### 4.3 Refining Word Audio Boundaries
**User intent:** Adjust which exact audio belongs to a word (often to improve pacing or fix alignment).

**Primary-state change:**

- Update the word’s start and/or end positions.
- If the system enforces full coverage / no overlap, neighbor spans may be adjusted as well.

**Audio implication:**

- Playback/export uses updated spans immediately via regenerated EDL.
- Boundary refinements are fully non-destructive and reversible.


## 5. Worked Examples

The examples below show how transcript edits imply audio edits. In the example we are using seconds as the start and end time for words, but in the real implementation we'll use sample indexes. This will be more accurate, but using seconds makes the examples a little easier to follow.

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
`[Hello, world, this, is, OTTER, demo]`

Derived EDL:  
`[0.00–12.00)` (single segment, because spans are adjacent and cover entire file)

### 5.2 Delete Example
User deletes: “world this”

Transcript order becomes:  
`[Hello, is, OTTER, demo]`

**Audio implication**: remove spans `[1.20–2.40)` and `[2.40–3.10)` from the edited timeline.

**Derived EDL segments**:

- `[0.00–1.20)`  (Hello)
- `[3.10–12.00)` (is, OTTER, demo)

Playback now jumps directly from 1.20s to 3.10s in source time, with no silence inserted.

### 5.3 Cut and Paste Example
User cuts “OTTER” and pastes it at the beginning.

Original order:  
`[Hello, world, this, is, OTTER, demo]`

New order:  
`[OTTER, Hello, world, this, is, demo]`

**Audio implication**: spans are concatenated in the new order.

**Derived EDL segments** (can't be merged due to reordering):

- `[3.50–5.00)` (OTTER)
- `[0.00–3.50)` (Hello world this is)
- `[5.00–12.00)` (demo)

### 5.4 Boundary Refinement Example
User feels a pause is too long at the start of “demo” and shortens it from `[5.00–12.00)` to `[5.20–12.00)`.

Now “demo” starts later. The edited output removes `[5.00–5.20)` from the final audio (because it is no longer owned by any word).

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

- Decode the segment range from the source audio.
- Write to output stream.

The export engine should not load the entire output into memory; it should stream.

### 7.3 Export Guarantees

- **Non-destructive**: source file unchanged.
- **Deterministic**: same transcript state → same output.
- **Correct duration**: output duration equals sum of owned spans of the edited transcript (after merges).

### 7.4 Progress and Cancellation
Export should:

- Report progress (segments completed, bytes written).
- Be cancellable and leave partial output in a safe state (e.g., delete temp output on cancel).


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
- After any apply/unapply, mark derived EDL/caches dirty (or rebuild immediately).

### 8.3 Command Types (Minimum Set)

- **DeleteWordsCommand**: removes a contiguous range of word IDs from transcript order.
- **InsertWordsCommand**: inserts word IDs at an index (paste).
- **MoveRangeCommand**: moves a range within transcript order.
- **UpdateWordSpanCommand**: updates one or more word spans (including neighbor adjustments).
- **CompositeCommand** (optional): groups multiple commands into one undo step; e.g. a drag and drop operation would combine cut and paste.

## 10. Persistence: Save and Load

Projects must support saving and resuming later with identical logical state.

### 10.1 What Is Saved
Persisted project data includes:

- Media reference (path + optional hash/size/mtime)
- Word records: text + word-owned spans
- Transcript ordering (edited order)
- Any user refinements (span edits, text edits)
- Auxiliary data structures provided by the transcription process (e.g. sound gap locations).

Optionally persisted:

- Cursor/selection position
- UI preferences

### 10.2 What Is Rebuilt on Load
Derived data is not persisted:

- EDL segments
- Playback caches
- Index maps

On load:

1. Validate schema version
2. Resolve or relink media
3. Load transcript words and ordering
4. Rebuild derived EDL and caches

### 10.3 Schema Versioning (not required for MVP)
Include:

- `schemaVersion` in project file
- Migration support for older versions

### 10.4 Relinking Media (not required for MVP)
If the source file is missing or mismatched:
- Prompt user to locate the correct file.
- Verify via hash/size/duration (policy choice).
- Preserve transcript edits regardless of relinking outcome.

---

## 11. Design Tradeoffs and Rationale

### 11.1 Why Transcript Is Primary

- Editing is intuitive and text-centric.
- Delete/reorder operations are simple list operations.
- Undo/redo is naturally defined on transcript edits.
- Audio output is deterministic and derived.


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


## Appendix: Possible Data srtuctures

# Transcript-Primary Data Structures (Sample Index Model)

This document defines the **authoritative (persisted)** data structures for a transcript-primary audio editor, using **sample indexes** (not seconds) for all audio timing, plus the **runtime undo/redo** structures that operate on the authoritative state.

## Design Principles

- **Transcript is primary**: edits are applied to transcript state (word ordering and word-owned spans).
- **Non-destructive**: the source audio file is never modified.
- **Sample-accurate**: all spans are expressed in absolute **sample indexes** on the **source** timeline.
- **Derived artifacts are rebuildable**: EDL, caches, and mappings can be regenerated from the transcript.

---

## 1. Audio Time Primitives

All audio time is represented using integer sample indexes on the **source** audio timeline.

```ts
/** UUID v4 string. */
export type UUID = string;

/** Absolute sample index on the SOURCE audio timeline. Sample 0 is the first sample. */
export type SampleIndex = number;

/** A count of samples (duration). */
export type SampleCount = number;
```

> **Why samples?** Sample indexes avoid floating-point rounding and provide deterministic playback/export. Conversion to seconds/timecode is for display only using `sampleRateHz`.

---

## 2. Identifiers

Stable identifiers are UUID v4 strings.

```ts
export type ProjectId = UUID;
export type MediaId = UUID;
export type WordId = UUID;
export type CommandId = UUID;

export type SchemaVersion = number;
```

---

## 3. Media Reference (Authoritative)

A `MediaRef` identifies the immutable source audio and stores enough metadata to validate and relink the file.

```ts
export type MediaRef = {
  id: MediaId;

  /**
   * Last-known location of the source media.
   * May be missing/invalid on load; relinking updates this value.
   */
  path: string;

  /**
   * Optional fingerprinting used for relinking/validation.
   * Policy: you may store one or more fields depending on your needs.
   */
  contentHash?: string;      // e.g., sha256
  sizeBytes?: number;
  modifiedTimeMs?: number;

  /**
   * Audio properties captured at import time.
   * sampleRateHz is required to convert samples to seconds for display.
   */
  sampleRateHz: number;

  /** Optional: channel count (if known). */
  channels?: number;

  /** Total length of the source audio in samples. */
  totalSamples: SampleCount;
};
```

### Media Invariants (Recommended)
- `sampleRateHz > 0`
- `totalSamples > 0`
- If provided: `channels >= 1`
- If validating hashes: `contentHash` matches when loading (or trigger relink flow)

---

## 4. Word-Owned Audio Spans (Authoritative)

A word owns a contiguous span of source samples.

```ts
export type SampleSpan = {
  /** Inclusive start sample index on source timeline. */
  startSample: SampleIndex;

  /** Exclusive end sample index on source timeline. */
  endSample: SampleIndex;
};
```

### Span Invariants (Recommended)
- `0 <= startSample < endSample <= media.totalSamples`
- Optional strict mode: spans tile the full source timeline with no gaps/overlaps

---

## 5. Transcript Model (Primary Authoritative State)

### 5.1 Word Record (Authoritative)

A `Word` is the smallest editable unit in MVP. Each word has stable identity and a word-owned audio span.

```ts
export type Word = {
  id: WordId;

  /** The word text as shown in the transcript editor. */
  text: string;

  /**
   * Word-owned span on the SOURCE timeline, in samples.
   * Per model: spans collectively account for all audio (including pauses),
   * and users may refine spans when needed.
   */
  span: SampleSpan;

  /** Optional metadata (not required for MVP correctness). */
  confidence?: number;   // e.g., ASR confidence (0..1)
  speakerId?: string;    // if diarization exists
};
```

### 5.2 Transcript Document (Authoritative)

The transcript document is the canonical editable object.

```ts
export type TranscriptDoc = {
  /**
   * Canonical word records keyed by stable ID.
   *
   * Policy choice:
   * - Keep removed words here (tombstone by absence from `order`) so undo/cut-paste
   *   is trivial and stable.
   * - Or garbage-collect later (never during active undo history).
   */
  wordsById: Record<WordId, Word>;

  /**
   * Edited transcript ordering (the edit).
   *
   * - Delete: remove IDs from this list
   * - Reorder: splice/move ranges within this list
   */
  order: WordId[];

  /** Optional timestamps for auditing/UI. */
  createdAtMs: number;
  updatedAtMs: number;
};
```

### Transcript Invariants (Recommended)
- `order` contains only IDs that exist in `wordsById`.
- Each ID appears at most once in `order` (for MVP).  
  *(If you later allow duplication, you’ll need occurrence IDs or a different model.)*

---

## 6. Project File (Persisted Boundary)

The project file contains authoritative state only. Derived artifacts (EDL/caches) are rebuilt on load.

```ts
export type Project = {
  schemaVersion: SchemaVersion;
  projectId: ProjectId;

  /** Immutable source media reference. */
  media: MediaRef;

  /** Primary editable document. */
  transcript: TranscriptDoc;

  /**
   * Optional persisted UI state (keep minimal by design).
   * Everything else should be derived at runtime.
   */
  uiState?: {
    activeWordId?: WordId;
    selection?: {
      anchorWordId: WordId;
      focusWordId: WordId;
    };
  };
};
```

---

## 7. Undo / Redo (Runtime Structures)

Undo/redo operates on **authoritative transcript state** via invertible commands. Undo stacks are typically **not persisted** in MVP.

### 7.1 Cursor and Selection Snapshots

If you want undo to restore cursor/selection, store snapshots on each command.

```ts
export type CursorState = {
  activeWordId?: WordId;
  anchorWordId?: WordId;
  focusWordId?: WordId;

  /**
   * Optional: edited timeline cursor position expressed in samples.
   * This is *not* source time; it represents a position in the edited playback timeline.
   * It may be recomputed from word ordering + spans, but storing it can make undo feel nicer.
   */
  focusEditedSample?: SampleIndex;
};
```

### 7.2 Command Interface

Commands are the atomic, invertible units of edit history.

```ts
export interface Command {
  id: CommandId;
  type: string;
  timestampMs: number;
  label?: string;

  /**
   * Apply edit to the project's authoritative state.
   * Derived artifacts (EDL/caches) are rebuilt or marked dirty afterwards.
   */
  apply(project: Project): void;

  /**
   * Reverse edit exactly.
   * Never re-run inference logic during undo; restore prior objects/values.
   */
  unapply(project: Project): void;
}
```

### 7.3 Composite Commands (Transactions)

Used to group multiple low-level edits into one undo step (e.g., drag boundary, multi-step gesture).

```ts
export type CompositeCommand = Command & {
  type: "composite";
  label: string;
  commands: Command[];
};
```

**Semantics**
- `apply`: apply sub-commands in order
- `unapply`: unapply sub-commands in reverse order

### 7.4 Core Command Types

#### 7.4.1 Delete Words

Deletes a contiguous range of words from the transcript ordering.

```ts
export type DeleteWordsCommand = Command & {
  type: "deleteWords";

  /** Index in transcript.order where deletion begins. */
  startIndex: number;

  /** The exact word IDs removed, captured in order. */
  removedWordIds: WordId[];

  beforeCursor?: CursorState;
  afterCursor?: CursorState;
};
```

**Apply**
- `transcript.order.splice(startIndex, removedWordIds.length)`

**Unapply**
- `transcript.order.splice(startIndex, 0, ...removedWordIds)`

> `wordsById` typically remains unchanged (tombstone policy).

---

#### 7.4.2 Insert Words (Paste)

Inserts words into transcript ordering. Supports cross-project paste by optionally including word records to add.

```ts
export type InsertWordsCommand = Command & {
  type: "insertWords";

  /** Insertion index into transcript.order. */
  index: number;

  /** IDs inserted in order. */
  insertedWordIds: WordId[];

  /**
   * Optional payload of word records to add to wordsById if they don't exist.
   * Needed for cross-project paste or duplication.
   */
  insertedWordsById?: Record<WordId, Word>;

  beforeCursor?: CursorState;
  afterCursor?: CursorState;
};
```

**Apply**
- Add any missing words from `insertedWordsById` into `wordsById`
- `transcript.order.splice(index, 0, ...insertedWordIds)`

**Unapply**
- Remove `insertedWordIds` from `transcript.order` at `index`
- Optional: if words were introduced by this command and are not referenced elsewhere, remove them from `wordsById`  
  *(Requires bookkeeping; MVP can skip cleanup.)*

---

#### 7.4.3 Move Range (Reorder / Cut-Paste)

Moves a contiguous range of word IDs within transcript ordering.

```ts
export type MoveRangeCommand = Command & {
  type: "moveRange";

  /** Start index of moved range in transcript.order. */
  fromIndex: number;

  /** Number of words moved. */
  count: number;

  /**
   * Insertion index after removal (important for correctness).
   * Example: remove at fromIndex, then insert at toIndex in the shortened array.
   */
  toIndex: number;

  /** Captured moved IDs, in order, to make undo exact. */
  movedWordIds: WordId[];

  beforeCursor?: CursorState;
  afterCursor?: CursorState;
};
```

**Apply**
- `moved = transcript.order.splice(fromIndex, count)` (should equal `movedWordIds`)
- `transcript.order.splice(toIndex, 0, ...moved)`

**Unapply**
- Remove the moved range from its current position
- Reinsert at the original `fromIndex`

> This command represents “cut + paste” as a single undoable step.

---

#### 7.4.4 Update Word Span (Boundary Refinement)

Updates the word-owned span for one word. If strict tiling invariants are enforced, include neighbor adjustments explicitly.

```ts
export type UpdateWordSpanCommand = Command & {
  type: "updateWordSpan";

  wordId: WordId;

  beforeSpan: SampleSpan;
  afterSpan: SampleSpan;

  /**
   * If enforcing full coverage/no overlap, boundary changes may require
   * adjusting neighboring spans. Capture those changes explicitly for undo.
   */
  neighborAdjustments?: Array<{
    wordId: WordId;
    beforeSpan: SampleSpan;
    afterSpan: SampleSpan;
  }>;
};
```

**Apply**
- Set `wordsById[wordId].span = afterSpan`
- Apply each neighbor adjustment (if any)

**Unapply**
- Restore `beforeSpan`
- Restore neighbors' `beforeSpan`

---

#### 7.4.5 Update Word Text (Optional)

Corrects transcript text while keeping spans unchanged.

```ts
export type UpdateWordTextCommand = Command & {
  type: "updateWordText";

  wordId: WordId;
  beforeText: string;
  afterText: string;
};
```

---

### 7.5 Undo Manager (Runtime)

Tracks history stacks and optional in-progress transaction.

```ts
export type UndoManager = {
  undoStack: Command[];
  redoStack: Command[];

  /**
   * Optional: in-progress transaction used to group micro-edits
   * into a single undo step.
   */
  openTransaction?: {
    id: UUID;
    label: string;
    commands: Command[];
    beforeCursor?: CursorState;
    afterCursor?: CursorState;
  };
};
```

**Rules**
- Applying a new command pushes it to `undoStack` and clears `redoStack`.
- Undo pops from `undoStack`, runs `unapply`, and pushes to `redoStack`.
- Redo pops from `redoStack`, runs `apply`, and pushes to `undoStack`.
- After any apply/unapply, derived structures (EDL/caches) must be rebuilt or marked dirty.

---

## 8. Notes on Derived Structures (Not Primary)

The following are derived from the authoritative state and are typically rebuilt on demand:
- EDL segments (`srcStart/srcEnd` in samples)
- Edited timeline prefix sums
- Word → (segment index, offset) maps for seeking/highlighting
- Waveform summaries aligned to transcript

These are intentionally omitted from the “primary” list to keep persistence and correctness simple.
