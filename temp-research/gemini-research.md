
# **Technical Analysis and Architectural Blueprint for Multi-User Audio Recording on Discord**

## **Executive Summary**

This report presents a comprehensive technical analysis of solutions for programmatically recording high-fidelity, multi-user audio from Discord voice channels, with a specific focus on enabling speaker diarization for a transcription and summarization service.

The primary finding is that the programmatic recording of separate, distinct audio streams for each user in a Discord voice channel is technically feasible through the Discord API. This capability, while not officially documented for audio reception, is a stable and long-standing feature leveraged by several production-grade services. The underlying mechanism relies on the Real-time Transport Protocol (RTP) and unique Synchronization Source (SSRC) identifiers that allow a bot client to demultiplex the channel's audio and attribute individual packets to specific users.

The core recommendation is the development of a bot application using the **Python** programming language and the **Pycord** library. This stack is advised due to Pycord's high-level "Sink" abstraction, which significantly simplifies the complex process of capturing, separating, and encoding multi-track audio, thereby accelerating development and reducing implementation risk. The proposed system architecture is a distributed, batch-processing model inspired by established services like the Craig bot. This design decouples the lightweight task of raw audio capture from the resource-intensive tasks of transcoding and transcription, ensuring scalability, resilience, and cost-efficiency.

A critical and non-negotiable prerequisite for the operation of such a service is the implementation of a robust, transparent, and explicit user consent mechanism. This is mandated by Discord's Developer Policy, its Terms of Service, and a complex landscape of international data privacy laws. The consent framework must be a core technical feature of the application, not merely a superficial addition.

This document provides the definitive analysis of the Discord Voice API's capabilities, a comparative evaluation of leading Node.js and Python libraries, detailed architectural blueprints for a complete transcription pipeline, and a thorough examination of the associated legal and compliance obligations necessary to inform a sound architectural decision.

## **I. Core Feasibility Analysis: Multi-Track Audio Reception from the Discord Voice API**

The foundational requirement for the proposed service is the ability to capture distinct audio streams for each participant in a voice channel. This section deconstructs the Discord Voice API to provide a definitive confirmation of this capability.

### **1.1. Deconstruction of the Discord Voice Connection Protocol**

A Discord voice connection is not a single monolithic stream but a dual-channel system comprising a WebSocket connection for control and a separate UDP connection for media transmission.1 Understanding this bifurcation is essential to comprehending how a recording bot operates.

The connection process follows a precise handshake protocol. A bot client first signals its intent to join a voice channel by sending a Voice State Update payload over the main Discord Gateway WebSocket.1 Discord's gateway responds with two crucial pieces of information: a

session\_id for the voice session and the connection details for a dedicated voice server.

The bot then establishes a new, separate WebSocket connection to this voice server. It authenticates using an Identify payload containing its user ID, server ID, the session ID, and a token. Upon successful identification, the voice server replies with an OP2 Ready payload. This payload is critical, as it contains the bot's unique **Synchronization Source (SSRC)** identifier, the UDP port for voice data, and the supported encryption modes.1

The SSRC is the technical cornerstone that enables multi-track recording. All voice data is transmitted over the UDP connection as Opus audio packets encapsulated within the Real-time Transport Protocol (RTP). Each RTP packet header includes the SSRC of the user who sent it.1 This allows a receiving client, such as our recording bot, to listen to the single stream of mixed packets from all users in the channel and accurately attribute each individual audio packet to its specific origin user.

### **1.2. The Definitive Answer: Affirming the Capability to Receive Per-User Audio Streams**

The Discord API unequivocally supports the reception of separate audio streams on a per-user basis. This conclusion is supported by direct evidence from library APIs and the empirical proof of long-standing production services.

The most conclusive evidence is found within the application programming interfaces (APIs) of mature Discord libraries. The @discordjs/voice package, the official voice module for the popular Node.js library discord.js, exposes a VoiceReceiver class. This class contains a method, subscribe(target: string), where the target parameter is a user's unique Discord ID.2 The documentation explicitly states this method "Creates a subscription for the given user id" and returns a readable stream of that user's Opus audio packets. The existence of this targeted subscription method is definitive proof that the underlying Discord API can route per-user audio streams to a bot client. The architectural pattern is not to receive a single, pre-mixed stream, but rather to create multiple, parallel subscriptions—one for each user in the channel that the service intends to record.3

This technical capability is validated by the existence and widespread adoption of the Craig bot, a service whose primary feature since its launch in 2017 has been multi-track voice channel recording.4 Craig produces separate, synchronized audio files for each speaker, a function that would be impossible without the API-level ability to receive distinct user streams.7 The bot's longevity and use in professional contexts like podcasting serve as undeniable real-world validation that this functionality is stable and robust enough for a commercial service.

It is crucial, however, to acknowledge a key risk factor: this audio reception functionality is officially undocumented by Discord. The documentation for @discordjs/voice explicitly warns, "Audio receive is not documented by Discord so stable support is not guaranteed".9 This sentiment is echoed in

