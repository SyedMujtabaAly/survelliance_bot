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
          3. IDENTIFY AND LOG all payment details: the exact time of payment, payment method used (cash, card, Apple Pay, etc.), and amount.
          4. IDENTIFY AND LOG specific sales pitches: "phone on AAL" (add a line), "new line", "port in", "tablet pitch", or "accessory pitch".
          5. FORMAT: Provide the conversation transcript. If a payment or pitch is detected, append a clear [LOG] with the details.
          Example: [TRANSCRIPT]: "Would you like to add a tablet today?" [LOG]: Pitch Detected: Tablet.`,
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
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col h-screen overflow-hidden selection:bg-blue-500/30">
      <header className="flex justify-between items-center px-6 py-4 bg-white border-b border-slate-200 shrink-0 shadow-sm">
        <div className="flex items-center gap-4">
          <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-800">AIMS Services Survelliance Bot</h1>
        </div>
        
        <div className="flex items-center gap-6 text-sm">
          {errorMessage && (
            <div className="bg-red-50 text-red-600 px-3 py-1.5 rounded-full text-xs font-medium border border-red-200 flex items-center shadow-sm">
              <Zap className="w-3 h-3 mr-1.5" />
              {errorMessage}
            </div>
          )}
          <div className="flex bg-slate-100 p-1 rounded-lg">
            {(["camera", "screen"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setSourceType(type)}
                disabled={isRecording}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  sourceType === type 
                    ? "bg-white text-blue-600 shadow-sm" 
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                } disabled:opacity-50`}
              >
                {type === "camera" ? "Camera" : "Screen Share"}
              </button>
            ))}
          </div>
          
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg font-medium transition-all text-sm shadow-sm ${
              isRecording 
                ? 'bg-red-50 hover:bg-red-100 text-red-600 border border-red-200' 
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isRecording ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden p-6 flex gap-6">
        {/* Left Column: Live Transcription & Video */}
        <section className="w-1/3 flex flex-col gap-6 shrink-0 min-w-[320px]">
          <div className="bg-slate-900 rounded-xl overflow-hidden aspect-video relative shadow-sm border border-slate-200">
             <video 
               ref={videoRef} 
               autoPlay 
               playsInline 
               muted 
               className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 ${isRecording ? 'opacity-100' : 'opacity-0'}`}
             />
             <canvas ref={canvasRef} className="hidden" width={640} height={480} />
             
             {!isRecording ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-50">
                  <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-400">
                    <Mic className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-medium text-slate-600">Camera / Screen inactive</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-[200px]">Click 'Start Recording' to begin capturing sales data.</p>
                </div>
             ) : (
                <div className="absolute top-3 right-3 z-20 flex gap-2">
                  <div className="bg-black/50 backdrop-blur-md text-white px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 border border-white/10">
                    <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                    Live
                  </div>
                </div>
             )}
          </div>

          <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden">
             <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2 bg-slate-50/50 block">
                <Languages className="w-4 h-4 text-blue-500" />
                <h3 className="text-sm font-semibold text-slate-800">Live Transcript</h3>
             </div>
             
             <div id="log-container" className="flex-1 overflow-y-auto p-5 scroll-smooth custom-scrollbar-light">
               <AnimatePresence mode="popLayout">
                 {(currentTranslation || currentTranscription) && (
                   <motion.div 
                     key="live"
                     initial={{ opacity: 0, scale: 0.98 }}
                     animate={{ opacity: 1, scale: 1 }}
                     className="mb-6 bg-blue-50/50 p-4 rounded-lg border border-blue-100"
                   >
                     <div className="flex items-center gap-2 mb-2">
                       <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                       <span className="text-xs font-semibold uppercase tracking-wider text-blue-600">Capturing...</span>
                     </div>
                     <div className="text-sm text-slate-500 mb-1">
                        {currentTranscription}
                     </div>
                     <div className="text-sm font-medium text-slate-800">
                        {currentTranslation}
                        <motion.span animate={{ opacity: [0, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-1.5 h-3.5 bg-blue-500 ml-1.5 align-middle rounded-full" />
                     </div>
                   </motion.div>
                 )}
               </AnimatePresence>

               <div className="space-y-4">
                  {transcriptions.length === 0 && !currentTranslation && !currentTranscription && (
                    <div className="flex flex-col items-center justify-center h-40 text-slate-400">
                      <History className="w-8 h-8 mb-3 opacity-20" />
                      <p className="text-sm">No activity recorded yet</p>
                    </div>
                  )}
                  {transcriptions.slice().reverse().map((t, idx) => (
                    <div key={t.id} className="relative pl-4 border-l-2 border-slate-100 pb-1">
                      <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-slate-200 border-2 border-white"></div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-slate-400">{new Date(t.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}</span>
                      </div>
                      <p className="text-sm text-slate-700 leading-relaxed">
                        {t.translation || t.text}
                      </p>
                    </div>
                  ))}
               </div>
             </div>
          </div>
        </section>

        {/* Right Column: Scenario Synthesis */}
        <section className="flex-1 flex flex-col gap-6">
          <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col overflow-hidden relative">
             <div className="absolute top-0 right-0 p-8 opacity-[0.02] pointer-events-none">
                <FileText className="w-64 h-64 -mr-16 -mt-16 text-blue-900" />
             </div>

             <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/30">
               <div>
                 <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                   <Shield className="w-5 h-5 text-indigo-500" />
                   Sales & Payment Audit Report
                 </h2>
                 <p className="text-sm text-slate-500 mt-1">AI-generated summary of the current session</p>
               </div>
               
               <button 
                 onClick={generateScenario}
                 disabled={transcriptions.length === 0 || isGeneratingScenario}
                 className="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 px-4 py-2 rounded-lg flex items-center font-semibold text-sm transition-all disabled:opacity-50 border border-indigo-100"
               >
                 {isGeneratingScenario ? (
                   <span className="flex items-center gap-2">
                     <div className="w-3 h-3 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin"></div>
                     Analyzing...
                   </span>
                 ) : 'Refresh Report'}
               </button>
             </div>

             <div className="flex-1 p-8 overflow-y-auto custom-scrollbar-light relative z-10">
               {scenario ? (
                 <div className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap font-medium pb-8">
                   {scenario}
                 </div>
               ) : (
                 <div className="h-full flex flex-col flex-1 items-center justify-center text-slate-400">
                    <FileText className="w-12 h-12 mb-4 opacity-20" />
                    <p className="text-sm">Awaiting sufficient conversational data.</p>
                 </div>
               )}
             </div>
          </div>

          {/* Action Bars */}
          <div className="grid grid-cols-3 gap-6 shrink-0">
             <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center">
               <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Total Logs</p>
               <p className="text-3xl font-bold text-slate-800">
                 {transcriptions.length}
               </p>
             </div>
             <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center">
               <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Current Status</p>
               <p className="text-3xl font-bold text-slate-800 flex items-center gap-2">
                 {isRecording ? <span className="text-emerald-500">Active</span> : <span className="text-slate-400">Standby</span>}
               </p>
             </div>
             <div className="bg-gradient-to-br from-indigo-500 to-blue-600 p-5 rounded-xl shadow-sm flex flex-col justify-center text-white">
               <p className="text-xs font-semibold text-indigo-100 uppercase tracking-wide mb-1">System Integrity</p>
               <p className="text-3xl font-bold">Secure</p>
             </div>
          </div>
        </section>
      </main>

      <style>{`
        .custom-scrollbar-light::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar-light::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar-light::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        .custom-scrollbar-light::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}</style>
    </div>
  );
}
