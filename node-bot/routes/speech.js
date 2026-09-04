/*
 * Speech endpoints: transcribe, synthesize, OCR
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tesseract = require('tesseract.js');

// Configuration
const WHISPER_BIN = process.env.WHISPER_BIN || 'C:\\whisper.cpp\\main.exe';
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(__dirname, '..', 'models', 'ggml-base.en.bin');
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'fish';

function handleTranscribe(req, res) {
  try {
    const audioDataUrl = req.body.audioDataUrl;
    
    if (!audioDataUrl) {
      return res.status(400).json({ error: 'Missing audioDataUrl' });
    }
    
    // Decode and save WAV
    const buffer = Buffer.from(audioDataUrl.split(',')[1], 'base64');
    const wavPath = path.join(__dirname, '..', 'temp', `audio_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, buffer);
    
    // Transcribe with whisper.cpp
    const result = spawnSync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      wavPath,
      '-ofmt', 'txt',
      '-otxt',
      path.join(__dirname, '..', 'temp', `transcript_${Date.now()}.txt`)
    ], { encoding: 'utf-8' });
    
    if (result.status !== 0) {
      throw new Error(`Whisper failed: ${result.stderr || result.stdout}`);
    }
    
    const transcript = fs.readFileSync(
      path.join(__dirname, '..', 'temp', `transcript_${Date.now()}.txt`),
      'utf-8'
    ).trim();
    
    // Cleanup
    try { fs.unlinkSync(wavPath); fs.unlinkSync(path.join(__dirname, '..', 'temp', `transcript_${Date.now()}.txt`)); } catch (e) {}
    
    res.json({ transcript });
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).json({ error: 'Transcription failed', message: err.message });
  }
}

function handleSynthesize(req, res) {
  try {
    const { text } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid text' });
    }
    
    // Route to appropriate TTS provider
    switch (TTS_PROVIDER) {
      case 'kokoro':
        return handleKokoroSynthesize(text, res);
      case 'fish':
      default:
        return handleFishSpeechSynthesize(text, res);
    }
  } catch (err) {
    console.error('Synthesize error:', err);
    res.status(500).json({ error: 'Text synthesis failed', message: err.message });
  }
}

function handleKokoroSynthesize(text, res) {
  // Kokoro service endpoint
  const url = process.env.KOKORO_TTS_URL || 'http://localhost:8081';
  
  fetch(`${url}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  .then(res => res.arrayBuffer())
  .then(buffer => {
    const wavPath = path.join(__dirname, '..', 'temp', `kokoro_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, Buffer.from(buffer));
    
    // Return as base64 data URL
    const base64 = fs.readFileSync(wavPath).toString('base64');
    try { fs.unlinkSync(wavPath); } catch (e) {}
    
    res.json({ audioDataUrl: `data:audio/wav;base64,${base64}` });
  })
  .catch(err => {
    console.error('Kokoro TTS error:', err);
    throw new Error('Failed to connect to Kokoro service');
  });
}

function handleFishSpeechSynthesize(text, res) {
  // Fish Speech server endpoint
  const url = process.env.FISH_TTS_URL || 'http://localhost:8090';
  
  fetch(`${url}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  .then(res => res.arrayBuffer())
  .then(buffer => {
    const wavPath = path.join(__dirname, '..', 'temp', `fish_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, Buffer.from(buffer));
    
    // Return as base64 data URL
    const base64 = fs.readFileSync(wavPath).toString('base64');
    try { fs.unlinkSync(wavPath); } catch (e) {}
    
    res.json({ audioDataUrl: `data:audio/wav;base64,${base64}` });
  })
  .catch(err => {
    console.error('Fish Speech TTS error:', err);
    throw new Error('Failed to connect to Fish Speech service');
  });
}

function handleScreenRead(req, res) {
  try {
    const screenshotDataUrl = req.body.screenshotDataUrl;
    
    if (!screenshotDataUrl) {
      return res.status(400).json({ error: 'Missing screenshotDataUrl' });
    }
    
    // Decode PNG/JPEG to file
    const buffer = Buffer.from(screenshotDataUrl.split(',')[1], 'base64');
    const imgPath = path.join(__dirname, '..', 'temp', `screenshot_${Date.now()}.png`);
    fs.writeFileSync(imgPath, buffer);
    
    // OCR with Tesseract.js
    tesseract.recognize(imgPath, 'eng', {
      logger: m => console.log('[Tesseract]', m)
    })
    .then(({ data: { text } }) => {
      try { fs.unlinkSync(imgPath); } catch (e) {}
      
      res.json({ ocrText: text });
    })
    .catch(err => {
      console.error('OCR error:', err);
      throw new Error('Failed to perform OCR');
    });
  } catch (err) {
    console.error('Screen read error:', err);
    res.status(500).json({ error: 'Screen reading failed', message: err.message });
  }
}

function handleHealth(req, res) {
  res.json({ status: 'ok', timestamp: Date.now() });
}

module.exports = {
  handleTranscribe,
  handleSynthesize,
  handleScreenRead,
  handleHealth
};
