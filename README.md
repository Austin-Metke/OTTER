# OTTER Read-Only Proof of Concept
***Open Text Transcription Editing Resource***

<image src="assets/icon.png" width="35%"> <image src="assets/Screenshot1.png" width="50%" align="right">
## Overview

This repository contains a Proof of Concept (PoC) for OTTER, the **O**pen **T**ext **T**ranscription **E**diting **R**esource. It is for use with CSUMB Computer Science Capstone Program.

OTTER uses an automatic speech recognition (ASR) model to allow users to edit audio files by editing text rather than solely via waveform editors.

The PoC demonstrates how text transcription, audio playback, and timeline synchronization can work together with no cloud services or closed-source dependencies. It is implemented as a local desktop app using Electron, with a JavaScript-based UI and a locally invoked transcription backend. Audio and text never leave the user's computer so it remains private.

It exists to:

+ Ground discussions in a working system
+ Demonstrate feasibility
+ Demonstrate concrete mechanisms that can be used
+ Highlight real technical tradeoffs

It is:

+ **Not** able to make any edits whatsoever - not even adjusting the word-to-audio mapping
+ **Not** thoroughly tested or documented
+ **Not** production-ready code!

## Scope

### What This Prototype Demonstrates

The purpose of this application is to demonstrate:

+ Transcription
	+ Transcription runs locally; no cloud services are required.
	+ Transcription  generates word-level timestamps
	+ Transcription uses a Whisper-family model to produce word timings.
	+ Transcription progress is streamed from whisper wrapper back to front end.
+ UI Concepts
	+ Transcript-driven navigation
	+ Clicking a word in the transcript seeks the audio to that word.
	+ Playback highlights the current word in the transcript.
	+ Audio is displayed using a waveform view synchronized with playback.
	+ Waveform visualization to fine-tune selections
+ Architecture
	+ Electron architecture
	+ Separation of concerns between:
		+ Main process (file access, process spawning)
		+ Renderer (UI)
		+ Preload (secure IPC boundary)
	+ Local Whisper-based ASR
	+ Flexible pipeline for transcription process

### What This Prototype Intentionally Does Not Do

To keep the focus clear, this prototype does not attempt to:

+ Perform transcript-based editing (cut, paste, rearrange)
+ Persist projects or edits
+ Handle multiple speakers (diarization)
+ Support all audio formats
+ Package into a self-contained application
+ Provide a polished end-user experience

These are deliberate omissions and are appropriate topics for the full capstone project.

### Supported Audio Format

For simplicity and accurate word-level seeking, this prototype only supports PCM WAV audio.

Why:

+ WAV provides sample-accurate seeking
+ Avoids codec delays and frame-based imprecision
+ Keeps synchronization logic simple and predictable

Students are encouraged to explore broader format support (e.g., MP3, AAC, normalization pipelines) as part of the capstone.

## Installing, Launching, and Using the PoC

### Requirements

+ Node.js (v18+ recommended)
+ Python 3.10+
+ [Electron](https://www.electronjs.org)
+ [faster-whisper](https://pypi.org/project/faster-whisper/) for text transcription
+ [FFmpeg](https://ffmpeg.org):
	+ Used for audio inspection and (optionally) format normalization
	+ Also used indirectly by waveform rendering and audio decoding
	+ Must be available on the system PATH


### Installation & Running

1. Clone the repository

	```
	git clone https://github.com/jpasqua/otter-poc.git
	cd otter-poc
	```

1. Install Node dependencies

	```
	npm install
	```

2. Set up Python environment

	```
	python3 -m venv .venv
	source .venv/bin/activate
	pip install faster-whisper
	```

3. Run the app

	```
	npm start
	```

**NOTE**: This PoC is not a cleanly packaged app, you must run it in a context where your python virtul environment is already active. Using the steps above in a shell/terminal will have that effect.

### Using the PoC

1.	Click Choose Audio… and select a WAV file.
1.	Click Transcribe to generate a transcript.
1. Press Play in the main waveform area to hear audio starting at the cursor.
1.	Clicking a word in the transcript will:
  + Move the cursor in the main audio waveform
  + Display a detail view of the audio around that word
1. Use the detail view to fine-tune the mapping to the selected word
2. Developer Tools
    + Use the Developer Tools to look at the log from the transcription pipeline
	+ Select a pre-configured transcription pipeline or enter a custom specification.
	+ If no explicit selection is made, a default pipeline will be used.
	+ All pipelines are stored in `otter_py/sample_specs`. Any `json` file placed in that folder will be presented as a pipeline specification in the app

## Architectural Notes

### Transcription Pipeline

The transcription pipleline consists of a primary transcription phase followed by zero or more post-processing steps which may improve accuracy of the transcript and / or alignment of the transcript to the audio. The pipleline can be configured by the Electron app, but runs in a separate python process. The app communicates with it using [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc).

The app exposes a panel where developers can choose pre-existing pipeline configurations or enter a new one on the fly. This makes experimentation simpler and also allows developers to work in parallel on new pipeline components. The provided components are:

+ Transcription
	+ **faster_whisper**: An implementation using the `faster-whisper` package. quite a few parameters may be set using the pipeline configuration with no code changes needed. For example, the model size may be changed.
	+ **whisperx_vad**: An implementation using the `whisperx` package along with the `Silero` aligner. Again, many options may be specified including model size.
+ Post-processing
	+ **clean_word_timings**:  Normalizes adjacent word boundaries to remove small overlaps and close tiny gaps.This improves selection/playback behavior by ensuring word boundaries are "tight" and consistent.
	+ **adjust_short_words**: Heuristic pass that expands very short words by extending their start time leftward, without overlapping the previous word.

Alternative transcription modules and post-processors may be designed, implemented, and added as options for the transcription pipeline.  For example, other post processors may analyze the audio waveform to look for clean separations between words to help align the transcript.

Even with good transcription and post-processing, transcript timing is treated as approximate, not sample-perfect. Minor timing nudges may be required for perceptually clean playback. This reflects real-world constraints of speech recognition systems and learning the limits of this technology is part of the Capstone process.

For more details on how the Electron PoC is organized, please see [Understanding Electron](doc/UnderstandingElectron.md) notes.


## License

This project is licensed under the [MIT License](LICENSE).

You are free to use, modify, and distribute this project under the terms of the MIT license. See the [LICENSE](LICENSE) file for more details.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

