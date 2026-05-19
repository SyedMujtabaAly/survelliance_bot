import { useState, useEffect, useRef } from "react";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { 
  Mic, 
  Volume2, 
  Languages, 
  FileText, 
  Play, 
  Square,
  History,
  Shield,
  Zap,
  Sparkles
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { arrayBufferToBase64, floatTo16BitPCM } from "./lib/audio-utils";

interface TranscriptionEntry {
  id: string;
  text: string;
  translation?: string;
  sender: "user" | "bot";
  timestamp: number;
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [sourceType, setSourceType] = useState<"camera" | "screen">("camera");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [currentTranscription, setCurrentTranscription] = useState("");
  const [currentTranslation, setCurrentTranslation] = useState("");
  const [scenario, setScenario] = useState<string | null>(null);
  const [isGeneratingScenario, setIsGeneratingScenario] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState("English");
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const nextAudioTimeRef = useRef<number>(0);

  const getAI = () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY missing. Please add it to your environment variables.");
    }
    return new GoogleGenAI({ apiKey: key as string });
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoIntervalRef = useRef<number | null>(null);

  const playAudioChunk = (base64Data: string) => {
    // Playback disabled as per user request to "not speak"
    // Leave function for potential future use or debugging
  };

  useEffect(() => {
    // Auto-scroll the log container
    const container = document.getElementById("log-container");
    if (container) {
      container.scrollTop = container.scrollHeight;
    }

    // Auto-trigger report synthesis every 5 entries
    if (transcriptions.length > 0 && transcriptions.length % 5 === 0 && !isGeneratingScenario) {
      generateScenario();
    }
  }, [transcriptions]);

  const startRecording = async () => {
    setErrorMessage(null);
    try {
      let mediaStream: MediaStream;
      
      try {
        if (sourceType === "screen") {
          let captureStream: MediaStream;
          try {
            // Priority 1: Screen + Audio
            // @ts-ignore
            captureStream = await navigator.mediaDevices.getDisplayMedia({ 
              video: true,
              audio: true
            });
          } catch (ve: any) {
            console.warn("Screen capture with audio failed, trying video only:", ve);
            try {
              // Priority 2: Screen Video Only
              // @ts-ignore
              captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            } catch (ve2: any) {
              console.error("Screen capture failed entirely:", ve2);
              if (ve2.name === 'NotAllowedError' || ve2.message.includes('permissions policy')) {
                throw new Error("ACCESS BLOCKED: Click 'Open in new tab' at the top right to use Screen Feed.");
              }
              throw new Error("Screen capture failed. Check if you closed the selector or denied permissions.");
            }
          }

          // If we have video but no audio, try to supplement with microphone
          if (captureStream.getAudioTracks().length === 0) {
            try {
              const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
              mediaStream = new MediaStream([
                ...captureStream.getVideoTracks(),
                ...micStream.getAudioTracks()
              ]);
            } catch (ae) {
              console.warn("Microphone access denied for screen feed fallback.");
              mediaStream = captureStream; 
            }
          } else {
            mediaStream = captureStream;
          }
        } else {
          // Webcam fallback chain
          try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ 
              audio: true,
              video: { width: { ideal: 640 }, height: { ideal: 480 } }
            });
          } catch (e1) {
            console.warn("High-res webcam failed, trying basic audio/video:", e1);
            try {
              mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            } catch (e2) {
              console.warn("Video failed entirely, trying audio only:", e2);
              mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
          }
        }
      } catch (err: any) {
        console.error("Device initialization failed:", err);
        throw err;
      }
      
      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      
      // CRITICAL: Check if we actually have audio tracks to process
      if (mediaStream.getAudioTracks().length > 0) {
        const source = audioContextRef.current.createMediaStreamSource(mediaStream);
        processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

        processorRef.current.onaudioprocess = (e) => {
          if (!sessionRef.current) return;
          
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmData = floatTo16BitPCM(inputData);
          const base64Data = arrayBufferToBase64(pcmData.buffer);
          
          sessionRef.current.sendRealtimeInput({
            audio: { 
              data: base64Data, 
              mimeType: `audio/pcm;rate=16000` 
            }
          });
        };

        source.connect(processorRef.current);
        processorRef.current.connect(audioContextRef.current.destination);
      } else {
        console.warn("No audio tracks found in the stream.");
        // We don't throw here to allow video-only (scene description) if needed, 
        // but we should warn the user.
        setErrorMessage("Warning: No audio detected. Ensure 'Share system audio' is checked or microphone is active.");
      }

      const sessionPromise = getAI().live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are a RETAIL SALES MONITORING BOT.
          MISSION:
          1. TRANSCRIBE the whole conversation between the salesperson and the customer in real-time.
          2. DO NOT narrate physical events or movements. Focus ONLY on the conversation.
          3. PAYMENT DETECTION: RELIABLY IDENTIFY, EXTRACT AND LOG all payment details. You must accurately capture:
             - Payment Method: specifically identify if it's Cash, Credit/Debit Card, Tap-to-Pay, Apple Pay, Google Pay, Digital Wallet, etc.
             - Exact Amount.
             - Time of payment (based on conversation context).
          4. IDENTIFY AND LOG specific sales pitches: "phone on AAL" (add a line), "new line", "port in", "tablet pitch", or "accessory pitch".
          5. EXPLICIT SPEAKER TAGS: You MUST label every single line of transcription with either [SALESPERSON]: or [CUSTOMER]: depending on who is speaking. START every new spoken line on a NEW LINE. NEVER omit these tags.
          6. FORMAT: Provide the conversation transcript. If a payment or pitch is detected, append a clear [LOG] with the details on a NEW LINE.
          Example: 
          [SALESPERSON]: "That will be $45.50."
          [CUSTOMER]: "Here, I'll just use Apple Pay."
          [LOG]: Payment Detected: $45.50 via Apple Pay.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
             console.log("Connected to Gemini Live");
             
             // Start video streaming loop if video exists in stream
             if (streamRef.current?.getVideoTracks().length) {
                videoIntervalRef.current = window.setInterval(() => {
                  if (sessionRef.current && videoRef.current && canvasRef.current) {
                    const canvas = canvasRef.current;
                    const context = canvas.getContext("2d");
                    if (context) {
                      context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                      const base64Video = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
                      sessionRef.current.sendRealtimeInput({
                        video: { data: base64Video, mimeType: "image/jpeg" }
                      });
                    }
                  }
                }, 1000);
             }
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log("G-Stream Msg:", message);

            if (message.goAway) {
               console.warn("Received GoAway signal from Gemini API. Session duration reached.", message.goAway);
               setErrorMessage("Session duration limit reached. Please re-initialize.");
               stopRecording();
               return;
            }

            const serverContent = message.serverContent;
            if (!serverContent) return;
            
            // Handle Model Transcription (Bot's spoken response turned to text)
            const outputTranscription = (serverContent as any).outputTranscription?.text;
            if (outputTranscription) {
               setCurrentTranslation(prev => prev + outputTranscription);
            }

            // Handle Model Turn (Actual text parts from model, though modality is audio)
            const modelPart = serverContent.modelTurn?.parts;
            if (modelPart) {
               const text = modelPart.map(p => p.text).filter(Boolean).join("");
               if (text) {
                  // Avoid duplication if outputTranscription already captured it
                  if (!outputTranscription || !outputTranscription.includes(text)) {
                    setCurrentTranslation(prev => prev + text);
                  }
               }
            }

            // Handle Audio Transcriptions (Input Speech from Source Window)
            const inputTranscription = (serverContent as any).inputTranscription?.text;
            if (inputTranscription) {
               setCurrentTranscription(prev => prev + inputTranscription);
            }
            
            // Handle Model Turn Completion - Archive both to log
            if (serverContent.turnComplete) {
               if (currentTranslation || currentTranscription) {
                  const newEntry: TranscriptionEntry = {
                    id: Date.now().toString(),
                    text: currentTranscription.trim() || "Environmental Audio",
                    translation: currentTranslation.trim() || "Scanning...",
                    sender: "bot",
                    timestamp: Date.now()
                  };
                  setTranscriptions(prev => [...prev, newEntry]);
                  setCurrentTranslation("");
                  setCurrentTranscription("");
               }
            }
          },
          onerror: (err) => {
             console.error("Live Error:", err);
             setErrorMessage("Live API Connection Error. Check your API key or network.");
          },
        },
      });

      sessionRef.current = await sessionPromise;
      setIsRecording(true);
    } catch (err) {
      console.error("Error starting session:", err);
      setErrorMessage(err instanceof Error ? err.message : "Failed to initialize devices.");
      stopRecording();
    }
  };

  const stopRecording = () => {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    
    if (currentTranscription || currentTranslation) {
       setTranscriptions(prev => [...prev, {
         id: Date.now().toString(),
         text: currentTranscription || "User speech detected",
         translation: currentTranslation,
         sender: "user",
         timestamp: Date.now()
       }]);
       setCurrentTranscription("");
       setCurrentTranslation("");
    }
    
    setIsRecording(false);
  };

  const generateScenario = async () => {
    if (transcriptions.length === 0) return;
    setIsGeneratingScenario(true);
    try {
      const historyText = transcriptions.slice(-50).map(t => `Timestamp: ${new Date(t.timestamp).toLocaleTimeString()}\nOriginal/Transcribed: ${t.text}\nEnglish Translation: ${t.translation}`).join("\n\n");
      const response = await getAI().models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts: [{ text: `Act as a Retail Sales Auditor. Analyze the following combined transcript from a monitoring feed and generate a "Retail Sales & Payment Report". 
        Include:
        1. A summary of the conversation between the salesperson and customer.
        2. All payments made, including exact time, method used (cash/card), and total amount.
        3. A log of any specific sales pitches made: e.g. "phone on AAL" (add a line), "new line", "port in", "tablet pitch", or "accessory".
        KEEP THE REPORT PROFESSIONAL, CONCISE, AND ALL-CAPS TO MATCH A SURVEILLANCE AESTHETIC.
        \n\n${historyText}` }] }],
      });
      setScenario(response.text || "No report generated.");
    } catch (err) {
      console.error("Scenario generation failed:", err);
    } finally {
      setIsGeneratingScenario(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 lg:p-8 font-sans border-8 border-zinc-900 flex flex-col gap-8 selection:bg-blue-500/30">
      <header className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-700'}`}></div>
            <span className={`text-[10px] font-bold tracking-[0.2em] uppercase ${isRecording ? 'text-emerald-500' : 'text-zinc-500'}`}>
              {isRecording ? 'System Live' : 'System Standby'}
            </span>
          </div>
          <h1 className="text-5xl font-black tracking-tighter uppercase italic leading-none">AIMS SERVICES SURVEILLANCE BOT</h1>
        </div>
        
        <div className="flex flex-col items-end gap-4 text-right">
          {errorMessage && (
            <div className="bg-red-600 px-4 py-2 text-xs font-black uppercase italic tracking-tighter text-white animate-pulse shadow-xl shadow-red-900/40 border border-red-400/50">
              CRITICAL ERROR: {errorMessage}
            </div>
          )}
          <div className="flex gap-2 mb-2">
            {(["camera", "screen"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setSourceType(type)}
                disabled={isRecording}
                className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest border transition-all ${
                  sourceType === type 
                    ? "bg-zinc-100 text-zinc-950 border-zinc-100" 
                    : "bg-transparent text-zinc-500 border-zinc-800 hover:border-zinc-700"
                } disabled:opacity-20`}
              >
                {type === "camera" ? "Webcam" : "Screen Feed"}
              </button>
            ))}
          </div>
          <div className="hidden sm:block">
            <div className="text-[10px] font-mono text-zinc-500 uppercase">SOURCE: {isRecording ? 'NEST_AUDIO_CAM_01' : 'NO_SIGNAL'}</div>
            <div className="text-[10px] font-mono text-zinc-500 uppercase">LATENCY: {isRecording ? '18MS' : '--'} // G3F_SURVEILLANCE</div>
          </div>
          
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`flex items-center gap-2 px-8 py-3 rounded-none font-black uppercase italic tracking-tighter transition-all text-sm shadow-2xl ${
              isRecording 
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-red-900/20' 
                : 'bg-zinc-100 hover:bg-white text-zinc-950 shadow-zinc-100/10'
            }`}
          >
            {isRecording ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            {isRecording ? 'Terminate' : 'Initialize'}
          </button>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-8 min-h-0">
        {/* Left Column: Live Transcription & Video */}
        <section className="col-span-12 lg:col-span-5 flex flex-col min-h-0 gap-6">
          <div className="flex justify-end items-end">
            <div className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono rounded text-zinc-400 uppercase">LOG ➔ {targetLanguage.slice(0,3)}</div>
          </div>

          <div className="bg-zinc-900/50 rounded-2xl overflow-hidden aspect-video relative border border-zinc-800 shadow-2xl">
             <video 
               ref={videoRef} 
               autoPlay 
               playsInline 
               muted 
               className={`absolute inset-0 w-full h-full object-cover grayscale transition-opacity duration-1000 ${isRecording ? 'opacity-40' : 'opacity-0'}`}
             />
             <canvas ref={canvasRef} className="hidden" width={640} height={480} />
             
             {!isRecording ? (
                <div className="absolute inset-0 flex items-center justify-center text-center p-8">
                  <div className="max-w-xs transition-all duration-700">
                    <Zap className="w-12 h-12 mx-auto mb-4 text-zinc-700" />
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-4">Awaiting Signal</p>
                    
                    {sourceType === "screen" && (
                      <div className="bg-zinc-800/50 p-4 rounded-xl border border-zinc-700 text-left space-y-2">
                        <p className="text-[10px] font-black uppercase text-white tracking-tighter">Multi-Profile Setup:</p>
                        <p className="text-[10px] text-zinc-400 leading-tight">
                          1. Click "Initialize" and select <b>Window</b> (preferred) or <b>Entire Screen</b>.<br/>
                          2. Choose the Google Home window from your other profile.<br/>
                          3. <b>CRITICAL:</b> Ensure "Share system audio" is checked.<br/>
                          4. Keep that window unminimized for best results.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
             ) : (
                <div className="absolute top-4 right-4 z-20 flex gap-2">
                  <div className="bg-emerald-500 text-zinc-950 px-2 py-0.5 text-[10px] font-black uppercase tracking-tighter">
                    CONNECTED
                  </div>
                </div>
             )}
          </div>

          <div id="log-container" className="flex-1 bg-zinc-900/30 rounded-2xl p-6 border border-zinc-800 space-y-4 overflow-y-auto custom-scrollbar scroll-smooth">
             <div className="flex items-center gap-2 mb-2 pb-2 border-b border-zinc-800/50">
                <Languages className="w-3 h-3 text-zinc-500" />
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-mono">Live translation & Events</span>
             </div>
             
             <AnimatePresence mode="popLayout">
               {(currentTranslation || currentTranscription) ? (
                 <motion.div 
                   key="live"
                   initial={{ opacity: 0, y: 10 }}
                   animate={{ opacity: 1, y: 0 }}
                   className="text-xl font-black uppercase tracking-tight text-white leading-tight italic"
                 >
                   <span className="text-zinc-600 mr-2 opacity-50 font-mono text-[10px] not-italic">REPORTING //</span>
                   <div className="text-zinc-400 text-xs not-italic opacity-40 font-mono mb-2 border-l-2 border-zinc-800 pl-2">
                      SOURCE_FEED: {currentTranscription || 'Analyzing signal...'}
                   </div>
                   <div className="text-emerald-400">
                      {currentTranslation || 'Decoding translation...'}
                      <motion.span animate={{ opacity: [0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1 h-5 bg-emerald-500 ml-1 align-middle" />
                   </div>
                 </motion.div>
               ) : (
                 <p className="text-zinc-600 text-xs italic font-medium">Awaiting security signal...</p>
               )}
             </AnimatePresence>

             <div className="pt-4 space-y-4 border-t border-zinc-800/50">
                {transcriptions.slice().reverse().map((t, idx) => (
                  <div key={t.id} className={`p-4 bg-zinc-800/20 rounded-xl border border-zinc-800/50 space-y-1 transition-all ${idx > 5 ? 'opacity-30' : 'opacity-100 scale-100'}`}>
                    <div className="flex justify-between items-center">
                      <p className="text-[10px] font-mono text-zinc-600 tracking-tighter uppercase font-bold">{new Date(t.timestamp).toLocaleTimeString()} // EVENT_LOG</p>
                      <Shield className="w-3 h-3 text-zinc-700" />
                    </div>
                    <div className="text-sm leading-relaxed text-zinc-300 font-medium space-y-3 mt-4">
                      {t.translation.split('\n').filter(line => line.trim() !== '').map((line, i) => {
                         const isSales = line.includes('[SALESPERSON]');
                         const isCust = line.includes('[CUSTOMER]');
                         const isLog = line.includes('[LOG]');
                         
                         if (isSales) {
                           return (
                             <div key={i} className="flex flex-col items-start w-full">
                               <div className="bg-blue-900/20 border border-blue-800/30 text-blue-100 px-4 py-2.5 rounded-2xl rounded-tl-sm max-w-[90%] font-sans">
                                 {line.replace(/\[SALESPERSON\]:?/g, '').trim()}
                               </div>
                               <span className="text-[9px] text-blue-500/70 font-black tracking-widest font-mono mt-1.5 ml-1 uppercase">Salesperson</span>
                             </div>
                           );
                         } else if (isCust) {
                           return (
                             <div key={i} className="flex flex-col items-end w-full">
                               <div className="bg-emerald-900/20 border border-emerald-800/30 text-emerald-100 px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[90%] text-right font-sans">
                                 {line.replace(/\[CUSTOMER\]:?/g, '').trim()}
                               </div>
                               <span className="text-[9px] text-emerald-500/70 font-black tracking-widest font-mono mt-1.5 mr-1 uppercase">Customer</span>
                             </div>
                           );
                         } else if (isLog) {
                           return (
                             <div key={i} className="flex flex-col items-center w-full my-4">
                               <div className="bg-amber-900/20 border border-amber-800/40 text-amber-400 px-6 py-2 rounded-none text-xs w-full text-center uppercase tracking-widest font-mono">
                                 {line.replace(/\[LOG\]:?/g, '').trim()}
                               </div>
                             </div>
                           );
                         }
                         
                         // Fallback for unformatted text
                         return <div key={i} className="px-2 py-1 text-zinc-400 italic">{line}</div>;
                      })}
                    </div>
                  </div>
                ))}
             </div>
          </div>
        </section>

        {/* Right Column: Scenario Synthesis */}
        <section className="col-span-12 lg:col-span-7 flex flex-col gap-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500 font-mono">CODE WITH MUJT4B4</h2>
            <div className="flex gap-4">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-bold text-zinc-500 uppercase font-mono">Context Density</span>
                <span className="text-sm font-mono font-bold text-zinc-300 italic">{transcriptions.length * 12} // PTS</span>
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0">
             {/* Massive Typography Section */}
             <div className="flex-1 bg-white text-zinc-950 rounded-3xl p-10 flex flex-col justify-between shadow-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-8 opacity-[0.03] grayscale pointer-events-none">
                   <FileText className="w-80 h-80 -mr-20 -mt-20 transform rotate-12" />
                </div>

                <div className="relative z-10">
                  <span className="text-[10px] font-black uppercase tracking-[0.3em] bg-zinc-950 text-white px-3 py-1.5 inline-block mb-10 transition-transform group-hover:translate-x-1">Synthesis Active</span>
                  <div className="space-y-4">
                    <h3 className="text-5xl sm:text-6xl lg:text-7xl font-black leading-[0.9] tracking-tighter uppercase italic break-words transition-all duration-700">
                      {scenario ? (
                        scenario.trim().split('\n')[0].slice(0, 30) + (scenario.length > 30 ? '...' : '')
                      ) : (
                        <span className="text-zinc-100 italic">Signal_Null<br/>Awaiting_Data</span>
                      )}
                    </h3>
                  </div>
                </div>
                
                <div className="relative z-10 grid grid-cols-1 gap-6 border-t border-zinc-100 pt-10 mt-10 overflow-hidden">
                  <div className="max-h-[300px] overflow-y-auto custom-scrollbar-light pr-4">
                    <p className="text-[10px] font-bold uppercase mb-4 tracking-widest text-zinc-400 font-mono">Live Intelligence Report</p>
                    <div className="text-sm font-medium leading-relaxed uppercase tracking-tight text-zinc-800 whitespace-pre-wrap">
                      {scenario || "Awaiting sufficient conversational data to synthesize a full security assessment report. Ensure your Google Home feed is active and unmuted."}
                    </div>
                  </div>
                </div>
             </div>

             {/* Action Bars */}
             <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1 font-mono">Sentiment</p>
                  <p className="text-2xl font-black italic uppercase tracking-tighter text-zinc-200">
                    {transcriptions.length > 0 ? 'Dynamic' : 'Neural'}
                  </p>
                </div>
                <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1 font-mono">Confidence</p>
                  <p className="text-2xl font-black italic uppercase tracking-tighter text-emerald-500">
                    {transcriptions.length > 0 ? '98.4%' : '0.0%'}
                  </p>
                </div>
                <button 
                  onClick={generateScenario}
                  disabled={transcriptions.length === 0 || isGeneratingScenario}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl flex items-center justify-center font-black text-sm uppercase italic tracking-tighter transition-all disabled:opacity-20 shadow-xl shadow-emerald-900/20 active:scale-95"
                >
                  {isGeneratingScenario ? 'Processing Report...' : 'Generate Report'}
                </button>
             </div>
          </div>
        </section>
      </main>

      <footer className="mt-4 flex flex-col sm:flex-row justify-between items-center border-t border-zinc-900/50 pt-10 gap-8">
        <div className="flex gap-16">
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest font-mono">Log Entries</span>
            <span className="text-3xl font-black italic text-zinc-400 tracking-tighter leading-none mt-1">{transcriptions.length}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest font-mono">Neural Nodes</span>
            <span className="text-3xl font-black italic text-zinc-400 tracking-tighter leading-none mt-1">G3F_01</span>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="px-5 py-2 border border-zinc-800 rounded-none text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">
            SECURED // TLS_1.3
          </div>
          <div className="px-5 py-2 bg-zinc-900 text-zinc-500 rounded-none text-[10px] font-black uppercase tracking-[0.2em] border border-zinc-800">
            CONNECTIVITY // 100%
          </div>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.03); border-radius: 0px; }
        .custom-scrollbar-light::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar-light::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.05); border-radius: 0px; }
      `}</style>
    </div>
  );
}
