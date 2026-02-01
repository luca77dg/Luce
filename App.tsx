
import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  Coffee, 
  Utensils, 
  Moon, 
  Trophy, 
  Check, 
  Star, 
  ChevronLeft, 
  ChevronRight, 
  TrendingUp, 
  Mic, 
  MicOff,
  Apple,
  RotateCcw,
  XCircle,
  Trash2,
  Loader2
} from 'lucide-react';
import { DaySummary, UserState, ChatMessage, CheckInData, MealConfig } from './types';
import { getLuceResponse } from './geminiService';
import { GoogleGenAI, Modality } from '@google/genai';

// --- COSTANTI ---
const MEALS: MealConfig[] = [
  { id: 'colazione', label: 'Colazione', time: '07:00', icon: 'coffee' },
  { id: 'spuntino_mattina', label: 'Spuntino Mattutino', time: '11:00', icon: 'apple' },
  { id: 'pranzo', label: 'Pranzo', time: '13:00', icon: 'utensils' },
  { id: 'spuntino_pomeriggio', label: 'Spuntino Pomeridiano', time: '17:00', icon: 'apple' },
  { id: 'cena', label: 'Cena', time: '20:00', icon: 'moon' },
];

const SYSTEM_INSTRUCTION = `Sei Luce, un assistente virtuale empatico per il recupero alimentare. Il tuo tono è luminoso e incoraggiante. Usa emoji ✨. Rispondi sempre al maschile verso l'utente.`;

// Componente Logo che rispecchia esattamente l'icona iOS
const LuceLogo = ({ className }: { className?: string }) => (
  <svg width="40" height="40" viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg" className={className}>
    <defs>
      <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style={{stopColor:'#FF5E7E'}} />
        <stop offset="100%" style={{stopColor:'#FF2D55'}} />
      </linearGradient>
    </defs>
    <rect width="180" height="180" rx="40" fill="url(#logoGrad)" />
    <circle cx="90" cy="90" r="35" stroke="white" strokeWidth="8" fill="none" />
    <g stroke="white" strokeWidth="8" strokeLinecap="round">
      <line x1="90" y1="30" x2="90" y2="45" />
      <line x1="90" y1="135" x2="90" y2="150" />
      <line x1="30" y1="90" x2="45" y2="90" />
      <line x1="135" y1="90" x2="150" y2="90" />
      <line x1="48" y1="48" x2="58" y2="58" />
      <line x1="122" y1="122" x2="132" y2="132" />
      <line x1="132" y1="48" x2="122" y2="58" />
      <line x1="58" y1="122" x2="48" y2="132" />
    </g>
  </svg>
);

// --- HELPER FUNCTIONS ---
function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
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

const getLocalDateKey = (date: Date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const getWeekMonday = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
};

const hasBonusInWeek = (history: Record<string, DaySummary>, date: Date, excludeDateKey?: string) => {
  const monday = getWeekMonday(date);
  for (let i = 0; i < 7; i++) {
    const checkDate = new Date(monday);
    checkDate.setDate(monday.getDate() + i);
    const key = getLocalDateKey(checkDate);
    if (key === excludeDateKey) continue;
    if (history[key]?.hasBonus) return true;
  }
  return false;
};

const isDaySuccessful = (summary: DaySummary | undefined): boolean => {
  if (!summary) return false;
  if (summary.status === 'holiday' || summary.status === 'sick') return true;
  return !!summary.isCompleted;
};

const calculateDayCompletion = (status: 'regular' | 'holiday' | 'sick', meals: Record<string, any>, history: Record<string, DaySummary>, date: Date, excludeKey?: string) => {
  if (status === 'holiday' || status === 'sick') return true;
  const mealsValues = Object.values(meals);
  const mealsCount = mealsValues.filter(v => v !== null).length;
  const hasBonus = mealsValues.some(v => v === 'bonus');
  const hasKo = mealsValues.some(v => v === 'ko');
  const otherBonusInWeek = hasBonusInWeek(history, date, excludeKey);
  return mealsCount === MEALS.length && !hasKo && !(hasBonus && otherBonusInWeek);
};

const isDayFailed = (summary: DaySummary | undefined, date: Date, today: Date): boolean => {
  if (!summary) return date < today;
  const mealsValues = Object.values(summary.meals || {});
  if (mealsValues.some(v => v === 'ko')) return true;
  if (summary.status === 'regular' && date < today && !summary.isCompleted) return true;
  return false;
};