discord.py community discussions.10 While the term "undocumented" implies a degree of risk, a deeper analysis suggests this risk is manageable. The feature has been available for many years, and a significant ecosystem of popular community tools and even commercial services with paid tiers has been built upon it.4 Discord is aware of these bots; the maintainers of the open-source Craig bot have even been featured on technology podcasts to discuss their work.12 The "undocumented" status is likely a strategic decision by Discord to avoid the support and maintenance burden of an officially sanctioned feature and to mitigate liability for any changes, rather than an indication of imminent deprecation. The risk of Discord removing this functionality without significant warning is low, as it would break a substantial and valued part of the developer ecosystem. Therefore, this risk should be monitored but should not be considered a blocker to development.

### **1.3. Analysis of Voice Metadata: The "Speaking" Event and User Identification**

In addition to the audio data itself, the Discord Voice API provides critical real-time metadata about user activity. The most important piece of metadata for this project is the Speaking event, identified by Opcode 5 in the low-level voice protocol, which is explicitly "used to indicate which users are speaking".1

High-level libraries provide convenient abstractions for this event. In discord.js, for instance, a connection's VoiceReceiver object emits start and end events on its speaking property, providing the userId of the person who has just started or stopped transmitting audio.13 This provides a clear, actionable, and low-latency signal of a user's speaking status.

To link this speaking event to the raw audio packets, the libraries maintain a mapping between a user's SSRC and their Discord user ID. The discord.js VoiceReceiver class includes an ssrcMap property for this exact purpose.2 This map is populated as users join the channel and begin transmitting, creating the crucial link between a raw RTP packet's SSRC and the human user who sent it.

This speaking event is more than just metadata; it is a powerful catalyst for both system efficiency and the downstream diarization process. A naive recording implementation might subscribe to a user's audio stream and continuously write every received packet to a file. However, for any individual participant, the majority of a conversation consists of silence. This naive approach would result in unnecessarily large audio files, creating significant overhead in disk I/O, storage costs, and subsequent processing time.

The speaking event enables a far more efficient architecture. The recording logic can be designed to only open a file write stream for a given user upon receiving a speaking.start event associated with their userId. The stream can then be closed or paused upon receiving the corresponding speaking.end event. This transforms the recording process from a continuous, brute-force capture into an intelligent, event-driven one that only records when audio is actually being transmitted.

For the final goal of speaker diarization, this is a transformative advantage. The timestamps of these API-level start and end events provide a preliminary, coarse-grained speaker timeline. This data effectively bootstraps the diarization process by answering the question, "Who was generally active during this period?" before any complex audio analysis is performed. While a more sophisticated Voice Activity Detection (VAD) algorithm will still be necessary to achieve precise word-level timing from the recorded audio, this initial filtering from the API significantly reduces the search space and computational cost of the subsequent diarization algorithm.

## **II. Comparative Analysis of Programmatic Recording Solutions**

With the core feasibility established, the next step is to select the optimal technology stack. This section evaluates the primary libraries and architectural patterns available for implementing the recording functionality in the Node.js and Python ecosystems.

### **2.1. The Node.js Ecosystem: A Deep Dive into @discordjs/voice**

The official solution for voice interactions within the discord.js ecosystem is the @discordjs/voice package.9 It provides a powerful but low-level, stream-based API that gives developers granular control over the entire audio pipeline.

The implementation paradigm requires the developer to manage the full lifecycle of the audio stream. The key primitives include joinVoiceChannel() to establish the connection, the connection.receiver object for handling all incoming audio, and receiver.subscribe(userId) to create a Node.js ReadableStream of raw Opus packets for a specific user.2 The crucial speaking status metadata is available via the

receiver.speaking event emitter.13

A typical workflow involves subscribing to a user's stream, creating a WriteStream to a file (e.g., recording.opus), and piping the readable stream into the writeable one. If uncompressed audio is desired, an additional step is required to pipe the stream through a decoding library, such as prism-media, before writing to a file.16

The primary advantage of this approach is the maximum degree of control it affords the developer over the audio pipeline. However, this control comes at the cost of significantly higher implementation complexity. The developer is responsible for correctly handling stream events, managing decoders, and dealing with potential errors, such as corrupted Opus files, which can be a non-trivial challenge.17

### **2.2. The Python Ecosystem: Evaluating Pycord and Extensions**

The Python ecosystem, particularly through the Pycord library, offers a much higher-level, "batteries-included" approach to voice recording. Pycord, a maintained and modernized fork of the original discord.py library, has built-in support for multi-track recording through an elegant "Sink" abstraction.18

This paradigm abstracts away the complexities of stream management. The developer simply invokes the vc.start\_recording(sink, finished\_callback) method, where vc is the voice client instance.20 The

sink argument is an object from a variety of pre-built classes provided by the library, such as discord.sinks.WaveSink or discord.sinks.PCMSink, which handle the final encoding of the audio.21 Internally, the voice client manages subscribing to all users and routing their audio to the appropriate sink.

The workflow is remarkably simple. After the recording is stopped (via vc.stop\_recording()), the finished\_callback function is executed. This function receives the sink object as an argument. The sink.audio\_data attribute is a dictionary that conveniently maps each user\_id to its corresponding recorded audio data, ready to be saved to a file.20

The primary advantage of Pycord's approach is the dramatic reduction in code complexity and development time. It provides a robust, out-of-the-box solution that is less prone to the low-level implementation errors that can occur with stream-based APIs. While it offers less granular control over the raw Opus stream compared to @discordjs/voice, this is not a significant disadvantage for the stated goal of recording high-fidelity audio for transcription.

