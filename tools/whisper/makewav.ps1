Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$path = 'C:\ManaAI\Mana\tools\whisper\test.wav'
$synth.SetOutputToWaveFile($path)
$synth.Speak('Hello world. This is a short test of the local speech to text system.')
$synth.Dispose()
Write-Output "WAV generated $path"
