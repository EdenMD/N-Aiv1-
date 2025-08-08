const { default: makeWASocket, DisconnectReason, jidNormalizedUser, fetchLatestBaileysVersion, delay, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const initializeFirebase = require('./firebaseConfig');
const userData = require('./userData.json');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// --- Firebase Initialization ---
const admin = initializeFirebase();
const db = admin.database(); // Realtime Database for auth
const firestore = admin.firestore(); // Firestore for conversations

// --- RTDB Path for Auth ---
const AUTH_DB_PATH = 'whatsapp_auth/baileys_session';
const CONVERSATIONS_COLLECTION = 'whatsapp_conversations';

// --- Gemini AI Configuration ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// --- Default AI Prompt for Nyasha Munyanyiwa (Zila fallback replacement) ---
const DEFAULT_NYASHA_PROMPT = `
YouYou are Nyasha Munyanyiwa, a 16-year-old boy living in Zimbabwe with his mother, father, and sister.
You are generally curious, respectful, and observant. You speak in a friendly, slightly informal tone, characteristic of a Zimbabwean teenager.
You might use common Zimbabwean phrases or expressions subtly (e.g., "howzit," "sharp," "eish," "saka").
You enjoy talking about daily life, school, friends, local events, and maybe a bit about sports or music popular in Zimbabwe.
Do not break character. Do not reveal you are an AI. Do not act as a general AI assistant.
Always try to respond within the persona of Nyasha Munyanyiwa. Keep responses concise but engaging.
`;


// Function to load credentials from Firebase RTDB
async function loadCredsFromFirebase() {
  try {
    const snapshot = await db.ref(AUTH_DB_PATH).once('value');
    const creds = snapshot.val();
    if (!creds) {
      console.error('No WhatsApp authentication data found in Firebase. Please run the Replit authentication setup.');
      process.exit(1);
    }
    console.log('WhatsApp authentication data loaded from Firebase.');
    return creds; // Return only the creds object
  } catch (error) {
    console.error('Error loading authentication data from Firebase:', error);
    process.exit(1);
  }
}

// Function to save credentials to Firebase RTDB
async function saveCredsToFirebase(creds) {
  try {
    await db.ref(AUTH_DB_PATH).set(JSON.parse(JSON.stringify(creds)));
    console.log('Authentication data updated in Firebase Realtime Database.');
  } catch (error) {
    console.error('Error saving authentication data to Firebase:', error);
  }
}

// Function to store message in Firestore for conversation history
async function storeMessageInFirestore(fromJid, messageId, messageContent, participant, timestamp, direction) {
  try {
    const docRef = firestore.collection(CONVERSATIONS_COLLECTION).doc(fromJid);
    await docRef.set({
      messages: admin.firestore.FieldValue.arrayUnion({
        id: messageId,
        content: messageContent,
        participant: participant, // 'user' or 'bot'
        timestamp: timestamp,
        direction: direction // 'incoming' or 'outgoing'
      })
    }, { merge: true });
    // console.log(`Message stored for ${fromJid}: ${messageContent}`);
  } catch (error) {
    console.error('Error storing message in Firestore:', error);
  }f
}

// Function to get conversation history from Firestore
async function getConversationHistory(fromJid) {
  try {
    const doc = await firestore.collection(CONVERSATIONS_COLLECTION).doc(fromJid).get();
    if (doc.exists) {
      // Get the last N messages, e.g., 10 messages
      const messages = doc.data().messages || [];
      return messages.slice(-10); // Adjust as needed for context size
    }
    return [];
  } catch (error) {
    console.error('Error fetching conversation history from Firestore:', error);
    return [];
  }
}

// Baileys getMessage function implementation
// Crucial for Baileys to reconstruct message context (e.g., for quoted messages)
const getMessage = async (key) => {
  if (firestore) {
    try {
      const doc = await firestore.collection(CONVERSATIONS_COLLECTION).doc(key.remoteJid).get();
      const messages = doc.exists ? doc.data().messages : [];
      // Find the message by its ID
      const msg = messages.find(m => m.id === key.id);
      if (msg) {
        // Baileys expects a specific message structure
        // This is a simplified reconstruction. For full fidelity, you'd need to save more details.
        return {
          conversation: msg.content,
          key: { id: msg.id, remoteJid: key.remoteJid, fromMe: msg.direction === 'outgoing' }
        };
      }
    } catch (error) {
      console.error('Error in getMessage from Firestore:', error);
    }
  }
  return undefined; // Or return a mock message if absolutely necessary
};

async function connectToWhatsApp() {
  console.log('Attempting to connect to WhatsApp...');
  const { version } = await fetchLatestBaileysVersion();
  console.log(`using Baileys v${version.join('.')}`);

  // --- NEW: Temporary local file setup for Baileys --- 
  const AUTH_FILE_DIR = 'temp_baileys_session';
  if (fs.existsSync(AUTH_FILE_DIR)) {
    fs.rmSync(AUTH_FILE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(AUTH_FILE_DIR);

  // Load credentials from Firebase RTDB
  const credsFromFirebase = await loadCredsFromFirebase();

  // Write the loaded credentials to the local creds.json file that useMultiFileAuthState expects
  fs.writeFileSync(path.join(AUTH_FILE_DIR, 'creds.json'), JSON.stringify(credsFromFirebase));

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FILE_DIR);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // QR code already handled by Replit
    browser: ['GitHub Actions Bot', 'Chrome', '1.0'],
    getMessage: getMessage // Crucial for message context
  });

  // Event listener for connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'close') {
      let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      // Clean up temporary files on disconnect to ensure a fresh start on next run
      fs.rmSync(AUTH_FILE_DIR, { recursive: true, force: true });

      if (reason === DisconnectReason.badSession || reason === DisconnectReason.loggedOut) {
        console.error(`!!! Bad Session or Logged Out. Please re-run Replit authentication to get a fresh QR and update Firebase. !!!`);
        process.exit(1); // Exit with error, GitHub Action will restart on schedule
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log(`Connection closed (Reason: ${reason}). Reconnecting...`);
        setTimeout(() => connectToWhatsApp(), 1000); // Attempt to reconnect quickly
      } else {
        console.log(`Connection closed due to: ${reason || lastDisconnect?.error}. Restarting bot...`);
        process.exit(1); // Exit with error, GitHub Action will restart on schedule
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection opened successfully on GitHub Actions!');
    }
  });

  // Event listener for credentials update (IMPORTANT for session refreshes)
  sock.ev.on('creds.update', async () => {
    console.log('Credentials updated. Saving to local files and syncing to Firebase...');
    await saveCreds(); // This saves updates to the local temp_baileys_session/creds.json file
    // Now read the updated creds from the local file system and push to Firebase
    const updatedCreds = JSON.parse(fs.readFileSync(path.join(AUTH_FILE_DIR, 'creds.json')));
    await saveCredsToFirebase(updatedCreds);
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const msg of messages) {
        // Ignore messages from myself or status updates
        if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

        const from = jidNormalizedUser(msg.key.remoteJid); // Sender JID
        const messageContent = msg.message?.extendedTextMessage?.text || msg.message?.conversation || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
        const messageId = msg.key.id;
        const timestamp = parseInt(msg.messageTimestamp * 1000); // Convert to milliseconds

        console.log(`[${from}] Received: ${messageContent.substring(0, 50)}... (ID: ${messageId})`);

        // Store incoming message in Firestore
        await storeMessageInFirestore(from, messageId, messageContent, 'user', timestamp, 'incoming');

        let userConfig = userData[from];
        let responseText = '';
        let aiPrompt = '';

        if (userConfig) {
          console.log(`User ${userConfig.name} found. Using custom prompt.`);
          aiPrompt = userConfig.prompt;
        } else {
          // --- Zila Fallback Mechanism (Now using Nyasha Munyanyiwa persona) ---
          console.log(`No specific config for ${from}. Defaulting to Nyasha Munyanyiwa persona.`);
          aiPrompt = DEFAULT_NYASHA_PROMPT;
        }

        const history = await getConversationHistory(from);

        // Prepare chat history for Gemini
        const chat = model.startChat({
          history: history.map(h => ({
            role: h.participant === 'user' ? 'user' : 'model', // Gemini expects 'user' or 'model'
            parts: [{ text: h.content }]
          })),
          generationConfig: {
            maxOutputTokens: 200,
          },
        });

        try {
          // Add the current user message to the chat
          const result = await chat.sendMessage(`${aiPrompt}\nUser: ${messageContent}`);
          const response = await result.response;
          responseText = response.text();
          console.log('Gemini response:', responseText);
        } catch (error) {
          console.error('Error generating Gemini response:', error);
          responseText = 'Apologies, I encountered an error trying to generate a response from Nyasha. Please try again later.';
        }

        if (responseText) {
          await sock.sendMessage(from, { text: responseText });
          console.log(`Sent response to ${from}: ${responseText.substring(0, 50)}...`);
          // Store outgoing message in Firestore
          await storeMessageInFirestore(from, sock.generateMessageTag(), responseText, 'bot', Date.now(), 'outgoing');
        }
      }
    }
  });

  // Keep the process alive (for GitHub Actions timeout management)
  // This ensures the script doesn't exit prematurely before GitHub's timeout.
  setInterval(() => { /* Keep alive */ }, 60 * 1000);
}

// Start the bot
connectToWhatsApp();
