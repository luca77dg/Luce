
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { 
  Heart, 
  Sparkles, 
  MessageCircle, 
  Calendar as CalendarIcon, 
  Smile, 
  Frown, 
  Meh, 
  Sun,
  Send,
  ArrowRight,
  Info,
  CheckCircle2,
  Circle,
  Coffee,
  Apple,
  Utensils,
  Moon,
  Trophy,
  Check,
  Star,
  X,
  Loader2,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  Mic,
  MicOff,
} from 'lucide-react';
import { DaySummary, UserState, ChatMessage, CheckInData, MealConfig } from './types';
import { getLuceResponse } from './geminiService';

// --- COSTANTI ---
const MEALS: MealConfig[] = [
  { id: 'colazione', label: 'Colazione', time: '07:00', icon: 'coffee' },
  { id: 'spuntino_mattina', label: 'Spuntino Mattutino', time: '11:00', icon: 'apple' },
  { id: 'pranzo', label: 'Pranzo', time: '13:00', icon: 'utensils' },
  { id: 'spuntino_pomeriggio', label: 'Spuntino Pomeridiano', time: '17:00', icon: 'apple' },
  { id: 'cena', label: 'Cena', time: '20:00', icon: 'moon' },
];

const SYSTEM_INSTRUCTION = `
Sei un assistente virtuale empatico e motivazionale di nome "Luce", specializzato nel supporto a persone che stanno seguendo un percorso di recupero o gestione di disturbi alimentari. 
Il tuo tono deve essere luminoso, incoraggiante, caloroso e mai giudicante.
Usa sempre il genere maschile per l'utente (es. "Benvenuto", "Sei stato bravo") come richiesto.
`;

// --- HELPER FUNCTIONS ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

