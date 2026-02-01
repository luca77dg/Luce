
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { UserState, ChatMessage, CheckInData, MealConfig, DaySummary } from './types';
import { getLuceResponse } from './geminiService';
import { 
  Heart, 
  Sparkles, 
  MessageCircle, 
  Calendar, 
  Award, 
  Smile, 
  Frown, 
  Meh, 
  Sun,
  Send,
  ArrowRight,
  Info,
  CheckCircle2,
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
  Circle,
  TrendingUp,
  CloudRain,
  Flame,
  Palmtree,
  Thermometer,
  Edit3,
  Mic,
  MicOff,
  Bell,
  BellOff,
  Clock
} from 'lucide-react';

const MEALS: MealConfig[] = [
  { id: 'colazione', label: 'Colazione', time: '07:00', icon: 'coffee' },
  { id: 'spuntino_mattina', label: 'Spuntino Mattutino', time: '11:00', icon: 'apple' },
  { id: 'pranzo', label: 'Pranzo', time: '13:00', icon: 'utensils' },
  { id: 'spuntino_pomeriggio', label: 'Spuntino Pomeridiano', time: '17:00', icon: 'apple' },
  { id: 'cena', label: 'Cena', time: '20:00', icon: 'moon' },
];

const SYSTEM_INSTRUCTION = `
Sei un assistente virtuale empatico e motivazionale di nome "Luce", specializzato nel supporto a persone che stanno seguendo un percorso di recupero o gestione di disturbi alimentari. Il tuo tono deve essere luminoso, incoraggiante, caloroso e mai giudicante.

REGOLE DI COMPORTAMENTO:
1. GENTILEZZA PRIMA DI TUTTO: Se l'utente riporta di non aver seguito la dieta, non usare mai parole come "fallimento", "errore" o "sbaglio". Usa termini come "momento di flessibilità", "piccolo intoppo" o "sfida".
2. MOTIVAZIONE VISIVA: Usa spesso emoji colorate (🌟, ✨, 🌈, 💖, 🌸, 🦋) per rendere il testo visivamente vivo.
3. GESTIONE DELLO "SGARRO": Se l'utente usa il suo bonus settimanale, fagli capire che è normale.
4. FOCUS SULLE EMOZIONI: Valida le emozioni dell'utente.
5. NO CONSIGLI MEDICI: Suggerisci di parlarne con professionisti se necessario.
6. STILE DI RISPOSTA: Mantieni le risposte brevi e piene di energia positiva.
`;

// Audio helpers
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

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
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
  return date.toLocaleDateString('en-CA');
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
  while (true) {
    const dk = getLocalDateKey(checkDate);
    const summary = history[dk];
    if (isDaySuccessful(summary)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
    else break;
    if (streak > 3650) break;
  }
  return streak;
};

