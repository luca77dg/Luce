
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
  Clock,
  ShieldCheck,
  AlertTriangle
} from 'lucide-react';

const MEALS: MealConfig[] = [
  { id: 'colazione', label: 'Colazione', time: '07:00', icon: 'coffee' },
  { id: 'spuntino_mattina', label: 'Spuntino Mattutino', time: '11:00', icon: 'apple' },
  { id: 'pranzo', label: 'Pranzo', time: '13:00', icon: 'utensils' },
  { id: 'spuntino_pomeriggio', label: 'Spuntino Pomeridiano', time: '17:00', icon: 'apple' },
  { id: 'cena', label: 'Cena', time: '20:00', icon: 'moon' },
];

const SYSTEM_INSTRUCTION = `
Sei un assistente virtuale empatico e motivazionale di nome "Luce", specializzato nel supporto a persone che stanno seguendo un percorso di recupero o gestione di disturbi alimentari. Il tuo tono deve essere luminoso, incoraggiante, caloroso e mai giudicante. Rispondi usando forme maschili (es. Benvenuto) se non specificato diversamente.
`;

// PCM Audio helpers
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

const App: React.FC = () => {
  const [view, setView] = useState<'dashboard' | 'checkin' | 'chat' | 'calendar'>('dashboard');
  const [isSaving, setIsSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    try {
      return localStorage.getItem('luce_notifications_enabled') === 'true';
    } catch { return false; }
  });
  const [overdueMeal, setOverdueMeal] = useState<MealConfig | null>(null);
  
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
        return { 
          ...parsed, 
          dailyMeals: {}, 
          rewardClaimed: false, 
          isDayClosed: false, 
          history: parsed.history || {}, 
          streak: calculateDailyStreak(parsed.history || {}), 
          weeklyStreak: calculateWeeklyStreak(parsed.history || {}) 
        };
      }
      return parsed;
    } catch (e) {
      console.error("Storage Error:", e);
      return defaultState;
    }
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [mealToSelect, setMealToSelect] = useState<string | null>(null);

  // AI Status Check Effect
  useEffect(() => {
    const checkKey = async () => {
      try {
        const key = (typeof process !== 'undefined' && process.env) ? process.env.API_KEY : null;
        if (key && key.length > 5) {
          setAiStatus('ok');
        } else {
          setAiStatus('error');
        }
      } catch (e) {
        setAiStatus('error');
      }
    };
    checkKey();
  }, []);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const lastNotifiedMealId = useRef<string | null>(null);
  const [isLiveActive, setIsLiveActive] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('luce_user_state', JSON.stringify(user));
    } catch (e) { console.error("Save Error:", e); }
  }, [user]);

  useEffect(() => {
    try {
      localStorage.setItem('luce_notifications_enabled', String(notificationsEnabled));
    } catch (e) { console.error("Save Error:", e); }
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
      const todaySummary: DaySummary = { 
        date: dateKey, 
        isCompleted: isActuallyCompleted, 
        mealsCount, 
        hasBonus: hasBonusToday, 
        mood: prev.history[dateKey]?.mood || 'felice', 
        meals: newDailyMeals, 
        status: prev.history[dateKey]?.status || 'regular' 
      };
      const newHistory = { ...prev.history, [dateKey]: todaySummary };
      return { 
        ...prev, 
        dailyMeals: newDailyMeals, 
        lastCheckIn: now.toDateString(), 
        history: newHistory, 
        bonusUsed: isBonusUsedInWeekInternal(now, newHistory, newDailyMeals), 
        streak: calculateDailyStreak(newHistory), 
        weeklyStreak: calculateWeeklyStreak(newHistory) 
      };
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
      return { ...prev, history: newHistory, dailyMeals: newDailyMeals, streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory) };
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
          <button onClick={() => setView('dashboard')} className="p-2 rounded-full hover:bg-gray-100 text-gray-400 transition-colors"><ArrowRight className="rotate-180" size={20} /></button>
        )}
      </header>

      <main className="flex-1 px-6 pb-2 z-10 overflow-y-auto">
        {view === 'dashboard' && (
          <Dashboard 
            user={user} 
            aiStatus={aiStatus}
            onOpenMealSelector={(id: string) => setMealToSelect(id)} 
            onCloseDay={() => setView('checkin')} 
            onReopenDay={() => setUser(prev => ({ ...prev, isDayClosed: false }))} 
            isWeeklyBonusUsed={isBonusUsedInWeekInternal(new Date(), user.history, user.dailyMeals)}
            notificationsEnabled={notificationsEnabled}
            onRequestNotifications={requestNotificationPermission}
            onDisableNotifications={() => setNotificationsEnabled(false)}
            overdueMeal={overdueMeal}
          />
        )}
        {view === 'checkin' && <CheckInForm onSubmit={(data: any) => { finalizeDay(data, setUser, setView, setShowReward, sendMessage, user); }} onCancel={() => setView('dashboard')} isSaving={isSaving} initialData={user.isDayClosed ? user.history[getLocalDateKey()] : undefined} />}
        {view === 'chat' && <ChatView messages={messages} onSendMessage={sendMessage} isTyping={isTyping} isLiveActive={isLiveActive} onToggleLive={toggleLiveSession} />}
        {view === 'calendar' && <CalendarView user={user} onUpdateDay={handleUpdateDay} />}
      </main>

      {mealToSelect && <MealSelector mealToSelect={mealToSelect} isWeeklyBonusUsed={isBonusUsedInWeekInternal(new Date(), user.history, user.dailyMeals)} onSelect={setMealStatus} onCancel={() => setMealToSelect(null)} userMeals={user.dailyMeals} />}
      {showReward && <RewardModal onClaim={() => { setUser(prev => ({ ...prev, rewardClaimed: true })); setShowReward(false); sendMessage("Grazie per il premio! 💖", true); }} />}

      <nav className="p-4 flex justify-around items-center border-t border-gray-100 bg-white z-20">
        <button onClick={() => setView('calendar')} className={`flex flex-col items-center gap-1 transition-all ${view === 'calendar' ? 'text-gray-800' : 'text-gray-300 hover:text-gray-400'}`}><Calendar size={28} /></button>
        <div className="relative -top-6">
          <button onClick={() => setView('dashboard')} className={`w-16 h-16 rounded-full flex items-center justify-center text-white shadow-xl border-4 border-white transition-all ${view === 'dashboard' ? 'bg-rose-400 scale-110' : 'bg-gray-300'}`}><Sun size={32} /></button>
        </div>
        <button onClick={() => setView('chat')} className={`flex flex-col items-center gap-1 transition-all ${view === 'chat' ? 'text-gray-800' : 'text-gray-300 hover:text-gray-400'}`}><MessageCircle size={28} /></button>
      </nav>
    </div>
  );
};