const getLocalDateKey = (date: Date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getStartOfWeek = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const isDaySuccessful = (summary: DaySummary | undefined): boolean => {
  if (!summary) return false;
  if (summary.status === 'holiday' || summary.status === 'sick') return true;
  return summary.isCompleted;
};

const calculateDailyStreak = (history: Record<string, DaySummary>): number => {
  let streak = 0;
  const now = new Date();
  let checkDate = new Date(now);
  const todayKey = getLocalDateKey(now);
  if (!isDaySuccessful(history[todayKey])) checkDate.setDate(checkDate.getDate() - 1);
  while (streak < 3650) {
    const dk = getLocalDateKey(checkDate);
    const summary = history[dk];
    if (isDaySuccessful(summary)) { 
      streak++; 
      checkDate.setDate(checkDate.getDate() - 1); 
    } else {
      break;
    }
  }
  return streak;
};

const calculateWeeklyStreak = (history: Record<string, DaySummary>): number => {
  const today = new Date();
  const currentMon = getStartOfWeek(today);
  let streak = 0;
  let checkMon = new Date(currentMon);
  checkMon.setDate(checkMon.getDate() - 7);
  while (streak < 500) {
    let weekSuccess = true;
    let anyRegularDay = false;
    for (let i = 0; i < 7; i++) {
      const d = new Date(checkMon);
      d.setDate(d.getDate() + i);
      const dk = getLocalDateKey(d);
      const summary = history[dk];
      if (!isDaySuccessful(summary)) { weekSuccess = false; break; }
      if (summary && (summary.status === 'regular' || !summary.status)) anyRegularDay = true;
    }
    if (weekSuccess && anyRegularDay) { 
      streak++; 
      checkMon.setDate(checkMon.getDate() - 7); 
    } else {
      break;
    }
  }
  return streak;
};

const isBonusUsedInWeekInternal = (date: Date, currentHistory: Record<string, DaySummary>, currentDailyMeals: Record<string, 'regular' | 'bonus' | null>, excludeDateKey?: string) => {
  const startOfWeek = getStartOfWeek(date);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  const usedInHistory = Object.values(currentHistory).some(summary => {
    if (summary.date === excludeDateKey) return false;
    const d = new Date(summary.date);
    return d >= startOfWeek && d <= endOfWeek && summary.hasBonus;
  });
  return usedInHistory || Object.values(currentDailyMeals).some(v => v === 'bonus');
};

const getDynamicMotivation = (history: Record<string, DaySummary>, name: string) => {
  const dates = Object.keys(history).sort().reverse();
  const last7Dates = dates.slice(0, 7);
  const last7Days = last7Dates.map(d => history[d]);
  if (dates.length === 0) return { title: `Benvenuto, ${name} ✨`, subtitle: "Iniziamo questo viaggio insieme, con gentilezza." };
  const completedCount = last7Days.filter(d => isDaySuccessful(d)).length;
  if (last7Days[0]?.status === 'sick' || last7Days[0]?.status === 'holiday') return { title: `${name}, pensa al riposo 🍵`, subtitle: "Il tuo corpo ha bisogno di energia per guarire." };
  if (completedCount >= 6) return { title: `Stai splendendo, ${name}! 🌟`, subtitle: "La tua costanza è d'ispirazione. Continua così." };
  if (completedCount >= 4) return { title: `Ottimo ritmo, ${name} 🍃`, subtitle: "Stai costruendo basi solide per il tuo benessere." };
  return { title: `Un passo alla volta, ${name} 🌸`, subtitle: "Ogni pasto è un nuovo atto di gentilezza verso di te." };
};

// --- COMPONENTE PRINCIPALE ---
const App: React.FC = () => {
  const [view, setView] = useState<'dashboard' | 'checkin' | 'chat' | 'calendar'>('dashboard');
  const [aiStatus, setAiStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  
  const [user, setUser] = useState<UserState>(() => {
    const defaultState: UserState = {
      streak: 0, weeklyStreak: 0, bonusUsed: false, lastCheckIn: null, name: 'Luca', dailyMeals: {}, rewardClaimed: false, isDayClosed: false, history: {}
    };
    try {
      const saved = localStorage.getItem('luce_user_state');
      if (!saved) return defaultState;
      const parsed = JSON.parse(saved);
      const todayStr = new Date().toDateString();
      if (parsed.lastCheckIn !== todayStr) {
        return { ...parsed, dailyMeals: {}, rewardClaimed: false, isDayClosed: false, history: parsed.history || {}, streak: calculateDailyStreak(parsed.history || {}), weeklyStreak: calculateWeeklyStreak(parsed.history || {}) };
      }
      return parsed;
    } catch { return defaultState; }
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [mealToSelect, setMealToSelect] = useState<string | null>(null);

  // Live API Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const [isLiveActive, setIsLiveActive] = useState(false);

  useEffect(() => {
    const checkKey = () => {
      const key = process.env.API_KEY;
      // Semplificato il controllo della chiave: se esiste nell'environment, consideriamo online.
      if (key && key.trim() !== "") {
        setAiStatus('ok');
      } else {
        console.warn("API KEY non rilevata nell'environment.");
        setAiStatus('error');
      }
    };
    checkKey();
  }, []);

  useEffect(() => {
    try { localStorage.setItem('luce_user_state', JSON.stringify(user)); } catch {}
  }, [user]);

  const setMealStatus = (mealId: string, status: 'regular' | 'bonus' | null) => {
    const now = new Date();
    const dateKey = getLocalDateKey(now);
    const newDailyMeals = { ...user.dailyMeals, [mealId]: status };
    setUser(prev => {
      const mealsCount = Object.values(newDailyMeals).filter(Boolean).length;
      const hasBonusToday = Object.values(newDailyMeals).some(v => v === 'bonus');
      const bonusAlreadyUsedThisWeek = isBonusUsedInWeekInternal(now, prev.history, {}, dateKey);
      const isActuallyCompleted = mealsCount === MEALS.length && (!hasBonusToday || !bonusAlreadyUsedThisWeek);
      const todaySummary: DaySummary = { date: dateKey, isCompleted: isActuallyCompleted, mealsCount, hasBonus: hasBonusToday, mood: prev.history[dateKey]?.mood || 'felice', meals: newDailyMeals, status: prev.history[dateKey]?.status || 'regular' };
      const newHistory = { ...prev.history, [dateKey]: todaySummary };
      return { ...prev, dailyMeals: newDailyMeals, lastCheckIn: now.toDateString(), history: newHistory, bonusUsed: isBonusUsedInWeekInternal(now, newHistory, newDailyMeals), streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory) };
    });
    setMealToSelect(null);
  };

  const sendMessage = async (text: string, silent = false) => {
    if (!text.trim()) return;
    if (!silent) setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date() }]);
    setIsTyping(true);
    
    const responseText = await getLuceResponse(messages, text);
    
    if (responseText === "OPS_KEY_ERROR") {
      setAiStatus('error');
      setMessages(prev => [...prev, { role: 'assistant', content: "C'è un piccolo problema con la mia chiave magica (API Key). Assicurati di averla configurata correttamente su Vercel! ✨", timestamp: new Date() }]);
    } else {
      setMessages(prev => [...prev, { role: 'assistant', content: responseText, timestamp: new Date() }]);
    }
    setIsTyping(false);
  };

  const toggleLiveSession = async () => {
    if (isLiveActive) {
      sessionRef.current?.close();
      inputAudioContextRef.current?.close();
      outputAudioContextRef.current?.close();
      setIsLiveActive(false);
      return;
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;
      nextStartTimeRef.current = 0;
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(inputData) }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            setIsLiveActive(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: () => {
             setIsLiveActive(false);
             setAiStatus('error');
          }
        },
        config: { responseModalities: [Modality.AUDIO], systemInstruction: SYSTEM_INSTRUCTION }
      });
      sessionRef.current = await sessionPromise;
    } catch { setIsLiveActive(false); }
  };

  const finalizeDay = (data: CheckInData) => {
    const now = new Date();
    const dateKey = getLocalDateKey(now);
    setUser(prev => {
      const mealsCount = Object.values(prev.dailyMeals).filter(Boolean).length;
      const hasBonusToday = Object.values(prev.dailyMeals).some(v => v === 'bonus');
      const bonusAlreadyUsedThisWeek = isBonusUsedInWeekInternal(now, prev.history, {}, dateKey);
      const isCompleted = (data.status === 'holiday' || data.status === 'sick') ? true : (mealsCount === MEALS.length && (!hasBonusToday || !bonusAlreadyUsedThisWeek));
      const summary: DaySummary = { date: dateKey, isCompleted, mealsCount, hasBonus: hasBonusToday, mood: data.mood, meals: { ...prev.dailyMeals }, status: data.status || 'regular' };
      const newHistory = { ...prev.history, [dateKey]: summary };
      return { ...prev, history: newHistory, isDayClosed: true, lastCheckIn: now.toDateString(), streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory) };
    });
    setView('dashboard');
    setShowReward(true);
    sendMessage("Ho concluso la mia giornata. Grazie Luce! ✨", true);
  };

  return (
    <div className="min-h-screen max-w-md mx-auto flex flex-col shadow-2xl bg-[#fffafb] relative overflow-hidden">
      <header className="px-6 pt-8 pb-4 flex justify-between items-center z-10">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-rose-400 rounded-2xl flex items-center justify-center text-white shadow-lg"><Sun size={24} /></div>
          <h1 className="text-xl font-bold text-gray-800">Luce</h1>
        </div>
        {view !== 'dashboard' && <button onClick={() => setView('dashboard')} className="p-2 rounded-full hover:bg-gray-100 text-gray-400"><ArrowRight className="rotate-180" size={20} /></button>}
      </header>

      <main className="flex-1 px-6 pb-2 z-10 overflow-y-auto">
        {view === 'dashboard' && (
          <div className="space-y-6 animate-in fade-in duration-500 pb-12">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-gray-800 leading-tight">{getDynamicMotivation(user.history, user.name).title}</h2>
              <p className="text-gray-500 text-[13px] italic font-medium leading-relaxed">{getDynamicMotivation(user.history, user.name).subtitle}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-indigo-50 p-6 rounded-[2rem] flex flex-col items-center border border-indigo-100 shadow-sm"><Trophy className="text-indigo-500 mb-1" size={32} /><span className="text-4xl font-bold text-indigo-900">{user.weeklyStreak}</span><span className="text-[10px] uppercase tracking-widest text-indigo-500 font-extrabold">Settimane</span></div>
              <div className={`p-6 rounded-[2rem] flex flex-col items-center border shadow-sm ${user.bonusUsed ? 'bg-amber-50 border-amber-100' : 'bg-emerald-50 border-emerald-100'}`}><Heart className={`size-[32px] mb-1 ${user.bonusUsed ? 'text-amber-500 fill-amber-500' : 'text-emerald-500 fill-emerald-500'}`} /><span className={`text-xl font-bold ${user.bonusUsed ? 'text-amber-600' : 'text-emerald-600'}`}>{user.bonusUsed ? 'Utilizzato' : 'Libero'}</span><span className={`text-[10px] uppercase tracking-widest font-extrabold ${user.bonusUsed ? 'text-amber-500' : 'text-emerald-500'}`}>Bonus</span></div>
            </div>
            <div className="bg-gray-50/50 p-6 rounded-[2.5rem] space-y-3">
              <h3 className="font-bold text-gray-700 mb-1 flex items-center gap-2"><Sun className="text-amber-400" size={20} /> Pasti di Oggi</h3>
              {MEALS.map(meal => (
                <button key={meal.id} onClick={() => !user.isDayClosed && setMealToSelect(meal.id)} disabled={user.isDayClosed} className="w-full flex items-center justify-between p-4 rounded-3xl bg-white shadow-sm active:scale-95 transition-all">
                  <div className="flex items-center gap-4 text-left">
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center bg-gray-50/50">
                      {meal.icon === 'coffee' && <Coffee size={24} className="text-gray-400" />}
                      {meal.icon === 'apple' && <Apple size={24} className="text-gray-400" />}
                      {meal.icon === 'utensils' && <Utensils size={24} className="text-gray-400" />}
                      {meal.icon === 'moon' && <Moon size={24} className="text-gray-400" />}
                    </div>
                    <div><p className="text-sm font-bold text-gray-700">{meal.label}</p><p className="text-[10px] text-gray-400 font-medium">{meal.time}</p></div>
                  </div>
                  {user.dailyMeals[meal.id] ? (<div className={`rounded-full p-1.5 ${user.dailyMeals[meal.id] === 'bonus' ? 'bg-amber-500' : 'bg-emerald-500'}`}>{user.dailyMeals[meal.id] === 'bonus' ? <Star size={18} className="text-white fill-current" /> : <Check size={18} className="text-white" />}</div>) : <div className="w-7 h-7 rounded-full border-2 border-gray-100" />}
                </button>
              ))}
            </div>
            {!user.isDayClosed ? <button onClick={() => setView('checkin')} className="w-full bg-[#1e293b] text-white py-5 rounded-[2rem] font-bold shadow-2xl flex items-center justify-center gap-2 text-lg active:scale-95">Chiudi la Giornata <Sparkles size={22} /></button> : <div className="bg-amber-100 p-6 rounded-[2.5rem] border border-amber-200 text-amber-800 text-center font-bold">Giornata conclusa! Ottimo lavoro ✨</div>}
            
            <div className="flex justify-center mb-4"><div className={`px-4 py-1.5 rounded-full border flex items-center gap-2 ${aiStatus === 'ok' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-rose-50 text-rose-600 border-rose-100'}`}><div className={`w-1.5 h-1.5 rounded-full ${aiStatus === 'ok' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} /><span className="text-[9px] font-bold uppercase tracking-widest">{aiStatus === 'ok' ? 'Luce Online' : 'Luce Offline'}</span></div></div>
          </div>
        )}
        {view === 'checkin' && <CheckInForm onSubmit={finalizeDay} onCancel={() => setView('dashboard')} />}
        {view === 'chat' && <ChatView messages={messages} onSendMessage={sendMessage} isTyping={isTyping} isLiveActive={isLiveActive} onToggleLive={toggleLiveSession} />}
        {view === 'calendar' && <CalendarView user={user} />}
      </main>

      {mealToSelect && <MealSelector mealToSelect={mealToSelect} isWeeklyBonusUsed={user.bonusUsed} onSelect={setMealStatus} onCancel={() => setMealToSelect(null)} userMeals={user.dailyMeals} />}
      {showReward && <RewardModal onClaim={() => setShowReward(false)} />}

      <nav className="p-4 flex justify-around items-center border-t border-gray-100 bg-white z-20">
        <button onClick={() => setView('calendar')} className={`flex flex-col items-center gap-1 ${view === 'calendar' ? 'text-gray-800' : 'text-gray-300'}`}><CalendarIcon size={28} /></button>
        <div className="relative -top-6"><button onClick={() => setView('dashboard')} className={`w-16 h-16 rounded-full flex items-center justify-center text-white shadow-xl border-4 border-white transition-all ${view === 'dashboard' ? 'bg-rose-400 scale-110' : 'bg-gray-300'}`}><Sun size={32} /></button></div>
        <button onClick={() => setView('chat')} className={`flex flex-col items-center gap-1 ${view === 'chat' ? 'text-gray-800' : 'text-gray-300'}`}><MessageCircle size={28} /></button>
      </nav>
    </div>
  );
};

const CheckInForm: React.FC<{ onSubmit: (data: any) => void; onCancel: () => void }> = ({ onSubmit, onCancel }) => {
  const [mood, setMood] = useState('felice');
  const [emotions, setEmotions] = useState('');
  const [status, setStatus] = useState<'regular' | 'holiday' | 'sick'>('regular');
  return (
    <div className="space-y-6 pb-12 animate-in slide-in-from-bottom duration-500">
      <h2 className="text-2xl font-bold text-gray-800">Com'è andata oggi?</h2>
      <div className="grid grid-cols-3 gap-3">
        {['regular', 'holiday', 'sick'].map(s => <button key={s} onClick={() => setStatus(s as any)} className={`p-4 rounded-3xl border-2 transition-all ${status === s ? 'border-rose-400 bg-rose-50 text-rose-600' : 'bg-white border-gray-100 text-gray-300'}`}><span className="text-[10px] font-bold uppercase">{s}</span></button>)}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[{id:'felice', icon:Smile}, {id:'così così', icon:Meh}, {id:'difficile', icon:Frown}].map(m => <button key={m.id} onClick={() => setMood(m.id)} className={`p-4 rounded-3xl border-2 transition-all ${mood === m.id ? 'border-rose-400 bg-rose-50' : 'bg-white border-gray-100'}`}><m.icon size={28} className="mx-auto" /></button>)}
      </div>
      <textarea value={emotions} onChange={e => setEmotions(e.target.value)} placeholder="Come ti senti veramente?" className="w-full p-4 rounded-3xl border-2 border-gray-100 focus:border-rose-200 focus:ring-0 min-h-[120px] text-sm" />
      <div className="flex gap-4"><button onClick={onCancel} className="flex-1 py-4 font-bold text-gray-400">Annulla</button><button onClick={() => onSubmit({mood, emotions, status})} className="flex-[2] bg-rose-400 text-white py-4 rounded-3xl font-bold shadow-lg">Salva</button></div>
    </div>
  );
};

const ChatView: React.FC<any> = ({ messages, onSendMessage, isTyping, isLiveActive, onToggleLive }) => {
  const [input, setInput] = useState('');
  return (
    <div className="flex flex-col h-[65vh] space-y-4">
      <div className="flex-1 overflow-y-auto space-y-4 pr-2">
        {messages.map((m:any, i:number) => <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[80%] p-4 rounded-3xl text-sm ${m.role === 'user' ? 'bg-rose-400 text-white' : 'bg-white border border-rose-50'}`}>{m.content}</div></div>)}
        {isTyping && <div className="flex justify-start"><div className="bg-white p-4 rounded-3xl border border-rose-50 animate-pulse">...</div></div>}
      </div>
      <div className="flex items-center gap-2 bg-white p-2 rounded-full border border-gray-100 shadow-sm mt-auto">
        <button onClick={onToggleLive} className={`p-3 rounded-full ${isLiveActive ? 'bg-rose-500 text-white animate-pulse' : 'bg-rose-50 text-rose-400'}`}>{isLiveActive ? <MicOff size={20} /> : <Mic size={20} />}</button>
        <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && (onSendMessage(input), setInput(''))} placeholder="Parla con Luce..." className="flex-1 bg-transparent border-none text-sm px-2" />
        <button onClick={() => (onSendMessage(input), setInput(''))} className="p-3 bg-rose-400 text-white rounded-full shadow-md"><Send size={20} /></button>
      </div>
    </div>
  );
};