### **2.3. Deconstruction of a Production System: The Craig Bot Architecture**

To design a scalable and resilient service, it is instructive to analyze the architecture of existing production systems. The official Craig bot is open-source, revealing a sophisticated polyglot architecture written primarily in TypeScript, C++, and C, indicative of a highly optimized system designed for performance and scale.22

A crucial architectural pattern, articulated clearly by a similar open-source project named Pandora, is the separation of the system into a **"recording" component** and a **"cooking" (processing) component**.23 This is a foundational design pattern for building a scalable service.

* **The Recorder:** This is a lightweight, and ideally stateless, bot application. Its sole responsibility is to join a voice channel, manage user interactions (like consent), subscribe to user audio streams, and dump the raw, unprocessed audio data to a durable, intermediate storage location (like a cloud object store).  
* **The Cooker:** This is an asynchronous, out-of-process worker service. It is triggered after a recording session concludes. Its job is to retrieve the raw data and perform all the computationally expensive tasks: transcoding the audio to a standard format, ensuring synchronization, packaging the final files, and, in this project's case, interfacing with the transcription API.

This decoupled architecture allows for independent, horizontal scaling. A large fleet of lightweight recorder bots can handle a massive number of concurrent voice channels, while a separate, auto-scaling fleet of more powerful cooker workers can be provisioned based on the length of the processing queue. The Pandora project also highlights the necessity of an external state store, such as Redis, to track the status of active recordings, ensuring resilience against individual bot instance crashes.23

### **Table 1: Feature and Implementation Comparison of Node.js and Python Voice Libraries**

| Feature | @discordjs/voice (Node.js) | Pycord (Python) | Analysis & Recommendation |
| :---- | :---- | :---- | :---- |
| **Multi-Track Recording** | Yes, via explicit per-user subscribe() calls. | Yes, handled automatically by the Sink abstraction. | Both libraries fully support the core requirement. |
| **API Abstraction Level** | Low-level, stream-based. | High-level, object-oriented "Sink" model. | Pycord's high-level API abstracts away significant complexity. |
| **Implementation Complexity** | High. Developer manages streams, decoding, and file I/O. | Low. The library handles stream separation and encoding internally. | Pycord enables a much faster development cycle with less boilerplate code. |
| **Control vs. Convenience** | Favors granular control over the raw Opus stream. | Favors developer convenience and rapid implementation. | For this project's goals, convenience outweighs the need for low-level stream control. |
| **Speaking Events** | Explicit speaking.on('start') and speaking.on('end') events. | Less direct. Handled internally by sinks or inferred via on\_voice\_state\_update. | Node.js provides a cleaner API for this specific metadata, but it's not a critical blocker for Python. |
| **Recommendation** | A viable but more labor-intensive option. | **Recommended.** The high-level API significantly accelerates development and reduces the risk of low-level errors, making it the optimal choice. |  |

## **III. Architectural Blueprints for a Transcription and Diarization Service**

This section outlines the recommended end-to-end system architecture, covering audio ingestion, processing pipelines, and data management best practices.

### **3.1. Audio Ingestion Architectures: Real-Time vs. Post-Processing Batch**

A fundamental architectural decision is whether to process audio in real-time as it is spoken or to process it in batches after a recording session has concluded.

* **Batch Processing (Recommended):** This architecture aligns perfectly with the "record now, cook later" pattern observed in systems like Craig and Pandora.23 The bot records the entire session, saving separate raw audio files for each user. When the session ends, a job is triggered to process this complete dataset.  
  * **Pros:** This approach is architecturally simpler and more resilient to transient network or service failures. It is more cost-effective, as the resource-intensive processing can be run on ephemeral or spot-priced compute instances. Critically, it allows the transcription and summarization models to operate on the full context of the entire conversation, which generally leads to higher accuracy and more coherent results.24  
  * **Cons:** The primary drawback is latency; users must wait until after the session is complete to receive the final transcript and summary.27  
* **Real-Time Streaming:** In this model, the bot captures audio in small, continuous chunks (e.g., a few seconds at a time, potentially delimited by voice activity). Each chunk is immediately streamed to the transcription service for processing.29  
  * **Pros:** The main advantage is immediate results, enabling features like live captioning.31  
  * **Cons:** This architecture is significantly more complex to build and maintain, requiring robust handling of streaming protocols (like WebSockets or gRPC), out-of-order data, and state management. It incurs higher operational costs due to the need for "always-on" infrastructure. Furthermore, processing audio in isolated chunks can degrade the accuracy of transcription and, most notably, the quality of summarization, which benefits greatly from global conversational context.29

For a service whose primary value proposition includes high-quality transcription *and summarization*, the **Batch Processing** architecture is the superior initial choice. It prioritizes the quality of the final output and aligns with a more scalable and cost-effective system design.

### **Table 2: Trade-offs of Real-Time vs. Batch Transcription Architectures**