const Dashboard: React.FC<any> = ({ 
  user, aiStatus, onOpenMealSelector, onCloseDay, onReopenDay, isWeeklyBonusUsed,
  notificationsEnabled, onRequestNotifications, onDisableNotifications, overdueMeal
}) => {
  const completedCount = MEALS.filter(m => user.dailyMeals[m.id]).length;
  const todayFormatted = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  const motivation = useMemo(() => getDynamicMotivation(user.history, user.name), [user.history, user.name]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-12">
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
        <div className="bg-indigo-50 p-6 rounded-[2rem] flex flex-col items-center text-center justify-center min-h-[160px] border border-indigo-100 relative shadow-sm"><Trophy className="text-indigo-500 mb-1" size={32} /><span className="text-4xl font-bold text-indigo-900">{user.weeklyStreak}</span><span className="text-[10px] uppercase tracking-widest text-indigo-500 font-extrabold">Settimane</span></div>
        <div className={`p-6 rounded-[2rem] flex flex-col items-center text-center justify-center min-h-[160px] border shadow-sm ${isWeeklyBonusUsed ? 'bg-amber-50 border-amber-100' : 'bg-[#ECFDF5] border-emerald-100'}`}><Heart className={`size-[32px] mb-1 ${isWeeklyBonusUsed ? 'text-amber-500 fill-amber-500' : 'text-[#10B981] fill-[#10B981]'}`} /><span className={`text-xl font-bold ${isWeeklyBonusUsed ? 'text-amber-600' : 'text-[#10B981]'}`}>{isWeeklyBonusUsed ? 'Utilizzato' : 'Disponibile'}</span><span className={`text-[10px] uppercase tracking-widest font-extrabold ${isWeeklyBonusUsed ? 'text-amber-500' : 'text-[#10B981]'}`}>Bonus</span></div>
      </div>
      <div className="bg-[#F3F4F6]/50 p-6 rounded-[2.5rem] space-y-4 shadow-inner border border-gray-100">
        <div className="flex justify-between items-center mb-1"><h3 className="font-bold text-gray-700 flex items-center gap-2"><Sun className="text-amber-400" size={20} /> I Tuoi Pasti</h3><span className="text-[10px] font-bold text-rose-400 bg-rose-50 px-3 py-1 rounded-full">{completedCount}/5</span></div>
        <div className="space-y-3">
          {MEALS.map((meal) => (
            <button key={meal.id} onClick={() => !user.isDayClosed && onOpenMealSelector(meal.id)} disabled={user.isDayClosed} className={`w-full flex items-center justify-between p-4 rounded-3xl transition-all bg-white ${user.isDayClosed ? 'opacity-90' : 'active:scale-95 shadow-sm hover:shadow-md'}`}>
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

      <div className="flex justify-center pt-8 opacity-60">
        <div className={`px-4 py-2 rounded-full border flex items-center gap-2 transition-all duration-500 ${aiStatus === 'ok' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : aiStatus === 'checking' ? 'bg-amber-50 border-amber-100 text-amber-600' : 'bg-rose-50 border-rose-100 text-rose-600'}`}>
          <div className={`w-2 h-2 rounded-full animate-pulse ${aiStatus === 'ok' ? 'bg-emerald-500' : aiStatus === 'checking' ? 'bg-amber-500' : 'bg-rose-500'}`} />
          <span className="text-[10px] font-bold uppercase tracking-widest">
            {aiStatus === 'ok' ? 'Sistema Luce Online' : aiStatus === 'checking' ? 'Verifica Sistema...' : 'Luce Offline'}
          </span>
          {aiStatus === 'ok' ? <ShieldCheck size={12} /> : aiStatus === 'error' ? <AlertTriangle size={12} /> : <Loader2 size={12} className="animate-spin" />}
        </div>
      </div>

      <style>{`@keyframes bounce-gentle { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } } .animate-bounce-gentle { animation: bounce-gentle 2s ease-in-out infinite; }`}</style>
    </div>
  );
};

const finalizeDay = (
  data: CheckInData, 
  setUser: React.Dispatch<React.SetStateAction<UserState>>, 
  setView: (v: 'dashboard' | 'checkin' | 'chat' | 'calendar') => void,
  setShowReward: (v: boolean) => void,
  sendMessage: (text: string, silent?: boolean) => void,
  user: UserState
) => {
  const now = new Date();
  const dateKey = getLocalDateKey(now);
  
  setUser(prev => {
    const mealsCount = Object.values(prev.dailyMeals).filter(Boolean).length;
    const hasBonusToday = Object.values(prev.dailyMeals).some(v => v === 'bonus');
    const bonusAlreadyUsedThisWeek = isBonusUsedInWeekInternal(now, prev.history, {}, dateKey);
    const isCompleted = (data.status === 'holiday' || data.status === 'sick')
      ? true 
      : (mealsCount === MEALS.length && (!hasBonusToday || !bonusAlreadyUsedThisWeek));
    
    const summary: DaySummary = {
      date: dateKey,
      isCompleted,
      mealsCount,
      hasBonus: hasBonusToday,
      mood: data.mood,
      meals: { ...prev.dailyMeals },
      status: data.status || 'regular'
    };
    
    const newHistory = { ...prev.history, [dateKey]: summary };
    return {
      ...prev,
      history: newHistory,
      isDayClosed: true,
      lastCheckIn: now.toDateString(),
      streak: calculateDailyStreak(newHistory),
      weeklyStreak: calculateWeeklyStreak(newHistory)
    };
  });
  
  setView('dashboard');
  setShowReward(true);
  
  const statusMsg = data.status === 'sick' ? "Oggi non sono stato bene" : data.status === 'holiday' ? "Oggi ero in vacanza" : "Ho concluso la mia giornata";
  sendMessage(`${statusMsg}. Mi sento ${data.mood} e ho provato ${data.emotions || 'calma'}.`, false);
};

const CheckInForm: React.FC<{ onSubmit: (data: any) => void; onCancel: () => void; isSaving: boolean; initialData?: DaySummary }> = ({ onSubmit, onCancel, isSaving, initialData }) => {
  const [mood, setMood] = useState(initialData?.mood || 'felice');
  const [emotions, setEmotions] = useState('');
  const [status, setStatus] = useState<'regular' | 'holiday' | 'sick'>(initialData?.status || 'regular');

  return (
    <div className="space-y-6 pb-12 animate-in slide-in-from-bottom-4 duration-500">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-gray-800">Com'è andata oggi?</h2>
        <p className="text-gray-500 text-sm">Prenditi un momento per riflettere con gentilezza.</p>
      </div>

      <div className="space-y-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-gray-400">Tipo di giornata</label>
        <div className="grid grid-cols-3 gap-3">
          {[
            { id: 'regular', label: 'Normale', icon: Sun },
            { id: 'holiday', label: 'Vacanza', icon: Palmtree },
            { id: 'sick', label: 'Malattia', icon: Thermometer },
          ].map((s) => (
            <button
              key={s.id}
              onClick={() => setStatus(s.id as any)}
              className={`p-4 rounded-3xl flex flex-col items-center gap-2 border-2 transition-all ${status === s.id ? 'border-rose-400 bg-rose-50 text-rose-600' : 'border-gray-100 bg-white text-gray-400'}`}
            >
              <s.icon size={20} />
              <span className="text-[10px] font-bold uppercase">{s.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-gray-400">Il tuo umore</label>
        <div className="grid grid-cols-3 gap-3">
          {[
            { id: 'felice', icon: Smile, color: 'text-emerald-500' },
            { id: 'così così', icon: Meh, color: 'text-amber-500' },
            { id: 'difficile', icon: Frown, color: 'text-rose-500' },
          ].map((m) => (
            <button
              key={m.id}
              onClick={() => setMood(m.id)}
              className={`p-4 rounded-3xl flex flex-col items-center gap-2 border-2 transition-all ${mood === m.id ? 'border-rose-400 bg-rose-50' : 'border-gray-100 bg-white'}`}
            >
              <m.icon size={28} className={m.color} />
              <span className="text-[10px] font-bold uppercase text-gray-500">{m.id}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-gray-400">Pensieri ed emozioni</label>
        <textarea
          value={emotions}
          onChange={(e) => setEmotions(e.target.value)}
          placeholder="Come ti senti veramente?"
          className="w-full p-4 rounded-3xl border-2 border-gray-100 focus:border-rose-200 focus:ring-0 min-h-[120px] text-sm"
        />
      </div>

      <div className="flex gap-4 pt-4">
        <button onClick={onCancel} className="flex-1 py-4 rounded-3xl font-bold text-gray-400">Indietro</button>
        <button
          onClick={() => onSubmit({ mood, emotions, status })}
          disabled={isSaving || !emotions.trim()}
          className="flex-[2] bg-rose-400 text-white py-4 rounded-3xl font-bold shadow-lg shadow-rose-100 disabled:opacity-50"
        >
          {isSaving ? 'Salvataggio...' : 'Concludi Giornata'}
        </button>
      </div>
    </div>
  );
};

const ChatView: React.FC<{ messages: ChatMessage[]; onSendMessage: (t: string) => void; isTyping: boolean; isLiveActive: boolean; onToggleLive: () => void }> = ({ messages, onSendMessage, isTyping, isLiveActive, onToggleLive }) => {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isTyping]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSendMessage(input);
    setInput('');
  };

  return (
    <div className="flex flex-col h-[65vh] space-y-4 animate-in fade-in duration-500">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
        {messages.length === 0 && (
          <div className="text-center py-12 space-y-4 opacity-40">
            <Heart size={48} className="mx-auto text-rose-300" />
            <p className="text-sm italic">"Sono qui per ascoltarti e sostenerti, senza giudizio." ✨</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] p-4 rounded-3xl text-sm ${m.role === 'user' ? 'bg-rose-400 text-white rounded-tr-none' : 'bg-white border border-rose-50 text-gray-700 rounded-tl-none shadow-sm'}`}>
              {m.content}
            </div>
          </div>
        ))}
        {isTyping && (
          <div className="flex justify-start">
            <div className="bg-white p-4 rounded-3xl rounded-tl-none border border-rose-50 flex gap-1">
              <div className="w-1.5 h-1.5 bg-rose-300 rounded-full animate-bounce" />
              <div className="w-1.5 h-1.5 bg-rose-300 rounded-full animate-bounce [animation-delay:0.2s]" />
              <div className="w-1.5 h-1.5 bg-rose-300 rounded-full animate-bounce [animation-delay:0.4s]" />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 bg-white p-2 rounded-full border border-gray-100 shadow-sm mt-auto">
        <button 
          onClick={onToggleLive} 
          className={`p-3 rounded-full transition-all shadow-sm ${isLiveActive ? 'bg-rose-500 text-white animate-pulse' : 'bg-rose-50 text-rose-400'}`}
          title={isLiveActive ? "Disattiva Live Voice" : "Attiva Live Voice"}
        >
          {isLiveActive ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Parla con Luce..."
          className="flex-1 bg-transparent border-none focus:ring-0 text-sm px-2"
        />
        <button onClick={handleSend} className="p-3 bg-rose-400 text-white rounded-full shadow-md active:scale-90 transition-transform">
          <Send size={20} />
        </button>
      </div>
    </div>
  );
};

const CalendarView: React.FC<{ user: UserState; onUpdateDay: (dk: string, s: DaySummary) => void }> = ({ user }) => {
  const days = useMemo(() => {
    const today = new Date();
    const result = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      result.push(d);
    }
    return result;
  }, []);

  return (
    <div className="space-y-6 pb-12 animate-in fade-in duration-500">
      <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
        <TrendingUp size={24} className="text-rose-400" /> Il Tuo Viaggio
      </h2>
      <div className="space-y-3">
        {days.map(date => {
          const dk = getLocalDateKey(date);
          const summary = user.history[dk];
          const isSuccessful = isDaySuccessful(summary);
          
          return (
            <div key={dk} className="bg-white p-4 rounded-3xl border border-gray-100 flex items-center justify-between shadow-sm transition-all hover:border-rose-100">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-sm ${isSuccessful ? 'bg-emerald-50 text-emerald-500' : summary ? 'bg-rose-50 text-rose-500' : 'bg-gray-50 text-gray-300'}`}>
                  {date.getDate()}
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-700 capitalize">
                    {date.toLocaleDateString('it-IT', { weekday: 'short', month: 'short' })}
                  </p>
                  <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">
                    {summary?.status === 'holiday' ? 'Vacanza 🌴' : summary?.status === 'sick' ? 'Riposo 🍵' : summary ? 'Completata' : 'In attesa'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {summary?.hasBonus && <Star size={16} className="text-amber-400" fill="currentColor" />}
                {isSuccessful ? (
                  <CheckCircle2 size={24} className="text-emerald-400" />
                ) : summary ? (
                  <X size={24} className="text-rose-300" />
                ) : (
                  <Circle size={24} className="text-gray-100" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const MealSelector: React.FC<{ mealToSelect: string; isWeeklyBonusUsed: boolean; onSelect: (id: string, s: 'regular' | 'bonus' | null) => void; onCancel: () => void; userMeals: Record<string, any> }> = ({ mealToSelect, isWeeklyBonusUsed, onSelect, onCancel, userMeals }) => {
  const meal = MEALS.find(m => m.id === mealToSelect);
  if (!meal) return null;

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-50 flex items-end justify-center p-4 animate-in fade-in duration-300">
      <div className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 space-y-6 shadow-2xl animate-in slide-in-from-bottom-full duration-300">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-rose-50 rounded-3xl flex items-center justify-center mx-auto text-rose-400 mb-2">
            {meal.icon === 'coffee' && <Coffee size={32} />}
            {meal.icon === 'apple' && <Apple size={32} />}
            {meal.icon === 'utensils' && <Utensils size={32} />}
            {meal.icon === 'moon' && <Moon size={32} />}
          </div>
          <h3 className="text-xl font-bold text-gray-800">{meal.label}</h3>
          <p className="text-gray-400 text-sm">Com'è andata la registrazione?</p>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <button 
            onClick={() => onSelect(mealToSelect, 'regular')} 
            className="w-full p-5 rounded-3xl bg-emerald-50 border-2 border-emerald-100 text-emerald-700 font-bold flex items-center justify-between hover:bg-emerald-100 transition-all"
          >
            Pasto Regolare <Check strokeWidth={3} />
          </button>
          <button 
            onClick={() => onSelect(mealToSelect, 'bonus')} 
            disabled={isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus'}
            className={`w-full p-5 rounded-3xl border-2 font-bold flex items-center justify-between transition-all ${isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus' ? 'bg-gray-50 border-gray-100 text-gray-300 cursor-not-allowed' : 'bg-amber-50 border-amber-100 text-amber-700 hover:bg-amber-100'}`}
          >
            Usa Bonus <Star fill={isWeeklyBonusUsed && userMeals[mealToSelect] !== 'bonus' ? 'none' : 'currentColor'} />
          </button>
        </div>
        <button onClick={onCancel} className="w-full text-gray-400 font-bold py-2 hover:text-gray-600 transition-colors">Più tardi</button>
      </div>
    </div>
  );
};

const RewardModal: React.FC<{ onClaim: () => void }> = ({ onClaim }) => {
  return (
    <div className="fixed inset-0 bg-rose-400/90 backdrop-blur-md z-[100] flex items-center justify-center p-8 animate-in fade-in duration-500">
      <div className="bg-white rounded-[3rem] p-10 text-center space-y-6 shadow-2xl max-w-sm animate-in zoom-in-95 duration-500">
        <div className="w-24 h-24 bg-amber-50 rounded-[2rem] flex items-center justify-center mx-auto text-amber-400 mb-4">
          <Trophy size={64} />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-gray-800 leading-tight">Che Splendore! ✨</h2>
          <p className="text-gray-500 italic text-sm">Hai completato la giornata con sincerità verso te stesso. Meriti un grande abbraccio virtuale.</p>
        </div>
        <button 
          onClick={onClaim} 
          className="w-full py-5 bg-rose-400 text-white rounded-3xl font-bold shadow-lg shadow-rose-200 active:scale-90 transition-all"
        >
          Ricevi un Abbraccio 💖
        </button>
      </div>
    </div>
  );
};

export default App;
