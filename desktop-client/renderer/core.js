// Voice pipeline, VAD, streaming queue wiring (core.js)
const { createDesktopStreamingChunkQueue } = window.ManaStreamingChunkQueue;

function initVoicePipeline() {
  // Initialize streaming chunk queue for reply audio playback
  const queue = createDesktopStreamingChunkQueue();
  
  // Wire IPC listener for backend replies
  window.electronAPI?.onReplyReceived((reply) => {
    if (!reply.audioChunks || !reply.audioChunks.length) return;
    
    // Feed chunks into the streaming queue
    reply.audioChunks.forEach(chunk => {
      queue.push(chunk);
    });
    
    // Trigger playback when first chunk arrives
    queue.play();
  });

  // Handle backend disconnection/reconnection
  window.electronAPI?.onBackendStatus((status) => {
    if (status === 'disconnected') {
      queue.pause();
    } else if (status === 'reconnected') {
      queue.resume();
    }
  });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVoicePipeline);
} else {
  initVoicePipeline();
}
