namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: RMS mouth-openness + MFCC-based viseme mouth-shape
// classification, ported from windows-launcher/avatar/lip-sync.js (issue
// #275/#161's math) -- computeMfcc's mel-filterbank/DCT pipeline and
// classifyViseme's formant-band scoring port directly, as do rmsToMouth
// and smoothMouthValue.
//
// spectralCentroidHz/centroidToMouthForm/vrmMouthBlendShapes are NOT
// ported -- per the JS file's own comments, viseme classification is the
// more accurate mouth-shape signal, and both drive the same
// ParamMouthForm-equivalent output, so keeping only the better one avoids
// two competing signals for nothing; VRM blend shapes are irrelevant to
// this Cubism-only port.
internal static class LipSyncAnalyzer
{
    public readonly record struct MfccResult(double[] MelEnergies, double[] MelCenterHz);

    // Maps speech RMS amplitude to a 0..1 mouth-open value with a noise floor.
    public static float RmsToMouth(float rms, float floor = 0.01f, float gain = 9f)
    {
        var value = rms - floor;
        return value <= 0 ? 0f : Math.Min(1f, value * gain);
    }

    // Fast attack, slower decay so the mouth snaps open but closes
    // smoothly. dtMs: elapsed time since the previous call.
    public static float SmoothMouthValue(float previous, float target, float dtMs, float attackMs = 40f, float decayMs = 140f)
    {
        var tau = target > previous ? attackMs : decayMs;
        var alpha = Math.Min(1f, dtMs / Math.Max(1f, tau));
        return previous + (target - previous) * alpha;
    }

    private readonly record struct MelFilterbank(double[][] Filters, double[] CenterHz);

    private static readonly Dictionary<string, MelFilterbank> FilterbankCache = new();

    private static double HzToMel(double hz) => 2595 * Math.Log10(1 + hz / 700);
    private static double MelToHz(double mel) => 700 * (Math.Pow(10, mel / 2595) - 1);

