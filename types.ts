
export interface DaySummary {
  date: string; // ISO date string (YYYY-MM-DD)
  isCompleted: boolean;
  mealsCount: number;
  hasBonus: boolean;
  mood: string;
  meals?: Record<string, 'regular' | 'bonus' | 'ko' | null>;
  status?: 'regular' | 'holiday' | 'sick';
  isClosed?: boolean;
}

export interface UserState {
  streak: number;
  weeklyStreak: number;
  bonusUsed: boolean;
  lastCheckIn: string | null;
  name: string;
  dailyMeals: Record<string, 'regular' | 'bonus' | 'ko' | null>;
  rewardClaimed: boolean;
  isDayClosed: boolean;
  history: Record<string, DaySummary>; // Keyed by YYYY-MM-DD
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface CheckInData {
  mood: string;
  emotions: string;
  status?: 'regular' | 'holiday' | 'sick';
}

export interface MealConfig {
  id: string;
  label: string;
  time: string;
  icon: string;
}
