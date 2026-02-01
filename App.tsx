
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
  Trash2
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
  return summary.isCompleted;
};

const calculateDailyStreak = (history: Record<string, DaySummary>): number => {
  let streak = 0;
  let checkDate = new Date();
  const todayKey = getLocalDateKey(checkDate);
  if (!isDaySuccessful(history[todayKey])) checkDate.setDate(checkDate.getDate() - 1);
  
  while (streak < 3650) {
    const dk = getLocalDateKey(checkDate);
    const summary = history[dk];
    if (isDaySuccessful(summary)) { 
      streak++; 
      checkDate.setDate(checkDate.getDate() - 1); 
    } else break;
  }
  return streak;
};

const calculateWeeklyStreak = (history: Record<string, DaySummary>): number => {
  let count = 0;
  let d = new Date();
  d.setHours(0, 0, 0, 0);
  
  const day = d.getDay();
  const diffToSunday = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diffToSunday);
  
  const sortedKeys = Object.keys(history).sort();
  if (sortedKeys.length === 0) return 0;
  const earliestDate = parseDateKey(sortedKeys[0]);
  earliestDate.setHours(0,0,0,0);

  const today = new Date();
  today.setHours(0,0,0,0);

  while(d >= earliestDate) {
    let weekSuccess = true;
    let anyRegular = false;
    let hasDataForWeek = false;

    for(let i = 0; i < 7; i++) {
      let check = new Date(d);
      check.setDate(d.getDate() - i);
      
      if (check < earliestDate) continue;
      if (check > today) continue;

      const key = getLocalDateKey(check);
      const summary = history[key];
      
      if (summary) {
        hasDataForWeek = true;
        if (!isDaySuccessful(summary)) {
          weekSuccess = false;
          break;
        }
        if (summary.status === 'regular') anyRegular = true;
      } else {
        weekSuccess = false;
        break;
      }
    }

    if (weekSuccess && hasDataForWeek) {
      if (anyRegular) count++;
      d.setDate(d.getDate() - 7);
    } else if (!hasDataForWeek) {
       d.setDate(d.getDate() - 7);
    } else {
      break;
    }
  }
  return count;
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
      const todayStr = new Date().toDateString();
      const todayKey = getLocalDateKey();
      
      const history = parsed.history || {};
      const newStreak = calculateDailyStreak(history);
      const newWeeklyStreak = calculateWeeklyStreak(history);
      
      if (parsed.lastCheckIn !== todayStr) {
        const todayHistory = history[todayKey];
        return { 
          ...parsed, 
          dailyMeals: todayHistory?.meals || {}, 
          rewardClaimed: false, 
          isDayClosed: false, 
          streak: newStreak, 
          weeklyStreak: newWeeklyStreak 
        };
      }
      
      const todayHistory = history[todayKey];
      return { 
        ...parsed, 
        dailyMeals: todayHistory?.meals || parsed.dailyMeals || {},
        streak: newStreak, 
        weeklyStreak: newWeeklyStreak 
      };
    } catch { return defaultState; }
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [mealToSelect, setMealToSelect] = useState<string | null>(null);

  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const [isLiveActive, setIsLiveActive] = useState(false);

  useEffect(() => {
    localStorage.setItem('luce_user_v8', JSON.stringify(user));
  }, [user]);

  const setMealStatus = (mealId: string, status: 'regular' | 'bonus' | 'ko' | null) => {
    const now = new Date();
    const dateKey = getLocalDateKey(now);
    
    setUser(prev => {
      const currentMealsInHistory = prev.history[dateKey]?.meals || prev.dailyMeals;
      const newDailyMeals = { ...currentMealsInHistory, [mealId]: status };
      
      const mealsValues = Object.values(newDailyMeals);
      const mealsCount = mealsValues.filter(v => v !== null).length;
      const hasBonus = mealsValues.some(v => v === 'bonus');
      const hasKo = mealsValues.some(v => v === 'ko');
      
      const otherBonusInWeek = hasBonusInWeek(prev.history, now, dateKey);
      
      const isCompleted = mealsCount === MEALS.length && !hasKo && !(hasBonus && otherBonusInWeek);
      
      const summary: DaySummary = { 
        ...prev.history[dateKey],
        date: dateKey, 
        isCompleted, 
        mealsCount, 
        hasBonus, 
        mood: prev.history[dateKey]?.mood || 'felice', 
        meals: newDailyMeals, 
        status: prev.history[dateKey]?.status || 'regular' 
      };
      const newHistory = { ...prev.history, [dateKey]: summary };
      return { 
        ...prev, 
        dailyMeals: newDailyMeals, 
        history: newHistory, 
        streak: calculateDailyStreak(newHistory),
        weeklyStreak: calculateWeeklyStreak(newHistory)
      };
    });
    setMealToSelect(null);
  };

  const updateHistoryEntry = (dk: string, summary: DaySummary) => {
    const isToday = dk === getLocalDateKey();
    setUser(prev => {
      const newHistory = { ...prev.history, [dk]: summary };
      return { 
        ...prev, 
        history: newHistory, 
        dailyMeals: isToday ? (summary.meals || {}) : prev.dailyMeals,
        streak: calculateDailyStreak(newHistory),
        weeklyStreak: calculateWeeklyStreak(newHistory)
      };
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
    try {
      const apiKey = typeof process !== 'undefined' ? process.env.API_KEY : null;
      if (!apiKey) {
        setAiStatus('error');
        return;
      }
      const ai = new GoogleGenAI({ apiKey: apiKey });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
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
          onclose: () => setIsLiveActive(false),
          onerror: () => {
            setIsLiveActive(false);
            setAiStatus('error');
          }
        },
        config: { responseModalities: [Modality.AUDIO], systemInstruction: SYSTEM_INSTRUCTION }
      });
      sessionRef.current = await sessionPromise;
    } catch { 
      setIsLiveActive(false);
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
      const hasKo = mealsValues.some(v => v === 'ko');
      
      const otherBonusInWeek = hasBonusInWeek(prev.history, new Date(), dk);
      const isCompleted = (data.status === 'holiday' || data.status === 'sick') ? true : (mealsCount === MEALS.length && !hasKo && !(hasBonus && otherBonusInWeek));
      
      const summary: DaySummary = { 
        ...prev.history[dk], 
        date: dk, 
        isCompleted, 
        mood: data.mood, 
        status: data.status,
        mealsCount,
        hasBonus,
        meals: mealsToUse
      };
      const newHistory = { ...prev.history, [dk]: summary };
      return { 
        ...prev, 
        history: newHistory, 
        dailyMeals: mealsToUse,
        isDayClosed: true, 
        lastCheckIn: new Date().toDateString(), 
        streak: calculateDailyStreak(newHistory),
        weeklyStreak: calculateWeeklyStreak(newHistory)
      };
    });
    setView('dashboard');
    setShowReward(true);
    sendMessage("Ho completato la giornata! Grazie Luce ✨", true);
  };

  const bonusUsedThisWeek = useMemo(() => hasBonusInWeek(user.history, new Date()), [user.history]);
  const todayKey = getLocalDateKey();
  const currentMeals = user.history[todayKey]?.meals || user.dailyMeals;

  return (
    <div className="min-h-screen max-w-md mx-auto flex flex-col bg-[#fffafb] shadow-2xl relative overflow-hidden">
      <header className="px-6 pt-8 pb-4 flex justify-between items-center z-10">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-rose-400 rounded-2xl flex items-center justify-center text-white shadow-lg"><Sun size={24} /></div>
          <h1 className="text-xl font-bold text-gray-800">Luce</h1>
        </div>
        {view !== 'dashboard' && <button onClick={() => setView('dashboard')} className="p-2 rounded-full hover:bg-gray-100 text-gray-400 transition-colors"><ArrowRight className="rotate-180" size={20} /></button>}
      </header>

      <main className="flex-1 px-6 pb-2 z-10 overflow-y-auto custom-scrollbar">
        {view === 'dashboard' && (
          <div className="space-y-6 animate-in fade-in duration-500 pb-12">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold text-gray-800">Ciao, Luca ✨</h2>
              <p className="text-gray-500 text-xs font-medium">Sii gentile con te stesso oggi.</p>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-amber-50 p-6 rounded-[2.2rem] flex flex-col items-center border border-amber-100 shadow-sm transition-all active:scale-95">
                <Star className="text-amber-500 mb-2" size={36} />
                <span className="text-4xl font-bold text-amber-900">{user.weeklyStreak}</span>
                <span className="text-[10px] uppercase font-extrabold text-amber-500 text-center tracking-wider mt-1">Settimane</span>
              </div>
              <div className={`${bonusUsedThisWeek ? 'bg-rose-50 border-rose-100' : 'bg-emerald-50 border-emerald-100'} p-6 rounded-[2.2rem] flex flex-col items-center border shadow-sm transition-all active:scale-95`}>
                <Heart className={`${bonusUsedThisWeek ? 'text-rose-500' : 'text-emerald-500'} mb-2`} size={36} />
                <span className={`text-lg font-bold ${bonusUsedThisWeek ? 'text-rose-900' : 'text-emerald-900'} text-center leading-tight mt-1`}>{bonusUsedThisWeek ? 'Usato' : 'Libero'}</span>
                <span className={`text-[10px] uppercase font-extrabold ${bonusUsedThisWeek ? 'text-rose-500' : 'text-emerald-500'} text-center tracking-wider mt-auto`}>Bonus Sett.</span>
              </div>
            </div>

            <div className="bg-gray-50/50 p-6 rounded-[2.5rem] space-y-3 shadow-inner">
              <h3 className="font-bold text-gray-700 mb-1 flex items-center gap-2"><Sun className="text-amber-400" size={20} /> Pasti Odierni</h3>
              {MEALS.map(meal => (
                <button key={meal.id} onClick={() => !user.isDayClosed && setMealToSelect(meal.id)} disabled={user.isDayClosed} className="w-full flex items-center justify-between p-4 rounded-3xl bg-white shadow-sm active:scale-95 transition-all">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-gray-50">
                      {meal.icon === 'coffee' && <Coffee size={20} className="text-gray-400" />}
                      {meal.icon === 'apple' && <Apple size={20} className="text-gray-400" />}
                      {meal.icon === 'utensils' && <Utensils size={20} className="text-gray-400" />}
                      {meal.icon === 'moon' && <Moon size={20} className="text-gray-400" />}
                    </div>
                    <div className="text-left"><p className="text-sm font-bold text-gray-700">{meal.label}</p><p className="text-[10px] text-gray-400">{meal.time}</p></div>
                  </div>
                  {currentMeals[meal.id] ? (
                    <div className={`rounded-full p-1.5 ${currentMeals[meal.id] === 'bonus' ? 'bg-amber-400 shadow-amber-200' : currentMeals[meal.id] === 'ko' ? 'bg-rose-400 shadow-rose-200' : 'bg-emerald-400 shadow-emerald-200'} shadow-lg`}>
                      {currentMeals[meal.id] === 'ko' ? <XCircle size={16} className="text-white" /> : <Check size={16} className="text-white" />}
                    </div>
                  ) : (
                    <div className="w-6 h-6 rounded-full border-2 border-gray-100" />
                  )}
                </button>
              ))}
            </div>

            {!user.isDayClosed ? <button onClick={() => setView('checkin')} className="w-full bg-[#1e293b] text-white py-5 rounded-[2.5rem] font-bold shadow-2xl flex items-center justify-center gap-2 text-lg active:scale-95 transition-all">Completa la Giornata <Sparkles size={22} /></button> : <div className="p-6 bg-rose-50 rounded-[2.5rem] text-center text-rose-600 font-bold border border-rose-100">Giornata conclusa con cura ✨</div>}
            
            <div className="flex justify-center"><div className={`px-4 py-1.5 rounded-full border flex items-center gap-2 ${aiStatus === 'ok' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}><div className={`w-1.5 h-1.5 rounded-full ${aiStatus === 'ok' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} /><span className="text-[9px] font-bold uppercase tracking-widest">{aiStatus === 'ok' ? 'Luce Online' : 'Luce Offline'}</span></div></div>
          </div>
        )}
        
        {view === 'checkin' && <CheckInForm history={user.history} dateKey={getLocalDateKey()} initialData={{ mood: user.history[getLocalDateKey()]?.mood || 'felice', status: user.history[getLocalDateKey()]?.status || 'regular', meals: currentMeals }} onSubmit={closeDay} onCancel={() => setView('dashboard')} />}
        {view === 'chat' && <ChatView messages={messages} onSendMessage={sendMessage} isTyping={isTyping} isLiveActive={isLiveActive} onToggleLive={toggleLive} />}
        {view === 'calendar' && <CalendarView user={user} onUpdate={updateHistoryEntry} />}
      </main>

      {mealToSelect && <MealSelector mealId={mealToSelect} isBonusAvailable={!bonusUsedThisWeek} onSelect={setMealStatus} onCancel={() => setMealToSelect(null)} />}
      {showReward && <RewardModal onClaim={() => setShowReward(false)} />}

      <nav className="p-4 flex justify-around items-center border-t border-gray-100 bg-white z-20">
        <button onClick={() => setView('calendar')} className={`flex flex-col items-center gap-1 transition-all ${view === 'calendar' ? 'text-gray-800 scale-110' : 'text-gray-300 hover:text-rose-300'}`}><CalendarIcon size={28} /></button>
        <div className="relative -top-6"><button onClick={() => setView('dashboard')} className={`w-16 h-16 rounded-full flex items-center justify-center text-white shadow-xl border-4 border-white transition-all ${view === 'dashboard' ? 'bg-rose-400 scale-110' : 'bg-gray-300 hover:bg-rose-200'}`}><Sun size={32} /></button></div>
        <button onClick={() => setView('chat')} className={`flex flex-col items-center gap-1 transition-all ${view === 'chat' ? 'text-gray-800 scale-110' : 'text-gray-300 hover:text-rose-300'}`}><MessageCircle size={28} /></button>
      </nav>
    </div>
  );
};