    // Standard triangular mel filterbank: numFilters overlapping triangles
    // spaced evenly on the mel scale between minHz/maxHz. Built once per
    // (numFilters, fftSize, sampleRate, minHz, maxHz) combination and
    // cached -- these are all constant for the life of an audio session,
    // and rebuilding ~26 filters on every lip-sync tick would be wasted
    // work.
    private static MelFilterbank GetMelFilterbank(int numFilters, int fftSize, int sampleRate, double minHz, double maxHz)
    {
        var key = $"{numFilters}:{fftSize}:{sampleRate}:{minHz}:{maxHz}";
        if (FilterbankCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var numBins = fftSize / 2 + 1;
        var minMel = HzToMel(minHz);
        var maxMel = HzToMel(maxHz);
        var melPoints = new double[numFilters + 2];
        for (var i = 0; i < melPoints.Length; i++)
        {
            melPoints[i] = minMel + (maxMel - minMel) * i / (numFilters + 1);
        }
        var hzPoints = new double[melPoints.Length];
        for (var i = 0; i < melPoints.Length; i++)
        {
            hzPoints[i] = MelToHz(melPoints[i]);
        }
        var binPoints = new int[hzPoints.Length];
        for (var i = 0; i < hzPoints.Length; i++)
        {
            binPoints[i] = (int)Math.Floor((fftSize + 1) * hzPoints[i] / sampleRate);
        }

        var filters = new double[numFilters][];
        var centerHz = new double[numFilters];
        for (var f = 0; f < numFilters; f++)
        {
            var left = binPoints[f];
            var center = binPoints[f + 1];
            var right = binPoints[f + 2];
            var weights = new double[numBins];
            if (center > left)
            {
                for (var bin = left; bin < center; bin++)
                {
                    if (bin >= 0 && bin < numBins)
                    {
                        weights[bin] = (double)(bin - left) / (center - left);
                    }
                }
            }
            if (right > center)
            {
                for (var bin = center; bin < right; bin++)
                {
                    if (bin >= 0 && bin < numBins)
                    {
                        weights[bin] = (double)(right - bin) / (right - center);
                    }
                }
            }
            filters[f] = weights;
            centerHz[f] = hzPoints[f + 1];
        }

        var filterbank = new MelFilterbank(filters, centerHz);
        FilterbankCache[key] = filterbank;
        return filterbank;
    }

    // magnitudesDb: dB magnitude spectrum, e.g. from SimpleFft.MagnitudesDb.
    // Returns mel energies (classifyViseme's input) and their band-center
    // frequencies -- not the DCT'd cepstral coefficients themselves, since
    // classifyViseme reads formant-band energy from the pre-DCT filterbank
    // directly (see its own comment for why: formant frequencies are
    // verifiable against textbook vowel tables in a way abstract cepstral
    // coefficients aren't, without labeled training data this project
    // doesn't have).
    public static MfccResult ComputeMelEnergies(
        ReadOnlySpan<float> magnitudesDb,
        int sampleRate,
        int fftSize,
        int numFilters = 26,
        double minHz = 0,
        double maxHz = -1)
    {
        if (maxHz < 0)
        {
            maxHz = sampleRate / 2.0;
        }
        var filterbank = GetMelFilterbank(numFilters, fftSize, sampleRate, minHz, maxHz);

        var numBins = magnitudesDb.Length;
        var power = new double[numBins];
        for (var i = 0; i < numBins; i++)
        {
            // Power, not amplitude -- dB is 10*log10(power), not 20*log10(power).
            power[i] = Math.Pow(10, magnitudesDb[i] / 10);
        }

        var melEnergies = new double[numFilters];
        for (var f = 0; f < numFilters; f++)
        {
            var weights = filterbank.Filters[f];
            double sum = 0;
            for (var i = 0; i < numBins && i < weights.Length; i++)
            {
                sum += weights[i] * power[i];
            }
            melEnergies[f] = sum;
        }

        return new MfccResult(melEnergies, filterbank.CenterHz);
    }

    // A small, fixed viseme set -- not a full phoneme inventory, just
    // enough to distinguish the mouth shapes that actually read
    // differently on an avatar: "aa" (open, e.g. father), "ee"
    // (close/front, e.g. see), "oo" (close/back, e.g. boot), "neutral"
    // (silence or ambiguous). Bands are typical adult vowel formant
    // ranges (F1 = jaw openness, F2 = tongue front/back).
    private static readonly (string Viseme, (double Lo, double Hi) F1, (double Lo, double Hi) F2)[] VisemeFormantBands =
    [
        ("aa", (600, 1000), (1000, 1900)),
        ("ee", (250, 450), (1900, 3000)),
        ("oo", (250, 450), (600, 1100)),
    ];

    private static double BandEnergy(double[] melEnergies, double[] melCenterHz, double loHz, double hiHz)
    {
        double sum = 0;
        for (var i = 0; i < melEnergies.Length; i++)
        {
            if (melCenterHz[i] >= loHz && melCenterHz[i] < hiHz)
            {
                sum += melEnergies[i];
            }
        }
        return sum;
    }

    // Picks whichever viseme's formant bands hold the largest share of
    // this frame's mel energy; "neutral" only when there's essentially no
    // signal (silence). No tie-margin -- a genuinely ambiguous frame still
    // deterministically picks whichever viseme scores highest (ties go to
    // "aa", first in VisemeFormantBands), matching the JS original -- an
    // acceptable simplification for a coarse mouth-shape signal, not a bug.
    public static string ClassifyViseme(MfccResult mfcc, double silenceFloor = 1e-6)
    {
        var melEnergies = mfcc.MelEnergies;
        var melCenterHz = mfcc.MelCenterHz;
        // default(MfccResult) (a readonly record struct) has null arrays,
        // not empty ones -- struct default-initialization skips the
        // constructor entirely, matching the JS original's "missing
        // melEnergies/melCenterHz" case (classifyViseme(null)/({})).
        if (melEnergies is null || melEnergies.Length == 0 || melCenterHz is null)
        {
            return "neutral";
        }

        double totalEnergy = 0;
        foreach (var e in melEnergies)
        {
            totalEnergy += e;
        }
        if (totalEnergy <= silenceFloor)
        {
            return "neutral";
        }

        var best = "neutral";
        double bestScore = 0;
        foreach (var (viseme, f1, f2) in VisemeFormantBands)
        {
            var f1Energy = BandEnergy(melEnergies, melCenterHz, f1.Lo, f1.Hi);
            var f2Energy = BandEnergy(melEnergies, melCenterHz, f2.Lo, f2.Hi);
            var score = (f1Energy + f2Energy) / totalEnergy;
            if (score > bestScore)
            {
                bestScore = score;
                best = viseme;
            }
        }
        return best;
    }

    // Maps a classified viseme to a -1..1 mouth-form range (negative =
    // rounder/"o"/"u", positive = wider/"i"/"e"), for driving
    // ParamMouthForm alongside RmsToMouth's ParamMouthOpenY.
    public static float VisemeToMouthForm(string viseme) => viseme switch
    {
        "ee" => 1f,
        "oo" => -1f,
        _ => 0f,
    };
}