const calculateDailyStreak = (history: Record<string, DaySummary>): number => {
  let streak = 0;
  let checkDate = new Date();
  checkDate.setHours(0, 0, 0, 0);
  const today = new Date(checkDate);
  const todayKey = getLocalDateKey(today);
  if (isDayFailed(history[todayKey], today, today)) {
    checkDate.setDate(checkDate.getDate() - 1);
  }
  while (streak < 3650) {
    const dk = getLocalDateKey(checkDate);
    const summary = history[dk];
    if (summary && !isDayFailed(summary, checkDate, today) && (summary.isCompleted || summary.status !== 'regular')) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (dk === getLocalDateKey(today) && !isDayFailed(summary, checkDate, today)) {
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
};

const calculateWeeklyStreak = (history: Record<string, DaySummary>): number => {
  const historyKeys = Object.keys(history);
  if (historyKeys.length === 0) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sortedKeys = historyKeys.sort();
  const firstMonday = getWeekMonday(parseDateKey(sortedKeys[0]));
  const currentMonday = getWeekMonday(today);
  let totalCount = 0;
  let checkMonday = new Date(currentMonday);
  while (checkMonday >= firstMonday) {
    let weekStatus: 'pending' | 'success' | 'fail' = 'success';
    let anyRegular = false;
    let hasKoInWeek = false;
    for (let i = 0; i < 7; i++) {
      const d = new Date(checkMonday);
      d.setDate(checkMonday.getDate() + i);
      const dk = getLocalDateKey(d);
      const summary = history[dk];
      const mealsValues = summary?.meals ? Object.values(summary.meals) : [];
      if (mealsValues.some(v => v === 'ko')) hasKoInWeek = true;
      if (!isDaySuccessful(summary)) {
        if (d >= today) weekStatus = 'pending';
        else weekStatus = 'fail';
      } else {
        if (summary.status === 'regular') anyRegular = true;
      }
    }
    if (hasKoInWeek || weekStatus === 'fail') break;
    if (weekStatus === 'success' && anyRegular) totalCount++;
    checkMonday.setDate(checkMonday.getDate() - 7);
  }
  return totalCount;
};

// --- COMPONENTE PRINCIPALE ---
const App: React.FC = () => {
  const [view, setView] = useState<'dashboard' | 'checkin' | 'chat' | 'calendar'>('dashboard');
  const [aiStatus, setAiStatus] = useState<'checking' | 'ok' | 'error'>('ok');
  
  const [user, setUser] = useState<UserState>(() => {
    const defaultState: UserState = {
      streak: 0, weeklyStreak: 0, bonusUsed: false, lastCheckIn: null, name: 'Luca', dailyMeals: {}, rewardClaimed: false, isDayClosed: false, history: {}
    };
    try {
      const saved = localStorage.getItem('luce_user_v8');
      if (!saved) return defaultState;
      const parsed = JSON.parse(saved);
      const history = parsed.history || {};
      const newStreak = calculateDailyStreak(history);
      const newWeeklyStreak = calculateWeeklyStreak(history);
      const todayStr = new Date().toDateString();
      const todayKey = getLocalDateKey();
      if (parsed.lastCheckIn !== todayStr) {
        const todayHistory = history[todayKey];
        return { ...parsed, dailyMeals: todayHistory?.meals || {}, rewardClaimed: false, isDayClosed: false, streak: newStreak, weeklyStreak: newWeeklyStreak, history: history };
      }
      const todayHistory = history[todayKey];
      return { ...parsed, dailyMeals: todayHistory?.meals || parsed.dailyMeals || {}, streak: newStreak, weeklyStreak: newWeeklyStreak, history: history };
    } catch { return defaultState; }
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [mealToSelect, setMealToSelect] = useState<string | null>(null);

  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isLiveLoading, setIsLiveLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem('luce_user_v8', JSON.stringify(user));
  }, [user]);

  const todayKey = getLocalDateKey();
  const currentMeals = useMemo(() => {
    return user.history[todayKey]?.meals || user.dailyMeals || {};
  }, [user.history, user.dailyMeals, todayKey]);

  const setMealStatus = (mealId: string, status: 'regular' | 'bonus' | 'ko' | null) => {
    const now = new Date();
    const dateKey = getLocalDateKey(now);
    setUser(prev => {
      const currentMealsInHistory = prev.history[dateKey]?.meals || prev.dailyMeals;
      const newDailyMeals = { ...currentMealsInHistory, [mealId]: status };
      const mealsValues = Object.values(newDailyMeals);
      const mealsCount = mealsValues.filter(v => v !== null).length;
      const hasBonus = mealsValues.some(v => v === 'bonus');
      const currentStatus = prev.history[dateKey]?.status || 'regular';
      const isCompleted = calculateDayCompletion(currentStatus, newDailyMeals, prev.history, now, dateKey);
      const summary: DaySummary = { ...prev.history[dateKey], date: dateKey, isCompleted, mealsCount, hasBonus, mood: prev.history[dateKey]?.mood || 'felice', meals: newDailyMeals, status: currentStatus };
      const newHistory = { ...prev.history, [dateKey]: summary };
      return { ...prev, dailyMeals: newDailyMeals, history: newHistory, streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory) };
    });
    setMealToSelect(null);
  };

  const updateHistoryEntry = (dk: string, summary: DaySummary) => {
    const isToday = dk === getLocalDateKey();
    setUser(prev => {
      const newHistory = { ...prev.history, [dk]: summary };
      return { ...prev, history: newHistory, dailyMeals: isToday ? (summary.meals || {}) : prev.dailyMeals, streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory) };
    });
  };

  const sendMessage = async (text: string, silent = false) => {
    if (!text.trim()) return;
    if (!silent) setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date() }]);
    setIsTyping(true);
    const responseText = await getLuceResponse(messages, text);
    if (responseText === "OPS_KEY_ERROR") {
      setAiStatus('error');
      setMessages(prev => [...prev, { role: 'assistant', content: "Configurazione API non valida. Verifica l'API KEY su Vercel ✨", timestamp: new Date() }]);
    } else {
      setAiStatus('ok');
      setMessages(prev => [...prev, { role: 'assistant', content: responseText, timestamp: new Date() }]);
    }
    setIsTyping(false);
  };

  const toggleLive = async () => {
    if (isLiveActive) {
      sessionRef.current?.close();
      setIsLiveActive(false);
      return;
    }

    setIsLiveLoading(true);
    try {
      const apiKey = typeof process !== 'undefined' ? process.env.API_KEY : null;
      if (!apiKey) {
        setAiStatus('error');
        setIsLiveLoading(false);
        return;
      }

      // iOS Check: Navigator mediaDevices might be restricted in some PWA contexts
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("L'accesso al microfono non è disponibile in questa modalità. Riprova da Safari.");
        setIsLiveLoading(false);
        return;
      }

      const ai = new GoogleGenAI({ apiKey: apiKey });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
      const inputCtx = new AudioContextClass({ sampleRate: 16000 });
      const outputCtx = new AudioContextClass({ sampleRate: 24000 });

      // iOS REQUIREMENT: Resume AudioContext from user gesture
      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();

      outputAudioContextRef.current = outputCtx;
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            setIsLiveActive(true);
            setIsLiveLoading(false);
            setAiStatus('ok');
          },
          onmessage: async (msg) => {
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              source.start();
            }
          },
          onclose: () => {
            setIsLiveActive(false);
            setIsLiveLoading(false);
          },
          onerror: () => {
            setIsLiveActive(false);
            setIsLiveLoading(false);
            setAiStatus('error');
          }
        },
        config: { responseModalities: [Modality.AUDIO], systemInstruction: SYSTEM_INSTRUCTION }
      });
      sessionRef.current = await sessionPromise;
    } catch (e) { 
      console.error(e);
      setIsLiveActive(false);
      setIsLiveLoading(false);
      setAiStatus('error');
    }
  };

  const closeDay = (data: CheckInData & { meals?: Record<string, 'regular' | 'bonus' | 'ko' | null> }) => {
    const dk = getLocalDateKey();
    setUser(prev => {
      const mealsToUse = data.meals || prev.dailyMeals;
      const mealsValues = Object.values(mealsToUse);
      const mealsCount = mealsValues.filter(v => v !== null).length;
      const hasBonus = mealsValues.some(v => v === 'bonus');
      const isCompleted = calculateDayCompletion(data.status || 'regular', mealsToUse, prev.history, new Date(), dk);
      const summary: DaySummary = { ...prev.history[dk], date: dk, isCompleted, mood: data.mood, status: data.status, mealsCount, hasBonus, meals: mealsToUse };
      const newHistory = { ...prev.history, [dk]: summary };
      return { ...prev, history: newHistory, dailyMeals: mealsToUse, isDayClosed: true, lastCheckIn: new Date().toDateString(), streak: calculateDailyStreak(newHistory), weeklyStreak: calculateWeeklyStreak(newHistory) };
    });
    setView('dashboard');
    setShowReward(true);
    sendMessage("Ho completato la giornata! Grazie Luce ✨", true);
  };

  const bonusUsedThisWeek = useMemo(() => hasBonusInWeek(user.history, new Date()), [user.history]);

  const motivationalPhrase = useMemo(() => {
    if (user.isDayClosed) return "Splendido lavoro per oggi! Luce è fiera di te. 💖";
    if (user.weeklyStreak >= 4) return "Oltre un mese di cammino! La tua luce splende fortissima. 🌟";
    if (user.weeklyStreak >= 1) return "Settimane di coraggio! Continua così, un passo alla volta. 🌈";
    if (user.streak >= 3) return "Stai andando alla grande! La costanza è la tua superpotenza. 🦋";
    if (user.streak > 0) return "Hai iniziato il tuo viaggio! Ogni pasto è una vittoria. 🌸";
    return "Sii gentile con te stesso oggi. Sei prezioso e unico. ✨";
  }, [user.weeklyStreak, user.streak, user.isDayClosed]);

  return (
    <div className="min-h-screen max-w-md mx-auto flex flex-col bg-[#fffafb] shadow-2xl relative overflow-hidden">
      <header className="px-6 pt-8 pb-4 flex justify-between items-center z-10">
        <div className="flex items-center gap-3">
          <LuceLogo className="shadow-lg rounded-xl" />
          <h1 className="text-xl font-extrabold text-gray-900 tracking-tight">Luce</h1>
        </div>
        {view === 'dashboard' && !user.isDayClosed ? (
          <button onClick={() => setView('checkin')} className="p-2 rounded-full hover:bg-rose-50 text-gray-900 transition-colors">
            <ArrowRight size={24} strokeWidth={2.5} />
          </button>
        ) : view !== 'dashboard' ? (
          <button onClick={() => setView('dashboard')} className="p-2 rounded-full hover:bg-rose-50 text-gray-900 transition-colors">
            <ArrowRight className="rotate-180" size={24} strokeWidth={2.5} />
          </button>
        ) : null}
      </header>

      <main className="flex-1 px-6 pb-2 z-10 overflow-y-auto custom-scrollbar">
        {view === 'dashboard' && (
          <div className="space-y-6 animate-in fade-in duration-500 pb-12">
            <div className="space-y-1">
              <h2 className="text-3xl font-extrabold text-gray-900 tracking-tight">Ciao, {user.name} ✨</h2>
              <p className="text-gray-700 text-sm font-semibold leading-relaxed">{motivationalPhrase}</p>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-[#fcf5e5] p-6 rounded-[2.2rem] flex flex-col items-center border border-[#f5ead2] shadow-sm transition-all active:scale-95">
                <Star className="text-[#F4A261] mb-2" size={36} fill="#F4A261" />
                <span className="text-4xl font-black text-[#5C4033]">{user.weeklyStreak}</span>
                <span className="text-[11px] uppercase font-black text-[#D4A373] text-center tracking-widest mt-1">Settimane</span>
              </div>
              <div className={`${bonusUsedThisWeek ? 'bg-rose-50 border-rose-100' : 'bg-[#e8f5f1] border-[#d8ebe6]'} p-6 rounded-[2.2rem] flex flex-col items-center border shadow-sm transition-all active:scale-95`}>
                {bonusUsedThisWeek ? (
                  <Sparkles className="text-rose-500 mb-2" size={36} />
                ) : (
                  <Heart className="text-[#2A9D8F] mb-2" size={36} fill="#2A9D8F" />
                )}
                <span className={`text-xl font-black ${bonusUsedThisWeek ? 'text-rose-700' : 'text-[#1D3557]'} text-center leading-tight mt-1 tracking-tight`}>{bonusUsedThisWeek ? 'Usato' : 'Libero'}</span>
                <span className={`text-[11px] uppercase font-black ${bonusUsedThisWeek ? 'text-rose-400' : 'text-[#2A9D8F]'} text-center tracking-widest mt-auto`}>Bonus Sett.</span>
              </div>
            </div>

            <div className="bg-gray-100/40 p-6 rounded-[2.5rem] space-y-3 shadow-inner">
              <h3 className="font-black text-gray-900 mb-2 flex items-center gap-2 text-base uppercase tracking-wider"><Sun className="text-amber-500" size={22} strokeWidth={2.5} /> Pasti Odierni</h3>
              {MEALS.map(meal => (
                <button key={meal.id} onClick={() => !user.isDayClosed && setMealToSelect(meal.id)} disabled={user.isDayClosed} className="w-full flex items-center justify-between p-4 rounded-3xl bg-white shadow-sm active:scale-95 transition-all group border border-gray-100/50">
                  <div className="flex items-center gap-4">
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center bg-gray-50 group-hover:bg-rose-50 transition-colors">
                      {meal.icon === 'coffee' && <Coffee size={22} className="text-gray-600" strokeWidth={2} />}
                      {meal.icon === 'apple' && <Apple size={22} className="text-gray-600" strokeWidth={2} />}
                      {meal.icon === 'utensils' && <Utensils size={22} className="text-gray-600" strokeWidth={2} />}
                      {meal.icon === 'moon' && <Moon size={22} className="text-gray-600" strokeWidth={2} />}
                    </div>
                    <div className="text-left"><p className="text-[15px] font-extrabold text-gray-900">{meal.label}</p><p className="text-[11px] text-gray-500 font-medium">{meal.time}</p></div>
                  </div>
                  {currentMeals[meal.id] ? (
                    <div className={`rounded-full p-1 border-2 ${currentMeals[meal.id] === 'ko' ? 'border-rose-500 text-rose-500' : currentMeals[meal.id] === 'bonus' ? 'border-amber-500 text-amber-500' : 'border-emerald-500 bg-emerald-500 text-white shadow-emerald-200 shadow-lg'}`}>
                      {currentMeals[meal.id] === 'ko' ? <XCircle size={20} strokeWidth={2.5} /> : currentMeals[meal.id] === 'bonus' ? <Star size={20} strokeWidth={2.5} fill="currentColor" /> : <Check size={20} strokeWidth={3} />}
                    </div>
                  ) : (
                    <div className="w-7 h-7 rounded-full border-2 border-gray-200" />
                  )}
                </button>
              ))}
            </div>

            {user.isDayClosed && (
              <div className="p-6 bg-rose-50 rounded-[2.5rem] text-center text-rose-700 font-black border border-rose-200 animate-in fade-in shadow-sm tracking-tight">
                Giornata conclusa con cura ✨
              </div>
            )}
            
            <div className="flex justify-center"><div className={`px-5 py-2 rounded-full border-2 flex items-center gap-2 shadow-sm ${aiStatus === 'ok' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}><div className={`w-2 h-2 rounded-full ${aiStatus === 'ok' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} /><span className="text-[10px] font-black uppercase tracking-widest">{aiStatus === 'ok' ? 'Luce Online' : 'Luce Offline'}</span></div></div>
          </div>
        )}
        
        {view === 'checkin' && <CheckInForm history={user.history} dateKey={getLocalDateKey()} initialData={{ mood: user.history[getLocalDateKey()]?.mood || 'felice', status: user.history[getLocalDateKey()]?.status || 'regular', meals: currentMeals }} onSubmit={closeDay} onCancel={() => setView('dashboard')} />}
        {view === 'chat' && <ChatView messages={messages} onSendMessage={sendMessage} isTyping={isTyping} isLiveActive={isLiveActive} isLiveLoading={isLiveLoading} onToggleLive={toggleLive} />}
        {view === 'calendar' && <CalendarView user={user} onUpdate={updateHistoryEntry} />}
      </main>

      {mealToSelect && <MealSelector mealId={mealToSelect} isBonusAvailable={!bonusUsedThisWeek} onSelect={setMealStatus} onCancel={() => setMealToSelect(null)} />}
      {showReward && <RewardModal onClaim={() => setShowReward(false)} />}

      <nav className="p-4 flex justify-around items-center border-t border-gray-200 bg-white z-20 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-4px_20px_rgba(0,0,0,0.03)]">
        <button onClick={() => setView('calendar')} className={`flex flex-col items-center gap-1 transition-all ${view === 'calendar' ? 'text-gray-900 scale-110' : 'text-gray-400 hover:text-rose-400'}`}><CalendarIcon size={30} strokeWidth={view === 'calendar' ? 2.5 : 2} /></button>
        <div className="relative -top-6"><button onClick={() => setView('dashboard')} className={`w-18 h-18 rounded-full flex items-center justify-center text-white shadow-2xl border-6 border-white transition-all ${view === 'dashboard' ? 'bg-rose-500 scale-110' : 'bg-gray-400 hover:bg-rose-300'}`}><Sun size={36} strokeWidth={2.5} /></button></div>
        <button onClick={() => setView('chat')} className={`flex flex-col items-center gap-1 transition-all ${view === 'chat' ? 'text-gray-800 scale-110' : 'text-gray-400 hover:text-rose-400'}`}><MessageCircle size={30} strokeWidth={view === 'chat' ? 2.5 : 2} /></button>
      </nav>
    </div>
  );
};

const CheckInForm: React.FC<any> = ({ onSubmit, onCancel, initialData, history, dateKey }) => {
  const [mood, setMood] = useState(initialData?.mood || 'felice');
  const [status, setStatus] = useState(initialData?.status || 'regular');
  const [meals, setMeals] = useState<Record<string, 'regular' | 'bonus' | 'ko' | null>>(initialData?.meals || {});
  const currentDayKey = dateKey || getLocalDateKey();
  const bonusUsedInWeek = useMemo(() => hasBonusInWeek(history || {}, parseDateKey(currentDayKey), currentDayKey), [history, currentDayKey]);

  const setStatusAndMeals = (newStatus: 'regular' | 'holiday' | 'sick') => {
    setStatus(newStatus);
    if (newStatus === 'regular') {
      const allRegular: Record<string, 'regular'> = {};
      MEALS.forEach(m => allRegular[m.id] = 'regular');
      setMeals(allRegular);
    }
  };

  const toggleMeal = (mealId: string) => {
    setMeals(prev => {
      const current = prev[mealId];
      let next: 'regular' | 'bonus' | 'ko' | null = null;
      if (!current) next = 'regular';
      else if (current === 'regular') next = bonusUsedInWeek ? 'ko' : 'bonus';
      else if (current === 'bonus') next = 'ko';
      else next = 'regular';
      return { ...prev, [mealId]: next };
    });
  };

  const resetMeal = (mealId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setMeals(prev => ({ ...prev, [mealId]: null }));
  };

  const resetDay = () => {
    setStatus('regular');
    setMood('felice');
    const emptyMeals: Record<string, null> = {};
    MEALS.forEach(m => emptyMeals[m.id] = null);
    setMeals(emptyMeals);
  };

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom duration-500 pb-12">
      <h2 className="text-3xl font-black text-gray-900 leading-tight tracking-tight">Com'è andata la giornata?</h2>
      <div className="space-y-4">
        <p className="text-[11px] font-black text-gray-500 uppercase tracking-widest">Stato Odierno</p>
        <div className="grid grid-cols-3 gap-3">
          {['regular', 'holiday', 'sick'].map(s => (
            <button key={s} onClick={() => setStatusAndMeals(s as any)} className={`py-4 rounded-3xl border-3 transition-all font-black text-[11px] uppercase shadow-sm ${status === s ? 'border-rose-500 bg-rose-50 text-rose-700' : 'bg-white text-gray-400 border-gray-100'}`}>{s === 'regular' ? 'Regolare' : s === 'holiday' ? 'Ferie' : 'Malattia'}</button>
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <p className="text-[11px] font-black text-gray-500 uppercase tracking-widest">Controlla i tuoi Pasti</p>
        <div className="space-y-3">
          {MEALS.map(meal => (
            <div key={meal.id} onClick={() => toggleMeal(meal.id)} className="w-full flex items-center justify-between p-4 rounded-2xl bg-white border border-gray-200 shadow-sm active:scale-[0.98] transition-all cursor-pointer group">
              <span className="text-sm font-black text-gray-900">{meal.label}</span>
              <div className="flex items-center gap-3">
                <div className={`px-4 py-2 rounded-full text-[11px] font-black uppercase transition-all shadow-sm border-2 ${meals[meal.id] === 'bonus' ? 'bg-amber-100 text-amber-700 border-amber-300' : meals[meal.id] === 'regular' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : meals[meal.id] === 'ko' ? 'bg-rose-100 text-rose-700 border-rose-300' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>{meals[meal.id] === 'bonus' ? 'Bonus' : meals[meal.id] === 'regular' ? 'Ok' : meals[meal.id] === 'ko' ? 'KO' : 'Incompleto'}</div>
                {meals[meal.id] !== null && <button onClick={(e) => resetMeal(meal.id, e)} className="p-2 hover:bg-gray-100 rounded-full text-gray-600 transition-colors"><RotateCcw size={18} strokeWidth={2.5} /></button>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <p className="text-[11px] font-black text-gray-500 uppercase tracking-widest">Il tuo Mood</p>
        <div className="grid grid-cols-3 gap-3">
          {[{ id: 'felice', icon: Smile, color: 'text-emerald-600' }, { id: 'così così', icon: Meh, color: 'text-amber-600' }, { id: 'difficile', icon: Frown, color: 'text-rose-600' }].map(m => (
            <button key={m.id} onClick={() => setMood(m.id)} className={`p-6 rounded-3xl border-3 transition-all ${mood === m.id ? 'border-rose-500 bg-rose-50 shadow-lg scale-105' : 'bg-white border-gray-100'}`}><m.icon size={36} strokeWidth={2.5} className={`mx-auto ${mood === m.id ? m.color : 'text-gray-300'}`} /></button>
          ))}
        </div>
      </div>
      <div className="space-y-4 pt-4">
        <button onClick={resetDay} className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-gray-100 text-gray-700 font-black text-[11px] uppercase border-2 border-dashed border-gray-300 hover:bg-gray-200 transition-all tracking-widest"><Trash2 size={18} /> Resetta Giornata</button>
      </div>
      <div className="flex gap-4 pt-4">
        <button onClick={onCancel} className="flex-1 py-5 font-black text-gray-500 uppercase text-[11px] tracking-widest">Annulla</button>
        <button onClick={() => onSubmit({ mood, status, meals })} className="flex-[2] bg-rose-500 text-white py-5 rounded-[2.2rem] font-black shadow-2xl active:scale-95 transition-all text-sm uppercase tracking-widest">Salva Progressi ✨</button>
      </div>
    </div>
  );
};

const CalendarView: React.FC<any> = ({ user, onUpdate }) => {
  const [curr, setCurr] = useState(new Date());
  const [editing, setEditing] = useState<any>(null);
  const grid = useMemo(() => {
    const y = curr.getFullYear(), m = curr.getMonth();
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const padding = firstDay === 0 ? 6 : firstDay - 1;
    const items = [];
    for (let i = 0; i < padding; i++) items.push(null);
    for (let i = 1; i <= daysInMonth; i++) items.push(new Date(y, m, i));
    const weeks = [];
    for (let i = 0; i < items.length; i += 7) weeks.push(items.slice(i, i + 7));
    return weeks;
  }, [curr]);

  const getWeekStatusIcon = (sundayDate: Date) => {
    let hasRegularDay = false, allSuccessful = true, hasAnyKo = false;
    for (let i = 0; i < 7; i++) {
      const d = new Date(sundayDate); d.setDate(sundayDate.getDate() - i);
      const dk = getLocalDateKey(d); const summary = user.history[dk];
      if (!isDaySuccessful(summary)) allSuccessful = false;
      if (summary) {
        if (summary.status === 'regular') hasRegularDay = true;
        const mealsValues = summary.meals ? Object.values(summary.meals) : [];
        if (mealsValues.some(v => v === 'ko')) hasAnyKo = true;
      } else {
        const today = new Date(); today.setHours(0,0,0,0);
        if (d < today) allSuccessful = false;
      }
    }
    if (hasAnyKo) return <div className="w-8 h-8 bg-rose-50 rounded-full flex items-center justify-center border border-rose-200 shadow-sm"><XCircle size={15} className="text-rose-600" strokeWidth={2.5} /></div>;
    if (allSuccessful && hasRegularDay) return <div className="w-8 h-8 bg-amber-50 rounded-full flex items-center justify-center border border-amber-200 animate-pulse shadow-sm"><Star size={15} className="text-amber-600 fill-amber-500" strokeWidth={2.5} /></div>;
    return <div className="w-2 h-2 rounded-full bg-gray-200" />;
  };

  const getDayColorClass = (dk: string) => {
    const summary = user.history[dk];
    if (!summary) return 'bg-gray-100 text-gray-500';
    const mealsValues = summary.meals ? Object.values(summary.meals) : [];
    if (!mealsValues.some(v => v !== null) && summary.status === 'regular') return 'bg-gray-100 text-gray-500';
    if (summary.status === 'holiday') return 'bg-sky-100 text-sky-800 border-2 border-sky-300';
    if (summary.status === 'sick') return 'bg-amber-100 text-amber-800 border-2 border-amber-300';
    if (summary.isCompleted) return 'bg-emerald-100 text-emerald-800 border-2 border-emerald-300';
    return 'bg-rose-100 text-rose-800 border-2 border-rose-300';
  };

  if (editing) return <CheckInForm history={user.history} dateKey={editing.key} initialData={{ mood: user.history[editing.key]?.mood || 'felice', status: user.history[editing.key]?.status || 'regular', meals: user.history[editing.key]?.meals || {} }} onSubmit={(d:any) => { const targetDate = parseDateKey(editing.key); const isCompleted = calculateDayCompletion(d.status || 'regular', d.meals || {}, user.history, targetDate, editing.key); onUpdate(editing.key, { ...user.history[editing.key], ...d, isCompleted }); setEditing(null); }} onCancel={() => setEditing(null)} />;

  return (
    <div className="space-y-6 pb-12 animate-in fade-in">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2 tracking-tight"><TrendingUp className="text-rose-500" strokeWidth={3} /> Il Tuo Viaggio</h2>
        <div className="flex items-center gap-2 bg-white p-1 rounded-full border-2 border-gray-100 shadow-sm">
          <button onClick={() => setCurr(new Date(curr.getFullYear(), curr.getMonth() - 1, 1))} className="p-2 hover:bg-rose-50 rounded-full transition-colors"><ChevronLeft size={22} strokeWidth={2.5} /></button>
          <span className="text-xs font-black uppercase px-2 text-gray-900">{curr.toLocaleDateString('it-IT', { month: 'short', year: 'numeric' })}</span>
          <button onClick={() => setCurr(new Date(curr.getFullYear(), curr.getMonth() + 1, 1))} className="p-2 hover:bg-rose-50 rounded-full transition-colors"><ChevronRight size={22} strokeWidth={2.5} /></button>
        </div>
      </div>
      <div className="bg-white p-6 rounded-[2.5rem] shadow-md border-2 border-gray-100/50 overflow-hidden">
        <div className="grid grid-cols-8 gap-2 mb-4">
          {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom', 'Premio'].map(h => <div key={h} className="text-center text-[9px] font-black text-gray-400 uppercase tracking-tighter">{h}</div>)}
          {grid.map((week, wi) => (
            <React.Fragment key={wi}>
              {week.map((d, di) => d ? <button key={getLocalDateKey(d)} onClick={() => setEditing({ date: d, key: getLocalDateKey(d) })} className={`w-10 h-10 rounded-xl flex items-center justify-center text-[13px] font-black transition-all hover:scale-110 active:scale-90 ${getDayColorClass(getLocalDateKey(d))} ${getLocalDateKey(d) === getLocalDateKey() ? 'ring-3 ring-rose-400 ring-offset-2' : ''}`}>{d.getDate()}</button> : <div key={`empty-${wi}-${di}`} className="w-10 h-10" />)}
              <div className="flex justify-center items-center">{week[6] && getWeekStatusIcon(week[6])}</div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

const ChatView: React.FC<any> = ({ messages, onSendMessage, isTyping, isLiveActive, isLiveLoading, onToggleLive }) => {
  const [inp, setInp] = useState('');
  return (
    <div className="flex flex-col h-[65vh] space-y-4">
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
        {messages.length === 0 && <div className="text-center p-10 space-y-3"><div className="w-20 h-20 bg-rose-100 rounded-full flex items-center justify-center mx-auto text-rose-500"><MessageCircle size={40} strokeWidth={2.5} /></div><p className="text-base text-gray-900 font-black tracking-tight">Inizia a parlare con Luce ✨</p></div>}
        {messages.map((m: any, i: number) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`p-5 rounded-[2rem] text-[15px] font-bold max-w-[85%] leading-snug shadow-sm ${m.role === 'user' ? 'bg-rose-500 text-white' : 'bg-white border-2 border-rose-50 text-gray-900'}`}>{m.content}</div>
          </div>
        ))}
        {isTyping && <div className="text-rose-600 text-[11px] animate-pulse font-black uppercase tracking-widest px-4">Luce sta scrivendo...</div>}
      </div>
      <div className="flex gap-2 bg-white p-1.5 rounded-full border-2 border-rose-100 shadow-xl items-center mt-auto">
        <button 
          onClick={onToggleLive} 
          disabled={isLiveLoading}
          className={`flex-shrink-0 w-12 h-12 flex items-center justify-center rounded-full transition-all ${isLiveActive ? 'bg-rose-600 text-white animate-pulse shadow-lg' : isLiveLoading ? 'bg-gray-100 text-gray-400' : 'bg-rose-50 text-rose-500 active:scale-90'}`}
        >
          {isLiveLoading ? <Loader2 size={22} className="animate-spin" /> : isLiveActive ? <MicOff size={22} strokeWidth={2.5} /> : <Mic size={22} strokeWidth={2.5} />}
        </button>
        <input 
          value={inp} 
          onChange={e => setInp(e.target.value)} 
          onKeyDown={e => e.key === 'Enter' && inp.trim() && (onSendMessage(inp), setInp(''))} 
          placeholder="Parla con Luce..." 
          className="flex-1 min-w-0 text-[15px] font-bold bg-transparent outline-none px-2 text-gray-900 placeholder:text-gray-300" 
        />
        <button 
          onClick={() => inp.trim() && (onSendMessage(inp), setInp(''))} 
          className="flex-shrink-0 w-12 h-12 flex items-center justify-center bg-rose-500 text-white rounded-full shadow-lg active:scale-90 transition-all"
        >
          <Send size={22} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
};

const MealSelector: React.FC<any> = ({ onSelect, onCancel, isBonusAvailable, mealId }) => (
  <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[60] flex items-end p-4 animate-in fade-in">
    <div className="w-full bg-white rounded-[3.5rem] p-10 space-y-8 animate-in slide-in-from-bottom duration-300 shadow-[0_-20px_50px_rgba(0,0,0,0.1)]">
      <div className="text-center space-y-3"><h3 className="font-black text-2xl text-gray-900 tracking-tight">Cura il tuo Pasto</h3><p className="text-sm text-gray-600 font-bold">Ogni scelta è un passo verso il benessere.</p></div>
      <div className="grid gap-5">
        <button onClick={() => onSelect(mealId, 'regular')} className="w-full p-7 bg-emerald-50 text-emerald-900 rounded-[2rem] font-black text-lg flex justify-between items-center border-3 border-emerald-200 hover:bg-emerald-100 transition-colors">Pasto Regolare <Check size={28} strokeWidth={3} /></button>
        <button onClick={() => isBonusAvailable && onSelect(mealId, 'bonus')} disabled={!isBonusAvailable} className={`w-full p-7 rounded-[2rem] font-black text-lg flex justify-between items-center border-3 transition-all ${isBonusAvailable ? 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100' : 'bg-gray-50 text-gray-400 border-gray-200 opacity-60 cursor-not-allowed'}`}>Usa Bonus <Star size={28} strokeWidth={2.5} fill={isBonusAvailable ? "currentColor" : "none"} /></button>
        <button onClick={() => onSelect(mealId, 'ko')} className="w-full p-7 bg-rose-50 text-rose-900 rounded-[2rem] font-black text-lg flex justify-between items-center border-3 border-rose-200 hover:bg-rose-100 transition-colors">Pasto Saltato / KO <XCircle size={28} strokeWidth={2.5} /></button>
      </div>
      <button onClick={onCancel} className="w-full py-2 text-gray-500 font-black uppercase text-[12px] tracking-widest hover:text-gray-900 transition-colors">Più tardi</button>
    </div>
  </div>
);

const RewardModal: React.FC<any> = ({ onClaim }) => (
  <div className="fixed inset-0 bg-rose-500/95 z-[100] flex items-center justify-center p-10 backdrop-blur-xl animate-in fade-in">
    <div className="bg-white rounded-[3.5rem] p-14 text-center space-y-8 animate-in zoom-in duration-500 shadow-2xl max-w-sm">
      <div className="w-28 h-28 bg-amber-50 rounded-full flex items-center justify-center mx-auto shadow-inner"><Trophy size={70} className="text-amber-500" strokeWidth={2} /></div>
      <div className="space-y-3"><h2 className="text-3xl font-black text-gray-900 tracking-tight leading-tight">Che Splendore! ✨</h2><p className="text-gray-700 text-base font-bold leading-relaxed">Hai concluso un'altra giornata con coraggio e sincerità. Sii fiero di te.</p></div>
      <button onClick={onClaim} className="w-full py-7 bg-rose-500 text-white rounded-[2.5rem] font-black shadow-2xl active:scale-95 transition-all text-xl uppercase tracking-wider">Un Abbraccio per Te 💖</button>
    </div>
  </div>
);

export default App;