// --- COMPONENTI UI ---
const CheckInForm: React.FC<any> = ({ onSubmit, onCancel, initialData, history, dateKey }) => {
  const [mood, setMood] = useState(initialData?.mood || 'felice');
  const [status, setStatus] = useState(initialData?.status || 'regular');
  const [meals, setMeals] = useState<Record<string, 'regular' | 'bonus' | 'ko' | null>>(initialData?.meals || {});

  const currentDayKey = dateKey || getLocalDateKey();
  const bonusUsedInWeek = useMemo(() => hasBonusInWeek(history || {}, parseDateKey(currentDayKey), currentDayKey), [history, currentDayKey]);

  const setStatusAndMeals = (newStatus: 'regular' | 'holiday' | 'sick') => {
    setStatus(newStatus);
    // Rimuoviamo l'auto-riempimento forzato dei pasti quando si seleziona 'regular'
    // Questo permette all'utente di tornare allo stato regolare e resettare i pasti manualmente.
  };

  const toggleMeal = (mealId: string) => {
    setMeals(prev => {
      const current = prev[mealId];
      let next: 'regular' | 'bonus' | 'ko' | null = null;
      if (!current) {
        next = 'regular';
      } else if (current === 'regular') {
        next = bonusUsedInWeek ? 'ko' : 'bonus';
      } else if (current === 'bonus') {
        next = 'ko';
      } else {
        next = 'regular';
      }
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
      <h2 className="text-2xl font-bold text-gray-800 leading-tight">Com'è andata la giornata?</h2>
      
      <div className="space-y-4">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Stato Odierno</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { id: 'regular', label: 'Regolare' },
            { id: 'holiday', label: 'Ferie' },
            { id: 'sick', label: 'Malattia' }
          ].map(s => (
            <button key={s.id} onClick={() => setStatusAndMeals(s.id as any)} className={`py-4 rounded-3xl border-2 transition-all font-bold text-[10px] uppercase shadow-sm ${status === s.id ? 'border-rose-400 bg-rose-50 text-rose-600' : 'bg-white text-gray-400 border-gray-100'}`}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Controlla i tuoi Pasti</p>
        <div className="space-y-2">
          {MEALS.map(meal => (
            <div key={meal.id} onClick={() => toggleMeal(meal.id)} className="w-full flex items-center justify-between p-3 rounded-2xl bg-white border border-gray-100 shadow-sm active:scale-[0.98] transition-all cursor-pointer group">
              <span className="text-xs font-bold text-gray-700">{meal.label}</span>
              <div className="flex items-center gap-2">
                <div className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase transition-all shadow-sm ${
                  meals[meal.id] === 'bonus' ? 'bg-amber-100 text-amber-600 border border-amber-200' : 
                  meals[meal.id] === 'regular' ? 'bg-emerald-100 text-emerald-600 border border-emerald-200' : 
                  meals[meal.id] === 'ko' ? 'bg-rose-100 text-rose-600 border border-rose-200' :
                  'bg-gray-50 text-gray-300 border border-gray-100'
                }`}>
                  {meals[meal.id] === 'bonus' ? 'Bonus' : meals[meal.id] === 'regular' ? 'Ok' : meals[meal.id] === 'ko' ? 'KO' : 'Incompleto'}
                </div>
                {meals[meal.id] !== null && (
                  <button onClick={(e) => resetMeal(meal.id, e)} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400 transition-colors" title="Reset pasto">
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Il tuo Mood</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { id: 'felice', icon: Smile, color: 'text-emerald-500' },
            { id: 'così così', icon: Meh, color: 'text-amber-500' },
            { id: 'difficile', icon: Frown, color: 'text-rose-500' }
          ].map(m => (
            <button key={m.id} onClick={() => setMood(m.id)} className={`p-6 rounded-3xl border-2 transition-all ${mood === m.id ? 'border-rose-400 bg-rose-50 shadow-md scale-105' : 'bg-white border-gray-100'}`}><m.icon size={32} className={`mx-auto ${mood === m.id ? m.color : 'text-gray-300'}`} /></button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <button onClick={resetDay} className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-gray-50 text-gray-400 font-bold text-xs border border-dashed border-gray-200 hover:bg-gray-100 transition-all">
          <Trash2 size={16} /> Resetta Giornata
        </button>
      </div>

      <div className="flex gap-4 pt-4">
        <button onClick={onCancel} className="flex-1 py-5 font-bold text-gray-400">Torna indietro</button>
        <button onClick={() => onSubmit({ mood, status, meals })} className="flex-[2] bg-rose-400 text-white py-5 rounded-[2rem] font-bold shadow-xl active:scale-95 transition-all text-sm">Salva Progressi ✨</button>
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

  const isSundayAStreak = (sundayDate: Date) => {
    let hasRegularDay = false;
    let allSuccessful = true;
    for (let i = 0; i < 7; i++) {
      const d = new Date(sundayDate);
      d.setDate(sundayDate.getDate() - i);
      const dk = getLocalDateKey(d);
      const summary = user.history[dk];
      if (!summary || !isDaySuccessful(summary)) {
        allSuccessful = false;
        break;
      }
      if (summary.status === 'regular') hasRegularDay = true;
    }
    return allSuccessful && hasRegularDay; 
  };

  const getDayColorClass = (dk: string) => {
    const summary = user.history[dk];
    if (!summary) return 'bg-gray-50 text-gray-400';

    const mealsValues = summary.meals ? Object.values(summary.meals) : [];
    const hasAnyMealData = mealsValues.some(v => v !== null);
    const isActuallyEmpty = !hasAnyMealData && summary.status === 'regular';

    if (isActuallyEmpty) return 'bg-gray-50 text-gray-400';
    if (summary.status === 'holiday') return 'bg-sky-50 text-sky-600 border border-sky-100';
    if (summary.status === 'sick') return 'bg-amber-50 text-amber-600 border border-amber-100';
    if (summary.isCompleted) return 'bg-emerald-50 text-emerald-600 border border-emerald-100';
    
    return 'bg-rose-50 text-rose-500 border border-rose-100';
  };

  if (editing) return (
    <CheckInForm history={user.history} dateKey={editing.key} initialData={{ mood: user.history[editing.key]?.mood || 'felice', status: user.history[editing.key]?.status || 'regular', meals: user.history[editing.key]?.meals || {} }} 
      onSubmit={(d:any) => { 
        const mealsValues = Object.values(d.meals || {});
        const mealsCount = mealsValues.filter(v => v !== null).length;
        const hasBonus = mealsValues.some(v => v === 'bonus');
        const hasKo = mealsValues.some(v => v === 'ko');
        const targetDate = parseDateKey(editing.key);
        const otherBonusInWeek = hasBonusInWeek(user.history, targetDate, editing.key);
        const isCompleted = (d.status === 'holiday' || d.status === 'sick') ? true : (mealsCount === MEALS.length && !hasKo && !(hasBonus && otherBonusInWeek));
        onUpdate(editing.key, { ...user.history[editing.key], ...d, isCompleted, mealsCount, hasBonus }); 
        setEditing(null); 
      }} onCancel={() => setEditing(null)} />
  );

  return (
    <div className="space-y-6 pb-12 animate-in fade-in">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><TrendingUp className="text-rose-400" /> Il Tuo Viaggio</h2>
        <div className="flex items-center gap-2 bg-white p-1 rounded-full border shadow-sm">
          <button onClick={() => setCurr(new Date(curr.getFullYear(), curr.getMonth() - 1, 1))} className="p-2 hover:bg-rose-50 rounded-full transition-colors"><ChevronLeft size={20} /></button>
          <span className="text-xs font-bold uppercase px-2">{curr.toLocaleDateString('it-IT', { month: 'short', year: 'numeric' })}</span>
          <button onClick={() => setCurr(new Date(curr.getFullYear(), curr.getMonth() + 1, 1))} className="p-2 hover:bg-rose-50 rounded-full transition-colors"><ChevronRight size={20} /></button>
        </div>
      </div>

      <div className="bg-white p-6 rounded-[2.5rem] shadow-sm border border-gray-100 overflow-hidden">
        <div className="grid grid-cols-8 gap-1 mb-4">
          {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom', 'Premio'].map(h => (
            <div key={h} className="text-center text-[8px] font-extrabold text-gray-300 uppercase tracking-tighter">{h}</div>
          ))}
          {grid.map((week, wi) => (
            <React.Fragment key={wi}>
              {week.map((d, di) => {
                if (!d) return <div key={`empty-${wi}-${di}`} className="w-9 h-9" />;
                const dk = getLocalDateKey(d);
                const isToday = dk === getLocalDateKey();
                return (
                  <button key={dk} onClick={() => setEditing({ date: d, key: dk })} className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold transition-all hover:scale-110 active:scale-90 ${getDayColorClass(dk)} ${isToday ? 'ring-2 ring-rose-300 ring-offset-1' : ''}`}>
                    {d.getDate()}
                  </button>
                );
              })}
              <div className="flex justify-center items-center">
                {week[6] && isSundayAStreak(week[6]) ? (
                  <div className="w-8 h-8 bg-amber-50 rounded-full flex items-center justify-center border border-amber-100 animate-pulse shadow-sm"><Star size={14} className="text-amber-500 fill-amber-500" /></div>
                ) : ( <div className="w-2 h-2 rounded-full bg-gray-100" /> )}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="bg-white p-6 rounded-[2.5rem] border border-gray-100 space-y-4 shadow-sm">
        <p className="text-[10px] font-extrabold text-gray-400 uppercase tracking-widest">Legenda Viaggio</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-6">
          <div className="flex items-center gap-3"><div className="w-4 h-4 bg-emerald-100 border border-emerald-200 rounded-md" /><span className="text-[11px] font-bold text-gray-600">Completato</span></div>
          <div className="flex items-center gap-3"><div className="w-4 h-4 bg-sky-100 border border-sky-200 rounded-md" /><span className="text-[11px] font-bold text-gray-600">Ferie</span></div>
          <div className="flex items-center gap-3"><div className="w-4 h-4 bg-amber-100 border border-amber-200 rounded-md" /><span className="text-[11px] font-bold text-gray-600">Malattia</span></div>
          <div className="flex items-center gap-3"><div className="w-4 h-4 bg-rose-100 border border-rose-200 rounded-md" /><span className="text-[11px] font-bold text-gray-600">Incompleto</span></div>
        </div>
      </div>
    </div>
  );
};

const ChatView: React.FC<any> = ({ messages, onSendMessage, isTyping, isLiveActive, onToggleLive }) => {
  const [inp, setInp] = useState('');
  return (
    <div className="flex flex-col h-[65vh] space-y-4">
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
        {messages.length === 0 && <div className="text-center p-10 space-y-2"><div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto text-rose-400"><MessageCircle size={32} /></div><p className="text-sm text-gray-400 font-medium">Inizia a parlare con Luce ✨</p></div>}
        {messages.map((m: any, i: number) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`p-4 rounded-[1.8rem] text-sm max-w-[85%] ${m.role === 'user' ? 'bg-rose-400 text-white shadow-lg' : 'bg-white border border-rose-50 shadow-sm text-gray-700'}`}>{m.content}</div>
          </div>
        ))}
        {isTyping && <div className="text-rose-300 text-[10px] animate-pulse font-bold uppercase tracking-widest px-4">Luce sta pensando...</div>}
      </div>
      <div className="flex gap-2 bg-white p-2 rounded-full border shadow-lg items-center mt-auto">
        <button onClick={onToggleLive} className={`p-3 rounded-full transition-all ${isLiveActive ? 'bg-rose-500 text-white animate-pulse' : 'bg-rose-50 text-rose-400'}`}>{isLiveActive ? <MicOff size={20} /> : <Mic size={20} />}</button>
        <input value={inp} onChange={e => setInp(e.target.value)} onKeyDown={e => e.key === 'Enter' && inp.trim() && (onSendMessage(inp), setInp(''))} placeholder="Parla con Luce..." className="flex-1 text-sm bg-transparent outline-none px-3" />
        <button onClick={() => inp.trim() && (onSendMessage(inp), setInp(''))} className="p-3 bg-rose-400 text-white rounded-full shadow-lg active:scale-90 transition-all"><Send size={20} /></button>
      </div>
    </div>
  );
};