| Attribute | Batch Processing Architecture | Real-Time Streaming Architecture |
| :---- | :---- | :---- |
| **Latency to Final Transcript** | High (minutes post-session) | Low (seconds) |
| **Implementation Complexity** | Low to Medium | High |
| **Infrastructure Cost** | Lower (uses ephemeral compute) | Higher (requires persistent services) |
| **Transcription Accuracy** | Potentially Higher (full context) | Potentially Lower (chunked context) |
| **Summarization Quality** | High (full context available) | Low to Medium (requires complex stateful summary) |
| **Resilience to Errors** | Higher (tolerant to processing delays) | Lower (sensitive to network drops) |
| **Initial Recommendation** | **Batch Processing** | Future Feature Enhancement |

### **3.2. The Audio Processing Pipeline: From Raw Opus to Transcription-Ready Formats**

The "cooker" service is responsible for a critical multi-step pipeline that transforms the raw captured audio into a format optimized for transcription models like OpenAI's Whisper.

1. **Capture Raw Audio:** The bot receives audio from Discord as encrypted Opus packets.1 The chosen library (e.g., Pycord's sinks) handles decryption and provides the raw audio, typically as either Opus data or decoded Pulse-Code Modulation (PCM) data.  
2. **Transcode to a Canonical Format:** This is the most important step for ensuring high-quality transcription. Regardless of the initial format, the audio should be converted to a standardized intermediate format. For Whisper, the optimal specification is **16,000 Hz (16kHz) sample rate, single-channel (mono), with 16-bit depth PCM encoding**.35 The industry-standard tool for this task is  
   **FFmpeg**, which can be controlled via command-line execution or through Python wrappers like pydub.37 A typical FFmpeg command for this conversion would be:  
   $ ffmpeg \-i input.opus \-ac 1 \-ar 16000 \-acodec pcm\_s16le output.wav.36  
3. **Prepare for Upload (Compression and Chunking):** The Whisper API imposes a 25 MB file size limit per request.40 An uncompressed WAV file from a long recording session can easily exceed this limit. If a file is too large, it must be either compressed or segmented into smaller chunks. For compression, a lossy format like MP3 or M4A is suitable for voice.40 While lower bitrates can significantly reduce file size and API latency, it is best to start with a high-quality source (the canonical WAV file) and compress as needed.43 If chunking is necessary, care should be taken to split the audio during pauses in speech to preserve context for the model.40

The recommended pipeline is for the cooker service to always transcode to the canonical 16kHz, 16-bit, mono WAV format first. This file can then be sent directly to the Whisper API. If it exceeds the size limit, it can then be compressed to a reasonably high-bitrate MP3 for upload.

### **Table 3: Recommended Audio Encoding Parameters for OpenAI Whisper**

| Parameter | Recommended Value | Rationale | Supporting Sources |
| :---- | :---- | :---- | :---- |
| **Container Format (Processing)** | WAV | Lossless, standard for raw PCM data, ensures maximum quality for processing. | 36 |
| **Encoding** | Linear PCM (16-bit) | Native format expected by Whisper's internal processing pipeline. | 36 |
| **Sample Rate** | 16,000 Hz (16kHz) | Matches the native sample rate the Whisper model was trained on for optimal results. | 35 |
| **Channels** | 1 (Mono) | Whisper expects mono audio; stereo provides no benefit and increases file size. | 36 |
| **Container Format (Upload)** | MP3 / M4A | Good compression for voice to meet API file size limits if WAV is too large. | 40 |

### **3.3. Data Persistence and Management: Best Practices**

A robust strategy for storing, organizing, and managing the recorded audio data is essential for the service's reliability and integrity.

* **Storage and Backup Strategy:** For valuable data such as user recordings, adhering to the **3-2-1 backup rule** is a critical best practice: maintain **3** total copies of the data, on **2** different types of media, with **1** copy stored off-site.46 A practical implementation for a cloud-native service would involve:  
  1. **Primary (Hot) Storage:** An object storage service like Amazon S3 or Google Cloud Storage for both the raw and processed audio files. This serves as the active working directory for the processing pipeline.  
  2. **Secondary (Warm) Storage:** A second, replicated copy on a different medium, such as a separate cloud provider or a Network Attached Storage (NAS) system, for redundancy.47  
  3. **Tertiary (Cold) Storage:** A third, off-site copy for disaster recovery, stored in a geographically distinct location using a cloud provider's archive tier (e.g., S3 Glacier).46  
* **File Naming Convention:** A consistent and descriptive file naming convention is crucial for organization, debugging, and data retrieval. A recommended format is: \_\_\_\_.\[format\]. For example: 123456789\_987654321\_xkpzaBS9t24b\_555444333\_20250717T170000Z.wav. This structure embeds all necessary metadata to trace a file to its origin without requiring a database lookup, and it is both human-readable and easily parsable. Special characters and spaces should be avoided.46  
* **Data Integrity and Metadata:** To guard against data corruption, checksums (e.g., MD5 or SHA256) should be generated for each file upon creation and verified after every transfer.46 All relevant metadata—including speaker IDs, timestamps, recording duration, and the final transcript—should be stored alongside the audio files, either in a relational database (as Craig does with PostgreSQL 48) or in structured sidecar files (e.g., JSON).46

## **IV. Compliance and Legal Framework: Navigating Discord's Terms and User Consent**

Operating a service that records user conversations carries significant legal and ethical responsibilities. Adherence to Discord's policies and data privacy laws is not optional; it is a prerequisite for the service's existence.

### **4.1. Interpreting the Discord Developer Policy and Terms of Service**

Discord's policies are clear and strict regarding user privacy and consent. The **Discord Developer Policy** explicitly states that developers **must not** "initiate processes on a user or server's behalf without first obtaining their permission".50 Recording a user's voice is unequivocally such a process. The policies also forbid any application that attempts to "bypass or circumvent Discord's privacy, safety, and/or security features".50 A recording bot must therefore operate as a legitimate, authorized application and cannot engage in any form of surreptitious recording.

While Discord's platform does not have a native call recording feature (apart from the newer, limited "Clips" functionality), the company is aware of and tolerates third-party recording bots that operate transparently. However, official statements in support forums emphasize that recording calls without the consent of all users is a violation of their policies and, in many jurisdictions, the law.51 The public controversy surrounding recent updates to Discord's own privacy policy regarding the storage of voice messages and clips demonstrates both the company's sensitivity to this issue and the community's strong expectation of privacy.52

### **4.2. A Blueprint for Ethical Implementation: Designing Robust User Consent Mechanisms**

The legal landscape for audio recording is complex. Many jurisdictions, including numerous U.S. states and European Union countries under the General Data Protection Regulation (GDPR), operate under "two-party" or "all-party" consent laws. This means that *every participant* in a conversation must give their consent to be recorded.53 To operate legally on a global platform like Discord, a commercial service must build its consent model around the strictest standard:

**all-party consent**.

A simple notice in the bot's profile or a one-time, server-wide agreement is legally insufficient. Consent must be active, informed, specific, and ongoing for each recording session. The consent mechanism must be treated as a core technical feature of the application, not as a legal checkbox. The state of each user's consent (consented or not\_consented) must be actively tracked throughout a session, and this state must directly control the bot's recording logic. The bot must never subscribe to or process audio from a user who has not given explicit, affirmative consent for that specific session.

The following multi-layered workflow is recommended to achieve robust and ethical consent:

1. **Server-Level Authorization:** The server owner or an administrator must first explicitly invite the bot to their server and agree to the service's terms, providing the initial gate of approval.  
2. **Persistent Visual Indicators:** The bot must clearly and continuously signal its recording function. Its username should be modified to include a visible indicator like \`\` or a recording icon, and its user status should explicitly state that it is recording a session.11  
3. **Audible Notification:** Upon joining a voice channel to begin a recording session, the bot must play a brief, unambiguous audio message, such as, "This channel is now being recorded".8  
4. **Explicit, Per-User, Per-Session Opt-In:** This is the most critical step. The bot must **not** record any user by default. Instead, each user who wishes to be included in the recording must provide explicit, affirmative consent for that session. This can be implemented through a clear user action, such as executing a slash command (e.g., /record-me), clicking a button on a bot-posted message, or reacting with a specific emoji.  
5. **Clear and Simple Opt-Out:** Users must have an equally simple and accessible method to revoke their consent and stop being recorded at any point during the session (e.g., a /stop-recording-me command or another button click).

## **V. Synthesis and Strategic Recommendations**

This final section consolidates the preceding analysis into a clear, actionable path forward for the development of the transcription and summarization service.

### **5.1. The Optimal Architectural Path Forward**

The recommended architecture is a **distributed, batch-processing system** designed for scalability, resilience, and quality. It consists of four primary components:

* **Component 1: The Recorder Bot (Python/Pycord):** A fleet of lightweight, stateless applications. The bot's sole responsibilities are to join voice channels, manage the user consent workflow, and, upon receiving consent, use Pycord's start\_recording functionality to capture raw audio streams. These raw streams should be uploaded directly to a cloud object store (e.g., an Amazon S3 bucket).  
* **Component 2: The Message Queue (e.g., RabbitMQ, AWS SQS):** When a recording session is stopped, the Recorder Bot places a message into a queue. This message contains all the necessary metadata for the processing job, such as the Guild ID, Channel ID, and a list of the file paths for each recorded user in the object store.  
* **Component 3: The Cooker/Transcription Worker (Python):** A separate, auto-scaling fleet of worker services that listen for messages on the queue. When a worker picks up a job, it downloads the raw audio files from the object store, executes the transcoding pipeline (to 16kHz mono WAV), sends the processed files to the Whisper API for transcription, performs speaker diarization on the results, and stores the final, structured output.  
* **Component 4: The State Store (Redis):** A high-availability Redis cluster is used to manage the real-time state of active recordings and the consent status of each user in those recordings. This provides resilience and allows for coordination across multiple instances of the Recorder Bot.

### **5.2. Final Library and Language Recommendation**

The recommended technology stack is **Python** with the **Pycord** library.

* **Language: Python.** The Python ecosystem is unparalleled for data science, audio processing (with libraries like pydub), and interfacing with modern AI APIs, including the official OpenAI library. This makes it the natural choice for the entire backend, from the bot to the processing workers.  
* **Discord Library: Pycord.** Its high-level abstractions for multi-track voice recording, specifically the "Sink" model, will dramatically accelerate development, reduce code complexity, and minimize the risk of hard-to-debug, low-level stream handling errors when compared to alternatives.20

### **5.3. Critical Path and Implementation Roadmap**

A phased implementation approach is recommended to manage complexity and risk.

1. **Phase 1: Core Recording Proof of Concept:** Develop a basic Pycord bot to validate the core technical premise. The goal is to successfully join a channel and use WaveSink to record multiple users into separate, locally saved WAV files. This phase should also establish the standardized file naming convention.  
2. **Phase 2: Architecture and Pipeline Development:** Build out the distributed architecture. Implement the Recorder Bot's logic to upload files to an object store, set up the message queue, and create a basic Cooker Worker. This worker should integrate the FFmpeg transcoding step and the initial API call to the Whisper service.  
3. **Phase 3: Consent and Compliance (Pre-Alpha):** Before any external testing, design and implement the full, multi-layered user consent mechanism as a core feature of the bot's state machine. Concurrently, draft a clear privacy policy and terms of service for the application. This phase is critical for legal and platform compliance.  
4. **Phase 4: Scalability and Productionizing:** Integrate Redis for resilient state management. Containerize all application components using Docker. Establish deployment pipelines and auto-scaling rules on the chosen cloud provider. Implement robust, structured logging, performance monitoring, and alerting.  
5. **Phase 5: User-Facing Application and Beta Launch:** Develop the front-end interface or API that allows end-users to access their generated transcripts and summaries. Begin a closed beta test with a group of trusted users to gather feedback and identify issues before a public launch.

#### **Works cited**

1. discord-api-docs-1/docs/topics/VOICE\_CONNECTIONS.md at ..., accessed July 18, 2025, [https://github.com/meew0/discord-api-docs-1/blob/master/docs/topics/VOICE\_CONNECTIONS.md](https://github.com/meew0/discord-api-docs-1/blob/master/docs/topics/VOICE_CONNECTIONS.md)  
2. VoiceReceiver (voice \- main) | discord.js, accessed July 18, 2025, [https://discord.js.org/docs/packages/voice/main/VoiceReceiver:Class](https://discord.js.org/docs/packages/voice/main/VoiceReceiver:Class)  
3. Record all users in a voice channel in discord.js v12 \- Stack Overflow, accessed July 18, 2025, [https://stackoverflow.com/questions/66321524/record-all-users-in-a-voice-channel-in-discord-js-v12](https://stackoverflow.com/questions/66321524/record-all-users-in-a-voice-channel-in-discord-js-v12)  
4. Craig, accessed July 18, 2025, [https://craig.chat/](https://craig.chat/)  
5. How can I record separate user voices in Discord? : r/obs \- Reddit, accessed July 18, 2025, [https://www.reddit.com/r/obs/comments/onovy8/how\_can\_i\_record\_separate\_user\_voices\_in\_discord/](https://www.reddit.com/r/obs/comments/onovy8/how_can_i_record_separate_user_voices_in_discord/)  
6. Craig \- Discord Bots, accessed July 18, 2025, [https://discord.bots.gg/bots/272937604339466240](https://discord.bots.gg/bots/272937604339466240)  
7. Recording multitrack audio from Discord with Craig : r/podcasts \- Reddit, accessed July 18, 2025, [https://www.reddit.com/r/podcasts/comments/94buic/recording\_multitrack\_audio\_from\_discord\_with\_craig/](https://www.reddit.com/r/podcasts/comments/94buic/recording_multitrack_audio_from_discord_with_craig/)  
8. How to Record Discord Calls Using Craig Bot, Audacity & OBS Studio \- Harrisons Blog, accessed July 18, 2025, [https://blog.harrisonbaron.com/how-to-record-discord-calls-using-craig-bot-audacity-obs-studio](https://blog.harrisonbaron.com/how-to-record-discord-calls-using-craig-bot-audacity-obs-studio)  
9. voice (main) \- discord.js, accessed July 18, 2025, [https://discord.js.org/docs/packages/voice/main](https://discord.js.org/docs/packages/voice/main)  
10. RFC: Voice Receive API Design/Usage · Issue \#1094 · Rapptz/discord.py \- GitHub, accessed July 18, 2025, [https://github.com/Rapptz/discord.py/issues/1094](https://github.com/Rapptz/discord.py/issues/1094)  
11. Introduction | Craig, accessed July 18, 2025, [https://craig.chat/docs/](https://craig.chat/docs/)  
12. New Maintainers of Craig for Discord Recording \- YouTube, accessed July 18, 2025, [https://www.youtube.com/watch?v=2NoZQJ-z\_s8](https://www.youtube.com/watch?v=2NoZQJ-z_s8)  
13. How to get speaking status in real time using Discord.js v13 \- Stack Overflow, accessed July 18, 2025, [https://stackoverflow.com/questions/70770884/how-to-get-speaking-status-in-real-time-using-discord-js-v13](https://stackoverflow.com/questions/70770884/how-to-get-speaking-status-in-real-time-using-discord-js-v13)  
14. How would I detect when a user is speaking in a voice channel discord.JS v13, accessed July 18, 2025, [https://stackoverflow.com/questions/71344815/how-would-i-detect-when-a-user-is-speaking-in-a-voice-channel-discord-js-v13](https://stackoverflow.com/questions/71344815/how-would-i-detect-when-a-user-is-speaking-in-a-voice-channel-discord-js-v13)  
15. discord.js, accessed July 18, 2025, [https://discord.js.org/](https://discord.js.org/)  
16. How to record Voice Channels V14 \- Discordjs \- Reddit, accessed July 18, 2025, [https://www.reddit.com/r/Discordjs/comments/102x6ww/how\_to\_record\_voice\_channels\_v14/](https://www.reddit.com/r/Discordjs/comments/102x6ww/how_to_record_voice_channels_v14/)  
17. Recording Discord Voice Chat with discord.js results in corrupted Opus files \- Stack Overflow, accessed July 18, 2025, [https://stackoverflow.com/questions/76397486/recording-discord-voice-chat-with-discord-js-results-in-corrupted-opus-files](https://stackoverflow.com/questions/76397486/recording-discord-voice-chat-with-discord-js-results-in-corrupted-opus-files)  
18. Introduction \- Pycord Guide, accessed July 18, 2025, [https://guide.pycord.dev/introduction](https://guide.pycord.dev/introduction)  
19. Pycord: HOME, accessed July 18, 2025, [https://pycord.dev/](https://pycord.dev/)  
20. Receiving Voice Samples \- Pycord Guide, accessed July 18, 2025, [https://guide.pycord.dev/voice/receiving](https://guide.pycord.dev/voice/receiving)  
21. pycord/examples/audio\_recording.py at master \- GitHub, accessed July 18, 2025, [https://github.com/Pycord-Development/pycord/blob/master/examples/audio\_recording.py](https://github.com/Pycord-Development/pycord/blob/master/examples/audio_recording.py)  
22. CraigChat/craig: Craig is a multi-track voice recorder for ... \- GitHub, accessed July 18, 2025, [https://github.com/CraigChat/craig](https://github.com/CraigChat/craig)  
23. SoTrxII/Pandora: A discord recording bot \- GitHub, accessed July 18, 2025, [https://github.com/SoTrxII/Pandora](https://github.com/SoTrxII/Pandora)  
24. Batch transcription overview \- Speech service \- Azure AI services | Microsoft Learn, accessed July 18, 2025, [https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription)  
25. Batch Processing vs. Stream Processing: A Comprehensive Guide \- Rivery, accessed July 18, 2025, [https://rivery.io/blog/batch-vs-stream-processing-pros-and-cons-2/](https://rivery.io/blog/batch-vs-stream-processing-pros-and-cons-2/)  
26. Real-Time vs Batch Data Integration: Pros & Cons \- TROCCO, accessed July 18, 2025, [https://global.trocco.io/blogs/real-time-vs-batch-data-integration-pros-cons](https://global.trocco.io/blogs/real-time-vs-batch-data-integration-pros-cons)  
27. Real-Time vs Batch Processing A Comprehensive Comparison for 2025 \- PingCAP, accessed July 18, 2025, [https://www.pingcap.com/article/real-time-vs-batch-processing-comparison-2025/](https://www.pingcap.com/article/real-time-vs-batch-processing-comparison-2025/)  
28. Batch vs. Real-Time Processing: What's the Difference? \- eHouse Studio, accessed July 18, 2025, [https://www.ehousestudio.com/blog/batch-vs-real-time-data-processing-whats-the-difference](https://www.ehousestudio.com/blog/batch-vs-real-time-data-processing-whats-the-difference)  
29. Evaluation of real-time transcriptions using end-to-end ASR models \- arXiv, accessed July 18, 2025, [https://arxiv.org/html/2409.05674v1](https://arxiv.org/html/2409.05674v1)  
30. \[D\] Implementing real time transcription : r/MachineLearning \- Reddit, accessed July 18, 2025, [https://www.reddit.com/r/MachineLearning/comments/15r35mq/d\_implementing\_real\_time\_transcription/](https://www.reddit.com/r/MachineLearning/comments/15r35mq/d_implementing_real_time_transcription/)  
31. Speech to text overview \- Speech service \- Azure AI services, accessed July 18, 2025, [https://docs.azure.cn/en-us/ai-services/speech-service/speech-to-text](https://docs.azure.cn/en-us/ai-services/speech-service/speech-to-text)  
32. Speech to text overview \- Speech service \- Azure AI services | Microsoft Learn, accessed July 18, 2025, [https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text)  
33. Real-Time Transcription \- What is it and how does it work? \- GetStream.io, accessed July 18, 2025, [https://getstream.io/glossary/real-time-transcription/](https://getstream.io/glossary/real-time-transcription/)  
34. Real Time vs. Batch Processing vs. Stream Processing – BMC Software | Blogs, accessed July 18, 2025, [https://www.bmc.com/blogs/batch-processing-stream-processing-real-time/](https://www.bmc.com/blogs/batch-processing-stream-processing-real-time/)  
35. Support for other audio formats · ggml-org whisper.cpp · Discussion \#1399 \- GitHub, accessed July 18, 2025, [https://github.com/ggml-org/whisper.cpp/discussions/1399](https://github.com/ggml-org/whisper.cpp/discussions/1399)  
36. Which audio file format is best? · openai whisper · Discussion \#41 \- GitHub, accessed July 18, 2025, [https://github.com/openai/whisper/discussions/41](https://github.com/openai/whisper/discussions/41)  
37. GigaSpeech/utils/opus\_to\_wav.py at main \- GitHub, accessed July 18, 2025, [https://github.com/SpeechColab/GigaSpeech/blob/main/utils/opus\_to\_wav.py](https://github.com/SpeechColab/GigaSpeech/blob/main/utils/opus_to_wav.py)  
38. Voice Computing in Python \- \- Maël Fabien, accessed July 18, 2025, [https://maelfabien.github.io/machinelearning/Speech8/](https://maelfabien.github.io/machinelearning/Speech8/)  
39. ffmpeg guide \- GitHub Gist, accessed July 18, 2025, [https://gist.github.com/protrolium/e0dbd4bb0f1a396fcb55](https://gist.github.com/protrolium/e0dbd4bb0f1a396fcb55)  
40. How to Transcribe Audio with Whisper: A Comprehensive Guide 2023 \- TranscribeTube, accessed July 18, 2025, [https://www.transcribetube.com/blog/how-to-transcribe-audio-with-whisper](https://www.transcribetube.com/blog/how-to-transcribe-audio-with-whisper)  
41. Audio API FAQ \- OpenAI Help Center, accessed July 18, 2025, [https://help.openai.com/en/articles/7031512-audio-api-faq](https://help.openai.com/en/articles/7031512-audio-api-faq)  
42. What is the best audio file to text converter for Transcribing? \- Microsoft Community Hub, accessed July 18, 2025, [https://techcommunity.microsoft.com/discussions/windows11/what-is-the-best-audio-file-to-text-converter-for-transcribing/4403367](https://techcommunity.microsoft.com/discussions/windows11/what-is-the-best-audio-file-to-text-converter-for-transcribing/4403367)  
43. Optimise OpenAI Whisper API: Audio Format, Sampling Rate and Quality \- DEV Community, accessed July 18, 2025, [https://dev.to/mxro/optimise-openai-whisper-api-audio-format-sampling-rate-and-quality-29fj?comments\_sort=top](https://dev.to/mxro/optimise-openai-whisper-api-audio-format-sampling-rate-and-quality-29fj?comments_sort=top)  
44. Optimise OpenAI Whisper API: Audio Format, Sampling Rate and Quality \- DEV Community, accessed July 18, 2025, [https://dev.to/mxro/optimise-openai-whisper-api-audio-format-sampling-rate-and-quality-29fj](https://dev.to/mxro/optimise-openai-whisper-api-audio-format-sampling-rate-and-quality-29fj)  
45. Introduction to audio encoding for Speech-to-Text bookmark\_border \- Google Cloud, accessed July 18, 2025, [https://cloud.google.com/speech-to-text/docs/encoding](https://cloud.google.com/speech-to-text/docs/encoding)  
46. Best Practices for Digital Audio Preservation \- Storii, accessed July 18, 2025, [https://www.storii.com/blog/best-practices-for-digital-audio-preservation](https://www.storii.com/blog/best-practices-for-digital-audio-preservation)  
47. How to Properly Store Audio Files: 5 Useful Tips \- Secure Redact, accessed July 18, 2025, [https://www.secureredact.ai/articles/how-to-store-audio-files](https://www.secureredact.ai/articles/how-to-store-audio-files)  
48. craig/SELFHOST.md at master · CraigChat/craig \- GitHub, accessed July 18, 2025, [https://github.com/CraigChat/craig/blob/master/SELFHOST.md](https://github.com/CraigChat/craig/blob/master/SELFHOST.md)  
49. Transcription Formatting: Best Practices for Accuracy and Clarity \- Sonix, accessed July 18, 2025, [https://sonix.ai/resources/transcription-formatting/](https://sonix.ai/resources/transcription-formatting/)  
50. Discord Developer Policy, accessed July 18, 2025, [https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)  
51. Record Calls \- Discord Support, accessed July 18, 2025, [https://support.discord.com/hc/en-us/community/posts/360071369492-Record-Calls](https://support.discord.com/hc/en-us/community/posts/360071369492-Record-Calls)  
52. Discord will possibly record your video calls, voice calls and channels including screen shares. : r/discordapp \- Reddit, accessed July 18, 2025, [https://www.reddit.com/r/discordapp/comments/11ihqq6/discord\_will\_possibly\_record\_your\_video\_calls/](https://www.reddit.com/r/discordapp/comments/11ihqq6/discord_will_possibly_record_your_video_calls/)  
53. How to Record Discord Audio: 7 Quick & Easy Ways in 2025 \- Descript, accessed July 18, 2025, [https://www.descript.com/blog/article/how-to-record-discord-audio](https://www.descript.com/blog/article/how-to-record-discord-audio)  
54. How To Record Discord Voice Calls? \- K\&F Concept, accessed July 18, 2025, [https://www.kentfaith.com/blog/article\_how-to-record-discord-voice-calls\_25136](https://www.kentfaith.com/blog/article_how-to-record-discord-voice-calls_25136)  
55. The Definite Guide to Craig Bot Discord in 2025 \- Filmora \- Wondershare, accessed July 18, 2025, [https://filmora.wondershare.com/video-editing/craig-bot-discord.html](https://filmora.wondershare.com/video-editing/craig-bot-discord.html)
