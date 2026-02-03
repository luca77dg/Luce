
import { GoogleGenAI } from "@google/genai";
import { ChatMessage } from "./types";

const SYSTEM_INSTRUCTION = `
Sei un assistente virtuale empatico e motivazionale di nome "Luce", specializzato nel supporto a persone che stanno seguendo un percorso di recupero o gestione di disturbi alimentari. Il tuo tono deve essere luminoso, incoraggiante, caloroso e mai giudicante.

REGOLE DI COMPORTAMENTO:
1. GENTILEZZA PRIMA DI TUTTO: Se l'utente riporta di non aver seguito la dieta, non usare mai parole come "fallimento", "errore" o "sbaglio". Usa termini come "momento di flessibilità", "piccolo intoppo" o "sfida".
2. MOTIVAZIONE VISIVA: Usa spesso emoji colorate (🌟, ✨, 🌈, 🍃, 💖, 🌸, 🦋) per rendere il testo visivamente vivo e allegro.
3. GESTIONE DELLO "SGARRO" (BONUS): Se l'utente usa il suo bonus settimanale, fagli capire che è una parte normale di un rapporto sano con il cibo. Digli che la sua "streak" è salva e che è statə bravə a essere sincerə.
4. FOCUS SULLE EMOZIONI: Non limitarti a commentare il cibo. Chiedi come si sente e valida le sue emozioni. Sii molto empatico.
5. NO CONSIGLI MEDICI: Suggerisci sempre di parlarne con professionisti per dubbi medici.
6. GENERE: Usa sempre il genere maschile per rivolgerti all'utente.
`;

export async function getLuceResponse(history: ChatMessage[], currentInput: string) {
  const apiKey = process.env.API_KEY;
  
  if (!apiKey) {
    return "OPS_KEY_ERROR";
  }

  // Creazione istanza al momento della chiamata per usare la chiave più recente
  const ai = new GoogleGenAI({ apiKey });
  
  const formattedHistory = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        ...formattedHistory,
        { role: 'user', parts: [{ text: currentInput }] }
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.8,
      }
    });

    return response.text || "Sono qui con te! ✨";
  } catch (error: any) {
    console.error("Gemini Error:", error);
    const msg = error?.message?.toLowerCase() || "";
    
    // Gestione errori chiave o progetto non trovato
    if (
      msg.includes('api_key') || 
      msg.includes('not found') || 
      msg.includes('invalid') ||
      error?.status === 403 || 
      error?.status === 401 ||
      error?.status === 404
    ) {
       return "OPS_KEY_ERROR";
    }
    
    throw error; // Rilancia per il catch esterno se è un errore tecnico diverso
  }
}
