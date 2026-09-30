using System;

namespace Mana.NativeLauncher;

// #922: listening is paused while I teach Mana my voice, so she doesn't
// wake to or answer the prompts, and put back as it was afterwards. Resume
// is safe to call twice (the enrolment's finally and Settings closing), and
// never starts listening that was off before.
internal sealed class ListeningPause
{
    private readonly Func<bool> isListening;
    private readonly Action toggleListening;
    private bool paused;
    private bool wasListening;

    public ListeningPause(Func<bool> isListening, Action toggleListening)
    {
        this.isListening = isListening;
        this.toggleListening = toggleListening;
    }

    public void Pause()
    {
        if (paused)
        {
            return;
        }
        paused = true;
        wasListening = isListening();
        if (wasListening)
        {
            toggleListening();
        }
    }

    public void Resume()
    {
        if (!paused)
        {
            return;
        }
        paused = false;
        // Turned back on by hand in the meantime: leave it be.
        if (wasListening && !isListening())
        {
            toggleListening();
        }
    }
}
