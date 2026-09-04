/*
 * POST /api/v1/chat - Transcribe audio → generate reply
 * 
 * Accepts:
 *   - text (string): direct user input (no transcription needed)
 *   - audioDataUrl (string): base64-encoded WAV audio for transcription
 *   - language (string, optional): spoken language code (default "en")
 * 
 * Returns:
 *   { reply: string, audioChunks?: [{data: string, durationMs: number}] }
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');

// Configuration from environment
const WHISPER_BIN = process.env.WHISPER_BIN || 'C:\\whisper.cpp\\main.exe';
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(__dirname, '..', 'models', 'ggml-base.en.bin');
const LLAMA_BIN = process.env.LLAMA_BIN || 'C:\\llama.cpp\\main.exe';
const LLAMA_MODEL = process.env.LLAMA_MODEL || path.join(__dirname, '..', 'models', 'Q4_K_M.gguf');

// Temporary files directory
const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function handleChat(req, res) {
  try {
    const body = req.body;
    
    // If direct text input (no transcription), generate reply immediately
    if (body.text && !body.audioDataUrl) {
      return generateReply(body.text, res);
    }
    
    // Transcribe audio first
    if (body.audioDataUrl) {
      const transcript = transcribeAudio(body.audioDataUrl, body.language || 'en');
      
      // Generate reply to transcription
      return generateReply(transcript, res);
    }
    
    // No input provided
    res.status(400).json({ error: 'Missing text or audioDataUrl' });
  } catch (err) {
    console.error('Chat endpoint error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

function transcribeAudio(audioDataUrl, language = 'en') {
  // Decode base64 to WAV file
  const buffer = Buffer.from(audioDataUrl.split(',')[1], 'base64');
  const wavPath = path.join(TEMP_DIR, `transcript_${Date.now()}.wav`);
  
  fs.writeFileSync(wavPath, buffer);
  
  try {
    // Run whisper.cpp transcription
    const result = spawnSync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '--print_progress',
      wavPath,
      '-ofmt', 'txt',
      '-otxt',
      path.join(TEMP_DIR, `transcript_${Date.now()}.txt`)
    ], { encoding: 'utf-8' });
    
    if (result.status !== 0) {
      throw new Error(`Whisper failed: ${result.stderr || result.stdout}`);
    }
    
    // Read transcript
    const transcriptPath = path.join(TEMP_DIR, `transcript_${Date.now()}.txt`);
    let transcript = fs.readFileSync(transcriptPath, 'utf-8').trim();
    
    // Clean up temp files
    try {
      fs.unlinkSync(wavPath);
      fs.unlinkSync(transcriptPath);
    } catch (e) {}
    
    return transcript;
  } catch (err) {
    console.error('Transcription error:', err);
    throw new Error(`Failed to transcribe audio: ${err.message}`);
  }
}

function generateReply(userInput, res) {
  // Decode base64 to WAV file for TTS
  const buffer = Buffer.from(userInput.split(',')[1], 'base64');
  const wavPath = path.join(TEMP_DIR, `reply_${Date.now()}.wav`);
  
  fs.writeFileSync(wavPath, buffer);
  
  try {
    // Run llama.cpp generation (simplified - in production this would stream)
    const result = spawnSync(LLAMA_BIN, [
      '-m', LLAMA_MODEL,
      '-p', userInput,
      '--temp', '0.7',
      '--top-p', '0.9',
      '-n', '256',
      '-bf16',
      path.join(TEMP_DIR, `reply_${Date.now()}.txt`)
    ], { encoding: 'utf-8' });
    
    if (result.status !== 0) {
      throw new Error(`Llama failed: ${result.stderr || result.stdout}`);
    }
    
    // Read reply
    const replyPath = path.join(TEMP_DIR, `reply_${Date.now()}.txt`);
    let reply = fs.readFileSync(replyPath, 'utf-8').trim();
    
    // Clean up temp files
    try {
      fs.unlinkSync(wavPath);
      fs.unlinkSync(replyPath);
    } catch (e) {}
    
    res.json({ reply });
  } catch (err) {
    console.error('Reply generation error:', err);
    res.status(500).json({ error: 'Failed to generate reply', message: err.message });
  }
}

module.exports = { handleChat };
