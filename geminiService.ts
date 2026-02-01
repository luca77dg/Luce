
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
  // Verifica sicura dell'esistenza dell'API KEY senza crashare il runtime
  const apiKey = typeof process !== 'undefined' ? process.env.API_KEY : null;

  if (!apiKey) {
    console.error("API_KEY missing in environment");
    return "OPS_KEY_ERROR";
  }

  const ai = new GoogleGenAI({ apiKey: apiKey });
  
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
    // Gestione errori di autenticazione o quota
    if (error?.message?.includes('API_KEY') || error?.status === 403 || error?.status === 401 || error?.message?.includes('not found')) {
       return "OPS_KEY_ERROR";
    }
    return "Oggi la mia connessione è un po' timida, ma io ci sono sempre per te. 💖";
  }
}