const MealSelector: React.FC<any> = ({ onSelect, onCancel, isBonusAvailable, mealId }) => (
  <div className="fixed inset-0 bg-black/40 backdrop-blur-md z-[60] flex items-end p-4 animate-in fade-in">
    <div className="w-full bg-white rounded-[3rem] p-8 space-y-6 animate-in slide-in-from-bottom duration-300 shadow-2xl border-t border-rose-100">
      <div className="text-center space-y-2"><h3 className="font-bold text-xl text-gray-800">Cura il tuo Pasto</h3><p className="text-xs text-gray-400">Ogni pasto è un atto di gentilezza.</p></div>
      <div className="grid gap-4">
        <button onClick={() => onSelect(mealId, 'regular')} className="w-full p-6 bg-emerald-50 text-emerald-700 rounded-[1.8rem] font-bold flex justify-between items-center border border-emerald-100 hover:bg-emerald-100 transition-colors">Pasto Regolare <Check size={24} /></button>
        <button 
          onClick={() => isBonusAvailable && onSelect(mealId, 'bonus')} 
          disabled={!isBonusAvailable}
          className={`w-full p-6 rounded-[1.8rem] font-bold flex justify-between items-center border transition-all ${isBonusAvailable ? 'bg-amber-50 text-amber-700 border-amber-100 hover:bg-amber-100' : 'bg-gray-50 text-gray-300 border-gray-100 opacity-50 cursor-not-allowed'}`}>
          Usa Bonus <Star size={24} className={isBonusAvailable ? "text-amber-400" : "text-gray-200"} />
        </button>
        <button onClick={() => onSelect(mealId, 'ko')} className="w-full p-6 bg-rose-50 text-rose-700 rounded-[1.8rem] font-bold flex justify-between items-center border border-rose-100 hover:bg-rose-100 transition-colors">Pasto Saltato / KO <XCircle size={24} /></button>
        {!isBonusAvailable && <p className="text-[10px] text-center text-rose-400 font-bold uppercase tracking-wider">Bonus già utilizzato per questa settimana ✨</p>}
      </div>
      <button onClick={onCancel} className="w-full py-2 text-gray-400 font-bold hover:text-gray-600 transition-colors">Forse più tardi</button>
    </div>
  </div>
);

const RewardModal: React.FC<any> = ({ onClaim }) => (
  <div className="fixed inset-0 bg-rose-400/90 z-[100] flex items-center justify-center p-10 backdrop-blur-lg animate-in fade-in">
    <div className="bg-white rounded-[3rem] p-12 text-center space-y-6 animate-in zoom-in duration-500 shadow-2xl">
      <div className="w-24 h-24 bg-amber-50 rounded-full flex items-center justify-center mx-auto shadow-inner"><Trophy size={60} className="text-amber-400" /></div>
      <div className="space-y-2"><h2 className="text-3xl font-bold text-gray-800">Che Splendore! ✨</h2><p className="text-gray-500 text-sm leading-relaxed">Hai concluso un'altra giornata del tuo percorso. Sei stato davvero coraggioso oggi.</p></div>
      <button onClick={onClaim} className="w-full py-6 bg-rose-400 text-white rounded-[2rem] font-bold shadow-2xl active:scale-95 transition-all text-lg">Ricevi un Abbraccio Virtuale 💖</button>
    </div>
  </div>
);

export default App;