const calculateWeeklyStreak = (history: Record<string, DaySummary>): number => {
  const today = new Date();
  const currentMon = getStartOfWeek(today);
  let streak = 0;
  let checkMon = new Date(currentMon);
  checkMon.setDate(checkMon.getDate() - 7);
  while (true) {
    let weekSuccess = true;
    let anyRegularDay = false;
    let anyHistoryInWeek = false;
    for (let i = 0; i < 7; i++) {
      const d = new Date(checkMon);
      d.setDate(d.getDate() + i);
      const dk = getLocalDateKey(d);
      const summary = history[dk];
      if (!isDaySuccessful(summary)) { weekSuccess = false; break; }
      if (summary) { anyHistoryInWeek = true; if (summary.status === 'regular' || !summary.status) anyRegularDay = true; }
    }
    if (weekSuccess && anyRegularDay) { streak++; checkMon.setDate(checkMon.getDate() - 7); }
    else break;
    if (streak > 500) break;
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
  if (dates.length === 0) return { title: `Benvenutə, ${name} ✨`, subtitle: "Iniziamo questo viaggio insieme, con gentilezza." };
  const completedCount = last7Days.filter(d => isDaySuccessful(d)).length;
  if (last7Days[0]?.status === 'sick' || last7Days[0]?.status === 'holiday') return { title: `${name}, pensa al riposo 🍵`, subtitle: "Il tuo corpo ha bisogno di energia per guarire." };
  if (completedCount >= 6) return { title: `Stai splendendo, ${name}! 🌟`, subtitle: "La tua costanza è d'ispirazione. Continua così." };
  if (completedCount >= 4) return { title: `Ottimo ritmo, ${name} 🍃`, subtitle: "Stai costruendo basi solide per il tuo benessere." };
  return { title: `Un passo alla volta, ${name} 🌸`, subtitle: "Ogni pasto è un nuovo atto di gentilezza verso di te." };
};

const App: React.FC = () => {
  const [view, setView] = useState<'dashboard' | 'checkin' | 'chat' | 'calendar'>('dashboard');
  const [isSaving, setIsSaving] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    return localStorage.getItem('luce_notifications_enabled') === 'true';
  });
  const [overdueMeal, setOverdueMeal] = useState<MealConfig | null>(null);
  
  const [user, setUser] = useState<UserState>(() => {
    const saved = localStorage.getItem('luce_user_state');
    const defaultState: UserState = {
      streak: 0, weeklyStreak: 0, bonusUsed: false, lastCheckIn: null, name: 'Luca', dailyMeals: {}, rewardClaimed: false, isDayClosed: false, history: {}
    };
    if (!saved) return defaultState;
    const parsed = JSON.parse(saved);
    const todayStr = new Date().toDateString();
    if (parsed.lastCheckIn !== todayStr) {
      return { ...parsed, dailyMeals: {}, rewardClaimed: false, isDayClosed: false, history: parsed.history || {}, streak: calculateDailyStreak(parsed.history || {}), weeklyStreak: calculateWeeklyStreak(parsed.history || {}) };
    }
    return parsed;
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [mealToSelect, setMealToSelect] = useState<string | null>(null);

  // Live API States
  const [isLiveActive, setIsLiveActive] = useState(false);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Notification / Reminder Logic
  const lastNotifiedMealId = useRef<string | null>(null);

  useEffect(() => {
    localStorage.setItem('luce_user_state', JSON.stringify(user));
  }, [user]);

  useEffect(() => {
    localStorage.setItem('luce_notifications_enabled', String(notificationsEnabled));
  }, [notificationsEnabled]);

  useEffect(() => {
    const checkOverdueMeals = () => {
      if (user.isDayClosed) {
        setOverdueMeal(null);
        return;
      }
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      let foundOverdue = null;
      for (const meal of MEALS) {
        const [h, m] = meal.time.split(':').map(Number);
        const mealMinutes = h * 60 + m;
        if (currentMinutes > mealMinutes + 60 && !user.dailyMeals[meal.id]) {
          foundOverdue = meal;
          if (notificationsEnabled && Notification.permission === 'granted' && lastNotifiedMealId.current !== meal.id) {
            new Notification("Luce ✨", {
              body: `Ehi, è passata un'ora dalla ${meal.label}. Ti va di dirmi come è andata? Ti aspetto! 🌸`,
            });
            lastNotifiedMealId.current = meal.id;
          }
          break;
        }
      }
      setOverdueMeal(foundOverdue);
    };
    const interval = setInterval(checkOverdueMeals, 60000);
    checkOverdueMeals();
    return () => clearInterval(interval);
  }, [user.dailyMeals, user.isDayClosed, notificationsEnabled]);

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) return;
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setNotificationsEnabled(true);
      sendMessage("Grazie per aver attivato i promemoria! ✨", true);
    } else {
      setNotificationsEnabled(false);
    }
  };

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
    try {
      const responseText = await getLuceResponse(messages, text);
      setMessages(prev => [...prev, { role: 'assistant', content: responseText, timestamp: new Date() }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: "Oggi ho un po' di nebbia... ma sono qui! 💖", timestamp: new Date() }]);
    } finally {
      setIsTyping(false);
    }
  };

  const toggleLiveSession = async () => {
    if (isLiveActive) {
      if (sessionRef.current) sessionRef.current.close();
      if (inputAudioContextRef.current) inputAudioContextRef.current.close();
      if (outputAudioContextRef.current) outputAudioContextRef.current.close();
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
      let currentInputTranscription = '';
      let currentOutputTranscription = '';
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            setIsLiveActive(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const audioCtx = outputCtx;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }
            if (message.serverContent?.inputTranscription) currentInputTranscription += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentOutputTranscription += message.serverContent.outputTranscription.text;
            if (message.serverContent?.turnComplete) {
              if (currentInputTranscription) setMessages(prev => [...prev, { role: 'user', content: currentInputTranscription, timestamp: new Date() }]);
              if (currentOutputTranscription) setMessages(prev => [...prev, { role: 'assistant', content: currentOutputTranscription, timestamp: new Date() }]);
              currentInputTranscription = '';
              currentOutputTranscription = '';
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: (e) => { console.error(e); setIsLiveActive(false); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (error) {
      console.error("Live API Error:", error);
      setIsLiveActive(false);
    }
  };

  const handleUpdateDay = (dk: string, s: DaySummary) => {
    setUser(prev => {
      const d = new Date(dk);
      const bonusUsedInOtherDays = isBonusUsedInWeekInternal(d, prev.history, {}, dk);
      
      const isCompleted = s.status !== 'regular' 
        ? true 
        : (s.mealsCount === 5 && (!s.hasBonus || !bonusUsedInOtherDays));
        
      const updatedSummary = { ...s, isCompleted };
      const newHistory = { ...prev.history, [dk]: updatedSummary };
      
      let newDailyMeals = prev.dailyMeals;
      if (dk === getLocalDateKey()) {
        newDailyMeals = s.meals || {};
      }

      return {
        ...prev,
        history: newHistory,
        dailyMeals: newDailyMeals,
        streak: calculateDailyStreak(newHistory),
        weeklyStreak: calculateWeeklyStreak(newHistory)
      };
    });
  };

  return (
    <div className="min-h-screen max-w-md mx-auto flex flex-col shadow-2xl bg-[#fffafb] relative overflow-hidden">
      <header className="px-6 pt-8 pb-4 flex justify-between items-center z-10 bg-transparent">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-rose-400 rounded-2xl flex items-center justify-center text-white shadow-lg">
            <Sun size={24} />
          </div>
          <h1 className="text-xl font-bold text-gray-800">Luce</h1>
        </div>
        {view !== 'dashboard' && (
          <button onClick={() => setView('dashboard')} className="p-2 rounded-full hover:bg-gray-100 text-gray-400"><ArrowRight className="rotate-180" size={20} /></button>
        )}
      </header>

      <main className="flex-1 px-6 pb-2 z-10 overflow-y-auto">
        {view === 'dashboard' && (
          <Dashboard 
            user={user} 
            onOpenMealSelector={(id) => setMealToSelect(id)} 
            onCloseDay={() => setView('checkin')} 
            onReopenDay={() => setUser(prev => ({ ...prev, isDayClosed: false }))} 
            isWeeklyBonusUsed={isBonusUsedInWeekInternal(new Date(), user.history, user.dailyMeals)}
            notificationsEnabled={notificationsEnabled}
            onRequestNotifications={requestNotificationPermission}
            onDisableNotifications={() => setNotificationsEnabled(false)}
            overdueMeal={overdueMeal}
          />
        )}
        {view === 'checkin' && <CheckInForm onSubmit={(data) => { finalizeDay(data, setUser, setView, setShowReward, sendMessage, user); }} onCancel={() => setView('dashboard')} isSaving={isSaving} initialData={user.isDayClosed ? user.history[getLocalDateKey()] : undefined} />}
        {view === 'chat' && <ChatView messages={messages} onSendMessage={sendMessage} isTyping={isTyping} isLiveActive={isLiveActive} onToggleLive={toggleLiveSession} />}
        {view === 'calendar' && <CalendarView user={user} onUpdateDay={handleUpdateDay} />}
      </main>

      {mealToSelect && <MealSelector mealToSelect={mealToSelect} isWeeklyBonusUsed={isBonusUsedInWeekInternal(new Date(), user.history, user.dailyMeals)} onSelect={setMealStatus} onCancel={() => setMealToSelect(null)} userMeals={user.dailyMeals} />}
      {showReward && <RewardModal onClaim={() => { setUser(prev => ({ ...prev, rewardClaimed: true })); setShowReward(false); sendMessage("Grazie per il premio! 💖", true); }} />}

      <nav className="p-4 flex justify-around items-center border-t border-gray-100 bg-white z-20">
        <button onClick={() => setView('calendar')} className={`flex flex-col items-center gap-1 ${view === 'calendar' ? 'text-gray-800' : 'text-gray-300'}`}><Calendar size={28} /></button>
        <div className="relative -top-6">
          <button onClick={() => setView('dashboard')} className={`w-16 h-16 rounded-full flex items-center justify-center text-white shadow-xl border-4 border-white ${view === 'dashboard' ? 'bg-rose-400' : 'bg-gray-300'}`}><Sun size={32} /></button>
        </div>
        <button onClick={() => setView('chat')} className={`flex flex-col items-center gap-1 ${view === 'chat' ? 'text-gray-800' : 'text-gray-300'}`}><MessageCircle size={28} /></button>
      </nav>
    </div>
  );
};

const Dashboard: React.FC<any> = ({ 
  user, onOpenMealSelector, onCloseDay, onReopenDay, isWeeklyBonusUsed,
  notificationsEnabled, onRequestNotifications, onDisableNotifications, overdueMeal
}) => {
  const completedCount = MEALS.filter(m => user.dailyMeals[m.id]).length;
  const todayFormatted = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  const motivation = useMemo(() => getDynamicMotivation(user.history, user.name), [user.history, user.name]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-6">
      {overdueMeal && (
        <div className="bg-amber-100 border-2 border-amber-200 p-4 rounded-[2rem] flex items-center gap-4 animate-bounce-gentle shadow-lg">
          <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-amber-500 shadow-sm shrink-0"><Clock size={24} /></div>
          <div><p className="text-sm font-bold text-amber-900 leading-tight">Momento di cura?</p><p className="text-[11px] text-amber-800/70">È passata un'ora dalla {overdueMeal.label}. Come va? ✨</p></div>
        </div>
      )}
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-gray-800 leading-tight">{motivation.title}</h2>
        <p className="text-gray-500 text-[13px] italic font-medium leading-relaxed max-w-[90%]">{motivation.subtitle}</p>
        <button onClick={notificationsEnabled ? onDisableNotifications : onRequestNotifications} className={`flex items-center gap-2 px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all mt-2 ${notificationsEnabled ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' : 'bg-rose-50 text-rose-500 border border-rose-100'}`}>{notificationsEnabled ? <><Bell size={12} /> Promemoria Attivi</> : <><BellOff size={12} /> Attiva Promemoria</>}</button>
        <div className="mt-4 border-b-2 border-rose-100 pb-2 w-full"><p className="text-[12px] text-gray-900 font-extrabold uppercase tracking-wide">OGGI È {todayFormatted}</p></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-indigo-50 p-6 rounded-[2rem] flex flex-col items-center text-center justify-center min-h-[160px] border border-indigo-100 relative"><Trophy className="text-indigo-500 mb-1" size={32} /><span className="text-4xl font-bold text-indigo-900">{user.weeklyStreak}</span><span className="text-[10px] uppercase tracking-widest text-indigo-500 font-extrabold">Settimane</span></div>
        <div className={`p-6 rounded-[2rem] flex flex-col items-center text-center justify-center min-h-[160px] border ${isWeeklyBonusUsed ? 'bg-amber-50 border-amber-100' : 'bg-[#ECFDF5] border-emerald-100'}`}><Heart className={`size-[32px] mb-1 ${isWeeklyBonusUsed ? 'text-amber-500 fill-amber-500' : 'text-[#10B981] fill-[#10B981]'}`} /><span className={`text-xl font-bold ${isWeeklyBonusUsed ? 'text-amber-600' : 'text-[#10B981]'}`}>{isWeeklyBonusUsed ? 'Utilizzato' : 'Disponibile'}</span><span className={`text-[10px] uppercase tracking-widest font-extrabold ${isWeeklyBonusUsed ? 'text-amber-500' : 'text-[#10B981]'}`}>Bonus</span></div>
      </div>
      <div className="bg-[#F3F4F6]/50 p-6 rounded-[2.5rem] space-y-4 shadow-inner border border-gray-100">
        <div className="flex justify-between items-center mb-1"><h3 className="font-bold text-gray-700 flex items-center gap-2"><Sun className="text-amber-400" size={20} /> I Tuoi Pasti</h3><span className="text-[10px] font-bold text-rose-400 bg-rose-50 px-3 py-1 rounded-full">{completedCount}/5</span></div>
        <div className="space-y-3">
          {MEALS.map((meal) => (
            <button key={meal.id} onClick={() => !user.isDayClosed && onOpenMealSelector(meal.id)} disabled={user.isDayClosed} className={`w-full flex items-center justify-between p-4 rounded-3xl transition-all bg-white ${user.isDayClosed ? 'opacity-90' : 'active:scale-95 shadow-sm'}`}>
              <div className="flex items-center gap-4 text-left">
                <div className="w-11 h-11 rounded-2xl flex items-center justify-center bg-gray-50/50">
                  {meal.icon === 'coffee' && <Coffee size={24} className="text-gray-400" />}
                  {meal.icon === 'apple' && <Apple size={24} className="text-gray-400" />}
                  {meal.icon === 'utensils' && <Utensils size={24} className="text-gray-400" />}
                  {meal.icon === 'moon' && <Moon size={24} className="text-gray-400" />}
                </div>
                <div><p className="text-sm font-bold text-gray-700">{meal.label}</p><p className="text-[10px] text-gray-400 font-medium">{meal.time}</p></div>
              </div>
              {user.dailyMeals[meal.id] ? (<div className={`rounded-full p-1.5 flex items-center justify-center ${user.dailyMeals[meal.id] === 'bonus' ? 'bg-amber-500' : 'bg-[#10B981]'}`}>{user.dailyMeals[meal.id] === 'bonus' ? <Star className="text-white" size={18} fill="currentColor" /> : <Check className="text-white" size={18} strokeWidth={4} />}</div>) : <div className="w-7 h-7 rounded-full border-2 border-gray-100"></div>}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-4 pt-2">
        {!user.isDayClosed ? <button onClick={onCloseDay} className="w-full bg-[#1e293b] text-white py-5 rounded-[2rem] font-bold shadow-2xl flex items-center justify-center gap-2 active:scale-95 transition-transform text-lg">Chiudi la Giornata <Sparkles size={22} /></button> : (
          <div className="space-y-4">
            <button onClick={onReopenDay} className="w-full bg-indigo-50 border-2 border-indigo-200 text-indigo-700 py-4 rounded-[2.5rem] font-bold flex items-center justify-center gap-2 active:scale-95 transition-all">Modifica Giornata <Edit3 size={20} /></button>
            <div className="bg-[#FEF9C3] p-6 rounded-[2.5rem] shadow-sm flex items-start gap-4 border border-amber-200"><Trophy className="text-amber-500 shrink-0" size={32} /><div><p className="font-bold text-amber-900 leading-tight">Ottimo lavoro!</p><p className="text-[11px] text-amber-800/70 italic mt-1">Diario concluso. ✨</p></div></div>
          </div>
        )}
      </div>
      <style>{`@keyframes bounce-gentle { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } } .animate-bounce-gentle { animation: bounce-gentle 2s ease-in-out infinite; }`}</style>
    </div>
  );
};

const ChatView: React.FC<any> = ({ messages, onSendMessage, isTyping, isLiveActive, onToggleLive }) => {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, isTyping]);
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (input.trim()) { onSendMessage(input); setInput(''); } };
  return (
    <div className="flex flex-col h-full space-y-4 animate-in fade-in pb-4">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-1">
        {messages.length === 0 && (
          <div className="text-center py-16 space-y-4">
            <div className="w-20 h-20 bg-rose-50 rounded-[2rem] flex items-center justify-center mx-auto text-rose-400 border border-rose-100 shadow-inner"><Sparkles size={40} /></div>
            <div className="space-y-2"><p className="text-gray-800 font-bold text-lg text-rose-500">Ciao, sono Luce ✨</p><p className="text-gray-400 text-sm italic px-8">Sono qui per ascoltarti senza giudizio. Come va oggi?</p></div>
          </div>
        )}
        {messages.map((m: any, i: number) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-4 rounded-3xl text-sm leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-rose-400 text-white rounded-tr-none' : 'bg-gray-100 text-gray-800 border border-gray-200 rounded-tl-none'}`}>{m.content}</div>
          </div>
        ))}
        {isTyping && <div className="flex gap-1.5 items-center bg-gray-100 p-4 rounded-3xl w-fit border border-gray-200 rounded-tl-none"><div className="w-1.5 h-1.5 bg-rose-300 rounded-full animate-bounce" /><div className="w-1.5 h-1.5 bg-rose-300 rounded-full animate-bounce [animation-delay:0.2s]" /><div className="w-1.5 h-1.5 bg-rose-300 rounded-full animate-bounce [animation-delay:0.4s]" /></div>}
      </div>
      <div className="flex flex-col gap-3">
        {isLiveActive && (<div className="bg-rose-50 p-3 rounded-2xl border border-rose-100 animate-pulse flex items-center justify-center gap-2"><div className="w-2 h-2 bg-rose-400 rounded-full" /><span className="text-[10px] font-bold text-rose-400 uppercase tracking-widest">Luce ti sta ascoltando...</span></div>)}
        <form onSubmit={handleSubmit} className="flex gap-2 bg-white p-2.5 rounded-[1.5rem] border border-gray-200 items-center shadow-sm focus-within:border-rose-200 transition-colors">
          <button type="button" onClick={onToggleLive} className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-all ${isLiveActive ? 'bg-rose-500 text-white animate-pulse' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>{isLiveActive ? <MicOff size={20} /> : <Mic size={20} />}</button>
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Scrivi a Luce..." className="flex-1 px-1 outline-none text-sm h-10 bg-transparent" />
          <button type="submit" disabled={!input.trim()} className="w-11 h-11 bg-rose-400 rounded-2xl flex items-center justify-center text-white active:scale-95 disabled:opacity-30 shadow-lg"><Send size={20} /></button>
        </form>
      </div>
    </div>
  );
};

const finalizeDay = async (data: CheckInData, setUser: any, setView: any, setShowReward: any, sendMessage: any, user: UserState) => {
  const now = new Date();
  const dateKey = getLocalDateKey(now);
  let meals = { ...user.dailyMeals };
  if (data.status === 'regular') MEALS.forEach(m => { if (!meals[m.id]) meals[m.id] = 'regular'; });
  const count = Object.values(meals).filter(Boolean).length;
  const hasBonus = Object.values(meals).some(v => v === 'bonus');
  const bonusUsedWeek = isBonusUsedInWeekInternal(now, user.history, {}, dateKey);
  const completed = count === MEALS.length && (!hasBonus || !bonusUsedWeek);
  setUser((prev: any) => {
    const summary: DaySummary = { date: dateKey, isCompleted: completed, mealsCount: count, hasBonus, mood: data.mood, meals, status: data.status };
    const newHistory = { ...prev.history, [dateKey]: summary };
    return { ...prev, isDayClosed: true, streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory), lastCheckIn: now.toDateString(), history: newHistory };
  });
  setView('calendar');
  if (completed || data.status !== 'regular') setShowReward(true);
  sendMessage(`Ho chiuso la giornata come ${data.status}. Mi sento ${data.mood}. Riflessione: ${data.emotions}`, true);
};

const MealSelector: React.FC<any> = ({ mealToSelect, isWeeklyBonusUsed, onSelect, onCancel, userMeals }) => (
  <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm">
    <div className="bg-white w-full max-w-md rounded-t-[3rem] p-8 space-y-6 shadow-2xl animate-in slide-in-from-bottom duration-300">
      <div className="flex justify-between items-center"><h3 className="text-xl font-bold text-gray-800">Com'è andato il pasto?</h3><button onClick={onCancel} className="p-2 text-gray-400"><X size={24} /></button></div>
      <div className="grid grid-cols-1 gap-4">
        <button onClick={() => onSelect(mealToSelect, 'regular')} className="flex items-center gap-4 p-5 rounded-3xl bg-emerald-50 border-2 border-emerald-100 text-emerald-700 active:scale-95 transition-transform"><div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center"><Check className="text-emerald-500" size={24} /></div><div className="text-left font-bold">Pasto Regolare</div></button>
        <button onClick={() => onSelect(mealToSelect, 'bonus')} disabled={isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus'} className={`flex items-center gap-4 p-5 rounded-3xl border-2 transition-all ${isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus' ? 'bg-gray-50 opacity-50 grayscale' : 'bg-amber-50 border-amber-100 text-amber-700 active:scale-95'}`}><div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center"><Star className={isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus' ? 'text-gray-300' : 'text-amber-500'} size={24} /></div><div className="text-left"><div className="font-bold">Bonus (Sgarro)</div>{isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus' && <div className="text-[10px] font-medium text-amber-600/60 leading-tight">Già utilizzato</div>}</div></button>
        <button onClick={() => onSelect(mealToSelect, null)} className="py-2 text-gray-400 text-sm">Rimuovi</button>
      </div>
    </div>
  </div>
);

const RewardModal: React.FC<any> = ({ onClaim }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm">
    <div className="bg-white rounded-3xl p-8 text-center space-y-4 shadow-2xl max-w-xs animate-in zoom-in-95">
      <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto text-amber-500"><Trophy size={48} className="animate-bounce" /></div>
      <h2 className="text-2xl font-bold text-gray-800">Traguardo! 🎉</h2>
      <p className="text-gray-600 text-sm">Luce è fiera di te!</p>
      <button onClick={onClaim} className="w-full bg-rose-500 text-white py-4 rounded-2xl font-bold shadow-lg">Accetta il Premio 💖</button>
    </div>
  </div>
);

const CheckInForm: React.FC<any> = ({ onSubmit, onCancel, isSaving, initialData }) => {
  const [mood, setMood] = useState(initialData?.mood || 'felice');
  const [emotions, setEmotions] = useState(''); 
  const [status, setStatus] = useState<'regular' | 'holiday' | 'sick'>(initialData?.status || 'regular');
  return (
    <div className="space-y-8 pb-8">
      <div className="text-center space-y-2"><h2 className="text-3xl font-bold text-gray-700">Riflessione</h2><p className="text-sm text-gray-400 italic">Prenditi un momento per ascoltarti...</p></div>
      <div className="flex gap-2">
        <button onClick={() => setStatus('regular')} className={`flex-1 p-4 rounded-3xl border-2 font-bold flex flex-col items-center gap-2 transition-all ${status === 'regular' ? 'bg-rose-50 border-rose-200 text-rose-600 shadow-md' : 'bg-white border-gray-50 text-gray-300'}`}><CheckCircle2 size={24}/><span className="text-xs">Regolare</span></button>
        <button onClick={() => setStatus('holiday')} className={`flex-1 p-4 rounded-3xl border-2 font-bold flex flex-col items-center gap-2 transition-all ${status === 'holiday' ? 'bg-indigo-50 border-indigo-200 text-indigo-600 shadow-md' : 'bg-white border-gray-50 text-gray-300'}`}><Palmtree size={24}/><span className="text-xs">Ferie</span></button>
        <button onClick={() => setStatus('sick')} className={`flex-1 p-4 rounded-3xl border-2 font-bold flex flex-col items-center gap-2 transition-all ${status === 'sick' ? 'bg-slate-100 border-slate-300 text-slate-600 shadow-md' : 'bg-white border-gray-50 text-gray-300'}`}><Thermometer size={24}/><span className="text-xs">Malattia</span></button>
      </div>
      <div className="flex justify-between px-2 bg-white/60 p-6 rounded-[2.5rem] border border-gray-100 shadow-sm items-center">
        {[{ icon: Smile, label: 'felice', color: 'text-[#10B981]' }, { icon: Meh, label: 'neutrale', color: 'text-[#F59E0B]' }, { icon: Frown, label: 'triste', color: 'text-[#F43F5E]' }].map(({ icon: Icon, label, color }) => (
          <button key={label} onClick={() => setMood(label)} className={`flex flex-col items-center gap-3 p-4 rounded-3xl transition-all ${mood === label ? 'bg-white scale-110 shadow-lg ring-1 ring-gray-0' : 'opacity-30'}`}><Icon size={44} className={color} /><span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{label}</span></button>
        ))}
      </div>
      <textarea value={emotions} onChange={(e) => setEmotions(e.target.value)} placeholder="Cosa porti nel cuore stasera?" className="w-full p-6 rounded-[2.5rem] border-2 border-gray-100 focus:border-rose-200 outline-none h-48 resize-none text-sm bg-white shadow-sm" />
      <button onClick={() => onSubmit({ mood, emotions, status })} disabled={isSaving} className="w-full bg-[#1e293b] text-white py-5 rounded-[2rem] font-bold shadow-2xl flex items-center justify-center gap-2 text-lg">{isSaving ? <Loader2 className="animate-spin" size={24} /> : 'Salva ✨'}</button>
    </div>
  );
};

const CalendarView: React.FC<any> = ({ user, onUpdateDay }) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDayInfo, setSelectedDayInfo] = useState<{ date: Date, summary: DaySummary | null } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<DaySummary | null>(null);

  const monthName = currentDate.toLocaleString('it-IT', { month: 'long', year: 'numeric' });
  
  const daysInMonth = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayIdx = new Date(year, month, 1).getDay();
    const leadingPadding = firstDayIdx === 0 ? 6 : firstDayIdx - 1;
    const days = [];
    for (let i = 0; i < leadingPadding; i++) days.push(new Date(year, month, -leadingPadding + i + 1));
    const lastDay = new Date(year, month + 1, 0).getDate();
    for (let i = 1; i <= lastDay; i++) days.push(new Date(year, month, i));
    
    // Trailing padding from next month - FIXED LOGIC
    let trailingCount = 1;
    while (days.length % 7 !== 0) {
      days.push(new Date(year, month + 1, trailingCount++));
    }
    return days;
  }, [currentDate]);

  // Group days by weeks for the 8th column logic
  const weeks = useMemo(() => {
    const w = [];
    for (let i = 0; i < daysInMonth.length; i += 7) {
      w.push(daysInMonth.slice(i, i + 7));
    }
    return w;
  }, [daysInMonth]);

  const handleDayClick = (date: Date) => {
    const dk = getLocalDateKey(date);
    const summary = user.history[dk] || null;
    setSelectedDayInfo({ date, summary });
    setIsEditing(false);
  };

  const startEditing = () => {
    if (selectedDayInfo) {
      setEditForm(selectedDayInfo.summary || {
        date: getLocalDateKey(selectedDayInfo.date),
        isCompleted: false,
        mealsCount: 0,
        hasBonus: false,
        mood: 'felice',
        meals: {},
        status: 'regular'
      });
      setIsEditing(true);
    }
  };

  const toggleMealInEdit = (mealId: string) => {
    if (!editForm) return;
    const current = editForm.meals?.[mealId];
    let next: 'regular' | 'bonus' | null = current === null || current === undefined ? 'regular' : current === 'regular' ? 'bonus' : null;
    const newMeals = { ...editForm.meals, [mealId]: next };
    setEditForm({ ...editForm, meals: newMeals, mealsCount: Object.values(newMeals).filter(Boolean).length, hasBonus: Object.values(newMeals).some(v => v === 'bonus'), status: 'regular' });
  };

  const saveEdits = () => {
    if (editForm && selectedDayInfo) {
      onUpdateDay(editForm.date, editForm);
      setSelectedDayInfo({ ...selectedDayInfo, summary: editForm });
      setIsEditing(false);
    }
  };

  const updateStatus = (newStatus: 'regular' | 'holiday' | 'sick') => {
    setEditForm(prev => {
      if (!prev) return null;
      let nextMeals = { ...prev.meals };
      if (newStatus === 'regular') {
        MEALS.forEach(m => {
          nextMeals[m.id] = 'regular';
        });
      }
      const count = Object.values(nextMeals).filter(Boolean).length;
      return { 
        ...prev, 
        status: newStatus, 
        meals: nextMeals,
        mealsCount: count,
        hasBonus: Object.values(nextMeals).some(v => v === 'bonus'),
        isCompleted: newStatus !== 'regular' || count === 5
      };
    });
  };

  const calculateWeekResult = (weekDays: Date[]) => {
    const summaries = weekDays.map(d => user.history[getLocalDateKey(d)]);
    const successes = summaries.filter(s => isDaySuccessful(s)).length;
    const today = new Date();
    const totalDaysPassed = weekDays.filter(d => d <= today).length;
    
    if (successes === 7) return 'perfect';
    if (successes >= totalDaysPassed && successes > 0) return 'partial';
    if (successes < totalDaysPassed) return 'failed';
    return 'none';
  };

  return (
    <div className="space-y-6 pb-12 relative animate-in fade-in">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-bold text-gray-800 capitalize">{monthName}</h2>
        <div className="flex gap-2">
          <button onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))} className="p-2 text-gray-400"><ChevronLeft size={20} /></button>
          <button onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))} className="p-2 text-gray-400"><ChevronRight size={20} /></button>
        </div>
      </div>
      
      <div className="grid grid-cols-[repeat(7,1fr)_40px] gap-2 items-center">
        {['L', 'M', 'M', 'G', 'V', 'S', 'D'].map(day => <div key={day} className="text-center text-[10px] font-bold text-gray-300 py-2 uppercase">{day}</div>)}
        <div className="text-center"><TrendingUp size={14} className="mx-auto text-gray-300" /></div>
        
        {weeks.map((week, wIdx) => (
          <React.Fragment key={`week-${wIdx}`}>
            {week.map((date, dIdx) => {
              const dk = getLocalDateKey(date);
              const summary = user.history[dk];
              const isToday = date.toDateString() === new Date().toDateString();
              const isCurrentMonth = date.getMonth() === currentDate.getMonth();
              let indicatorColor = 'bg-transparent';
              if (summary) {
                if (summary.status === 'holiday') indicatorColor = 'bg-indigo-400';
                else if (summary.status === 'sick') indicatorColor = 'bg-slate-400';
                else indicatorColor = summary.isCompleted ? (summary.hasBonus ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-rose-400';
              }
              return (
                <button 
                  key={dk}
                  onClick={() => handleDayClick(date)}
                  className={`aspect-square border-2 rounded-2xl flex flex-col items-center justify-center transition-all active:scale-95 ${isCurrentMonth ? 'bg-white border-gray-100 shadow-sm' : 'bg-gray-50/20 border-transparent opacity-20'} ${isToday ? 'ring-2 ring-rose-300 ring-offset-2' : ''}`}
                >
                  <span className={`text-[13px] font-bold ${isCurrentMonth ? 'text-gray-800' : 'text-gray-400'}`}>{date.getDate()}</span>
                  <div className={`w-1.5 h-1.5 ${indicatorColor} rounded-full mt-1 transition-colors`} />
                </button>
              );
            })}
            {/* Week Result Column */}
            <div className="flex items-center justify-center">
              {(() => {
                const res = calculateWeekResult(week);
                if (res === 'perfect') return <div className="w-7 h-7 bg-amber-100 rounded-lg flex items-center justify-center text-amber-500 shadow-sm animate-in zoom-in-50"><Sparkles size={16} /></div>;
                if (res === 'partial') return <div className="w-7 h-7 bg-emerald-50 rounded-lg flex items-center justify-center text-emerald-400 shadow-sm animate-in zoom-in-50"><CheckCircle2 size={16} /></div>;
                if (res === 'failed') return <div className="w-7 h-7 bg-rose-50 rounded-lg flex items-center justify-center text-rose-300 shadow-sm"><X size={14} /></div>;
                return <div className="w-7 h-7 bg-gray-50/50 rounded-lg" />;
              })()}
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* Legend Section */}
      <div className="bg-white/60 p-5 rounded-[2rem] border border-gray-100 shadow-sm mt-8 animate-in slide-in-from-bottom duration-500">
        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2"><Info size={12} /> Legenda Colori</h4>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-emerald-400 rounded-full" />
            <span className="text-[11px] font-bold text-gray-600">Pasti Regolari</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-amber-400 rounded-full" />
            <span className="text-[11px] font-bold text-gray-600">Con Bonus (Sgarro)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full" />
            <span className="text-[11px] font-bold text-gray-600">In Ferie</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-slate-400 rounded-full" />
            <span className="text-[11px] font-bold text-gray-600">Malattia</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-rose-400 rounded-full" />
            <span className="text-[11px] font-bold text-gray-600">Incompleto</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-transparent border border-gray-200 rounded-full" />
            <span className="text-[11px] font-bold text-gray-400 italic">In corso...</span>
          </div>
        </div>
      </div>

      {selectedDayInfo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-[2.5rem] p-8 text-center space-y-6 shadow-2xl max-w-sm w-full animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start">
              <div className="text-left">
                <h3 className="text-xl font-bold text-slate-800 capitalize">{selectedDayInfo.date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}</h3>
                {!isEditing && <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider mt-1">{selectedDayInfo.summary?.status === 'holiday' ? '🏖️ Ferie' : selectedDayInfo.summary?.status === 'sick' ? '🤒 Malattia' : selectedDayInfo.summary?.mood || 'Nessun dato'}</p>}
              </div>
              <button onClick={() => setSelectedDayInfo(null)} className="p-2 text-gray-400 hover:bg-gray-100 rounded-full transition-colors"><X size={24} /></button>
            </div>

            {isEditing && editForm ? (
              <div className="space-y-4 text-left">
                <div className="flex gap-2 mb-4">
                  {(['regular', 'holiday', 'sick'] as const).map(s => (
                    <button key={s} onClick={() => updateStatus(s)} className={`flex-1 p-3 rounded-2xl border-2 text-[11px] font-bold flex flex-col items-center gap-1 transition-all ${editForm.status === s ? 'bg-rose-50 border-rose-400 text-rose-600 scale-105 shadow-sm' : 'bg-white border-gray-100 text-gray-400 hover:bg-gray-50'}`}>
                      {s === 'holiday' ? <Palmtree size={18}/> : s === 'sick' ? <Thermometer size={18}/> : <CheckCircle2 size={18}/>}
                      {s === 'regular' ? 'Pasto' : s === 'holiday' ? 'Ferie' : 'Malato'}
                    </button>
                  ))}
                </div>
                {editForm.status === 'regular' && (
                  <div className="space-y-2">
                    {MEALS.map(meal => (
                      <button key={meal.id} onClick={() => toggleMealInEdit(meal.id)} className={`w-full flex items-center justify-between p-4 rounded-2xl border-2 transition-all ${editForm.meals?.[meal.id] === 'regular' ? 'bg-emerald-50 border-emerald-200 shadow-sm' : editForm.meals?.[meal.id] === 'bonus' ? 'bg-amber-50 border-amber-200 shadow-sm' : 'bg-white border-gray-100'}`}>
                        <span className={`text-sm font-bold ${editForm.meals?.[meal.id] === 'regular' ? 'text-emerald-700' : editForm.meals?.[meal.id] === 'bonus' ? 'text-amber-700' : 'text-slate-700'}`}>{meal.label}</span>
                        {editForm.meals?.[meal.id] === 'bonus' ? <Star size={20} className="text-amber-500 fill-amber-500" /> : editForm.meals?.[meal.id] === 'regular' ? <Check size={20} className="text-emerald-600 stroke-[3]" /> : <X size={18} className="text-gray-300" />}
                      </button>
                    ))}
                  </div>
                )}
                {editForm.status !== 'regular' && (
                  <div className="bg-blue-50/50 p-6 rounded-3xl border border-blue-100 text-center space-y-2">
                    <p className="text-sm font-bold text-blue-700">Giorno Speciale Selezionato ✨</p>
                    <p className="text-[11px] text-blue-600/80 italic">Questa giornata sarà segnata come completata per la tua costanza. Pensa solo al tuo benessere!</p>
                  </div>
                )}
                <div className="pt-4 space-y-2">
                  <button onClick={saveEdits} className="w-full bg-slate-800 text-white py-4 rounded-3xl font-bold text-lg shadow-lg active:scale-95 transition-all">Salva Modifiche</button>
                  <button onClick={() => setIsEditing(false)} className="w-full text-gray-400 font-bold text-sm py-2 text-center">Annulla</button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {selectedDayInfo.summary ? (
                  <div className="bg-gray-50 p-6 rounded-[2rem] text-left space-y-3 border border-gray-100">
                    <div className="flex justify-between items-center"><span className="text-sm text-gray-500">Stato:</span><span className="font-bold text-slate-800 capitalize">{selectedDayInfo.summary.status === 'holiday' ? '🏝️ Ferie' : selectedDayInfo.summary.status === 'sick' ? '🤒 Malattia' : '🍲 Regolare'}</span></div>
                    {selectedDayInfo.summary.status === 'regular' && (
                      <>
                        <div className="flex justify-between items-center"><span className="text-sm text-gray-500">Pasti:</span><span className="font-bold text-slate-800">{selectedDayInfo.summary.mealsCount}/5</span></div>
                        <div className="flex justify-between items-center"><span className="text-sm text-gray-500">Bonus:</span><span className={`font-bold ${selectedDayInfo.summary.hasBonus ? 'text-amber-500' : 'text-emerald-500'}`}>{selectedDayInfo.summary.hasBonus ? '✨ Sì' : '🍃 No'}</span></div>
                      </>
                    )}
                    <div className="pt-3 border-t border-gray-200 mt-2">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Dettaglio pasti</p>
                      {MEALS.map(m => (
                        <div key={m.id} className="flex justify-between py-1.5 text-sm">
                          <span className="text-slate-600 font-medium">{m.label}</span>
                          <span>{selectedDayInfo.summary?.meals?.[m.id] === 'regular' ? <Check size={16} className="text-emerald-500" /> : selectedDayInfo.summary?.meals?.[m.id] === 'bonus' ? <Star size={16} className="text-amber-500 fill-amber-500" /> : <X size={16} className="text-gray-300" />}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <p className="text-gray-400 text-sm italic py-8">Nessuna attività registrata per questo giorno.</p>}
                <button onClick={startEditing} className="w-full bg-rose-400 text-white py-4 rounded-3xl font-bold shadow-lg shadow-rose-100 text-lg active:scale-95 transition-all">Modifica Giorno</button>
                <button onClick={() => setSelectedDayInfo(null)} className="w-full bg-gray-100 text-gray-600 py-4 rounded-3xl font-bold text-lg active:scale-95 transition-all">Chiudi</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