// --- CALENDAR VIEW (MONTH GRID) ---
const CalendarView: React.FC<{ user: UserState }> = ({ user }) => {
  const [currentDate, setCurrentDate] = useState(new Date());

  const daysInMonth = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    
    const days = [];
    const startDay = firstDay.getDay(); 
    const padding = startDay === 0 ? 6 : startDay - 1; 
    
    for (let i = 0; i < padding; i++) days.push(null);
    for (let i = 1; i <= lastDay.getDate(); i++) days.push(new Date(year, month, i));
    
    return days;
  }, [currentDate]);

  const changeMonth = (offset: number) => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1));
  };

  const weekdays = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

  return (
    <div className="space-y-6 pb-12 animate-in fade-in">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <TrendingUp size={24} className="text-rose-400" /> Il Tuo Viaggio
        </h2>
        <div className="flex items-center gap-2 bg-white p-1 rounded-full border border-gray-100 shadow-sm">
          <button onClick={() => changeMonth(-1)} className="p-2 hover:bg-rose-50 rounded-full text-rose-400 transition-colors">
            <ChevronLeft size={20} />
          </button>
          <span className="text-xs font-bold text-gray-600 px-2 min-w-[100px] text-center capitalize">
            {currentDate.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}
          </span>
          <button onClick={() => changeMonth(1)} className="p-2 hover:bg-rose-50 rounded-full text-rose-400 transition-colors">
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-gray-50">
        <div className="grid grid-cols-7 mb-4">
          {weekdays.map(day => (
            <div key={day} className="text-center text-[10px] font-extrabold text-gray-300 uppercase tracking-widest pb-2">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-4">
          {daysInMonth.map((date, idx) => {
            if (!date) return <div key={`empty-${idx}`} />;
            
            const dk = getLocalDateKey(date);
            const summary = user.history[dk];
            const isSuccess = isDaySuccessful(summary);
            const isToday = dk === getLocalDateKey(new Date());

            return (
              <div key={dk} className="flex flex-col items-center relative">
                <div className={`
                  w-10 h-10 rounded-2xl flex items-center justify-center font-bold text-sm transition-all relative
                  ${isSuccess ? 'bg-emerald-50 text-emerald-600' : summary ? 'bg-rose-50 text-rose-500' : 'bg-gray-50 text-gray-400'}
                  ${isToday ? 'ring-2 ring-rose-300 ring-offset-2' : ''}
                `}>
                  {date.getDate()}
                  {summary && (
                    <div className="absolute -bottom-1 flex gap-0.5">
                      {isSuccess ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      ) : (
                        <div className="w-1.5 h-1.5 rounded-full bg-rose-300" />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-emerald-50 p-4 rounded-3xl border border-emerald-100 flex flex-col items-center">
          <CheckCircle2 size={20} className="text-emerald-500 mb-1" />
          <span className="text-[10px] uppercase font-extrabold text-emerald-600">Completati</span>
          <span className="text-xl font-bold text-emerald-900">{Object.values(user.history).filter(isDaySuccessful).length}</span>
        </div>
        <div className="bg-rose-50 p-4 rounded-3xl border border-rose-100 flex flex-col items-center">
          <TrendingUp size={20} className="text-rose-500 mb-1" />
          <span className="text-[10px] uppercase font-extrabold text-rose-600">Streak Max</span>
          <span className="text-xl font-bold text-rose-900">{user.streak}</span>
        </div>
        <div className="bg-indigo-50 p-4 rounded-3xl border border-indigo-100 flex flex-col items-center">
          <Sparkles size={20} className="text-indigo-500 mb-1" />
          <span className="text-[10px] uppercase font-extrabold text-indigo-600">Bonus Sett.</span>
          <span className="text-xl font-bold text-indigo-900">{user.bonusUsed ? 'Usato' : 'Pronto'}</span>
        </div>
      </div>
    </div>
  );
};

const MealSelector: React.FC<any> = ({ mealToSelect, isWeeklyBonusUsed, onSelect, onCancel, userMeals }) => (
  <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-50 flex items-end justify-center p-4">
    <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 space-y-6 shadow-2xl animate-in slide-in-from-bottom">
      <h3 className="text-xl font-bold text-gray-800 text-center">Registra Pasto</h3>
      <div className="grid gap-3">
        <button onClick={() => onSelect(mealToSelect, 'regular')} className="w-full p-5 rounded-3xl bg-emerald-50 border-2 border-emerald-100 text-emerald-700 font-bold flex justify-between">Regolare <Check /></button>
        <button onClick={() => onSelect(mealToSelect, 'bonus')} disabled={isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus'} className={`w-full p-5 rounded-3xl border-2 font-bold flex justify-between ${isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus' ? 'bg-gray-50 border-gray-100 text-gray-300' : 'bg-amber-50 border-amber-100 text-amber-700'}`}>Bonus <Star /></button>
      </div>
      <button onClick={onCancel} className="w-full text-gray-400 font-bold py-2">Chiudi</button>
    </div>
  </div>
);

const RewardModal: React.FC<{ onClaim: () => void }> = ({ onClaim }) => (
  <div className="fixed inset-0 bg-rose-400/90 backdrop-blur-md z-[100] flex items-center justify-center p-8">
    <div className="bg-white rounded-[3rem] p-10 text-center space-y-6 shadow-2xl animate-in zoom-in duration-500">
      <Trophy size={64} className="mx-auto text-amber-400" />
      <h2 className="text-2xl font-bold text-gray-800">Che Splendore! ✨</h2>
      <p className="text-gray-500 text-sm">Hai completato la giornata. Sei stato bravissimo!</p>
      <button onClick={onClaim} className="w-full py-5 bg-rose-400 text-white rounded-3xl font-bold shadow-lg">Ricevi un Abbraccio 💖</button>
    </div>
  </div>
);

export default App;
